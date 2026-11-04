-- C17: referral records (synthetic data only; C-D10 recommended option: record-keeping plus
-- print/export only, with an explicit share record for any cross-practice disclosure, until C-S4
-- verifies an exchange channel). Incoming and outgoing referrals; the package is an explicit, recorded
-- selection of record references (no content copied); a share record names purpose, scope (record
-- kinds) and expiry; responses carry their source; every lifecycle step is an append-only event. Never
-- deleted. A referral follows its patient through merges (class clinicalReferral).

-- Practice configuration: which consent template counts as the disclosure consent an outgoing
-- referral needs. No row: outgoing referrals are refused (fail closed; no command yet).
CREATE TABLE cuspatlas.clinical_referral_policies (
  tenant_id uuid PRIMARY KEY,
  disclosure_consent_template_ref text NOT NULL CHECK (disclosure_consent_template_ref ~ '^[A-Za-z0-9._:-]{1,128}$')
);

CREATE TABLE cuspatlas.clinical_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  origin_patient_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  counterparty_ref text NOT NULL CHECK (counterparty_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  requested_scope text NOT NULL CHECK (requested_scope ~ '^[a-z_]{1,64}$'),
  consent_id uuid,
  response_due_date date,
  possible_duplicate_of_id uuid,
  state text NOT NULL CHECK (state IN ('prepared', 'received', 'sent', 'responded', 'closed', 'cancelled')),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_by_role text NOT NULL CHECK (created_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  created_by_credential_ref text CHECK (created_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (origin_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (consent_id, tenant_id) REFERENCES cuspatlas.clinical_consents (id, tenant_id),
  FOREIGN KEY (possible_duplicate_of_id, tenant_id) REFERENCES cuspatlas.clinical_referrals (id, tenant_id),
  UNIQUE (id, tenant_id),
  -- An outgoing referral is a disclosure and names its consent; an incoming one starts received.
  CHECK ((direction = 'outgoing') = (consent_id IS NOT NULL))
);
CREATE INDEX clinical_referrals_subject ON cuspatlas.clinical_referrals (tenant_id, subject_patient_id);

CREATE TABLE cuspatlas.clinical_referral_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  referral_id uuid NOT NULL,
  record_kind text NOT NULL CHECK (record_kind IN ('renderedProcedure', 'chartEntry', 'note', 'historyVersion',
    'perioExam', 'planVersion', 'imageLink', 'labCase')),
  record_ref uuid NOT NULL,
  selected_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  selected_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (referral_id, tenant_id) REFERENCES cuspatlas.clinical_referrals (id, tenant_id),
  UNIQUE (referral_id, record_kind, record_ref)
);

CREATE TABLE cuspatlas.clinical_referral_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  referral_id uuid NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[a-z_]{1,64}$'),
  scope text[] NOT NULL CHECK (cardinality(scope) BETWEEN 1 AND 8 AND scope <@ ARRAY['renderedProcedure', 'chartEntry',
    'note', 'historyVersion', 'perioExam', 'planVersion', 'imageLink', 'labCase']::text[]),
  expires_at timestamptz NOT NULL,
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (referral_id, tenant_id) REFERENCES cuspatlas.clinical_referrals (id, tenant_id),
  UNIQUE (id, tenant_id),
  CHECK (expires_at > recorded_at)
);

CREATE TABLE cuspatlas.clinical_referral_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  referral_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  kind text NOT NULL CHECK (kind IN ('created', 'package_prepared', 'share_recorded', 'sent', 'transmission_failed',
    'response_recorded', 'closed', 'cancelled', 'recalled')),
  from_state text CHECK (from_state IN ('prepared', 'received', 'sent', 'responded', 'closed', 'cancelled')),
  to_state text NOT NULL CHECK (to_state IN ('prepared', 'received', 'sent', 'responded', 'closed', 'cancelled')),
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  error_code text CHECK (error_code ~ '^[a-z_]{1,64}$'),
  channel text CHECK (channel IN ('print', 'export')),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  actor_role text NOT NULL CHECK (actor_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  actor_credential_ref text CHECK (actor_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (referral_id, tenant_id) REFERENCES cuspatlas.clinical_referrals (id, tenant_id),
  UNIQUE (referral_id, sequence),
  CHECK ((sequence = 1) = (kind = 'created')),
  CHECK ((kind = 'created') = (from_state IS NULL)),
  CHECK ((kind = 'sent') = (channel IS NOT NULL)),
  CHECK ((kind = 'transmission_failed') = (error_code IS NOT NULL)),
  CHECK (kind NOT IN ('closed', 'cancelled', 'recalled') OR reason_code IS NOT NULL)
);

CREATE TABLE cuspatlas.clinical_referral_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  referral_id uuid NOT NULL,
  source_ref text NOT NULL CHECK (source_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  received_date date NOT NULL,
  document_refs text[] NOT NULL DEFAULT '{}' CHECK (cardinality(document_refs) <= 20),
  attribution text NOT NULL CHECK (attribution IN ('external_source', 'this_practice')),
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (referral_id, tenant_id) REFERENCES cuspatlas.clinical_referrals (id, tenant_id)
);

-- The lifecycle: each event is the next of its referral, from its current state, by an allowed step.
CREATE FUNCTION cuspatlas.referral_step_allowed(kind text, from_state text, to_state text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT (kind, from_state, to_state) IN (
      ('package_prepared', 'prepared', 'prepared'), ('share_recorded', 'prepared', 'prepared'),
      ('share_recorded', 'sent', 'sent'), ('transmission_failed', 'prepared', 'prepared'), ('sent', 'prepared', 'sent'),
      ('response_recorded', 'sent', 'responded'), ('response_recorded', 'received', 'responded'),
      ('closed', 'sent', 'closed'), ('closed', 'responded', 'closed'), ('closed', 'received', 'closed'),
      ('cancelled', 'prepared', 'cancelled'), ('cancelled', 'received', 'cancelled'), ('recalled', 'sent', 'cancelled'))
  $$;
GRANT EXECUTE ON FUNCTION cuspatlas.referral_step_allowed(text, text, text) TO cuspatlas_app;

CREATE FUNCTION cuspatlas.clinical_referral_events_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    last record;
  BEGIN
    SELECT e.sequence, e.to_state INTO last FROM cuspatlas.clinical_referral_events e
     WHERE e.referral_id = NEW.referral_id AND e.tenant_id = NEW.tenant_id ORDER BY e.sequence DESC LIMIT 1;
    IF (last IS NULL AND NEW.sequence <> 1)
       OR (last IS NOT NULL AND (NEW.sequence <> last.sequence + 1 OR NEW.from_state IS DISTINCT FROM last.to_state
                                 OR NOT cuspatlas.referral_step_allowed(NEW.kind, NEW.from_state, NEW.to_state)))
       OR (current_user = 'cuspatlas_app' AND NEW.actor_id IS DISTINCT FROM cuspatlas.current_actor_id()) THEN
      RAISE EXCEPTION 'a referral event is the next allowed step of its referral' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_referral_events_guard() FROM PUBLIC;
CREATE TRIGGER clinical_referral_events_insert BEFORE INSERT ON cuspatlas.clinical_referral_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_referral_events_guard();
CREATE TRIGGER clinical_referral_events_author BEFORE INSERT ON cuspatlas.clinical_referral_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard('actor_id', 'actor_role', 'actor_credential_ref');
CREATE TRIGGER clinical_referrals_author BEFORE INSERT ON cuspatlas.clinical_referrals
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'created_by', 'created_by_role', 'created_by_credential_ref');
CREATE TRIGGER clinical_referral_events_append_only BEFORE UPDATE OR DELETE ON cuspatlas.clinical_referral_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_referral_selections_append_only BEFORE UPDATE OR DELETE ON cuspatlas.clinical_referral_selections
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_referral_shares_append_only BEFORE UPDATE OR DELETE ON cuspatlas.clinical_referral_shares
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_referral_responses_append_only BEFORE UPDATE OR DELETE ON cuspatlas.clinical_referral_responses
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_referral_shares_human BEFORE INSERT ON cuspatlas.clinical_referral_shares
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.human_actor_guard('recorded_by');
CREATE TRIGGER clinical_referral_selections_human BEFORE INSERT ON cuspatlas.clinical_referral_selections
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.human_actor_guard('selected_by');
CREATE TRIGGER clinical_referral_responses_human BEFORE INSERT ON cuspatlas.clinical_referral_responses
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.human_actor_guard('recorded_by');

-- Identity, direction, counterparty, reason, scope and consent never change; only the state, the
-- merge reference and bookkeeping move.
CREATE FUNCTION cuspatlas.clinical_referrals_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'referrals are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['subject_patient_id', 'state', 'version', 'updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['subject_patient_id', 'state', 'version', 'updated_at'])
       OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'a referral changes only by its lifecycle' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_referrals_guard() FROM PUBLIC;
CREATE TRIGGER clinical_referrals_guard BEFORE UPDATE OR DELETE ON cuspatlas.clinical_referrals
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_referrals_guard();

-- At commit a referral's state is its latest event, and a sent event has a package and a live share
-- covering every selected kind (the database's own check of C-D10).
CREATE FUNCTION cuspatlas.clinical_referrals_state_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    last record;
  BEGIN
    IF current_user <> 'cuspatlas_app' THEN
      RETURN NULL;
    END IF;
    SELECT e.kind, e.to_state, e.at INTO last FROM cuspatlas.clinical_referral_events e
     WHERE e.referral_id = NEW.id AND e.tenant_id = NEW.tenant_id ORDER BY e.sequence DESC LIMIT 1;
    IF NEW.state IS DISTINCT FROM last.to_state
       OR (last.kind = 'sent' AND (
            NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_referral_selections s WHERE s.referral_id = NEW.id)
            OR NOT EXISTS (
              SELECT 1 FROM cuspatlas.clinical_referral_shares sh WHERE sh.referral_id = NEW.id AND sh.expires_at > last.at
                AND NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_referral_selections s WHERE s.referral_id = NEW.id
                                AND NOT (s.record_kind = ANY (sh.scope)))))) THEN
      RAISE EXCEPTION 'a referral state is its latest event; a sent referral has a covering share' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_referrals_state_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER clinical_referrals_state
  AFTER INSERT OR UPDATE ON cuspatlas.clinical_referrals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_referrals_state_guard();

