# Foundation execution ledger

Branch: `codex/foundation-core` in an isolated worktree outside the OneDrive-synced checkout. Base SHA: `6f560db9f4071b26a3bb598e09be87b326c4e1b4` (main, 2026-11-03). Head SHA is updated per batch below. Status values: not started, in progress, blocked with cause, verified. Nothing is prechecked.

Authorization basis: user instruction on 2026-11-03 to execute the [foundation execution runbook](../superpowers/plans/2026-11-03-foundation-execution-runbook.md) to completion. Scope stays within the runbook's permitted set: workspace files, pinned dependencies, synthetic tenancy/task/audit/outbox/idempotency/proposal migrations, fake integrations, tests, CI, developer runbooks. No clinical schema, UI, real model calls, messaging/payments/claims, production credentials or deployment.

## E0: environment and baseline — verified 2026-11-03

Host inventory (read-only): Node v24.13.1, npm 11.8.0, corepack 0.34.6, Git 2.53.0, gh present. Not on PATH: pnpm (available through corepack/npx), docker, psql, pg_ctl, supabase. WSL2 Ubuntu exists but has no PostgreSQL or Docker and sudo requires a password, so no host package install was attempted.

Database target decision: pinned `embedded-postgres` (MIT, PostgreSQL 17.11 binaries delivered as npm packages) started per test run in a temporary directory outside the repository, on a loopback port, with `persistent: false`. This is a real PostgreSQL server, not a mock. Evidence from the spike (scratchpad only, not committed):

| Check | Result |
|---|---|
| `initdb` + start | ready in ~10 s, `PostgreSQL 17.11 on x86_64-windows` |
| LOGIN NOSUPERUSER NOBYPASSRLS runtime role with RLS policy on `current_setting('app.tenant', true)` | sees only tenant rows |
| `set_config(..., true)` after `COMMIT` | context cleared, zero rows visible |

Target identity: database directory is a fresh `mkdtemp` path per run; connection is `127.0.0.1` on an ephemeral port chosen by the test harness; database name carries the synthetic marker `cuspatlas_synthetic`. No cloud project is connected. `cuspatlas-dev` (`pfnuigldoshdldetkaqk`) is recorded in SETUP.md and remains untouched; it is not a target selector for any command in this branch.

Limitations: Windows-only spike; CI must prove the Linux path. The embedded binaries are downloaded from npm at install time and pinned by the lockfile, so provenance is the npm package integrity hash. Data directory lives in the OS temp directory, never under the OneDrive-synced path.

## Batch status

| Batch | Status | Head SHA | Notes |
|---|---|---|---|
| E0 environment and baseline | verified | (this commit) | see above |
| E1 reproducible service (Task 1) | verified | bb25a6b | pnpm workspace, contracts, safe error boundary, ADR 0001 |
| E2 identity and contracts (Tasks 2–3) | verified (revision cycle 1 applied) | Task 2 013ef79; Task 3 bd2cfc7; revision see git log | exit gate met on the Windows host; Linux CI pending (Task 8) |
| E3 trustworthy mutations (Tasks 4–5) | verified | Task 4 473a748; Task 5 see git log | exit gate met on the Windows host; Linux CI pending (Task 8) |
| E4 durable integrations (Task 6) | not started | | |
| E5 programmatic control (Tasks 7–7a) | not started | | |
| E6 reproducibility and recovery (Task 8) | not started | | |

## Command log

Each batch appends exact commands, exit codes and a safe result summary. No secrets, dumps, private URLs or raw fixtures.

### E0

- `git worktree add -b codex/foundation-core <outside-OneDrive path> 6f560db` → exit 0
- Scratchpad spike: `node spike.mjs` with `embedded-postgres@17.11.0-beta.19`, `pg@8.23.1` → exit 0, output summarized in the table above

### E1 (Task 1)

Acceptance cases: `/healthz` returns exactly `{status:'ok'}`; unknown route/method returns a typed safe 404 refusal; error mapping never copies messages, stacks, SQL or payloads; the marker `SYNTHETIC_SECRET_42` placed in path, query, headers and body never reaches the response body, headers or any captured log line (logger at `trace`); unknown runtime environment refuses to build; runtime JSON Schemas for `AuditEvent`/`SecurityAttemptEvent` reject extra fields and fabricated identity.

- `corepack pnpm@10.18.3 --version` → exit 0 (corepack works without `corepack enable`; every command below is invoked as `corepack pnpm ...`)
- `corepack pnpm install` → exit 0; blocked lifecycle scripts reviewed and allowed only for `@embedded-postgres/*` and `esbuild` (`onlyBuiltDependencies`)
- Red: `corepack pnpm test -- service-boundary` before `apps/api` existed → exit 1 (`Failed to resolve entry for package "@cuspatlas/api"`)
- Green: `corepack pnpm test -- service-boundary` → exit 0, 1 file, 5 tests (the `scripts/run-vitest.mjs` wrapper strips the literal `--` so the documented filter form works)
- `rm -rf node_modules ... && corepack pnpm install --frozen-lockfile` → exit 0
- `corepack pnpm typecheck` → exit 0; `corepack pnpm lint` → exit 0; `corepack pnpm test` → exit 0, 2 files, 11 tests (contracts unit 6, service-boundary 5)
- `corepack pnpm licenses list --json` → exit 0, summarized in docs/adr/0001-runtime.md; `corepack pnpm audit` → no known vulnerabilities

