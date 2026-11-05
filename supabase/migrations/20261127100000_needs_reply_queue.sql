-- E10 / OR-08: the needs-reply messaging queue (synthetic data only). No second mechanism is added:
-- needs_reply is the E5 predicate (thread open and awaiting the practice). This migration adds only
-- the facts the queue needs.
--
--   messaging_reply_policies   reply-due time per staff queue, in business days (OR-D4, default 1 when
--                              a queue has no row). Business days are Monday to Friday in the thread
--                              location's IANA zone until a location holiday calendar exists.
--   thread_read_receipts       one fact per (thread, staff principal): the newest message that
--                              principal has read. Unread is derived against it. The app role can only
--                              see and write its own receipts. No message content is stored.
--   thread_reply_escalations   one append-only fact per (thread, unanswered portal message): the
--                              overdue escalation. Recorded idempotently when an overdue item is read,
--                              so it happens once per unanswered episode however often it is read.

CREATE TABLE cuspatlas.messaging_reply_policies (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  queue text NOT NULL CHECK (queue IN ('front_desk', 'billing', 'clinical_team')),
  reply_due_business_days integer NOT NULL CHECK (reply_due_business_days BETWEEN 1 AND 30),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, queue)
);

CREATE TABLE cuspatlas.thread_read_receipts (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  thread_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  -- Creation time of the newest message read; a later portal message is unread for this principal.
  last_read_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (thread_id, principal_id),
  FOREIGN KEY (thread_id, tenant_id) REFERENCES cuspatlas.message_threads (id, tenant_id)
);
CREATE INDEX thread_read_receipts_principal ON cuspatlas.thread_read_receipts (tenant_id, principal_id);

CREATE TABLE cuspatlas.thread_reply_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  thread_id uuid NOT NULL,
  -- The unanswered portal message that started the episode: the idempotency key of the escalation.
  trigger_message_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  escalated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  escalated_to_queue text NOT NULL DEFAULT 'practice_manager' CHECK (escalated_to_queue IN ('practice_manager')),
  FOREIGN KEY (thread_id, tenant_id) REFERENCES cuspatlas.message_threads (id, tenant_id),
  FOREIGN KEY (trigger_message_id, tenant_id) REFERENCES cuspatlas.thread_messages (id, tenant_id),
  UNIQUE (thread_id, trigger_message_id)
);
CREATE TRIGGER thread_reply_escalations_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.thread_reply_escalations
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.messaging_reply_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.messaging_reply_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.thread_read_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.thread_read_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.thread_reply_escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.thread_reply_escalations FORCE ROW LEVEL SECURITY;

CREATE POLICY messaging_reply_policies_select ON cuspatlas.messaging_reply_policies
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY messaging_reply_policies_insert ON cuspatlas.messaging_reply_policies
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND updated_by = cuspatlas.current_actor_id());
CREATE POLICY messaging_reply_policies_update ON cuspatlas.messaging_reply_policies
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND updated_by = cuspatlas.current_actor_id());

CREATE POLICY thread_read_receipts_select ON cuspatlas.thread_read_receipts
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());
CREATE POLICY thread_read_receipts_insert ON cuspatlas.thread_read_receipts
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());
CREATE POLICY thread_read_receipts_update ON cuspatlas.thread_read_receipts
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());

CREATE POLICY thread_reply_escalations_select ON cuspatlas.thread_reply_escalations
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY thread_reply_escalations_insert ON cuspatlas.thread_reply_escalations
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.messaging_reply_policies, cuspatlas.thread_read_receipts,
  cuspatlas.thread_reply_escalations TO cuspatlas_app;
GRANT UPDATE (reply_due_business_days, version, updated_by, updated_at) ON cuspatlas.messaging_reply_policies
  TO cuspatlas_app;
GRANT UPDATE (last_read_at, updated_at) ON cuspatlas.thread_read_receipts TO cuspatlas_app;