-- Merge: class clinicalReferral (relink guard, observation, registry mirror).
CREATE CONSTRAINT TRIGGER clinical_referrals_relink
  AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_referrals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_subject_relink_guard();
CREATE TRIGGER clinical_referrals_observe_subject AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_referrals
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('subject_patient_id');
CREATE OR REPLACE FUNCTION cuspatlas.merge_class_table(record_class text) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE record_class
      WHEN 'patientRelationship' THEN 'patient_relationships'
      WHEN 'appointmentRequest' THEN 'appointment_requests'
      WHEN 'appointment' THEN 'appointments'
      WHEN 'appointmentSeries' THEN 'appointment_series'
      WHEN 'waitlistEntry' THEN 'waitlist_entries'
      WHEN 'clinicalEncounter' THEN 'clinical_encounters'
      WHEN 'clinicalHistoryStream' THEN 'clinical_history_streams'
      WHEN 'clinicalChart' THEN 'clinical_charts'
      WHEN 'clinicalPerioStream' THEN 'clinical_perio_streams'
      WHEN 'clinicalTreatmentPlan' THEN 'clinical_treatment_plans'
      WHEN 'clinicalConsent' THEN 'clinical_consents'
      WHEN 'clinicalLabCase' THEN 'clinical_lab_cases'
      WHEN 'clinicalReferral' THEN 'clinical_referrals'
    END
  $$;