Unresolved: Linux CI not yet run (Task 8). The contracts unit test was written alongside the schemas rather than strictly red-first.

### E2 / Task 2 (tenant identity and isolation)

Acceptance cases (tests/integration/tenant-isolation.test.ts, 20 tests, all under the runtime role `cuspatlas_app` except fixture seeding and read-back): pg_roles proves the runtime role is NOSUPERUSER/NOBYPASSRLS/NOINHERIT/NOCREATEDB/NOCREATEROLE; RLS enabled and forced on all five tables; no context sees zero rows; no DELETE, no membership writes, no attempt reads; A cannot read B, update B, insert into B, or re-home a row; forged resource tenant denied and recorded with authenticated identity; forged context (A1 claiming B) denied by `authorize` and by the in-transaction membership recheck before work runs; revoked membership denied, including revocation after the context was built; service principal denied a human-only policy even with the scope or a forged `principal: 'human'`; live scopes win over inflated context scopes; pooled connection reuse clean sequentially (including a session-level `set_config` smuggle and a failed transaction) and across 40 concurrent interleaved A/B transactions on a 3-connection pool; HTTP `/v1/session` derives context server-side and ignores tenant headers; expired, not-yet-valid, wrong audience, wrong issuer, bad signature, `alg: none`, malformed and missing tokens are 401 with a null-identity attempt row; revoked membership with a valid token is 403; test issuer cannot be created, and the server refuses to boot with it, outside `synthetic-test`. tests/integration/migrate.test.ts (3 tests): idempotent re-run, changed applied file refused, non-synthetic target refused.

- Red: `corepack pnpm test:integration -- tenant-isolation` before `@cuspatlas/db`/domain/policies existed → exit 1 (`Failed to resolve entry for package "@cuspatlas/db"`)
- First green attempt hung: `log_min_messages=fatal` suppressed the readiness line embedded-postgres waits for; replaced with `log_error_verbosity=terse` + `log_min_error_statement=panic`; a stray postgres.exe from the killed run was terminated by PID.
- Green: `corepack pnpm test:integration -- tenant-isolation` → exit 0, 20 tests
- Mutation check (reverted): replacing `DISCARD ALL` with a no-op and dropping the `active` check in `authorize` → 2 tests failed as expected (session smuggle; revoked-after-build)
- `corepack pnpm test` → exit 0, 4 files, 34 tests; `corepack pnpm typecheck` → exit 0; `corepack pnpm lint` → exit 0
- `corepack pnpm migrate` without `CUSPATLAS_MIGRATION_DATABASE_URL` → exit 2 (refuses; URL never printed)
- `git check-ignore` confirms `supabase/migrations/<ts>_*.sql` is tracked while other `*.sql` files stay ignored

Deviations recorded in foundation-contract-decisions.md (same commit): schema `cuspatlas`; identity-lookup setting `cuspatlas.auth_principal_id`; token claims `tid`/`sid`; attempt identity rules. Unresolved: migrate.test.ts was written after the migrator (not red-first). Supabase security advisors were not run (no cloud connection by instruction); the local equivalent is the pg_roles/RLS assertions above.

### E2 / Task 3 (versioned transport contract and authorization parity)

Acceptance cases (tests/integration/transport-policy.test.ts, 17 tests; apps/api/src/contract-drift.test.ts, 5 tests): 201 CommandResult with tenant from the token while caller tenant headers are ignored; schema rejection 400 (wrong types, null, arrays, non-JSON, truncated JSON, bad locationRef, non-JSON content type) with nothing created; unknown properties including forged `tenantId`/`tenantRef`/`version` and a marker-named key 400 with a pointer collapsed to `/`; label bounds 0/1/120/121; Idempotency-Key required and bounded; location denial 403 recorded as `location_denied`; read-only member 403 `scope_missing`; service principal creates only in its own tenant; 401 on every route without a token; hidden cross-tenant, missing and malformed refs (read and relabel) return byte-identical 404 bodies apart from the correlation id, with identical header sets, and B's row is untouched; relabel bumps version and stale `expectedVersion` is 409 with `currentVersion`; cursor pagination walks exactly the caller tenant without duplicates; unsafe limits/cursors/unknown query keys 400; location-restricted listing; the marker in labels, location refs, property names, truncated bodies, idempotency keys, path params, query params, auth headers and forwarding headers never reaches responses, headers, logs or attempt rows; security-attempt sink outage keeps the denial closed with a safe 503 and a safe alert line; the domain service called directly refuses exactly as REST does and routes mutations through the `CommandExecutor` seam. Drift check fails on an unresolved `$ref`, an undocumented or unimplemented operation, loosened `additionalProperties`/label bounds and a diverging refusal enum.

