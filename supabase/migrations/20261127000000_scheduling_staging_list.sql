-- S20 (OR-05, OR-D2 accepted 2026-11-04): bounded per-location staging list for appointments being
-- moved. Synthetic data only. An entry references a booked appointment (which keeps its booking and
-- occupancy until it is rebooked through the S10 reschedule or explicitly cancelled) or an appointment
-- request. Staging is not an appointment state and touches no occupancy row. The list row carries the
-- configurable capacity (default 10) and is locked by every add, so the capacity check is serialized.
-- No patient reference is stored here (patients are reached through the appointment or request).

CREATE TABLE cuspatlas.scheduling_staging_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  capacity integer NOT NULL DEFAULT 10 CHECK (capacity BETWEEN 1 AND 100),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  UNIQUE (tenant_id, location_id),
  UNIQUE (id, tenant_id)
);

CREATE TABLE cuspatlas.scheduling_staging_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  list_id uuid NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('appointment', 'request')),
  appointment_id uuid,
  request_id uuid,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  state text NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'moved', 'removed')),
  removal_reason text CHECK (removal_reason ~ '^[a-z_]{1,64}$'),
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (list_id, tenant_id) REFERENCES cuspatlas.scheduling_staging_lists (id, tenant_id),
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES cuspatlas.appointments (id, tenant_id),
  FOREIGN KEY (request_id, tenant_id) REFERENCES cuspatlas.appointment_requests (id, tenant_id),
  CHECK ((subject_kind = 'appointment') = (appointment_id IS NOT NULL AND request_id IS NULL)),
  CHECK ((subject_kind = 'request') = (request_id IS NOT NULL AND appointment_id IS NULL)),
  CHECK ((state = 'staged') = (resolved_at IS NULL)),
  CHECK ((state = 'removed') = (removal_reason IS NOT NULL))
);
-- One staged entry per appointment and per request.
CREATE UNIQUE INDEX scheduling_staging_one_appointment ON cuspatlas.scheduling_staging_entries (tenant_id, appointment_id)
  WHERE state = 'staged' AND appointment_id IS NOT NULL;
CREATE UNIQUE INDEX scheduling_staging_one_request ON cuspatlas.scheduling_staging_entries (tenant_id, request_id)
  WHERE state = 'staged' AND request_id IS NOT NULL;
CREATE INDEX scheduling_staging_entries_list ON cuspatlas.scheduling_staging_entries (tenant_id, list_id, state);

-- An entry only moves forward (staged -> moved | removed), never back; its subject never changes.
CREATE FUNCTION cuspatlas.scheduling_staging_entries_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'staging entry version must increase by one' USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'staged' THEN
    RAISE EXCEPTION 'a resolved staging entry is final' USING ERRCODE = '42501';
  END IF;
  IF (NEW.list_id, NEW.subject_kind, NEW.appointment_id, NEW.request_id, NEW.reason_code, NEW.created_by,
      NEW.created_at) IS DISTINCT FROM
     (OLD.list_id, OLD.subject_kind, OLD.appointment_id, OLD.request_id, OLD.reason_code, OLD.created_by,
      OLD.created_at) THEN
    RAISE EXCEPTION 'a staging entry subject is never rewritten' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cuspatlas.scheduling_staging_entries_guard() FROM PUBLIC;
CREATE TRIGGER scheduling_staging_entries_guard BEFORE UPDATE ON cuspatlas.scheduling_staging_entries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.scheduling_staging_entries_guard();
CREATE TRIGGER scheduling_staging_entries_no_delete BEFORE DELETE ON cuspatlas.scheduling_staging_entries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER scheduling_staging_lists_no_delete BEFORE DELETE ON cuspatlas.scheduling_staging_lists
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.scheduling_staging_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_staging_lists FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_staging_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_staging_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY scheduling_staging_lists_select ON cuspatlas.scheduling_staging_lists
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY scheduling_staging_lists_insert ON cuspatlas.scheduling_staging_lists
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY scheduling_staging_lists_update ON cuspatlas.scheduling_staging_lists
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY scheduling_staging_entries_select ON cuspatlas.scheduling_staging_entries
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY scheduling_staging_entries_insert ON cuspatlas.scheduling_staging_entries
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY scheduling_staging_entries_update ON cuspatlas.scheduling_staging_entries
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.scheduling_staging_lists, cuspatlas.scheduling_staging_entries TO cuspatlas_app;
GRANT UPDATE (capacity, version, updated_at) ON cuspatlas.scheduling_staging_lists TO cuspatlas_app;
GRANT UPDATE (state, removal_reason, resolved_at, version, updated_at)
  ON cuspatlas.scheduling_staging_entries TO cuspatlas_app;
