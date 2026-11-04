# Foundation contract decisions (frozen before dependent code)

Status: decided 2026-11-03 for the synthetic foundation; changing any row requires editing this file in the same commit as the code that depends on it. These settle the "contract details to settle in E1" list in the execution runbook. SHARED-CONTRACTS.md wins where it already speaks.

## Toolchain and versions

- Node 24.x (current LTS line; `engines` pins `>=24.13 <25`). pnpm pinned through the `packageManager` field; corepack enables it. Exact dependency versions, no ranges, lockfile committed. Record the final set in `docs/adr/0001-runtime.md`.
- PostgreSQL 17.x via `embedded-postgres` for tests on every platform; CI additionally runs the same suite on Linux. Migrations are plain SQL files under `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` applied by a small in-repo migrator using the privileged connection; this keeps them compatible with the Supabase CLI later without requiring Docker now.
- Migrations must not depend on Supabase-only roles (`anon`, `authenticated`, `service_role`) or the `auth` schema in this foundation. Tenant context comes from the application, not from `auth.uid()`. An adapter ADR can map to Supabase Auth later.

## Database roles

- Privileged migration role: the embedded server's superuser in tests; a named owner role in any other environment. Never used by the application at runtime.
- Runtime role `cuspatlas_app`: LOGIN, NOSUPERUSER, NOBYPASSRLS, NOINHERIT, NOCREATEDB. Receives only explicit table-level grants (SELECT/INSERT, UPDATE where the domain allows, never UPDATE/DELETE on audit tables). RLS enabled and FORCED on every application table; default deny.
- Tenant context is transaction-local: `select set_config('cuspatlas.tenant_id', $1, true)` and `cuspatlas.actor_id`, set only by `withTenantTransaction` after `authorize` succeeded. Policies compare against `current_setting('cuspatlas.tenant_id', true)`; a missing or empty setting denies. Pooled connections run `DISCARD ALL` on release and the test suite proves no leakage across sequential and concurrent transactions.
- Every integration test that asserts a denial runs under `cuspatlas_app`, never the owner.
- Addition (F Task 2, 2026-11-03): application tables live in schema `cuspatlas` (not `public`, so a later PostgREST exposure of `public` cannot reach them). One further transaction-local setting, `cuspatlas.auth_principal_id`, is set only by the identity lookup after token signature verification, in its own read-only transaction with no tenant context; RLS lets it read only that principal's own membership rows. Tenant context is still established only by `withTenantTransaction`, which additionally rechecks the live, unrevoked membership and principal kind inside the transaction before running work. Why: membership must be loaded live before any tenant context exists, and a SECURITY DEFINER bypass would be subject to FORCE RLS for a non-superuser owner.

## Identity

- Tokens are JWTs signed with an asymmetric test-only key (EdDSA/Ed25519 via `jose`). The API verifies issuer, audience, expiry, not-before, signature and `sub`, then loads membership from the database on every request (no cached authority). A revoked or missing membership denies even with a valid unexpired token.
- The test issuer lives under `tests/` and is enabled only when `CUSPATLAS_ENV=synthetic-test`; the server refuses to start with the test issuer configured in any other environment. No test headers, no unsigned tokens, no tenant from the client.
- Addition (F Task 2): the token carries signed claims `sub` (principal UUID), `tid` (selected tenant UUID) and `sid` (session id); all are required with `exp` and `iat`, algorithm EdDSA only. `tid` is issuer-signed context, not caller input, and grants nothing without a live membership row. A missing or revoked membership returns 403 `forbidden`; signature/claim/expiry failures return 401 `unauthenticated`.
- `ActorContext` is built server-side: `{ tenantId, actorId, principal: 'human' | 'service', sessionId, scopes, correlationId }`. Service principals carry their own membership rows and scopes; a service principal can never satisfy a `human`-only policy.

## Refusals and results

- `CommandResult<T> = { data, version, correlationId, replayed }` only for success. Refusals are typed `DomainRefusal` values with `code`, `retryable`, `correlationId` and safe `detail`; the command boundary normalizes thrown policy denials into them. Transport mapping per SHARED-CONTRACTS: 201/2xx success, 400 schema, 422 domain validation, 401 unauthenticated, 403 denied, 404 for hidden cross-tenant or missing (identical body), 409 conflict/stale, 429 budget, safe 5xx. MCP returns `isError: true` with the same `code`, `retryable`, `correlationId`.
- Error bodies and logs never include request payloads, tokens, SQL, stack traces or the marker `SYNTHETIC_SECRET_42`. A privacy test injects the marker everywhere a caller controls text and asserts it never reaches responses, ordinary logs or audit rows.

