-- S15 waitlist and PT-02 cancellation recovery (synthetic data only).
-- A waitlist entry creates no appointment and no occupancy. An offer is a short-lived hold (ADR 0009
-- S-D6, recommended-pending-approval) with an outcome; it never books without the explicit acceptance
-- command, which books through the S10 insert path. A cancelled future booking opens a recovery
-- record; offers made for it are prepared for approval by default, or executed by a service principal
-- only under an explicit, revocable standing policy that is rechecked at execution and recorded.

-- Per-location offer policy (hold duration). No write command until practice configuration exists:
-- a location without a row cannot be offered.
CREATE TABLE cuspatlas.scheduling_offer_policies (
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  policy_ref text NOT NULL CHECK (policy_ref ~ '^[a-z0-9-]{1,64}$'),
  offer_ttl_minutes integer NOT NULL CHECK (offer_ttl_minutes BETWEEN 1 AND 1440),
  PRIMARY KEY (tenant_id, location_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id)
);

CREATE TABLE cuspatlas.waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  location_id uuid NOT NULL,
  appointment_type_code text CHECK (appointment_type_code ~ '^[a-z0-9_-]{1,40}$'),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  provider_preference_id uuid,
  desired_from timestamptz NOT NULL,
  desired_until timestamptz NOT NULL,
  priority integer NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  -- The patient's stated channel preference, recorded only; whether contact is allowed is E6's.
  requested_channel text NOT NULL DEFAULT 'none' CHECK (requested_channel IN ('none', 'sms', 'email', 'voice', 'portal')),
  expires_at timestamptz,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'offered', 'booked', 'removed')),
  state_reason text CHECK (state_reason ~ '^[a-z_]{1,64}$'),
  appointment_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  FOREIGN KEY (provider_preference_id, tenant_id) REFERENCES cuspatlas.scheduling_resources (id, tenant_id),
  CHECK (desired_from < desired_until),
  CHECK ((state = 'booked') = (appointment_id IS NOT NULL)),
  CHECK ((state = 'removed') = (state_reason IS NOT NULL)),
  UNIQUE (id, tenant_id)
);
CREATE INDEX waitlist_entries_location ON cuspatlas.waitlist_entries (tenant_id, location_id, state, priority);

CREATE TABLE cuspatlas.cancellation_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  location_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  provider_id uuid NOT NULL,
  operatory_id uuid,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'filled', 'closed')),
  filled_appointment_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES cuspatlas.appointments (id, tenant_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  CHECK ((state = 'filled') = (filled_appointment_id IS NOT NULL)),
  UNIQUE (tenant_id, appointment_id),
  UNIQUE (id, tenant_id)
);

-- Standing policy for policy-authorized execution (proposed shared contract; A owns registration).
CREATE TABLE cuspatlas.scheduling_standing_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('scheduling.recovery.execute')),
  owner_principal_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  grantee_principal_id uuid NOT NULL,
  location_refs text[] NOT NULL CHECK (cardinality(location_refs) BETWEEN 1 AND 20),
  max_offers_per_recovery integer NOT NULL CHECK (max_offers_per_recovery BETWEEN 1 AND 3),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES cuspatlas.principals (id),
  revoke_reason text CHECK (revoke_reason ~ '^[a-z_]{1,64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL AND revoke_reason IS NULL)),
  UNIQUE (id, tenant_id)
);

CREATE TABLE cuspatlas.waitlist_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  hold_id uuid NOT NULL,
  recovery_id uuid,
  location_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  provider_id uuid NOT NULL,
  operatory_id uuid,
  no_operatory_reason text CHECK (no_operatory_reason IN ('no_show', 'cancelled', 'not_yet_assigned', 'off_site')),
  expires_at timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('accepted', 'declined', 'expired', 'withdrawn')),
  outcome_reason text CHECK (outcome_reason ~ '^[a-z_]{1,64}$'),
  appointment_id uuid,
  standing_policy_id uuid,
  standing_policy_version integer,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  decided_by uuid REFERENCES cuspatlas.principals (id),
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (entry_id, tenant_id) REFERENCES cuspatlas.waitlist_entries (id, tenant_id),
  FOREIGN KEY (hold_id, tenant_id) REFERENCES cuspatlas.scheduling_holds (id, tenant_id),
  FOREIGN KEY (recovery_id, tenant_id) REFERENCES cuspatlas.cancellation_recoveries (id, tenant_id),
  FOREIGN KEY (standing_policy_id, tenant_id) REFERENCES cuspatlas.scheduling_standing_policies (id, tenant_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  CHECK ((outcome = 'accepted') = (appointment_id IS NOT NULL)),
  CHECK ((outcome IS NULL) = (decided_at IS NULL)),
  CHECK ((standing_policy_id IS NULL) = (standing_policy_version IS NULL)),
  UNIQUE (tenant_id, hold_id)
);
-- One live offer per entry; one live offer per held slot is the hold's occupancy constraint.
CREATE UNIQUE INDEX waitlist_offers_one_live ON cuspatlas.waitlist_offers (tenant_id, entry_id) WHERE outcome IS NULL;
CREATE INDEX waitlist_offers_recovery ON cuspatlas.waitlist_offers (tenant_id, recovery_id);

