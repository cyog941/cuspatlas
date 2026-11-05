-- S21 (OR-06, OR-D1 accepted 2026-11-04): provider request facts and staff presence behind the floor
-- read model. Synthetic data only. The floor view itself is computed on read from S11 attendance and
-- writes nothing. A provider request is an internal staff fact for one appointment's visit (open ->
-- acknowledged -> cleared, or open -> cleared); it never creates a patient-facing intent. Presence is
-- a staff-owned, self-set, expiring status; a principal can write only its own row (RLS).

CREATE TABLE cuspatlas.scheduling_provider_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  location_id uuid NOT NULL,
  provider_resource_id uuid,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'acknowledged', 'cleared')),
  acknowledged_by uuid REFERENCES cuspatlas.principals (id),
  acknowledged_at timestamptz,
  cleared_by uuid REFERENCES cuspatlas.principals (id),
  cleared_at timestamptz,
  clear_reason text CHECK (clear_reason ~ '^[a-z_]{1,64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES cuspatlas.appointments (id, tenant_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  FOREIGN KEY (provider_resource_id, tenant_id) REFERENCES cuspatlas.scheduling_resources (id, tenant_id),
  CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
  CHECK ((state = 'cleared') = (cleared_at IS NOT NULL AND cleared_by IS NOT NULL AND clear_reason IS NOT NULL))
);
-- At most one request that is not cleared per appointment.
CREATE UNIQUE INDEX scheduling_provider_requests_one_live ON cuspatlas.scheduling_provider_requests
  (tenant_id, appointment_id) WHERE state <> 'cleared';
CREATE INDEX scheduling_provider_requests_location ON cuspatlas.scheduling_provider_requests
  (tenant_id, location_id, state);

CREATE FUNCTION cuspatlas.scheduling_provider_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'provider request version must increase by one' USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'cleared' OR (OLD.state = 'acknowledged' AND NEW.state = 'open') THEN
    RAISE EXCEPTION 'a provider request only moves forward' USING ERRCODE = '42501';
  END IF;
  IF (NEW.appointment_id, NEW.location_id, NEW.provider_resource_id, NEW.reason_code, NEW.created_by,
      NEW.created_at) IS DISTINCT FROM
     (OLD.appointment_id, OLD.location_id, OLD.provider_resource_id, OLD.reason_code, OLD.created_by,
      OLD.created_at) THEN
    RAISE EXCEPTION 'a provider request subject is never rewritten' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cuspatlas.scheduling_provider_requests_guard() FROM PUBLIC;
CREATE TRIGGER scheduling_provider_requests_guard BEFORE UPDATE ON cuspatlas.scheduling_provider_requests
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.scheduling_provider_requests_guard();
CREATE TRIGGER scheduling_provider_requests_no_delete BEFORE DELETE ON cuspatlas.scheduling_provider_requests
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

CREATE TABLE cuspatlas.scheduling_staff_presence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  location_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('available', 'busy', 'away')),
  operatory_resource_id uuid,
  set_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  FOREIGN KEY (operatory_resource_id, tenant_id) REFERENCES cuspatlas.scheduling_resources (id, tenant_id),
  CHECK (expires_at > set_at),
  UNIQUE (tenant_id, principal_id)
);
CREATE TRIGGER scheduling_staff_presence_no_delete BEFORE DELETE ON cuspatlas.scheduling_staff_presence
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.scheduling_provider_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_provider_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_staff_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_staff_presence FORCE ROW LEVEL SECURITY;

CREATE POLICY scheduling_provider_requests_select ON cuspatlas.scheduling_provider_requests
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY scheduling_provider_requests_insert ON cuspatlas.scheduling_provider_requests
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY scheduling_provider_requests_update ON cuspatlas.scheduling_provider_requests
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY scheduling_staff_presence_select ON cuspatlas.scheduling_staff_presence
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
-- Self-set only: the database rejects a row for any principal but the transaction's actor.
CREATE POLICY scheduling_staff_presence_insert ON cuspatlas.scheduling_staff_presence
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());
CREATE POLICY scheduling_staff_presence_update ON cuspatlas.scheduling_staff_presence
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.scheduling_provider_requests, cuspatlas.scheduling_staff_presence TO cuspatlas_app;
GRANT UPDATE (state, acknowledged_by, acknowledged_at, cleared_by, cleared_at, clear_reason, version, updated_at)
  ON cuspatlas.scheduling_provider_requests TO cuspatlas_app;
GRANT UPDATE (location_id, status, operatory_resource_id, set_at, expires_at, version)
  ON cuspatlas.scheduling_staff_presence TO cuspatlas_app;
