-- E6: consent, opt-out, channel policy (with quiet hours), templates, the suppression decision and
-- recall enrollment. Synthetic data only. Consent and opt-out are append-only recorded facts with
-- source, channel, purpose, version and time; the latest fact for a channel and purpose wins and an
-- opt-out (purpose 'all') applies to every purpose of its channel until a later fact. The suppression
-- decision is recorded once per evaluation with exactly one reason from the single SuppressionReason
-- vocabulary. Defaults stay off: without a channel policy every intent is suppressed (policy_off).
-- Every rule here is recommended-pending-approval (legal and compliance review not yet available).

CREATE TABLE cuspatlas.communication_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  patient_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('portal', 'email', 'sms', 'voice')),
  purpose text NOT NULL CHECK (purpose IN ('reminders', 'recall', 'messaging', 'treatment', 'all')),
  state text NOT NULL CHECK (state IN ('granted', 'denied', 'opted_out')),
  source text NOT NULL CHECK (source IN ('staff_recorded', 'written_form', 'patient_reported', 'provider_stop_reply',
    'patient_portal', 'guardian_portal')),
  consent_version text NOT NULL CHECK (consent_version ~ '^[a-z0-9.-]{1,32}$'),
  -- The S5 relationship under which a guardian or proxy recorded it (re-evaluated at every decision).
  via_relationship_id uuid,
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (via_relationship_id, tenant_id) REFERENCES cuspatlas.patient_relationships (id, tenant_id),
  CHECK (purpose <> 'all' OR state = 'opted_out')
);
CREATE INDEX communication_consents_patient ON cuspatlas.communication_consents (tenant_id, patient_id, channel, seq);
CREATE TRIGGER communication_consents_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.communication_consents
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- Message templates: notice-only text (no placeholders), approved by practice administration; a
-- withdrawal is the only change and is final.
CREATE TABLE cuspatlas.message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  template_ref text NOT NULL CHECK (template_ref ~ '^[a-z0-9-]{1,64}$'),
  version integer NOT NULL CHECK (version >= 1),
  purpose text NOT NULL CHECK (purpose IN ('reminder', 'cancellation', 'waitlist_offer', 'recall')),
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 320 AND body !~ '[{}<>]'),
  state text NOT NULL CHECK (state IN ('approved', 'withdrawn')),
  approved_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, template_ref, version),
  UNIQUE (id, tenant_id),
  CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL) AND (withdrawn_at IS NULL) = (withdrawn_by IS NULL))
);

CREATE FUNCTION cuspatlas.message_template_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' OR OLD.state <> 'approved' OR NEW.state <> 'withdrawn'
      OR NEW.body <> OLD.body OR NEW.template_ref <> OLD.template_ref OR NEW.version <> OLD.version
      OR NEW.purpose <> OLD.purpose OR NEW.channel <> OLD.channel OR NEW.tenant_id <> OLD.tenant_id THEN
      RAISE EXCEPTION 'a template is immutable except for its final withdrawal' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END $$;
REVOKE ALL ON FUNCTION cuspatlas.message_template_guard() FROM PUBLIC;
CREATE TRIGGER message_templates_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.message_templates
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.message_template_guard();