- Red: `corepack pnpm test -- transport-policy contract-drift` before the schema/domain/routes existed → exit 1 (17 transport failures, mostly 404 from unregistered routes; drift module missing)
- One test bug fixed during green: a request carrying the marker only in forwarding headers is valid and correctly returns 201; it was moved out of the error-response list and asserted separately.
- Mutation check (reverted): `additionalProperties: true` on SyntheticTaskCreate plus disabling the version comparison → 5 tests failed as expected
- Fresh: `rm -rf node_modules ... && corepack pnpm install --frozen-lockfile` → exit 0
- `corepack pnpm typecheck` → exit 0; `corepack pnpm lint` → exit 0; `corepack pnpm contract:check` → exit 0
- `corepack pnpm test` → exit 0, 6 files, 56 tests (unit: contracts 6, contract-drift 5; integration: service-boundary 5, tenant-isolation 20, migrate 3, transport-policy 17)
- `corepack pnpm test:integration` → exit 0, 4 files, 45 tests; afterwards no postgres.exe and no `cuspatlas-pg-*` temp directory remained
- `corepack pnpm audit` → no known vulnerabilities
- Housekeeping: two postgres.exe processes and three temp data directories left by the killed hung runs during Task 2 were terminated/removed by PID and exact path.

Unresolved: replay/idempotency semantics (Task 5), committed-change audit/outbox (Task 4), MCP parity (Task 7) are not implemented; the `executeDirect` executor never replays. Linux CI and Supabase advisors not run. OpenAPI is validated by the in-repo drift check, not yet by an external OpenAPI linter.

### Revision cycle 1 (independent static review of bd2cfc7)

New tests: tests/integration/review-hardening.test.ts (10) and packages/db/src/statement-guard.test.ts (2). Red run `corepack pnpm test -- review-hardening statement-guard` → exit 1: 9 of 10 integration tests failed and the guard module was missing. The deadlock case timed out at 8 s and the suite's hook then hung for 120 s, which confirms finding 1. R7 passed on the red run, because jose's `algorithms: ['EdDSA']` allowlist already rejected HS256/RS256; that test is a regression guard and was never red.

| Finding | Fix | Test |
|---|---|---|
| R1 pool self-deadlock (authorize inside a tenant transaction took a second pool connection) | location checks inside the transaction reuse the pre-transaction `authorize` decision through `assertLocation`; no nested connect | `R1 ... 2x pool-size concurrent GET-by-id and relabel requests all complete on a 2-connection pool` (8 concurrent requests, 8 s bound, 5×200 + 3×409) |
| R2 stale check ahead of the executor; refusal ordering | `stale_version` check moved inside the executor handler; auth → schema → domain for create, relabel, get and list | `a replaying executor can replay a committed relabel even when expectedVersion is now stale`; `authorization is checked before schema validation` |
| R3 statement guard keyword-only | `assertDomainStatement` also rejects `;`, `--`, `/* */`, `set_config(`, `pg_*(` | `domain statement guard` (unit, 2); isolation smuggle test now proves both the guard and `DISCARD ALL` (session temp table gone after release) |
| R4 body parsed before authentication | authentication moved to route `onRequest` hooks; `request.actor` decoration | `malformed or unsupported bodies without a token are 401 with an attempt row` |
| R5 transparent cursor | HMAC-protected, tenant-bound opaque cursor (`packages/domain/src/cursor.ts`); schema `Cursor` pattern updated (OpenAPI references it; drift check passes) | `rejects tampered cursors and cursors minted for another tenant` |
| R6 name-based test-issuer refusal | structural `isConfiguredIdentity` registry fed only by `loadConfiguredIdentity(env)`; `resolveRuntimeEnv`; `apps/api/src/server.ts` + `main.ts` (`pnpm start`) | `refuses a non-configured key source outside synthetic-test ...`; `accepts a configured key source loaded from the environment, and refuses unknown environments` |
| R7 key confusion | none needed (EdDSA allowlist) | `HS256 (keyed with the public key bytes) and RS256 tokens are 401` |
| R8 attempt insert `WITH CHECK (true)` | migration `20261104000000_review_hardening.sql`: attribution requires `cuspatlas.attempt_tenant_id`; sink sets it transaction-locally | `the runtime role cannot attribute an attempt to a tenant without the sink-scoped setting` |
| Nit: members could read every member's scopes | same migration narrows memberships/principals to own rows | `a member sees only its own membership row inside its tenant` |
| Nit: pool error handlers | `pool.on('error')` on the server pools (test pools already had them) | n/a |
| Nit: migration ignore pattern | `.gitignore` now admits only `supabase/migrations/<14 digits>_*.sql` | manual: a `1_bad.sql` stayed ignored |

