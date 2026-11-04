-- C16: lab cases (synthetic data only; C-D9 recommended option: a configurable proposed state set with
-- print/export as the only channel until a lab partner is verified; no electronic ordering). A case
-- records the patient, the plan detail or item it serves, the S10 appointment, the lab as recorded
-- data, a case reference unique per lab, requested and expected return dates and attachment object
-- references (I stores attachments; no bytes here). Every transition is an append-only row with actor
-- and instant; a remake is a new case linked to the original. Overdue is derived, never a state.

-- Per-practice configuration of the proposed state set: a row with enabled = false switches a state
-- off; no row means enabled (runtime role reads only; no command yet).
CREATE TABLE cuspatlas.clinical_lab_case_state_config (
  tenant_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('sent', 'in_progress', 'received', 'seated', 'remake', 'cancelled')),
  enabled boolean NOT NULL,
  PRIMARY KEY (tenant_id, state)
);

CREATE TABLE cuspatlas.clinical_lab_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  origin_patient_id uuid NOT NULL,
  counterparty_ref text NOT NULL CHECK (counterparty_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  case_ref text NOT NULL CHECK (case_ref ~ '^[A-Za-z0-9._:-]{1,64}$'),
  plan_item_id uuid,
  plan_detail_id uuid,
  appointment_id uuid,
  requested_date date,
  expected_return_date date,
  received_date date,
  no_attachment_reason text CHECK (no_attachment_reason ~ '^[a-z_]{1,64}$'),
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'sent', 'in_progress', 'received', 'seated', 'remake', 'cancelled')),
  remake_of_id uuid,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_by_role text NOT NULL CHECK (created_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  created_by_credential_ref text CHECK (created_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (origin_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (plan_item_id, tenant_id) REFERENCES cuspatlas.clinical_plan_items (id, tenant_id),
  FOREIGN KEY (plan_detail_id, tenant_id) REFERENCES cuspatlas.clinical_plan_details (id, tenant_id),
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES cuspatlas.appointments (id, tenant_id),
  FOREIGN KEY (remake_of_id, tenant_id) REFERENCES cuspatlas.clinical_lab_cases (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, counterparty_ref, case_ref),
  UNIQUE (tenant_id, remake_of_id),
  CHECK (state NOT IN ('received', 'seated') OR received_date IS NOT NULL),
  CHECK (expected_return_date IS NULL OR requested_date IS NULL OR expected_return_date >= requested_date)
);
CREATE INDEX clinical_lab_cases_subject ON cuspatlas.clinical_lab_cases (tenant_id, subject_patient_id);

CREATE TABLE cuspatlas.clinical_lab_case_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  case_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  from_state text CHECK (from_state IN ('draft', 'sent', 'in_progress', 'received', 'seated', 'remake', 'cancelled')),
  to_state text NOT NULL CHECK (to_state IN ('draft', 'sent', 'in_progress', 'received', 'seated', 'remake', 'cancelled')),
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  actor_role text NOT NULL CHECK (actor_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  actor_credential_ref text CHECK (actor_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (case_id, tenant_id) REFERENCES cuspatlas.clinical_lab_cases (id, tenant_id),
  UNIQUE (case_id, sequence),
  CHECK ((sequence = 1) = (from_state IS NULL)),
  CHECK (sequence > 1 OR to_state = 'draft')
);

CREATE TABLE cuspatlas.clinical_lab_case_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  case_id uuid NOT NULL,
  attachment_ref text NOT NULL CHECK (attachment_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  added_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  added_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (case_id, tenant_id) REFERENCES cuspatlas.clinical_lab_cases (id, tenant_id),
  UNIQUE (case_id, attachment_ref)
);

-- The proposed transition set (C-D9 pending; recorded in the decisions file).
CREATE FUNCTION cuspatlas.lab_transition_allowed(from_state text, to_state text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT (from_state, to_state) IN (
      ('draft', 'sent'), ('draft', 'cancelled'), ('sent', 'in_progress'), ('sent', 'received'), ('sent', 'cancelled'),
      ('in_progress', 'received'), ('in_progress', 'cancelled'), ('received', 'seated'), ('received', 'remake'),
      ('seated', 'remake'))
  $$;
GRANT EXECUTE ON FUNCTION cuspatlas.lab_transition_allowed(text, text) TO cuspatlas_app;

-- A transition is the next one of its case, from the case's current state, by an allowed step.
CREATE FUNCTION cuspatlas.clinical_lab_case_transitions_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    last record;
  BEGIN
    SELECT t.sequence, t.to_state INTO last FROM cuspatlas.clinical_lab_case_transitions t
     WHERE t.case_id = NEW.case_id AND t.tenant_id = NEW.tenant_id ORDER BY t.sequence DESC LIMIT 1;
    IF (last IS NULL AND NEW.sequence <> 1)
       OR (last IS NOT NULL AND (NEW.sequence <> last.sequence + 1 OR NEW.from_state IS DISTINCT FROM last.to_state
                                 OR NOT cuspatlas.lab_transition_allowed(NEW.from_state, NEW.to_state)))
       OR (current_user = 'cuspatlas_app' AND NEW.actor_id IS DISTINCT FROM cuspatlas.current_actor_id()) THEN
      RAISE EXCEPTION 'a lab case transition is the next allowed step of its case' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_lab_case_transitions_guard() FROM PUBLIC;
CREATE TRIGGER clinical_lab_case_transitions_insert
  BEFORE INSERT ON cuspatlas.clinical_lab_case_transitions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_lab_case_transitions_guard();
CREATE TRIGGER clinical_lab_case_transitions_author
  BEFORE INSERT ON cuspatlas.clinical_lab_case_transitions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard('actor_id', 'actor_role', 'actor_credential_ref');
CREATE TRIGGER clinical_lab_case_transitions_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_lab_case_transitions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_lab_case_attachments_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_lab_case_attachments
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_lab_cases_author
  BEFORE INSERT ON cuspatlas.clinical_lab_cases
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'created_by', 'created_by_role', 'created_by_credential_ref');

-- A case's identity and links never change; only the lifecycle (state, return facts) and the merge
-- reference move. Return facts are set once. Never deleted.
CREATE FUNCTION cuspatlas.clinical_lab_cases_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'lab cases are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['subject_patient_id', 'state', 'received_date', 'no_attachment_reason', 'version',
                               'updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['subject_patient_id', 'state', 'received_date', 'no_attachment_reason',
                               'version', 'updated_at'])
       OR (OLD.received_date IS NOT NULL AND NEW.received_date IS DISTINCT FROM OLD.received_date)
       OR (OLD.no_attachment_reason IS NOT NULL AND NEW.no_attachment_reason IS DISTINCT FROM OLD.no_attachment_reason)
       OR NEW.version <> OLD.version + 1
       OR (NEW.state <> OLD.state AND NOT cuspatlas.lab_transition_allowed(OLD.state, NEW.state)) THEN
      RAISE EXCEPTION 'a lab case changes only by an allowed transition' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_lab_cases_guard() FROM PUBLIC;
CREATE TRIGGER clinical_lab_cases_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_lab_cases
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_lab_cases_guard();

-- At commit the case state is its latest transition (a state never moves without its transition row).
CREATE FUNCTION cuspatlas.clinical_lab_cases_state_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user = 'cuspatlas_app' AND NEW.state IS DISTINCT FROM (
         SELECT t.to_state FROM cuspatlas.clinical_lab_case_transitions t WHERE t.case_id = NEW.id
           AND t.tenant_id = NEW.tenant_id ORDER BY t.sequence DESC LIMIT 1) THEN
      RAISE EXCEPTION 'a lab case state is its latest transition' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_lab_cases_state_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER clinical_lab_cases_state
  AFTER INSERT OR UPDATE ON cuspatlas.clinical_lab_cases DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_lab_cases_state_guard();

-- Merge: a lab case follows its patient (merge class clinicalLabCase); the reference moves only with a
-- recorded merge or reversal, observed in its own transaction (20261109050000).
CREATE CONSTRAINT TRIGGER clinical_lab_cases_relink
  AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_lab_cases DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_subject_relink_guard();
CREATE TRIGGER clinical_lab_cases_observe_subject AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_lab_cases
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
    END
  $$;

ALTER TABLE cuspatlas.clinical_lab_case_state_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_lab_case_state_config FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_lab_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_lab_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_lab_case_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_lab_case_transitions FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_lab_case_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_lab_case_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY clinical_lab_case_state_config_select ON cuspatlas.clinical_lab_case_state_config
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_lab_cases_select ON cuspatlas.clinical_lab_cases
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_lab_cases_insert ON cuspatlas.clinical_lab_cases
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_lab_cases_update ON cuspatlas.clinical_lab_cases
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_lab_case_transitions_select ON cuspatlas.clinical_lab_case_transitions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_lab_case_transitions_insert ON cuspatlas.clinical_lab_case_transitions
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_lab_case_attachments_select ON cuspatlas.clinical_lab_case_attachments
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_lab_case_attachments_insert ON cuspatlas.clinical_lab_case_attachments
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND added_by = cuspatlas.current_actor_id());
GRANT SELECT ON cuspatlas.clinical_lab_case_state_config TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.clinical_lab_cases, cuspatlas.clinical_lab_case_transitions,
  cuspatlas.clinical_lab_case_attachments TO cuspatlas_app;
GRANT UPDATE (subject_patient_id, state, received_date, no_attachment_reason, version, updated_at)
  ON cuspatlas.clinical_lab_cases TO cuspatlas_app;
