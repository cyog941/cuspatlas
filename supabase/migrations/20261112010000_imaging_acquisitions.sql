-- I7: offline device, bridge failure and recovery worklist. Synthetic data only; device-specific operator
-- guidance stays blocked on I-S1. An acquisition requested while its device is not available becomes a
-- visible deferred item with a reason (never a silent failure or an endless spinner); it is released to a
-- job exactly once, or cancelled with a reason, by a person.

ALTER TABLE cuspatlas.imaging_bridge_jobs ADD CONSTRAINT imaging_bridge_jobs_id_tenant UNIQUE (id, tenant_id);

CREATE TABLE cuspatlas.imaging_acquisition_deferrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  device_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('acquire', 'import')),
  scope_path text CHECK (scope_path IS NULL OR cuspatlas.imaging_safe_bridge_path(scope_path)),
  intended_patient_id uuid,
  -- The patient record version seen at request time: a later change needs re-confirmation at release.
  patient_version integer CHECK (patient_version >= 1),
  defer_reason text NOT NULL CHECK (defer_reason IN ('device_offline', 'device_stale')),
  state text NOT NULL DEFAULT 'deferred' CHECK (state IN ('deferred', 'released', 'cancelled')),
  job_id uuid,
  resolved_by uuid REFERENCES cuspatlas.principals (id),
  resolved_at timestamptz,
  resolution_reason text CHECK (resolution_reason ~ '^[a-z_]{1,64}$'),
  patient_reconfirmed boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (device_id, tenant_id) REFERENCES cuspatlas.imaging_devices (id, tenant_id),
  FOREIGN KEY (intended_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (job_id, tenant_id) REFERENCES cuspatlas.imaging_bridge_jobs (id, tenant_id),
  CHECK (kind <> 'import' OR scope_path IS NOT NULL),
  CHECK ((intended_patient_id IS NULL) = (patient_version IS NULL)),
  CHECK ((state = 'deferred') = (resolved_at IS NULL AND resolved_by IS NULL)),
  CHECK ((state = 'released') = (job_id IS NOT NULL)),
  CHECK (state <> 'cancelled' OR resolution_reason IS NOT NULL)
);
CREATE INDEX imaging_acquisition_deferrals_open ON cuspatlas.imaging_acquisition_deferrals (tenant_id, created_at)
  WHERE state = 'deferred';

-- A deferral is resolved once (released or cancelled) by the acting person; nothing else changes.
CREATE FUNCTION cuspatlas.imaging_acquisition_deferrals_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state <> 'deferred' OR NEW.state = 'deferred'
     OR (NEW.id, NEW.tenant_id, NEW.device_id, NEW.kind, NEW.scope_path, NEW.intended_patient_id, NEW.patient_version,
         NEW.defer_reason, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.device_id, OLD.kind, OLD.scope_path, OLD.intended_patient_id,
         OLD.patient_version, OLD.defer_reason, OLD.created_by, OLD.created_at)
     OR NEW.version <> OLD.version + 1
     OR NEW.resolved_by IS DISTINCT FROM cuspatlas.current_actor_id() THEN
    RAISE EXCEPTION 'acquisition deferral change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_acquisition_deferrals_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_acquisition_deferrals
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_acquisition_deferrals_guard();

-- A released job names its deferral (set at job creation, fixed by the job guard). No foreign key on that
-- side: the deferral references its job, and the logical restore cannot load a cycle.
-- At most one job per deferral: release happens exactly once.
CREATE UNIQUE INDEX imaging_bridge_jobs_one_per_deferral ON cuspatlas.imaging_bridge_jobs (tenant_id, deferral_id)
  WHERE deferral_id IS NOT NULL;

ALTER TABLE cuspatlas.imaging_acquisition_deferrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_acquisition_deferrals FORCE ROW LEVEL SECURITY;
CREATE POLICY imaging_acquisition_deferrals_select ON cuspatlas.imaging_acquisition_deferrals
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_acquisition_deferrals_insert ON cuspatlas.imaging_acquisition_deferrals
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND state = 'deferred');
CREATE POLICY imaging_acquisition_deferrals_update ON cuspatlas.imaging_acquisition_deferrals
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
GRANT SELECT, INSERT ON cuspatlas.imaging_acquisition_deferrals TO cuspatlas_app;
GRANT UPDATE (state, job_id, resolved_by, resolved_at, resolution_reason, patient_reconfirmed, version, updated_at)
  ON cuspatlas.imaging_acquisition_deferrals TO cuspatlas_app;
REVOKE ALL ON FUNCTION cuspatlas.imaging_acquisition_deferrals_guard() FROM PUBLIC;

-- I6 correction: the claimant check applies to the transition into `claimed` only (a lease sweep or a
-- revocation of an already claimed job is not a claim).
CREATE OR REPLACE FUNCTION cuspatlas.imaging_bridge_jobs_claim_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'claimed' AND OLD.state IS DISTINCT FROM 'claimed' THEN
    IF NOT cuspatlas.imaging_bridge_job_allowed(NEW.device_id, NEW.kind, NEW.scope_path) THEN
      RAISE EXCEPTION 'job not allowed for this device' USING ERRCODE = '42501';
    END IF;
    IF NEW.device_id IS DISTINCT FROM cuspatlas.current_actor_id() THEN
      RAISE EXCEPTION 'only the device itself claims its job' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