Isolation tests adapted to the stricter guard: `pg_sleep` replaced with `generate_series` busy work, and the session `set_config` smuggle replaced with guard rejection plus a temp-table smuggle.

- Fresh: `rm -rf node_modules ... && corepack pnpm install --frozen-lockfile` → exit 0
- `corepack pnpm typecheck` → 0; `corepack pnpm lint` → 0; `corepack pnpm contract:check` → 0
- `corepack pnpm test` → exit 0, 8 files, 68 tests; `corepack pnpm test:integration` → exit 0, 5 files, 55 tests; no postgres.exe or temp data dir left
- `CUSPATLAS_ENV=bogus corepack pnpm start` → exit 1 with the CUSPATLAS_ENV refusal; `CUSPATLAS_ENV=development corepack pnpm start` without a database URL → exit 1 refusal
- `corepack pnpm audit` → no known vulnerabilities

Unresolved: cursor key is per process (multi-instance pagination needs a shared key; deployment decision). `server.ts` has not been started against a live database here (no non-test database exists); only its refusal paths were exercised.

### E3 / Task 4 (atomic audit and outbox)

Acceptance cases (tests/integration/atomic-events.test.ts, 15 tests): create and relabel each record exactly one task change, one audit row and one outbox row with matching correlation id, trace id, tenant, actor and aggregate version; a fault thrown after the domain write rolls back task, audit and outbox together (create and relabel); revoking the runtime role's INSERT on audit (and separately on outbox) makes the create fail with a safe 500 and nothing commits; RLS enabled and forced on both tables; under `cuspatlas_app` UPDATE/DELETE/TRUNCATE on audit and DELETE or payload UPDATE on outbox are refused (42501), only the delivery-state columns are updatable; the owner is also refused audit UPDATE by the append-only trigger; tenant B sees only B's audit/outbox rows, no context sees none, and inserts naming another tenant or actor are refused; logs captured at `trace` contain neither the marker nor payload content, and no audit/outbox row contains the marker after a create and relabel whose labels carry it; a denial raised after a domain write rolls the write back while its attempt row survives; a policy denial writes an attempt row and no audit/outbox row; an unauthenticated attempt has null tenant/actor; a forged tenant header plus another tenant's resource records the authenticated tenant, and a signed token naming a tenant without membership records a null tenant; a duplicate `attempt_ref` insert under the runtime role is refused (23505) while two retries of one business request produce two attempt rows; a sink outage keeps the denial closed with a safe 503 and alert line, and once the sink recovers the next denial is recorded.

- Red: `corepack pnpm test:integration -- atomic-events` before the migration/recordCommand existed → exit 1 (14 failed, 1 passed: the duplicate-attempt/retry case already held with the E2 sink; `relation "cuspatlas.audit_events" does not exist`)
- One test bug fixed during green: two refused statements had shared one transaction (the second saw 25P02); split into separate transactions.
- Green: `corepack pnpm test:integration -- atomic-events` → exit 0, 15 tests
- tests/integration/tenant-isolation.test.ts table inventory and default-deny lists extended with the two new tables (intentional contract change).
- `corepack pnpm typecheck` → 0; `corepack pnpm lint` → 0; `corepack pnpm contract:check` → 0
- `corepack pnpm test` → exit 0, 9 files, 83 tests; `corepack pnpm test:integration` → exit 0, 6 files, 70 tests

Crash-window limits, fail-closed handling and the outbox column grants for Task 6 are recorded in foundation-contract-decisions.md ("Task record: F Task 4"). Unresolved: trace ids are derived from the server correlation id (no OpenTelemetry/traceparent yet); Supabase advisors not run (no cloud connection by instruction); Linux CI pending (Task 8).

### E3 / Task 5 (idempotency and optimistic concurrency)

Acceptance cases (tests/integration/idempotency.test.ts, 18 tests; packages/domain/src/commands/digest.test.ts, 2 unit tests; all denial/isolation assertions under `cuspatlas_app`): reservation table RLS enabled+forced, runtime role has no DELETE/TRUNCATE and cannot update scope columns; a sequential retry replays with `replayed: true`, the same `taskRef` and a new correlation id, with exactly one task, audit and outbox row, and the row is `committed` with the independent canonical digest, a reference-only result and a 7-day TTL; a reordered identical body replays; a relabel retry does not bump the version twice; same key with a different body is 409 `idempotency_conflict` and creates nothing; the same key on another relabel target conflicts and leaves it untouched; tenant B reusing A's key gets its own fresh reservation and task in B and can never see A's rows; a service principal in the same tenant has its own scope; the runtime role cannot insert a reservation for another tenant or principal (42501); stale `expectedVersion` is 409 `stale_version` with `currentVersion`, recorded as `failed` with no audit row, and the same key replays the identical refusal after the task has moved on; a member revoked after the first call gets 403 on replay (no cached data), and after reinstatement the replay returns; a crash after commit but before the response (tenant-transaction wrapper throws after COMMIT) returns 500, and the retry with the same key replays the committed task with a single task/audit row; a `pending` reservation older than 60 s is taken over, a 5 s old one is 409 `conflict` (retryable) with nothing created; an expired reservation is not replayed; the runtime role cannot DELETE reservations, the owner-role purge removes only expired rows and refuses to run as `cuspatlas_app`; the marker used as idempotency key and label never reaches reservation rows, conflict responses or trace-level logs; concurrency (below).