## Two audit paths

- Committed-change audit (`audit_events`) and outbox (`outbox_events`) are inserted in the same transaction as the domain change by `recordCommand(tx, audit, event)`. Rollback removes all three. The runtime role has INSERT and SELECT only.
- Security attempt events (`security_attempt_events`) are written after rollback through an independent connection in its own transaction. Fields: `attemptRef` (UUID, unique), `correlationId`, `tenantId?`, `actorId?`, `operation`, `reasonCode`, `occurredAt`. Unauthenticated attempts leave tenant/actor null; identity is never fabricated. Addition (F Task 2): the denial codes that produce an attempt are `unauthenticated`, `forbidden` and `not_found`; for a verified token without an active membership the actor is the verified `sub` and the tenant is recorded only when a (revoked) membership row for it exists. Internal `reasonCode` values are never sent to the caller. If the attempt sink fails, the operation stays denied, a safe alert line is logged, and the caller receives a safe 5xx.

## Idempotency and concurrency

- Scope key: `(tenantId, principalId, operation, idempotencyKey)`. Keys are caller-supplied strings, 1–128 chars.
- Canonical payload digest: SHA-256 over JSON with recursively sorted object keys, no whitespace, UTF-8. Same key + different digest → 409 `idempotency_conflict`.
- Reservation states: `pending` → `committed` | `failed`. A concurrent duplicate blocks on the row lock of the reservation and then replays the recorded result. A `failed` terminal refusal is replayed as the same refusal. `pending` older than the in-flight timeout (60 s) is treated as unknown and the new request takes over the reservation.
- Replay reauthorizes with the current context before returning the saved result; a revoked caller gets the denial, not the cached result. Tenant B can never see A's reservation (RLS on the reservation table).
- Retention: 7 days, deleted by a maintenance job; expiry is recorded on the row.
- Optimistic concurrency: every versioned aggregate has an integer `version`; `expectedVersion` mismatch → 409 `stale_version` with the current version in safe detail.

## Synthetic domain

- The only aggregate is `synthetic_tasks` (`taskRef`, `tenantId`, `label` 1–120 chars, `locationRef?`, `version`). It is non-clinical by construction and exists only to exercise the guarantees. Demonstrating an approved synthetic action is not evidence for any clinical or financial operation.
- Addition (F Task 3, 2026-11-03): operations are `syntheticTasks.create` (POST /v1/synthetic-tasks, 201), `syntheticTasks.list` (cursor pagination, limit 1–100, default 25, larger values refused not clamped), `syntheticTasks.read` (GET by `taskRef`) and `syntheticTasks.relabel` (POST /v1/synthetic-tasks/{taskRef}/relabel with `expectedVersion`; mismatch 409 `stale_version`). Every mutation requires an `Idempotency-Key` header (1–128 of `[A-Za-z0-9._:-]`); replay semantics arrive with Task 5 through the `CommandExecutor` seam. A location-restricted membership may create only inside one of its locations, lists only its locations plus tenant-wide (`locationRef: null`) tasks, and gets 403 on another location's task in its own tenant. Malformed `taskRef` values return the same 404 body as hidden and missing ones. `GET /v1/session` returns the server-derived context.
- Scopes used: `syntheticTasks.read`, `syntheticTasks.write`, `syntheticTasks.approve`. They are registered here because the foundation needs them; the global scope registry adds them when the matrix is next updated.

## Worker and proposals

- Outbox rows are leased (`leased_until`, `attempt`, `max_attempts = 5`) with exponential backoff and jitter. Delivery key = outbox event id. Adapters return typed receipts `delivered | duplicate | unknown | failed`; `unknown` goes to reconciliation, never to automatic retry of the side effect. Exhausted attempts → `dead_letter` with reason.
- Proposals bind `tenantId`, `operation`, payload digest, resource version, policy version, proposer, expiry (default 15 min) and `state` in `prepared | approved | committed | expired | rejected`. Approver must be a human principal with `syntheticTasks.approve`, different from the proposer when the proposer is a service principal. Commit reauthorizes everything and runs through `executeOnce` with the proposal id as idempotency key, so a committed proposal cannot execute twice.

