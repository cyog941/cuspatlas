-- A14 webhook subscriptions and deliveries (workstream A batch 4; synthetic only; A-D7 registration model
-- recommended-pending-approval). A subscription names one https endpoint on the operator allowlist, a
-- closed set of catalog event types and one event version. Its signing secret is stored only as AES-GCM
-- ciphertext under a server key (never in plaintext, never in an idempotency result or a log); a rotation
-- keeps the previous ciphertext until an overlap deadline so both verify. A delivery is one attempt
-- series of one outbox event to one subscription; its body bytes are fixed at fan-out (references,
-- type, version and field names only) and every attempt is signed afresh. A replay is a new delivery
-- with the same event identity. Attempts are bounded (5) before dead-letter; nothing is ever deleted.

CREATE TABLE cuspatlas.webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  endpoint_url text NOT NULL CHECK (endpoint_url ~ '^https://[^[:space:]]+$' AND octet_length(endpoint_url) <= 2048),
  endpoint_host text NOT NULL CHECK (endpoint_host ~ '^[a-z0-9.:-]{1,253}$'),
  event_types text[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 64),
  event_version integer NOT NULL CHECK (event_version BETWEEN 1 AND 99),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  secret_ciphertext text NOT NULL CHECK (secret_ciphertext ~ '^[A-Za-z0-9_-]+$' AND octet_length(secret_ciphertext) BETWEEN 40 AND 400),
  secret_fingerprint text NOT NULL CHECK (secret_fingerprint ~ '^[0-9a-f]{16}$'),
  previous_secret_ciphertext text CHECK (previous_secret_ciphertext ~ '^[A-Za-z0-9_-]+$' AND octet_length(previous_secret_ciphertext) BETWEEN 40 AND 400),
  previous_secret_expires_at timestamptz,
  revoke_reason text CHECK (revoke_reason ~ '^[a-z_]{1,64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CHECK ((previous_secret_ciphertext IS NULL) = (previous_secret_expires_at IS NULL))
);
-- Two active subscriptions for one endpoint and event version are one registration too many.
CREATE UNIQUE INDEX webhook_subscriptions_endpoint_version
  ON cuspatlas.webhook_subscriptions (tenant_id, endpoint_url, event_version) WHERE state = 'active';

CREATE TABLE cuspatlas.webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  subscription_id uuid NOT NULL,
  -- The outbox event identity (the consumer's deduplication key); a replay repeats it.
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][A-Za-z]{0,63}\.[a-z][A-Za-z]{0,31}$'),
  event_version integer NOT NULL CHECK (event_version BETWEEN 1 AND 99),
  body text NOT NULL CHECK (octet_length(body) <= 4096),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivering', 'retrying', 'delivered',
    'dead_lettered', 'adapter_not_configured', 'paused', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts = 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_response_class text CHECK (last_response_class IN ('2xx', '3xx', '4xx', '5xx', 'network', 'timeout')),
  last_guard text CHECK (last_guard ~ '^[a-z_]{1,64}$'),
  -- The delivery this one replays (same tenant; no self-key so restore ordering stays acyclic).
  replay_of uuid,
  delivered_at timestamptz,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subscription_id, tenant_id) REFERENCES cuspatlas.webhook_subscriptions (id, tenant_id)
);
-- Fan-out is idempotent: one original delivery per subscription and event (replays are extra rows).
CREATE UNIQUE INDEX webhook_deliveries_original
  ON cuspatlas.webhook_deliveries (subscription_id, event_id) WHERE replay_of IS NULL;
CREATE INDEX webhook_deliveries_due ON cuspatlas.webhook_deliveries (tenant_id, state, next_attempt_at);
CREATE INDEX webhook_deliveries_log ON cuspatlas.webhook_deliveries (tenant_id, subscription_id, created_at DESC);

CREATE FUNCTION cuspatlas.webhook_records_no_delete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'webhook records are never deleted' USING ERRCODE = '42501'; END $$;
REVOKE ALL ON FUNCTION cuspatlas.webhook_records_no_delete() FROM PUBLIC;
CREATE TRIGGER webhook_subscriptions_no_delete BEFORE DELETE ON cuspatlas.webhook_subscriptions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.webhook_records_no_delete();
CREATE TRIGGER webhook_deliveries_no_delete BEFORE DELETE ON cuspatlas.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.webhook_records_no_delete();

ALTER TABLE cuspatlas.webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.webhook_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_subscriptions_select ON cuspatlas.webhook_subscriptions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY webhook_subscriptions_insert ON cuspatlas.webhook_subscriptions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY webhook_subscriptions_update ON cuspatlas.webhook_subscriptions
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY webhook_deliveries_select ON cuspatlas.webhook_deliveries
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY webhook_deliveries_insert ON cuspatlas.webhook_deliveries
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY webhook_deliveries_update ON cuspatlas.webhook_deliveries
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
GRANT SELECT, INSERT ON cuspatlas.webhook_subscriptions TO cuspatlas_app;
GRANT UPDATE (state, secret_ciphertext, secret_fingerprint, previous_secret_ciphertext,
  previous_secret_expires_at, revoke_reason, version, updated_at) ON cuspatlas.webhook_subscriptions TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.webhook_deliveries TO cuspatlas_app;
GRANT UPDATE (state, attempts, next_attempt_at, lease_token, lease_expires_at, last_response_class, last_guard,
  delivered_at, updated_at) ON cuspatlas.webhook_deliveries TO cuspatlas_app;