Concurrency loop results (each case 5 iterations, 10 parallel identical requests, 12-connection pool): `app.inject` → every iteration 10×201, exactly 1 `replayed: false`, 1 distinct taskRef, 1 task row, 1 audit row, 1 outbox row; real listening server with `fetch` → same; identical relabels → 10×200, 1 non-replayed, version 2, exactly 2 audit rows for the task (create + one relabel); 5 concurrent same-key different-body creates → 1×201 + 4×409 `idempotency_conflict`, 1 task row. The review-hardening R1 case (8 concurrent requests on a 2-connection pool) now runs through `executeOnce` and still completes. The idempotency file was additionally run 3 more times in a row: 18/18 each time (20 concurrency iterations per case in total, no duplicate observed).

- Red: `corepack pnpm test:integration -- idempotency` with the E2 `executeDirect` default → exit 1, 18 of 18 failed (missing table; the concurrency case saw 10 non-replayed mutations instead of 1)
- Green: `corepack pnpm test:integration -- idempotency` → exit 0, 18 tests
- Mutation check (reverted): disabling the digest comparison and recording refusals without committing → 5 tests failed as expected (both conflict cases, recorded stale refusal, marker/conflict case, concurrent altered bodies)
- OpenAPI: 409 added to create (manifest and document), Idempotency-Key replay semantics documented; tenant-isolation inventory extended with `command_idempotency`.
- Fresh: `rm -rf node_modules (all workspaces) && corepack pnpm install --frozen-lockfile` → exit 0
- `corepack pnpm typecheck` → 0; `corepack pnpm lint` → 0; `corepack pnpm contract:check` → 0
- `corepack pnpm test` → exit 0, 11 files, 103 tests (unit 15, integration 88); `corepack pnpm test:integration` → exit 0, 7 files, 88 tests; no postgres.exe or `cuspatlas-pg-*` temp dir left
- `corepack pnpm audit` → no known vulnerabilities

Decisions and refinements (key stored as digest, reference-only stored results with replay codecs, terminal-refusal set, `CommitThenRefuse` + savepoint, takeover and in-flight rules, owner-role maintenance) are in foundation-contract-decisions.md ("Task record: F Task 5"). Unresolved: the digest unit test was written alongside the implementation, not red-first; the maintenance role under FORCE RLS for a non-superuser owner is deferred to ADR 0002; Linux CI and Supabase advisors not run.

### E3 hardening (independent review of 473a748..088d9d3)

Base 088d9d3; this entry is committed as "Harden E3 after independent review". Status: verified (commands below).

| Finding | Fix | Test (tests/integration/idempotency.test.ts, "E3 hardening") |
|---|---|---|
| a. Purge under FORCE RLS silently deletes 0 rows for a non-superuser, non-BYPASSRLS owner; the check only refused the name `cuspatlas_app` | `purgeExpiredCommandIdempotency` checks positively that `current_user` is superuser or BYPASSRLS (`pg_roles`) and throws otherwise | a NOLOGIN, NOSUPERUSER, NOBYPASSRLS role with SELECT/DELETE (via `SET ROLE`) gets a thrown error, the expired row survives, then the superuser purge removes it; the existing `cuspatlas_app` refusal still holds |
| b. A duplicate blocked on an uncommitted reservation waited without bound | transaction-local `lock_timeout` (default 10 s, `createTenantTransactionRunner(pool, { lockTimeoutMs })`) set by the db layer in its existing parameterized `set_config` statement (statement guard unchanged); SQLSTATE 55P03 mapped to retryable 409 `conflict` in `executeOnce` (reservation) and `withTenantTransaction` (any other wait) | default inside a tenant transaction is `10s` and the released connection is back to `0`; a reservation held open by another transaction makes a duplicate return 409 `{code: conflict, retryable: true}` in < 5 s (bound 400 ms in the test) with nothing created, and the same key succeeds once the holder rolls back |
| c. Migration comment claims the audit trigger blocks the owner | task record corrected in foundation-contract-decisions.md (Task 4 record); the `COMMENT ON TRIGGER` correction ships in the Task 6 migration (applied migrations are immutable) | n/a (documentation) |
| d. Missing test: different keys, same `expectedVersion` | none needed (relabel locks the task row before the reservation) | 5 iterations of two concurrent relabels with different keys: exactly one 200 and one 409 `stale_version` with `currentVersion: 2`, final version 2, exactly one relabel audit row |