## Revision cycle 1 additions (2026-11-04, independent review of E1/E2)

- Security-attempt attribution: the insert policy on `security_attempt_events` is `tenant_id IS NULL OR tenant_id = cuspatlas.current_attempt_tenant_id()`. The sink inserts in its own transaction after setting `cuspatlas.attempt_tenant_id` transaction-locally to the verified tenant it is recording (or empty for unauthenticated attempts). A runtime-role insert that names a tenant without that setting is refused.
- Membership visibility: inside a tenant a member reads only its own membership and principal rows (`tenant = current tenant AND principal = current actor`, or the identity-lookup principal). No member can list other members' scopes.
- Key sources: outside `synthetic-test` the server accepts only an identity produced by `loadConfiguredIdentity` (issuer, audience and Ed25519 SPKI public key from `CUSPATLAS_JWT_ISSUER`, `CUSPATLAS_JWT_AUDIENCE`, `CUSPATLAS_JWT_PUBLIC_KEY_PEM`). The check is structural (module-private registry), so an inline or test key object is refused whatever its issuer name. `apps/api/src/main.ts` reads `CUSPATLAS_ENV` and refuses unknown values.
- Refusal ordering for every synthetic-task operation: authentication (in Fastify `onRequest`, before any body parsing) → authorization → schema validation → domain rules. Domain-rule refusals that depend on stored state (such as `stale_version`) run inside the handler given to the `CommandExecutor`, so Task 5 can replay a committed result instead of re-evaluating them; authorization of the located resource runs before the executor so replays are reauthorized.
- Location checks inside a tenant transaction reuse the decision returned by the `authorize` call made before the transaction; domain code never acquires a second pool connection while holding one.
- Domain statements inside a tenant transaction are single statements without comments, transaction control, `set_config(` or `pg_*(` calls (`assertDomainStatement`).
- List cursors are opaque: base64url JSON `{v:1, after}` plus a truncated HMAC-SHA256 over tenant and body with a per-process random key. Tampered or foreign-tenant cursors return 400. Cursors do not survive a process restart (acceptable for the synthetic foundation; a shared key is a deployment decision).

## Task record: F Task 4 atomic audit and outbox (2026-11-04)

Settled shapes (additions, no frozen row changed):

- `recordCommand(tx, change, payload)` lives in `packages/domain/src/events/record-command.ts` and is called by each mutating handler *inside* the executor handler, after the domain write. It inserts one `cuspatlas.audit_events` row and one `cuspatlas.outbox_events` row through the same tenant transaction. Tenant and actor are taken from the transaction-local context (`cuspatlas.current_tenant_id()` / `current_actor_id()`), and RLS `WITH CHECK` requires them to match, so a caller cannot attribute a change to another tenant or actor.
- Event shape: `event_version = 1`, `correlation_id`, `trace_id` (32 hex, the server correlation id; no caller `traceparent` is accepted yet) and `span_id` (16 random hex per event). One audit row and one outbox row per `(tenant, resource type, resource, version)` (unique constraints), so a duplicated mutation cannot be recorded twice.
- Outbox payload is classified `field-names-only`: `{ changedFields: [...] }` with field names matching `^[a-z][A-Za-z]{0,63}$`, never values; checked in code and bounded to 1 KiB in the database. Labels and other caller text never enter audit or outbox rows.
- Grants: the runtime role has SELECT and INSERT on both tables (own tenant only). Audit is append-only for every role through a `BEFORE UPDATE OR DELETE` trigger (the owner included; production retention/archival is a later deployment gate). The outbox grants column-level UPDATE on exactly `state, attempt, leased_until, next_attempt_at, last_outcome, updated_at` for the Task 6 worker; identity, aggregate and payload columns are not updatable and there is no DELETE. The UPDATE policy is tenant-scoped; Task 6 decides whether leasing runs per tenant context or through a dedicated worker role, and must not widen these grants silently.

Crash windows and fail-closed handling:

