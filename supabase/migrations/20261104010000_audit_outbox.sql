-- F Task 4: committed-change audit and transactional outbox. Synthetic, non-clinical.
-- Both rows are inserted by recordCommand() in the same transaction as the domain change, so a
-- rollback removes all three. Rows carry references, versions and correlation only: no labels, no
-- request bodies, no caller text. The runtime role may INSERT and SELECT (own tenant only); audit is
-- append-only for every role through a trigger; the outbox exposes column-level UPDATE on exactly the
-- delivery-state columns that the Task 6 worker needs (state, attempt, leased_until, next_attempt_at,
-- last_outcome, updated_at), never on identity, aggregate or payload columns. No DELETE anywhere.

CREATE TABLE cuspatlas.audit_events (
  event_ref uuid PRIMARY KEY,
  event_version smallint NOT NULL CHECK (event_version = 1),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  principal text NOT NULL CHECK (principal IN ('human', 'service')),
  operation text NOT NULL CHECK (operation ~ '^[a-z][A-Za-z]{0,40}(\.[a-z][A-Za-z]{0,40}){0,3}$'),
  resource_type text NOT NULL CHECK (resource_type ~ '^[a-z][A-Za-z]{0,63}$'),
  resource_ref uuid NOT NULL,
  resource_version integer NOT NULL CHECK (resource_version >= 1),
  correlation_id uuid NOT NULL,
  trace_id text NOT NULL CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  span_id text NOT NULL CHECK (span_id ~ '^[0-9a-f]{16}$'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- One committed change per aggregate version: a duplicate mutation cannot be audited twice.
  UNIQUE (tenant_id, resource_type, resource_ref, resource_version)
);
CREATE INDEX audit_events_correlation ON cuspatlas.audit_events (correlation_id);

CREATE TABLE cuspatlas.outbox_events (
  id uuid PRIMARY KEY,
  event_version smallint NOT NULL CHECK (event_version = 1),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  operation text NOT NULL CHECK (operation ~ '^[a-z][A-Za-z]{0,40}(\.[a-z][A-Za-z]{0,40}){0,3}$'),
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][A-Za-z]{0,63}$'),
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version >= 1),
  correlation_id uuid NOT NULL,
  trace_id text NOT NULL CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  span_id text NOT NULL CHECK (span_id ~ '^[0-9a-f]{16}$'),
  occurred_at timestamptz NOT NULL,
  -- Classified, minimized payload: field names only, never values. Bounded size.
  payload_class text NOT NULL CHECK (payload_class IN ('field-names-only')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 1024),
  -- Delivery state (Task 6). Defaults describe a freshly enqueued event.
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'delivered', 'retry', 'reconciliation', 'dead_letter')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts = 5),
  leased_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_outcome text CHECK (last_outcome ~ '^[a-z_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, aggregate_type, aggregate_id, aggregate_version)
);
CREATE INDEX outbox_events_ready ON cuspatlas.outbox_events (state, next_attempt_at);
CREATE INDEX outbox_events_correlation ON cuspatlas.outbox_events (correlation_id);

-- Append-only audit, independent of grants: refuses UPDATE and DELETE for every role, owner included.
-- (TRUNCATE is not granted to the runtime role; production retention is a later deployment gate.)
CREATE FUNCTION cuspatlas.audit_events_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '42501'; END $$;
REVOKE ALL ON FUNCTION cuspatlas.audit_events_append_only() FROM PUBLIC;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.audit_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.audit_events_append_only();

ALTER TABLE cuspatlas.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.outbox_events FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_events_select ON cuspatlas.audit_events
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY audit_events_insert ON cuspatlas.audit_events
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());

CREATE POLICY outbox_events_select ON cuspatlas.outbox_events
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY outbox_events_insert ON cuspatlas.outbox_events
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());
CREATE POLICY outbox_events_update ON cuspatlas.outbox_events
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.audit_events TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.outbox_events TO cuspatlas_app;
GRANT UPDATE (state, attempt, leased_until, next_attempt_at, last_outcome, updated_at)
  ON cuspatlas.outbox_events TO cuspatlas_app;
