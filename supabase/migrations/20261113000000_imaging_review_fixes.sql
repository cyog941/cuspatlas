-- Independent review of I5-I9 (synthetic data only): literal path-prefix comparison, converging
-- hold-subject locks, device-kind check on device rows, and a purge of expired assertion identifiers.

-- 1. Path prefixes compare literally (a LIKE pattern made '_' a wildcard: 'scan_in' admitted 'scanXin/...').
CREATE OR REPLACE FUNCTION cuspatlas.imaging_bridge_job_allowed(p_device uuid, p_kind text, p_path text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM cuspatlas.imaging_devices d
    WHERE d.id = p_device AND d.state = 'active' AND p_kind = ANY (d.allowed_job_kinds)
      AND (p_path IS NULL OR EXISTS (
        SELECT 1 FROM unnest(d.allowed_path_prefixes) pre
        WHERE p_path = pre OR left(p_path, length(pre) + 1) = pre || '/')));
$$;

-- 2. Hold-subject locks: take the computed set, recompute on a fresh snapshot, and repeat until the set
-- is stable, so an association or merge that committed while this transaction waited is also locked.
-- Returns the final locked set. (Locks are only ever added, never released before commit.)
CREATE FUNCTION cuspatlas.imaging_lock_hold_subjects(p_tenant uuid, p_object uuid) RETURNS uuid[]
LANGUAGE plpgsql AS $$
DECLARE
  locked uuid[] := '{}';
  wanted uuid[];
  n integer := 0;
BEGIN
  LOOP
    wanted := cuspatlas.imaging_hold_subjects(p_object);
    EXIT WHEN wanted <@ locked;
    PERFORM cuspatlas.imaging_lock_subjects(p_tenant, wanted);
    locked := ARRAY(SELECT DISTINCT x FROM unnest(locked || wanted) x ORDER BY x);
    n := n + 1;
    IF n > 20 THEN
      RAISE EXCEPTION 'hold subjects did not stabilise' USING ERRCODE = '40001';
    END IF;
  END LOOP;
  RETURN locked;
END;
$$;
REVOKE ALL ON FUNCTION cuspatlas.imaging_lock_hold_subjects(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.imaging_lock_hold_subjects(uuid, uuid) TO cuspatlas_app;

CREATE OR REPLACE FUNCTION cuspatlas.imaging_objects_hold_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'deleted' AND OLD.state <> 'deleted' THEN
    PERFORM cuspatlas.imaging_lock_hold_subjects(NEW.tenant_id, NEW.id);
    IF EXISTS (SELECT 1 FROM cuspatlas.imaging_object_holds(NEW.id)) THEN
      RAISE EXCEPTION 'an active legal hold covers this object' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 3. A device row may only name a principal of kind device (principals are invisible to the runtime role
-- except itself, so the check is a narrow definer function).
CREATE FUNCTION cuspatlas.imaging_principal_is_device(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, cuspatlas AS $$
  SELECT EXISTS (SELECT 1 FROM cuspatlas.principals p WHERE p.id = p_id AND p.kind = 'device');
$$;
REVOKE ALL ON FUNCTION cuspatlas.imaging_principal_is_device(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.imaging_principal_is_device(uuid) TO cuspatlas_app;
DROP POLICY imaging_devices_insert ON cuspatlas.imaging_devices;
CREATE POLICY imaging_devices_insert ON cuspatlas.imaging_devices
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND state = 'pending' AND key_version = 0 AND cuspatlas.imaging_principal_is_device(id));

-- 4. Assertion identifiers stay append-only except that one expired for over an hour may be deleted
-- (it can no longer be replayed: the assertion itself has expired).
CREATE FUNCTION cuspatlas.imaging_device_nonces_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.expires_at < now() - interval '1 hour' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'table is append-only' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION cuspatlas.imaging_device_nonces_guard() FROM PUBLIC;
DROP TRIGGER imaging_device_nonces_append_only ON cuspatlas.imaging_device_nonces;
CREATE TRIGGER imaging_device_nonces_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_device_nonces
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_device_nonces_guard();
GRANT DELETE ON cuspatlas.imaging_device_nonces TO cuspatlas_app;
CREATE POLICY imaging_device_nonces_delete ON cuspatlas.imaging_device_nonces
  FOR DELETE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND expires_at < now() - interval '1 hour');
