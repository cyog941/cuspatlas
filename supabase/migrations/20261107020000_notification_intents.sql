-- S14: notification intents, recorded in the booking, cancel and reschedule transactions and never
-- sent from here. Synthetic data only. No channel is verified (S-S2 / S-D5 pending), so the domain
-- writes channel 'none' only. Consent, opt-out, quiet hours and the suppression decision belong to E6
-- (not built): suppression_decision_ref is a placeholder that stays NULL until E6 adds its decision
-- path (and its own grant); scheduling never stores a consent value. Delivery is E7's outbox consumer.

CREATE TABLE cuspatlas.notification_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('appointment', 'waitlist_offer', 'recall_task')),
  subject_id uuid NOT NULL,
  location_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('reminder', 'cancellation', 'waitlist_offer', 'recall')),
  channel text NOT NULL CHECK (channel IN ('none', 'sms', 'email', 'voice', 'portal')),
  -- Stable delivery key E7 deduplicates on: purpose and subject.
  delivery_key text NOT NULL CHECK (delivery_key ~ '^[a-z_]{1,32}:[0-9a-f-]{36}$'),
  policy_ref text NOT NULL CHECK (policy_ref ~ '^[a-z0-9-]{1,64}$'),
  template_ref text CHECK (template_ref ~ '^[a-z0-9-]{1,64}$'),
  suppression_decision_ref uuid,
  -- The intent this one replaces (a cancellation or a reschedule supersedes the earlier reminder).
  superseded_intent_id uuid,
  due_at timestamptz,
  source_operation text NOT NULL CHECK (source_operation ~ '^[a-z][A-Za-z.]{0,79}$'),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  UNIQUE (tenant_id, delivery_key)
);
CREATE INDEX notification_intents_subject ON cuspatlas.notification_intents (tenant_id, subject_id);
CREATE INDEX notification_intents_superseded ON cuspatlas.notification_intents (tenant_id, superseded_intent_id);

CREATE TRIGGER notification_intents_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.notification_intents
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.notification_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.notification_intents FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_intents_select ON cuspatlas.notification_intents
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY notification_intents_insert ON cuspatlas.notification_intents
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.notification_intents TO cuspatlas_app;
