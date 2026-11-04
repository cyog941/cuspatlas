-- F Task 5: durable idempotency reservations for commands. Synthetic, non-clinical.
-- Scope: (tenant, principal, operation, key). The caller's key is stored only as its SHA-256 digest
-- (key_digest) so caller text never lands in the row; the payload is stored only as its canonical
-- digest. `result` holds a safe projection (references and versions, or a typed refusal), never
-- caller text. The reservation is written in the same transaction as the domain change, so a
-- committed reservation always matches a committed change and a rolled-back one disappears.
-- Retention: 7 days from reservation (expires_at), purged by a maintenance job that runs as the
-- privileged owner/migration role; the runtime role has no DELETE.

CREATE TABLE cuspatlas.command_idempotency (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  principal_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  operation text NOT NULL CHECK (operation ~ '^[a-z][A-Za-z]{0,40}(\.[a-z][A-Za-z]{0,40}){0,3}$'),
  key_digest text NOT NULL CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('pending', 'committed', 'failed')),
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 2048)),
  aggregate_version integer CHECK (aggregate_version >= 1),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reserved_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, operation, key_digest),
  CHECK (expires_at = reserved_at + interval '7 days'),
  CHECK ((state = 'pending') = (result IS NULL)),
  CHECK ((state = 'committed') = (aggregate_version IS NOT NULL))
);
CREATE INDEX command_idempotency_expires ON cuspatlas.command_idempotency (expires_at);

ALTER TABLE cuspatlas.command_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.command_idempotency FORCE ROW LEVEL SECURITY;

-- Own tenant AND own principal only: another tenant, or another principal in the same tenant, can
-- never see, replay or take over a reservation.
CREATE POLICY command_idempotency_select ON cuspatlas.command_idempotency
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());
CREATE POLICY command_idempotency_insert ON cuspatlas.command_idempotency
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());
CREATE POLICY command_idempotency_update ON cuspatlas.command_idempotency
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.command_idempotency TO cuspatlas_app;
-- Finalizing (state/result/aggregate_version) and taking over an expired or abandoned reservation
-- (payload_digest/correlation_id/reserved_at/expires_at). The scope columns are never updatable.
GRANT UPDATE (state, result, aggregate_version, payload_digest, correlation_id, reserved_at, updated_at,
  expires_at) ON cuspatlas.command_idempotency TO cuspatlas_app;
