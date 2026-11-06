-- Closeout E (synthetic engineering implementation, recommended-pending-approval): the worker's scheduled
-- dry-run orphan-bytes report is single-flight per tenant per interval. Two workers that became due at the
-- same moment each recorded a report. The scheduled run now takes a transaction-scoped advisory lock of
-- its tenant without waiting (a worker that does not get it records nothing) and re-checks, inside the
-- lock and on a fresh snapshot, whether the tenant's last scheduled report is older than the interval.
-- Scheduled records are marked, so due-ness is per tenant whichever worker principal recorded the last
-- one. Records written before this change are unmarked; the due check still counts the caller's own
-- unmarked dry runs, as before.
ALTER TABLE cuspatlas.imaging_orphan_sweeps
  ADD COLUMN scheduled boolean NOT NULL DEFAULT false,
  ADD CHECK (NOT scheduled OR dry_run);
CREATE INDEX imaging_orphan_sweeps_scheduled ON cuspatlas.imaging_orphan_sweeps (tenant_id, created_at)
  WHERE scheduled;

-- Non-blocking, transaction-scoped lock of the caller tenant's scheduled sweep. Domain statements cannot
-- call pg_* functions; this wrapper takes no argument and locks only the current tenant's key.
CREATE FUNCTION cuspatlas.imaging_try_lock_scheduled_sweep() RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid := cuspatlas.current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'scheduled sweep lock needs a tenant context' USING ERRCODE = '42501';
  END IF;
  RETURN pg_try_advisory_xact_lock(hashtextextended('imaging-scheduled-sweep:' || v_tenant::text, 0));
END;
$$;
REVOKE ALL ON FUNCTION cuspatlas.imaging_try_lock_scheduled_sweep() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.imaging_try_lock_scheduled_sweep() TO cuspatlas_app;
