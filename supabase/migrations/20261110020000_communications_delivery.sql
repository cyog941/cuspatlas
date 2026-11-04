-- E7: outbound messages, delivery attempts and provider receipts, against a FAKE provider only
-- (E-S1 is blocked-on-discovery; no provider SDK, no network). One outbound message per S14 intent
-- that E6 allowed, keyed by the intent's stable delivery key (the provider idempotency key). The
-- message body is the approved template version (notice only); recipient addresses are resolved from
-- the patient record at send time and never stored here. Attempts and receipts are append-only facts.
-- Leasing fences on `attempt` like the F6 outbox. Recommended-pending-approval throughout.

CREATE TABLE cuspatlas.outbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  intent_id uuid NOT NULL REFERENCES cuspatlas.notification_intents (id),
  patient_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('reminder', 'cancellation', 'waitlist_offer', 'recall')),
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  template_id uuid NOT NULL,
  delivery_key text NOT NULL CHECK (delivery_key ~ '^[a-z_]{1,32}:[0-9a-f-]{36}$'),
  intent_decision_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'delivered', 'failed', 'suppressed', 'unknown',
    'abandoned')),
  state_reason text CHECK (state_reason ~ '^[a-z_]{1,64}$'),
  suppression_reason text CHECK (suppression_reason IN ('no_consent', 'opt_out', 'quiet_hours', 'missing_contact',
    'policy_off', 'appointment_cancelled', 'appointment_missing', 'template_withdrawn', 'recall_not_due', 'grant_expired')),
  send_after timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  leased_until timestamptz,
  reconcile_after timestamptz,
  provider_ref text CHECK (provider_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  last_receipt_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (template_id, tenant_id) REFERENCES cuspatlas.message_templates (id, tenant_id),
  FOREIGN KEY (intent_decision_id, tenant_id) REFERENCES cuspatlas.suppression_decisions (id, tenant_id),
  UNIQUE (tenant_id, intent_id),
  UNIQUE (tenant_id, delivery_key),
  UNIQUE (id, tenant_id),
  CHECK ((state = 'suppressed') = (suppression_reason IS NOT NULL)),
  CHECK (state NOT IN ('sent', 'delivered') OR provider_ref IS NOT NULL)
);
CREATE INDEX outbound_messages_due ON cuspatlas.outbound_messages (tenant_id, state, next_attempt_at);
CREATE UNIQUE INDEX outbound_messages_provider_ref ON cuspatlas.outbound_messages (tenant_id, provider_ref)
  WHERE provider_ref IS NOT NULL;

-- Every update bumps the version; a terminal suppression, abandonment or delivery is never reopened.
CREATE FUNCTION cuspatlas.outbound_message_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'outbound messages are never deleted' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 OR NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
      OR NEW.intent_id <> OLD.intent_id OR NEW.delivery_key <> OLD.delivery_key OR NEW.template_id <> OLD.template_id
      OR NEW.patient_id <> OLD.patient_id OR NEW.channel <> OLD.channel
      OR (OLD.state IN ('suppressed', 'abandoned') AND NEW.state <> OLD.state)
      OR (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref) THEN
      RAISE EXCEPTION 'outbound message change refused' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END $$;
REVOKE ALL ON FUNCTION cuspatlas.outbound_message_guard() FROM PUBLIC;
CREATE TRIGGER outbound_messages_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.outbound_messages
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.outbound_message_guard();

CREATE TABLE cuspatlas.delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  message_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 0),
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'duplicate', 'rejected_transient', 'rejected_permanent',
    'unknown', 'reconciled_found', 'reconciled_not_found', 'lookup_unavailable', 'suppressed', 'deferred',
    'decision_unavailable', 'resolved_resend', 'resolved_abandon')),
  decision_id uuid,
  provider_ref text CHECK (provider_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (message_id, tenant_id) REFERENCES cuspatlas.outbound_messages (id, tenant_id),
  FOREIGN KEY (decision_id, tenant_id) REFERENCES cuspatlas.suppression_decisions (id, tenant_id)
);
CREATE INDEX delivery_attempts_message ON cuspatlas.delivery_attempts (tenant_id, message_id);
CREATE TRIGGER delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- Provider receipts, deduplicated on the provider event identity. `applied` records whether the
-- receipt moved the message state (late or out-of-order receipts never regress it).
CREATE TABLE cuspatlas.message_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  message_id uuid NOT NULL,
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  state text NOT NULL CHECK (state IN ('delivered', 'failed', 'bounced')),
  occurred_at timestamptz NOT NULL,
  applied boolean NOT NULL,
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (message_id, tenant_id) REFERENCES cuspatlas.outbound_messages (id, tenant_id),
  UNIQUE (tenant_id, dedupe_key)
);
CREATE TRIGGER message_receipts_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.message_receipts
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.outbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.outbound_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.delivery_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.message_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.message_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY outbound_messages_select ON cuspatlas.outbound_messages
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY outbound_messages_insert ON cuspatlas.outbound_messages
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY outbound_messages_update ON cuspatlas.outbound_messages
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY delivery_attempts_select ON cuspatlas.delivery_attempts
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY delivery_attempts_insert ON cuspatlas.delivery_attempts
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());
CREATE POLICY message_receipts_select ON cuspatlas.message_receipts
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY message_receipts_insert ON cuspatlas.message_receipts
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.outbound_messages, cuspatlas.delivery_attempts, cuspatlas.message_receipts
  TO cuspatlas_app;
GRANT UPDATE (state, state_reason, suppression_reason, next_attempt_at, attempt, leased_until, reconcile_after,
  provider_ref, last_receipt_at, version, updated_at) ON cuspatlas.outbound_messages TO cuspatlas_app;