-- Channel policy per intent purpose, versioned and append-only. channel 'none' is the default (no
-- row). A live channel needs a template and explicit quiet hours (E-D7: no shipped default window).
CREATE TABLE cuspatlas.channel_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  purpose text NOT NULL CHECK (purpose IN ('reminder', 'cancellation', 'waitlist_offer', 'recall')),
  version integer NOT NULL CHECK (version >= 1),
  channel text NOT NULL CHECK (channel IN ('none', 'email', 'sms')),
  template_ref text CHECK (template_ref ~ '^[a-z0-9-]{1,64}$'),
  quiet_start time,
  quiet_end time,
  reminder_lead_minutes integer CHECK (reminder_lead_minutes BETWEEN 0 AND 10080),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, purpose, version),
  CHECK (channel = 'none' OR (template_ref IS NOT NULL AND quiet_start IS NOT NULL AND quiet_end IS NOT NULL
    AND quiet_start <> quiet_end)),
  CHECK (channel = 'none' OR purpose <> 'reminder' OR reminder_lead_minutes IS NOT NULL)
);
CREATE TRIGGER channel_policies_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.channel_policies
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- One recorded decision per evaluation. stage 'intent' is decided in the transaction that records an
-- S14 intent; stage 'send' is E7's recheck at execution. Exactly one SuppressionReason when suppressed.
CREATE TABLE cuspatlas.suppression_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  subject_patient_id uuid NOT NULL,
  intent_id uuid,
  message_id uuid,
  stage text NOT NULL CHECK (stage IN ('intent', 'send')),
  purpose text NOT NULL CHECK (purpose IN ('reminder', 'cancellation', 'waitlist_offer', 'recall')),
  channel text NOT NULL CHECK (channel IN ('none', 'email', 'sms')),
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'suppressed')),
  reason text CHECK (reason IN ('no_consent', 'opt_out', 'quiet_hours', 'missing_contact', 'policy_off',
    'appointment_cancelled', 'appointment_missing', 'template_withdrawn', 'recall_not_due', 'grant_expired')),
  deferred_until timestamptz,
  consent_id uuid REFERENCES cuspatlas.communication_consents (id),
  channel_policy_id uuid REFERENCES cuspatlas.channel_policies (id),
  template_id uuid REFERENCES cuspatlas.message_templates (id),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9.-]{1,64}$'),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (id, tenant_id),
  CHECK ((outcome = 'suppressed') = (reason IS NOT NULL)),
  CHECK (deferred_until IS NULL OR reason = 'quiet_hours')
);
CREATE INDEX suppression_decisions_patient ON cuspatlas.suppression_decisions (tenant_id, subject_patient_id);
CREATE INDEX suppression_decisions_intent ON cuspatlas.suppression_decisions (tenant_id, intent_id);
CREATE TRIGGER suppression_decisions_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.suppression_decisions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- The S14 placeholder becomes a real reference: an intent's decision must exist in the same tenant.
ALTER TABLE cuspatlas.notification_intents
  ADD CONSTRAINT notification_intents_decision_fk
  FOREIGN KEY (suppression_decision_ref, tenant_id) REFERENCES cuspatlas.suppression_decisions (id, tenant_id);

-- Recall enrollment: one row per S16 due item (patient, policy, qualifying event). It sends nothing.
CREATE TABLE cuspatlas.recall_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  patient_id uuid NOT NULL,
  recall_policy_id uuid NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version >= 1),
  last_event_id uuid NOT NULL,
  due_date date NOT NULL,
  enrolled_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (recall_policy_id) REFERENCES cuspatlas.recall_policies (id),
  UNIQUE (tenant_id, patient_id, recall_policy_id, last_event_id)
);
CREATE TRIGGER recall_enrollments_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.recall_enrollments
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.communication_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.communication_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.message_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.channel_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.channel_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.suppression_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.suppression_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.recall_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.recall_enrollments FORCE ROW LEVEL SECURITY;

CREATE POLICY communication_consents_select ON cuspatlas.communication_consents
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY communication_consents_insert ON cuspatlas.communication_consents
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());
CREATE POLICY message_templates_select ON cuspatlas.message_templates
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY message_templates_insert ON cuspatlas.message_templates
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND approved_by = cuspatlas.current_actor_id());
CREATE POLICY message_templates_update ON cuspatlas.message_templates
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY channel_policies_select ON cuspatlas.channel_policies
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY channel_policies_insert ON cuspatlas.channel_policies
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY suppression_decisions_select ON cuspatlas.suppression_decisions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY suppression_decisions_insert ON cuspatlas.suppression_decisions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());
CREATE POLICY recall_enrollments_select ON cuspatlas.recall_enrollments
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY recall_enrollments_insert ON cuspatlas.recall_enrollments
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND enrolled_by = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.communication_consents, cuspatlas.message_templates, cuspatlas.channel_policies,
  cuspatlas.suppression_decisions, cuspatlas.recall_enrollments TO cuspatlas_app;
GRANT UPDATE (state, withdrawn_at, withdrawn_by) ON cuspatlas.message_templates TO cuspatlas_app;