- Committed path: the domain change, audit and outbox commit in one PostgreSQL transaction. A crash or any thrown error before `COMMIT` removes all three; an audit or outbox insert failure aborts the transaction and the caller receives a safe 500 (tested by revoking the insert grant). A crash after `COMMIT` but before the response leaves a durable change whose response was lost; Task 5 replays it under the same idempotency key.
- Attempt path: written after the domain transaction rolled back, through an independent pool in its own transaction, before the denial response is sent. Any delivered 401/403/404 therefore has a durable attempt row. A process crash between the rollback and the attempt commit loses that attempt record; the operation itself is still denied because nothing committed. No durable ingress exists, so the foundation does not claim that every received attempt is captured.
- Sink outage: the operation stays denied, a fixed alert line `security_attempt_sink_unavailable` is logged (no request data), and the caller receives 503 `service_unavailable` (retryable). There is no in-memory buffer that could drop events silently; once the sink recovers, new attempts are recorded again (tested).
- Attempt rows are deduplicated only by `attempt_ref` (primary key); retries of the same business request produce separate rows.

## Task record: F Task 5 idempotency and optimistic concurrency (2026-11-04)

Refinements of the frozen "Idempotency and concurrency" rows (same commit as the code):

- Scope storage: the reservation key is `(tenant_id, principal_id, operation, key_digest)` where `key_digest` = SHA-256 hex of the caller's key. The scope semantics are unchanged; the raw key is never stored because keys are caller text (the marker is a valid key). Payloads are stored only as their canonical digest.
- Digest input: the command envelope payload. Relabel's envelope payload is `{ taskRef, label, expectedVersion }`, so the same key on another task conflicts.
- Stored result: never the response body. Each operation registers a replay codec (`packages/domain/src/commands/replay-codecs.ts`) that persists server references only (`{ kind: 'success', taskRef }` plus `aggregate_version`) and rebuilds caller-echoed fields (the label) from the replay request, whose payload has the identical digest. An operation without a codec fails closed (500). Refusals are stored as `{ kind: 'refusal', code, retryable, detail? }` with server-authored detail only.
- Single transaction: the reservation, domain change, audit, outbox and finalization commit together. `pending` therefore never becomes visible from this code; a committed `pending` row can only come from an external or future two-phase path. Such a row younger than 60 s returns 409 `conflict` (retryable: the outcome is in flight or unknown); older than 60 s with the same digest it is taken over; with a different digest it is 409 `idempotency_conflict`. An expired row (`expires_at <= now()`) is treated as absent and taken over.
- Concurrent duplicates: `INSERT .. ON CONFLICT DO NOTHING` blocks on the first transaction's uncommitted unique entry, then `SELECT .. FOR UPDATE` reads the committed row and replays it. Lock order: relabel locks the task row before the reservation, create locks only the reservation, so no cycle exists.
- Terminal refusals recorded as `failed` and replayed: `stale_version`, `validation_failed`, `invalid_request` and non-retryable `conflict`. The handler runs in a savepoint (`TenantTransaction.savepoint`, fixed server-chosen names, not reachable through `tx.query`); on such a refusal its writes are undone, the reservation is marked `failed`, and the domain throws `CommitThenRefuse`, which tells `withTenantTransaction` to COMMIT and then surface the refusal. Denials, retryable refusals and unexpected errors roll back everything including the reservation, so the same key may be retried.
- Replay reauthorizes structurally: authentication, `authorize` and the in-transaction membership recheck all run before the executor, so a revoked caller gets 403 and never the stored result.
- Replay responses carry the current request's correlation id (the original is kept on the row) and the operation's normal success status (201 for create, 200 for relabel) with `replayed: true`.
- Grants: the runtime role has SELECT, INSERT and column-level UPDATE on `state, result, aggregate_version, payload_digest, correlation_id, reserved_at, updated_at, expires_at` (finalize and take over); the scope columns are not updatable; no DELETE or TRUNCATE. RLS (enabled and forced) limits every statement to the current tenant AND the current principal.
- Retention: `expires_at = reserved_at + 7 days` (check constraint). `purgeExpiredCommandIdempotency` (packages/db) is the maintenance path; it runs on the privileged owner/migration connection and refuses to run as `cuspatlas_app`. Under FORCE RLS a non-superuser owner needs BYPASSRLS or a dedicated maintenance policy; that role choice is deferred to the deployment ADR (0002) and is not evidenced here.
- `executeOnce` is the default executor of the domain service and of `buildApp`; `executeDirect` remains only for tests that fault the handler.