- Red: `corepack pnpm test:integration -- idempotency` before the fixes → exit 1, 3 failed / 19 passed of 22 (purge returned without error; lock_timeout was `0`; the held-reservation duplicate hung until the 30 s test timeout). Case d passed on the red run (regression guard, never red).
- Green: `corepack pnpm test:integration -- idempotency` → exit 0, 22 tests
- `corepack pnpm typecheck` → 0; `corepack pnpm lint` → 0; `corepack pnpm contract:check` → 0
- `corepack pnpm test` → exit 0, 11 files, 107 tests; `corepack pnpm test:integration` → exit 0, 7 files, 92 tests

Unresolved: the concrete maintenance role outside tests (BYPASSRLS role vs. dedicated maintenance policy) remains an ADR 0002 decision; the check only guarantees a loud failure.

### E4 / Task 6 (durable worker with fresh policy)

Base 19abaa0 (E3 hardening). Status: verified (commands below). Files: apps/worker/src/{lease,dispatch,backoff,index}.ts, apps/worker/src/backoff.test.ts, packages/domain/src/integrations/adapter.ts, tests/integration/support/fake-provider.ts (synthetic, in-memory, no network), supabase/migrations/20261104030000_worker_delivery.sql, tests/integration/worker-recovery.test.ts. Lease-role decision and all shapes: foundation-contract-decisions.md ("Task record: F Task 6").

Acceptance cases (tests/integration/worker-recovery.test.ts, 17 tests; backoff.test.ts, 2 unit tests; every isolation/denial assertion runs as `cuspatlas_app`): receipts table RLS enabled+forced, runtime role has INSERT but no UPDATE/DELETE/TRUNCATE on receipts, UPDATE on `dead_letter_reason` only among the new columns, still no UPDATE on payload/tenant/actor/max_attempts; the audit trigger carries the corrected `COMMENT ON TRIGGER` (E3 hardening item c); happy path delivers once with one receipt and is never leased again; provider `duplicate` finalizes delivered with one receipt and one effect; worker crash after provider success but before acknowledgement (finalize transaction dies) leaves the event leased, and after lease expiry the next worker reconciles by delivery key and finalizes `reconciled` with 1 provider call and 1 effect against a NON-idempotent fake (x5); lease expires mid-flight after acceptance, the successor reconciles without sending and the late acknowledgement gets `lease-lost` and changes nothing, 1 receipt (x5); two workers racing on the same ready event lease it once, 1 call, 1 effect (x10); out-of-order receipts (attempt 2 accepted before attempt 1 arrives; attempt 1 then gets `duplicate`) give 1 effect, 1 receipt row (attempt 2) and an unchanged final row (x5); timeout after acceptance goes to `reconciliation`, stays there while lookup is unavailable, then finalizes from the receipt with no resend; an adapter that throws after acceptance is treated as unknown, not as not sent; membership revoked after enqueue gives `denied`, no provider call, dead letter `membership_revoked`, and a security attempt row (tenant alpha, the event actor, `syntheticTasks.create`, `membership_inactive`); a scope downgrade after enqueue gives `authorization_denied`; a revoked worker principal cannot lease and the event stays pending; 5 retryable failures give retry x4 then dead letter `max_attempts_exhausted` at attempt 5, the row is not leased again and stays visible through `listDeadLetters` under the runtime role with the payload kept; the default backoff defers the retry and a non-retryable failure gives `provider_rejected`; a worker in tenant A's context leases only A's events, sees/updates 0 of B's events and 0 of B's receipts, inserting a receipt naming tenant B fails 42501 and an A receipt pointing at a B event fails 23503 (tenant-consistent FK); the A-only worker principal cannot open a B context and its attempt row has a null tenant (not fabricated); a marker in payload field names reaches the fake provider but never the worker log lines, receipts, attempt rows or outbox state columns.

- Red: `corepack pnpm test:integration -- worker-recovery` with the Task 6 migration withheld → exit 1, 17 of 17 failed (`relation "cuspatlas.delivery_receipts" does not exist` / `column "dead_letter_reason" does not exist`). Honest note: the worker and adapter code were written before this test file, so this red shows the schema dependency, not test-first behavior. The mutation checks below are the stronger evidence.
- Mutation check 1 (reverted): reconciliation step disabled + lease fence removed + fresh reauthorization skipped → 7 of 17 failed as expected (crash, lease expiry, out-of-order, timeout, adapter-throw, revoked, downgraded)
- Mutation check 2 (reverted): `FOR UPDATE SKIP LOCKED` removed from the lease → the two-worker race failed (both workers leased and delivered)
- Green: `corepack pnpm test:integration -- worker-recovery` → exit 0, 17 tests; repeated 3 more times → 17/17 each time (race cases: 20 crash, 20 lease-expiry, 40 two-worker, 20 out-of-order iterations in total, no duplicate effect observed)
- tests/integration/tenant-isolation.test.ts inventory and default-deny lists extended with `delivery_receipts` (intentional contract change). New action/scope `outbox.deliver` (service principals only) added to the policy table.
- Lockfile: new workspace importer `apps/worker` and the integration-test link (`corepack pnpm install --offline`, no registry packages added)
- `corepack pnpm typecheck` → 0; `corepack pnpm lint` → 0; `corepack pnpm contract:check` → 0
- `corepack pnpm test` → exit 0, 13 files, 126 tests; `corepack pnpm test:integration` → exit 0, 8 files, 109 tests

