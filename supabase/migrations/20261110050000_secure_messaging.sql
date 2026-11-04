-- E5: secure messaging between portal principals and staff queues (synthetic data only).
--
-- A thread belongs to one patient and one location (its time zone governs notice quiet hours). A
-- message is immutable after it is posted; attachments are references only (an I image reference or
-- an object reference: bytes never live here and each reference is authorized separately). Message
-- bodies are never logged, audited or put in a notification. Every read of a thread is access-audited
-- (sensitive-read log). Retention is policy data pending legal review (E-D5): nothing is ever deleted
-- here; a legal-hold placeholder marks threads that must outlive any future retention period.
--
-- A staff reply produces a notice through E6/E7 only: E6 decides (purpose message_notice, consent
-- purpose messaging) and E7 delivers an approved notice-only template through the fake provider. The
-- notice never carries message content.

CREATE TABLE cuspatlas.message_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  patient_id uuid NOT NULL,
  location_id uuid NOT NULL,
  topic text NOT NULL CHECK (topic IN ('appointment', 'billing', 'forms', 'general')),
  queue text NOT NULL CHECK (queue IN ('front_desk', 'billing', 'clinical_team')),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  awaiting text NOT NULL CHECK (awaiting IN ('practice', 'patient')),
  assigned_to uuid REFERENCES cuspatlas.principals (id),
  retention_class text NOT NULL DEFAULT 'secure_messaging_administrative'
    CHECK (retention_class IN ('secure_messaging_administrative')),
  legal_hold boolean NOT NULL DEFAULT false,
  legal_hold_reason text CHECK (legal_hold_reason ~ '^[a-z_]{1,64}$'),
  opened_via text NOT NULL CHECK (opened_via IN ('portal', 'staff')),
  opened_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  via_relationship_id uuid,
  close_reason text CHECK (close_reason ~ '^[a-z_]{1,64}$'),
  closed_by uuid REFERENCES cuspatlas.principals (id),
  closed_at timestamptz,
  last_message_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  FOREIGN KEY (via_relationship_id, tenant_id) REFERENCES cuspatlas.patient_relationships (id, tenant_id),
  UNIQUE (id, tenant_id),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK (legal_hold OR legal_hold_reason IS NULL)
);
CREATE INDEX message_threads_patient ON cuspatlas.message_threads (tenant_id, patient_id, last_message_at);

-- A thread is never deleted and its identity (patient, location, opener) never changes.
CREATE FUNCTION cuspatlas.message_threads_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'message threads are never deleted' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 OR NEW.patient_id <> OLD.patient_id OR NEW.location_id <> OLD.location_id
        OR NEW.opened_by <> OLD.opened_by OR NEW.opened_via <> OLD.opened_via OR NEW.created_at <> OLD.created_at
        OR NEW.via_relationship_id IS DISTINCT FROM OLD.via_relationship_id THEN
      RAISE EXCEPTION 'message thread change refused' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.message_threads_guard() FROM PUBLIC;
CREATE TRIGGER message_threads_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.message_threads
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.message_threads_guard();

CREATE TABLE cuspatlas.thread_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  thread_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  author_kind text NOT NULL CHECK (author_kind IN ('portal', 'staff')),
  via_relationship_id uuid,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array'),
  -- The E6 decision for the notice of a staff reply (null for a portal message: staff see a worklist).
  notice_decision_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (thread_id, tenant_id) REFERENCES cuspatlas.message_threads (id, tenant_id),
  FOREIGN KEY (via_relationship_id, tenant_id) REFERENCES cuspatlas.patient_relationships (id, tenant_id),
  FOREIGN KEY (notice_decision_id, tenant_id) REFERENCES cuspatlas.suppression_decisions (id, tenant_id),
  UNIQUE (id, tenant_id)
);
CREATE INDEX thread_messages_thread ON cuspatlas.thread_messages (tenant_id, thread_id, created_at);
CREATE TRIGGER thread_messages_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.thread_messages
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.message_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.message_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.thread_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.thread_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY message_threads_select ON cuspatlas.message_threads
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY message_threads_insert ON cuspatlas.message_threads
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND opened_by = cuspatlas.current_actor_id());
CREATE POLICY message_threads_update ON cuspatlas.message_threads
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY thread_messages_select ON cuspatlas.thread_messages
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY thread_messages_insert ON cuspatlas.thread_messages
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND author_id = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.message_threads, cuspatlas.thread_messages TO cuspatlas_app;
GRANT UPDATE (state, awaiting, assigned_to, legal_hold, legal_hold_reason, close_reason, closed_by, closed_at,
  last_message_at, version) ON cuspatlas.message_threads TO cuspatlas_app;

-- The notice purpose joins E6/E7's purpose vocabulary.
ALTER TABLE cuspatlas.channel_policies DROP CONSTRAINT channel_policies_purpose_check;
ALTER TABLE cuspatlas.channel_policies ADD CONSTRAINT channel_policies_purpose_check
  CHECK (purpose IN ('reminder', 'cancellation', 'waitlist_offer', 'recall', 'message_notice'));
ALTER TABLE cuspatlas.message_templates DROP CONSTRAINT message_templates_purpose_check;
ALTER TABLE cuspatlas.message_templates ADD CONSTRAINT message_templates_purpose_check
  CHECK (purpose IN ('reminder', 'cancellation', 'waitlist_offer', 'recall', 'message_notice'));
ALTER TABLE cuspatlas.suppression_decisions DROP CONSTRAINT suppression_decisions_purpose_check;
ALTER TABLE cuspatlas.suppression_decisions ADD CONSTRAINT suppression_decisions_purpose_check
  CHECK (purpose IN ('reminder', 'cancellation', 'waitlist_offer', 'recall', 'message_notice'));
ALTER TABLE cuspatlas.outbound_messages DROP CONSTRAINT outbound_messages_purpose_check;
ALTER TABLE cuspatlas.outbound_messages ADD CONSTRAINT outbound_messages_purpose_check
  CHECK (purpose IN ('reminder', 'cancellation', 'waitlist_offer', 'recall', 'message_notice'));

-- An outbound message comes from exactly one source: an S14 intent, or a staff reply's notice.
ALTER TABLE cuspatlas.outbound_messages ALTER COLUMN intent_id DROP NOT NULL;
ALTER TABLE cuspatlas.outbound_messages ADD COLUMN thread_message_id uuid;
ALTER TABLE cuspatlas.outbound_messages
  ADD CONSTRAINT outbound_messages_thread_message_fk
  FOREIGN KEY (thread_message_id, tenant_id) REFERENCES cuspatlas.thread_messages (id, tenant_id);
ALTER TABLE cuspatlas.outbound_messages ADD CONSTRAINT outbound_messages_one_source
  CHECK (num_nonnulls(intent_id, thread_message_id) = 1);
ALTER TABLE cuspatlas.outbound_messages ADD CONSTRAINT outbound_messages_thread_message_unique
  UNIQUE (tenant_id, thread_message_id);

CREATE OR REPLACE FUNCTION cuspatlas.outbound_message_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'outbound messages are never deleted' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 OR NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
      OR NEW.intent_id IS DISTINCT FROM OLD.intent_id OR NEW.thread_message_id IS DISTINCT FROM OLD.thread_message_id
      OR NEW.delivery_key <> OLD.delivery_key OR NEW.template_id <> OLD.template_id
      OR NEW.patient_id <> OLD.patient_id OR NEW.channel <> OLD.channel
      OR (OLD.state IN ('suppressed', 'abandoned') AND NEW.state <> OLD.state)
      OR (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref) THEN
      RAISE EXCEPTION 'outbound message change refused' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END $$;
