-- Integration hardening (codex/backend-integration; synthetic data only). New migration; applied
-- migrations are never edited.
--
-- command_idempotency.payload_digest was an unkeyed SHA-256 over the canonical JSON of the command
-- payload. Payloads can carry low-entropy patient data (an allergen name, a contact value), so an
-- unkeyed digest at rest can be confirmed by guessing. From this migration the application writes
-- scheme 2: HMAC-SHA-256 under a server secret (CUSPATLAS_IDEMPOTENCY_DIGEST_KEY; a test-only key
-- under synthetic-test, refused elsewhere) over a purpose label, the tenant and the canonical JSON.
-- Comparison semantics are unchanged (equal payload, equal digest, within a tenant and key).
--
-- Rows written before this migration are scheme 1 and are still compared by their own scheme until
-- they expire (reservations live 7 days; the maintenance purge removes them); a takeover of an
-- expired or abandoned row rewrites it as scheme 2. Only synthetic rows exist.
ALTER TABLE cuspatlas.command_idempotency
  ADD COLUMN payload_digest_scheme smallint NOT NULL DEFAULT 1 CHECK (payload_digest_scheme IN (1, 2));
ALTER TABLE cuspatlas.command_idempotency ALTER COLUMN payload_digest_scheme SET DEFAULT 2;
GRANT UPDATE (payload_digest_scheme) ON cuspatlas.command_idempotency TO cuspatlas_app;
COMMENT ON COLUMN cuspatlas.command_idempotency.payload_digest IS
  'Scheme 2: HMAC-SHA-256 (hex) under the server idempotency digest key over purpose, tenant and canonical JSON; scheme 1 (legacy, expiring): unkeyed SHA-256.';
