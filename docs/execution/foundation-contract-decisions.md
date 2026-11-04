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