-- An offer outcome is recorded once; the binding (entry, hold, window, policy) never changes.
CREATE FUNCTION cuspatlas.waitlist_offers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'offers are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.outcome IS NOT NULL
     OR (NEW.id, NEW.tenant_id, NEW.entry_id, NEW.hold_id, NEW.recovery_id, NEW.starts_at, NEW.ends_at, NEW.provider_id,
         NEW.operatory_id, NEW.expires_at, NEW.standing_policy_id, NEW.standing_policy_version, NEW.created_by,
         NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.tenant_id, OLD.entry_id, OLD.hold_id, OLD.recovery_id, OLD.starts_at, OLD.ends_at, OLD.provider_id,
         OLD.operatory_id, OLD.expires_at, OLD.standing_policy_id, OLD.standing_policy_version, OLD.created_by,
         OLD.created_at) THEN
    RAISE EXCEPTION 'offer change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waitlist_offers_guard BEFORE UPDATE OR DELETE ON cuspatlas.waitlist_offers
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.waitlist_offers_guard();

-- A standing policy is revoked once; its grant (owner, grantee, operation, scope, limits, expiry) is immutable.
CREATE FUNCTION cuspatlas.scheduling_standing_policies_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'standing policies are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     OR (NEW.id, NEW.tenant_id, NEW.operation, NEW.owner_principal_id, NEW.grantee_principal_id, NEW.location_refs,
         NEW.max_offers_per_recovery, NEW.expires_at, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.tenant_id, OLD.operation, OLD.owner_principal_id, OLD.grantee_principal_id, OLD.location_refs,
         OLD.max_offers_per_recovery, OLD.expires_at, OLD.created_at)
     OR NEW.revoked_by IS DISTINCT FROM cuspatlas.current_actor_id() THEN
    RAISE EXCEPTION 'standing policy change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scheduling_standing_policies_guard BEFORE UPDATE OR DELETE ON cuspatlas.scheduling_standing_policies
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.scheduling_standing_policies_guard();

ALTER TABLE cuspatlas.scheduling_offer_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_offer_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.waitlist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.waitlist_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.cancellation_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.cancellation_recoveries FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_standing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_standing_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.waitlist_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.waitlist_offers FORCE ROW LEVEL SECURITY;

CREATE POLICY scheduling_offer_policies_select ON cuspatlas.scheduling_offer_policies
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY waitlist_entries_select ON cuspatlas.waitlist_entries
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY waitlist_entries_insert ON cuspatlas.waitlist_entries
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY waitlist_entries_update ON cuspatlas.waitlist_entries
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY cancellation_recoveries_select ON cuspatlas.cancellation_recoveries
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY cancellation_recoveries_insert ON cuspatlas.cancellation_recoveries
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY cancellation_recoveries_update ON cuspatlas.cancellation_recoveries
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY scheduling_standing_policies_select ON cuspatlas.scheduling_standing_policies
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY scheduling_standing_policies_insert ON cuspatlas.scheduling_standing_policies
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND owner_principal_id = cuspatlas.current_actor_id());
CREATE POLICY scheduling_standing_policies_update ON cuspatlas.scheduling_standing_policies
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY waitlist_offers_select ON cuspatlas.waitlist_offers
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY waitlist_offers_insert ON cuspatlas.waitlist_offers
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY waitlist_offers_update ON cuspatlas.waitlist_offers
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT ON cuspatlas.scheduling_offer_policies TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.waitlist_entries TO cuspatlas_app;
GRANT UPDATE (subject_patient_id, state, state_reason, appointment_id, version, updated_at)
  ON cuspatlas.waitlist_entries TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.cancellation_recoveries TO cuspatlas_app;
GRANT UPDATE (state, filled_appointment_id, version, updated_at) ON cuspatlas.cancellation_recoveries TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.scheduling_standing_policies TO cuspatlas_app;
GRANT UPDATE (revoked_at, revoked_by, revoke_reason, version, updated_at)
  ON cuspatlas.scheduling_standing_policies TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.waitlist_offers TO cuspatlas_app;
GRANT UPDATE (outcome, outcome_reason, appointment_id, decided_by, decided_at, version, updated_at)
  ON cuspatlas.waitlist_offers TO cuspatlas_app;