CREATE OR REPLACE FUNCTION cuspatlas.merge_class_digest_exclude(record_class text) RETURNS text[]
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE record_class
      WHEN 'patientRelationship' THEN ARRAY['subject_patient_id', 'counterparty_patient_id', 'revoked_at', 'revoked_by',
        'revoke_reason', 'version', 'updated_at']
      WHEN 'appointmentRequest' THEN ARRAY['subject_patient_id', 'provider_preference_id', 'preferred_windows',
        'flexibility', 'urgent', 'contact_consent', 'note', 'state', 'state_reason', 'appointment_id',
        'expiry_policy_ref', 'closed_at', 'version', 'updated_at']
      WHEN 'appointment' THEN ARRAY['subject_patient_id', 'status', 'cancel_reason', 'cancelled_at', 'rescheduled_to_id',
        'request_id', 'version', 'updated_at']
      WHEN 'appointmentSeries' THEN ARRAY['subject_patient_id', 'occurrence_count', 'state', 'end_reason', 'ended_at',
        'version', 'updated_at']
      WHEN 'waitlistEntry' THEN ARRAY['subject_patient_id', 'state', 'state_reason', 'appointment_id', 'version',
        'updated_at']
      WHEN 'clinicalEncounter' THEN ARRAY['subject_patient_id', 'state', 'disposition_code', 'closed_by', 'closed_by_role',
        'closed_by_credential_ref', 'closed_at', 'version', 'updated_at']
      WHEN 'clinicalHistoryStream' THEN ARRAY['subject_patient_id', 'head_sequence', 'version', 'updated_at']
      WHEN 'clinicalChart' THEN ARRAY['subject_patient_id', 'head_sequence', 'version', 'updated_at']
      WHEN 'clinicalPerioStream' THEN ARRAY['subject_patient_id', 'head_sequence', 'version', 'updated_at']
      WHEN 'clinicalTreatmentPlan' THEN ARRAY['subject_patient_id', 'head_version', 'version', 'updated_at']
      WHEN 'clinicalConsent' THEN ARRAY['subject_patient_id', 'version', 'updated_at']
      WHEN 'clinicalLabCase' THEN ARRAY['subject_patient_id', 'state', 'received_date', 'no_attachment_reason', 'version',
        'updated_at']
      WHEN 'clinicalReferral' THEN ARRAY['subject_patient_id', 'state', 'version', 'updated_at']
    END
  $$;

