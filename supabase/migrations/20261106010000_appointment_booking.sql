-- S10: holds, appointments (bookings) and their recorded lifecycle (synthetic data only). Overlap is
-- decided by the S7 exclusion constraint on scheduling_occupancy (source kinds hold and appointment
-- were reserved there); this migration adds the release path for occupancy rows. Cancellation and
-- rescheduling are recorded facts: nothing is deleted and the runtime role has no DELETE anywhere.

-- A short-lived reservation of resources (S-D6: an offer holds a slot). Occupancy rows of kind
-- `hold` carry it; an expired hold stops counting as busy at once (scheduling_busy below) and its
-- rows are released by the next booking that needs the range or by the reconciliation command.
CREATE TABLE cuspatlas.scheduling_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'converted', 'released')),
  release_reason text CHECK (release_reason ~ '^[a-z_]{1,64}$'),
  released_at timestamptz,
  appointment_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at AND ends_at - starts_at <= interval '8 hours'),
  CHECK ((state = 'released') = (released_at IS NOT NULL AND release_reason IS NOT NULL)),
  CHECK ((state = 'converted') = (appointment_id IS NOT NULL)),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  UNIQUE (id, tenant_id)
);
CREATE INDEX scheduling_holds_expiry ON cuspatlas.scheduling_holds (tenant_id, state, expires_at);

-- The booking. Patient identity, request, attendance, clinical completion and billing are separate
-- facts kept elsewhere; this row records only who is booked where and when, with which resources.
CREATE TABLE cuspatlas.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  location_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  -- IANA zone the booking was made for (display); instants are stored in UTC.
  time_zone text NOT NULL CHECK (char_length(time_zone) <= 64
    AND time_zone ~ '^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2})$'),
  provider_id uuid NOT NULL,
  -- Nullable by design: an appointment may hold no operatory, with a typed exception reason.
  operatory_id uuid,
  no_operatory_reason text CHECK (no_operatory_reason IN ('no_show', 'cancelled', 'not_yet_assigned', 'off_site')),
  appointment_type_code text CHECK (appointment_type_code ~ '^[a-z0-9_-]{1,40}$'),
  request_id uuid,
  hold_id uuid,
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled', 'rescheduled')),
  cancel_reason text CHECK (cancel_reason ~ '^[a-z_]{1,64}$'),
  cancelled_at timestamptz,
  rescheduled_from_id uuid,
  rescheduled_to_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at AND ends_at - starts_at <= interval '8 hours'),
  CHECK ((operatory_id IS NULL) = (no_operatory_reason IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  CHECK ((status = 'rescheduled') = (rescheduled_to_id IS NOT NULL)),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  FOREIGN KEY (provider_id, location_id, tenant_id) REFERENCES cuspatlas.scheduling_resources (id, location_id, tenant_id),
  FOREIGN KEY (operatory_id, location_id, tenant_id) REFERENCES cuspatlas.scheduling_resources (id, location_id, tenant_id),
  FOREIGN KEY (request_id, tenant_id) REFERENCES cuspatlas.appointment_requests (id, tenant_id),
  FOREIGN KEY (hold_id, tenant_id) REFERENCES cuspatlas.scheduling_holds (id, tenant_id),
  UNIQUE (id, tenant_id)
);
CREATE INDEX appointments_location_day ON cuspatlas.appointments (tenant_id, location_id, starts_at);
CREATE INDEX appointments_patient ON cuspatlas.appointments (tenant_id, subject_patient_id);

-- Back-links (request -> booking, hold -> booking, booking <-> its reschedule) are plain references
-- written by the domain in the same transaction as the forward link. They carry no foreign key on
-- purpose: a foreign-key cycle cannot be restored row by row with constraints active (the logical
-- restore loads parents before children). The forward keys above (request_id, hold_id) are enforced.

-- Authorized overrides: code, reason, actor and the conflict kinds overridden (append-only).
CREATE TABLE cuspatlas.appointment_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  override_code text NOT NULL CHECK (override_code IN ('provider_approved', 'practice_policy', 'emergency')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  overridden_kinds text[] NOT NULL CHECK (cardinality(overridden_kinds) BETWEEN 1 AND 7),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9.-]{1,64}$'),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES cuspatlas.appointments (id, tenant_id)
);

-- Booking lifecycle facts (append-only): booked, cancelled, rescheduled out/in, request linked.
CREATE TABLE cuspatlas.appointment_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('booked', 'cancelled', 'rescheduled_out', 'rescheduled_in', 'request_linked')),
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  related_appointment_id uuid,
  appointment_version integer NOT NULL CHECK (appointment_version >= 1),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES cuspatlas.appointments (id, tenant_id)
);
CREATE INDEX appointment_lifecycle_events_appointment ON cuspatlas.appointment_lifecycle_events (tenant_id, appointment_id);