Unresolved: the aggregate location is not rechecked at delivery (field-names-only payload); tenant iteration/scheduling of the per-tenant worker and an operator re-drive path for dead letters are not implemented; no real provider (none authorized); Linux CI and Supabase advisors not run.
### E5 / Task 7 (MCP parity on the synthetic domain)

Acceptance cases (tests/integration/mcp-parity.test.ts, 93 tests; apps/mcp/src/tool-drift.test.ts, 5 unit tests). A table-driven harness runs 78 operation x case rows through REST (`app.inject`) and through the SDK client against a real Streamable HTTP listener on `port: 0`, and asserts the same status-equivalent, `code`, `retryable` and refusal shape (plus a security-attempt row for every 401/403/404 on both sides, with null tenant/actor for 401). Rows: allowed (create/list/get/relabel), unauthorized tenant, revoked member, insufficient scope (including an invalid payload from a read-only caller: 403 before schema), location denial (create/get/relabel), hidden cross-tenant and missing tasks (404, byte-identical body apart from the correlation id), 14 schema violations (label of 121 chars, unknown property, missing/invalid `idempotencyKey`, bad cursor, version 0), stale version (409), and ten token failures on all four operations (missing, garbage, expired, not-yet-valid, wrong issuer, foreign key, `alg:none`, HS256, REST-audience token at MCP / MCP-audience token at REST, malformed audience). Protocol tests: `tools/list` returns exactly the four tools and only the `tools` capability; unknown tool is a protocol error that does not echo the name; 401 carries a Bearer challenge with `resource_metadata` and RFC 9728 metadata is served; browser Origin 403, GET/DELETE 405, wrong path 404, body over 16 KiB 413; the server refuses to start with the REST audience or a test issuer outside synthetic-test. Idempotency: MCP replay returns the same taskRef with `replayed: true`; a REST replay of an MCP-created key (and the reverse) replays; same key with another payload is 409 `idempotency_conflict` on both; keys are not shared across principals or tenants; a relabel retry does not bump the version twice; a member revoked after the first call is denied on replay. Privacy: the marker in label, idempotency key (valid and invalid), cursor, unknown property name, taskRef and bearer token appears in no tool error, attempt row, header or log line; tool log lines carry only level, msg, tool, actorId, correlationId and code.

- Red: `corepack pnpm test:integration -- mcp-parity` before `apps/mcp/src/server.ts` existed -> exit 1 (suite failed to load: `Cannot find module './server'`, 0 tests). The drift unit test was written after the tool definitions, not red-first.
- First green attempt: 89/93; failures were a harness bug (unknown list query params not forwarded to REST), an over-strict `detail` comparison for the idempotency key (header on REST, argument on MCP; differs by design, flagged `detailMayDiffer`), and the 401 challenge lacking `resource_metadata` (the server now derives it from its listen address unless configured).
- Green: `corepack pnpm test:integration -- mcp-parity` -> exit 0, 93 tests
- Fresh: `rm -rf node_modules (all workspaces) && corepack pnpm install --frozen-lockfile` -> exit 0
- `corepack pnpm typecheck` -> 0; `lint` -> 0; `contract:check` -> 0
- `corepack pnpm test` -> exit 0, 13 files, 201 tests (unit 20, integration 181); `corepack pnpm test:integration` -> exit 0, 8 files, 181 tests; no postgres process left
- `corepack pnpm audit` -> no known vulnerabilities

Decisions are in foundation-contract-decisions.md ("Task record: F Task 7"). SDK `@modelcontextprotocol/sdk` 1.32.2 (exact), MCP authorization revision 2025-06-18. Outside apps/mcp: `tests/integration/package.json` gained `@cuspatlas/mcp` and the SDK as devDependencies (the in-process client), plus `pnpm-lock.yaml`.

Unresolved: no authorization server, dynamic client registration or consent (token validation only); the MCP stateless server has no runnable entrypoint/`main.ts` yet and was exercised only through tests on synthetic databases; no rate limiting on the MCP endpoint; the Origin and 405/413/404 transport refusals are not recorded as security attempts (they occur before identity); Linux CI and Supabase advisors not run.

### Task 8 part 1: CI and supply chain

Base c34688e (Tasks 1-7 integrated). Status: configured and locally tested on Windows; the Linux/GitHub run is NOT verified (it cannot run here). Files: `.github/workflows/ci.yml`, `scripts/privacy-scan.mjs`, `scripts/sbom.mjs`, `scripts/test-summary.mjs`, `docs/runbooks/development.md`, `package.json` scripts (`sbom`, `scan:privacy`, `ci`; no dependency changes), `.gitignore` (`artifacts/`).

