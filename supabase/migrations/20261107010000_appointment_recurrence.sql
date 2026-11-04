-- S13: recurrence series with a deliberate cap (ADR 0009 S-D1, recommended-pending-approval).
-- Synthetic data only. A series records its pattern and state; every occurrence is a real booking in
-- cuspatlas.appointments made through the S10 insert path, so it is versioned, rescheduled and
-- cancelled on its own. Occurrence and exception rows are append-only facts.

-- Per-tenant occurrence limit of one request (default 26, configuration ceiling 52). Read-only for
-- the runtime role; changing it never touches an existing series.
ALTER TABLE cuspatlas.scheduling_policy_settings
  ADD COLUMN series_occurrence_limit integer NOT NULL DEFAULT 26 CHECK (series_occurrence_limit BETWEEN 1 AND 52);

CREATE TABLE cuspatlas.appointment_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  location_id uuid NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  interval_count integer NOT NULL CHECK (interval_count BETWEEN 1 AND 12),
  -- Local wall-clock anchor in the location's zone (S-S3-R1/R2 apply when occurrences are computed).
  first_date date NOT NULL,
  start_minutes integer NOT NULL CHECK (start_minutes BETWEEN 0 AND 1439),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  time_zone text NOT NULL,
  provider_id uuid NOT NULL,
  operatory_id uuid,
  no_operatory_reason text CHECK (no_operatory_reason IN ('no_show', 'cancelled', 'not_yet_assigned', 'off_site')),
  additional_resource_ids uuid[] NOT NULL DEFAULT '{}',
  appointment_type_code text CHECK (appointment_type_code ~ '^[a-z0-9_-]{1,40}$'),
  -- The limit in force when the series was created (configuration changes affect new requests only).
  limit_at_creation integer NOT NULL CHECK (limit_at_creation BETWEEN 1 AND 52),
  occurrence_count integer NOT NULL CHECK (occurrence_count >= 1),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'ended')),
  end_reason text CHECK (end_reason ~ '^[a-z_]{1,64}$'),
  ended_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  FOREIGN KEY (provider_id, tenant_id) REFERENCES cuspatlas.scheduling_resources (id, tenant_id),
  FOREIGN KEY (operatory_id, tenant_id) REFERENCES cuspatlas.scheduling_resources (id, tenant_id),
  CHECK ((operatory_id IS NULL) = (no_operatory_reason IS NOT NULL)),
  CHECK ((state = 'ended') = (end_reason IS NOT NULL AND ended_at IS NOT NULL)),
  UNIQUE (id, tenant_id)
);

CREATE TABLE cuspatlas.appointment_series_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  series_id uuid NOT NULL,
  occurrence_index integer NOT NULL CHECK (occurrence_index >= 1),
  local_date date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('booked', 'skipped')),
  appointment_id uuid,
  skip_reason text CHECK (skip_reason ~ '^[a-z_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (series_id, tenant_id) REFERENCES cuspatlas.appointment_series (id, tenant_id),
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES cuspatlas.appointments (id, tenant_id),
  CHECK ((outcome = 'booked') = (appointment_id IS NOT NULL)),
  CHECK ((outcome = 'skipped') = (skip_reason IS NOT NULL)),
  UNIQUE (tenant_id, series_id, occurrence_index),
  UNIQUE (tenant_id, appointment_id)
);

CREATE TABLE cuspatlas.appointment_series_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  series_id uuid NOT NULL,
  occurrence_index integer NOT NULL CHECK (occurrence_index >= 1),
  appointment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cancelled', 'rescheduled')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (series_id, tenant_id) REFERENCES cuspatlas.appointment_series (id, tenant_id),
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES cuspatlas.appointments (id, tenant_id)
);
CREATE INDEX appointment_series_exceptions_series ON cuspatlas.appointment_series_exceptions (tenant_id, series_id);

CREATE TRIGGER appointment_series_occurrences_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.appointment_series_occurrences
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER appointment_series_exceptions_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.appointment_series_exceptions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- A series is ended once (never deleted); the pattern and anchor never change.
CREATE FUNCTION cuspatlas.appointment_series_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'series are never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.location_id, NEW.frequency, NEW.interval_count, NEW.first_date, NEW.start_minutes,
      NEW.duration_minutes, NEW.time_zone, NEW.limit_at_creation, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.location_id, OLD.frequency, OLD.interval_count, OLD.first_date, OLD.start_minutes,
      OLD.duration_minutes, OLD.time_zone, OLD.limit_at_creation, OLD.created_by, OLD.created_at)
     OR (OLD.state = 'ended' AND NEW.state <> 'ended')
     OR NEW.occurrence_count < OLD.occurrence_count THEN
    RAISE EXCEPTION 'series change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER appointment_series_guard BEFORE UPDATE OR DELETE ON cuspatlas.appointment_series
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.appointment_series_guard();

ALTER TABLE cuspatlas.appointment_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_series FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_series_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_series_occurrences FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_series_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_series_exceptions FORCE ROW LEVEL SECURITY;

CREATE POLICY appointment_series_select ON cuspatlas.appointment_series
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY appointment_series_insert ON cuspatlas.appointment_series
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY appointment_series_update ON cuspatlas.appointment_series
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY appointment_series_occurrences_select ON cuspatlas.appointment_series_occurrences
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY appointment_series_occurrences_insert ON cuspatlas.appointment_series_occurrences
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY appointment_series_exceptions_select ON cuspatlas.appointment_series_exceptions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY appointment_series_exceptions_insert ON cuspatlas.appointment_series_exceptions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.appointment_series TO cuspatlas_app;
GRANT UPDATE (subject_patient_id, occurrence_count, state, end_reason, ended_at, version, updated_at)
  ON cuspatlas.appointment_series TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.appointment_series_occurrences TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.appointment_series_exceptions TO cuspatlas_app;