CREATE TRIGGER appointment_overrides_append_only BEFORE UPDATE OR DELETE ON cuspatlas.appointment_overrides
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER appointment_lifecycle_events_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.appointment_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- A booking only moves forward: booked -> cancelled | rescheduled, never back; version +1 per update.
CREATE FUNCTION cuspatlas.appointments_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'appointment version must increase by one' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'booked' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'appointment status is final once cancelled or rescheduled' USING ERRCODE = '42501';
  END IF;
  IF OLD.request_id IS NOT NULL AND NEW.request_id IS DISTINCT FROM OLD.request_id THEN
    RAISE EXCEPTION 'a request link is never rewritten' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER appointments_guard BEFORE UPDATE ON cuspatlas.appointments
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.appointments_guard();

CREATE FUNCTION cuspatlas.scheduling_holds_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'hold version must increase by one' USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'active' THEN
    RAISE EXCEPTION 'a converted or released hold is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER scheduling_holds_guard BEFORE UPDATE ON cuspatlas.scheduling_holds
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.scheduling_holds_guard();

-- Occupancy rows are released once and never re-occupied or moved.
CREATE FUNCTION cuspatlas.scheduling_occupancy_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RAISE EXCEPTION 'occupancy is released exactly once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER scheduling_occupancy_guard BEFORE UPDATE ON cuspatlas.scheduling_occupancy
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.scheduling_occupancy_guard();

REVOKE ALL ON FUNCTION cuspatlas.appointments_guard(), cuspatlas.scheduling_holds_guard(),
  cuspatlas.scheduling_occupancy_guard() FROM PUBLIC;

-- The busy seam: unreleased occupancy, minus holds that have expired, plus location-wide blocks.
-- Search (S9), booking and holds (S10) read the same view, so they agree.
CREATE OR REPLACE VIEW cuspatlas.scheduling_busy WITH (security_invoker = true) AS
  SELECT o.tenant_id, o.location_id, o.resource_id, o.during, o.source_kind, o.source_id
  FROM cuspatlas.scheduling_occupancy o
  WHERE o.released_at IS NULL
    AND NOT (o.source_kind = 'hold' AND EXISTS (
      SELECT 1 FROM cuspatlas.scheduling_holds h
      WHERE h.id = o.source_id AND h.tenant_id = o.tenant_id AND h.expires_at <= now()))
  UNION ALL
  SELECT b.tenant_id, b.location_id, NULL::uuid, tstzrange(b.starts_at, b.ends_at, '[)'), 'time_block', b.id
  FROM cuspatlas.scheduling_time_blocks b WHERE b.resource_count = 0;

ALTER TABLE cuspatlas.scheduling_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_holds FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointments FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_lifecycle_events FORCE ROW LEVEL SECURITY;

CREATE POLICY scheduling_holds_select ON cuspatlas.scheduling_holds
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY scheduling_holds_insert ON cuspatlas.scheduling_holds
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY scheduling_holds_update ON cuspatlas.scheduling_holds
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY appointments_select ON cuspatlas.appointments
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY appointments_insert ON cuspatlas.appointments
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY appointments_update ON cuspatlas.appointments
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY appointment_overrides_select ON cuspatlas.appointment_overrides
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY appointment_overrides_insert ON cuspatlas.appointment_overrides
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());

CREATE POLICY appointment_lifecycle_events_select ON cuspatlas.appointment_lifecycle_events
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY appointment_lifecycle_events_insert ON cuspatlas.appointment_lifecycle_events
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());

-- Occupancy release (the column grant S7 deferred to this command).
CREATE POLICY scheduling_occupancy_update ON cuspatlas.scheduling_occupancy
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
GRANT UPDATE (released_at) ON cuspatlas.scheduling_occupancy TO cuspatlas_app;

GRANT SELECT, INSERT ON cuspatlas.scheduling_holds, cuspatlas.appointments, cuspatlas.appointment_overrides,
  cuspatlas.appointment_lifecycle_events TO cuspatlas_app;
GRANT UPDATE (state, release_reason, released_at, appointment_id, version, updated_at)
  ON cuspatlas.scheduling_holds TO cuspatlas_app;
-- Lifecycle, links and the merge relink column only: never the window, resources or creator.
GRANT UPDATE (subject_patient_id, status, cancel_reason, cancelled_at, rescheduled_to_id, request_id, version,
  updated_at) ON cuspatlas.appointments TO cuspatlas_app;