ALTER TABLE cuspatlas.clinical_referral_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_referral_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_referrals FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_referral_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_referral_selections FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_referral_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_referral_shares FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_referral_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_referral_events FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_referral_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_referral_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY clinical_referral_policies_select ON cuspatlas.clinical_referral_policies
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_referrals_select ON cuspatlas.clinical_referrals
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_referrals_insert ON cuspatlas.clinical_referrals
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_referrals_update ON cuspatlas.clinical_referrals
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_referral_selections_select ON cuspatlas.clinical_referral_selections
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_referral_selections_insert ON cuspatlas.clinical_referral_selections
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_referral_shares_select ON cuspatlas.clinical_referral_shares
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_referral_shares_insert ON cuspatlas.clinical_referral_shares
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_referral_events_select ON cuspatlas.clinical_referral_events
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_referral_events_insert ON cuspatlas.clinical_referral_events
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_referral_responses_select ON cuspatlas.clinical_referral_responses
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_referral_responses_insert ON cuspatlas.clinical_referral_responses
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
GRANT SELECT ON cuspatlas.clinical_referral_policies TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.clinical_referrals, cuspatlas.clinical_referral_selections,
  cuspatlas.clinical_referral_shares, cuspatlas.clinical_referral_events, cuspatlas.clinical_referral_responses
  TO cuspatlas_app;
GRANT UPDATE (subject_patient_id, state, version, updated_at) ON cuspatlas.clinical_referrals TO cuspatlas_app;