Workflow: triggers `pull_request` and push to `main`/`codex/**`; `permissions: contents: read`; no secrets, no `pull_request_target`; concurrency cancel-in-progress; `verify` on `ubuntu-24.04` (30 min) runs frozen install, typecheck, lint, contract:check, test (embedded PostgreSQL), count-only test summary, scan:privacy, sbom, an artifact scan (`node scripts/privacy-scan.mjs artifacts`, no allowlist, fails if the marker is present), then uploads SBOM, evidence-manifest skeleton and test summary (14 days). `windows-smoke` on `windows-2022` (30 min) runs install and `test:integration -- service-boundary`, required. Pinned actions: actions/checkout v7.0.1 `3d3c42e5aac5ba805825da76410c181273ba90b1`; pnpm/action-setup v6.1.1 `73e46992e05b19abd31f2f3c20e0e7370d762115`; actions/setup-node v7.1.0 `949feb2413d6458794dcd2491c4babbbce0c15c1`; actions/upload-artifact v7.0.2 `cf430e030ddbb5b0abf93d22962f4752f3646cd9` (SHAs resolved with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, annotated tags dereferenced). Node `24.x` (no `.nvmrc` exists; engines are `>=24.13 <25`). Linux binaries: `@embedded-postgres/linux-x64@17.11.0-beta.19` is in the lockfile. Branch protection is deliberately not configured; a human must require the checks after the first run.

Decision: the raw Vitest JSON report contains test titles, and one title legitimately names the marker (`keeps SYNTHETIC_SECRET_42 out of ...`). The first artifact scan caught exactly that (exit 1), so the uploaded `test-summary.json` is reduced by `scripts/test-summary.mjs` to counts and per-file status; the raw report stays in `runner.temp` and is not uploaded. The marker allowlist also includes `docs/ACCEPTANCE-SCENARIOS.md` (it specifies the marker test; found on the first scan). The development project ref is allowed in `docs/superpowers/**` too (it already appears there).

Commands and results (Windows, local):
- `corepack pnpm install --frozen-lockfile --offline --force` -> 0 (the worktree had stale workspace links for `apps/worker`; typecheck was failing before this and unrelated to these changes)
- `node --check` on the three scripts -> 0; YAML parse of ci.yml with the lockfile's `yaml@2.9.1` -> parses, jobs `verify` and `windows-smoke`
- `corepack pnpm scan:privacy` -> exit 0 (134 tracked files)
- Scan self-test: temp file containing the marker, `node scripts/privacy-scan.mjs <tmp>/fixture.txt` -> exit 1, `fixture.txt:1: synthetic-marker`; a temp directory with a credentialed postgres URL -> exit 1, `f2.txt:2: credentialed-database-url`; the unreduced test report as an argument -> exit 1 (`test-summary.json:1: synthetic-marker`)
- `corepack pnpm sbom` -> exit 0: 270 components, CycloneDX 1.5, root component `cuspatlas@0.0.0` with the commit property, purls like `pkg:npm/%40embedded-postgres/linux-x64@17.11.0-beta.19`; 66 components have no license entry because `pnpm licenses` sees only the installed (Windows) tree and they are recorded as NOASSERTION; `artifacts/evidence-manifest.json` is the skeleton with `controls: []` (AS-01..AS-04 are populated by the restore/evidence task)
- Artifact set check: `node scripts/privacy-scan.mjs artifacts` -> exit 0 and `grep -rIl SYNTHETIC_SECRET_42 artifacts` -> exit 1 (no match)
- `corepack pnpm typecheck` -> 0; `corepack pnpm lint` -> 0; `corepack pnpm contract:check` -> 0; `corepack pnpm test` -> exit 0, 15 files, 224 tests
- `corepack pnpm run ci` (same chain without the artifact upload) -> exit 0. Note: bare `pnpm ci` is reserved by pnpm and fails with ERR_PNPM_CI_NOT_IMPLEMENTED; use `pnpm run ci`.

Unresolved/unverified: the GitHub Actions run (Linux embedded PostgreSQL, Windows smoke, cache, artifact upload, the `--outputFile.json` reporter flag on the runner) is pending the first push; branch protection; no Dependabot configuration; no license data for foreign-platform optional packages; `pnpm audit` was not rerun in this part.

Correction (follow-up commit): the "scan:privacy exit 0 (134 tracked files)" result above was taken while the new files were still untracked, so `git ls-files` did not include them. On the committed tree (da0aa1b) the scan exited 1 with 4 findings: the literal marker in ci.yml and in the runbook, and two credential-shaped placeholder database URLs in the runbook. Fixes: the workflow's raw grep was removed (the scanner, which checks arguments without an allowlist, is the artifact check; the marker is defined only in allowlisted `tests/integration/support/marker.ts`); the runbook no longer spells the marker and its database URL examples carry no password (`PGPASSWORD` instead). The scanner stays strict (no placeholder exemption). Re-run results are in the next lines.
