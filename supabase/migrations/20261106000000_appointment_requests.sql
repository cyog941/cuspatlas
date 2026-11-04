-- S8: the appointment request is its own fact (synthetic data only). A request records what was
-- asked for; it holds no resource, writes no occupancy and blocks no slot. It reaches `scheduled`
-- only through a booking link (S10). Tenant and actor come from the transaction-local context; RLS
-- is enabled and forced; the runtime role has no DELETE anywhere.

-- Per-tenant scheduling policy settings (ADR 0009, recommended-pending-approval). Runtime role reads
-- only; no write command exists until practice configuration is built. Absent row = defaults.
CREATE TABLE cuspatlas.scheduling_policy_settings (
  tenant_id uuid PRIMARY KEY REFERENCES cuspatlas.tenants (id),
  -- A request may be closed as `expired` only under this configured policy reference.
  request_expiry_policy_ref text CHECK (request_expiry_policy_ref ~ '^[a-z0-9-]{1,64}$'),
  -- S10: hold duration in minutes (S-D6 proposal for synthetic tests only: 15).
  hold_ttl_minutes integer NOT NULL DEFAULT 15 CHECK (hold_ttl_minutes BETWEEN 1 AND 1440),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cuspatlas.appointment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  location_id uuid NOT NULL,
  -- Who asked through which surface: staff now; the portal (E3) calls the same command later.
  origin text NOT NULL CHECK (origin IN ('staff', 'portal')),
  source_channel text NOT NULL
    CHECK (source_channel IN ('phone', 'walk_in', 'email', 'portal', 'referral', 'recall', 'other')),
  appointment_type_code text CHECK (appointment_type_code ~ '^[a-z0-9_-]{1,40}$'),
  provider_preference_id uuid,
  preferred_windows jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(preferred_windows) = 'array' AND jsonb_array_length(preferred_windows) <= 5),
  flexibility text CHECK (flexibility IN ('any_time', 'mornings', 'afternoons', 'evenings', 'weekdays', 'weekends')),
  -- Urgency is a flag, never a state.
  urgent boolean NOT NULL DEFAULT false,
  contact_consent text NOT NULL CHECK (contact_consent IN ('unknown', 'granted', 'declined')),
  note text CHECK (char_length(note) BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'in_review', 'scheduled', 'declined', 'expired', 'withdrawn')),
  state_reason text CHECK (state_reason ~ '^[a-z_]{1,64}$'),
  -- The booking this request became (S10 adds the foreign key with the appointment table).
  appointment_id uuid,
  expiry_policy_ref text CHECK (expiry_policy_ref ~ '^[a-z0-9-]{1,64}$'),
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  FOREIGN KEY (provider_preference_id, tenant_id) REFERENCES cuspatlas.scheduling_resources (id, tenant_id),
  UNIQUE (id, tenant_id),
  CHECK (jsonb_array_length(preferred_windows) > 0 OR flexibility IS NOT NULL),
  -- Scheduled exactly when linked; terminal states carry their closing instant.
  CHECK ((state = 'scheduled') = (appointment_id IS NOT NULL)),
  CHECK ((state IN ('scheduled', 'declined', 'expired', 'withdrawn')) = (closed_at IS NOT NULL)),
  CHECK ((state = 'expired') = (expiry_policy_ref IS NOT NULL))
);
CREATE INDEX appointment_requests_patient ON cuspatlas.appointment_requests (tenant_id, subject_patient_id);
CREATE INDEX appointment_requests_state ON cuspatlas.appointment_requests (tenant_id, location_id, state);

-- Append-only transition history: every state change with actor, instant and reason.
CREATE TABLE cuspatlas.appointment_request_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  from_state text CHECK (from_state IN ('open', 'in_review', 'scheduled', 'declined', 'expired', 'withdrawn')),
  to_state text NOT NULL CHECK (to_state IN ('open', 'in_review', 'scheduled', 'declined', 'expired', 'withdrawn')),
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  appointment_id uuid,
  request_version integer NOT NULL CHECK (request_version >= 1),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (request_id, tenant_id) REFERENCES cuspatlas.appointment_requests (id, tenant_id),
  UNIQUE (tenant_id, request_id, request_version)
);
CREATE TRIGGER appointment_request_transitions_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.appointment_request_transitions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- Identity, origin and creation never change; every update bumps the version by exactly one.
CREATE FUNCTION cuspatlas.appointment_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'request version must increase by one' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER appointment_requests_guard BEFORE UPDATE ON cuspatlas.appointment_requests
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.appointment_requests_guard();
REVOKE ALL ON FUNCTION cuspatlas.appointment_requests_guard() FROM PUBLIC;

ALTER TABLE cuspatlas.scheduling_policy_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_policy_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_request_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_request_transitions FORCE ROW LEVEL SECURITY;

CREATE POLICY scheduling_policy_settings_select ON cuspatlas.scheduling_policy_settings
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY appointment_requests_select ON cuspatlas.appointment_requests
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY appointment_requests_insert ON cuspatlas.appointment_requests
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY appointment_requests_update ON cuspatlas.appointment_requests
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY appointment_request_transitions_select ON cuspatlas.appointment_request_transitions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY appointment_request_transitions_insert ON cuspatlas.appointment_request_transitions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());

GRANT SELECT ON cuspatlas.scheduling_policy_settings TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.appointment_requests, cuspatlas.appointment_request_transitions TO cuspatlas_app;
-- Preferences, lifecycle and the merge relink column; never id, tenant, origin, creator or creation.
GRANT UPDATE (subject_patient_id, provider_preference_id, preferred_windows, flexibility, urgent, contact_consent,
  note, state, state_reason, appointment_id, expiry_policy_ref, closed_at, version, updated_at)
  ON cuspatlas.appointment_requests TO cuspatlas_app;
