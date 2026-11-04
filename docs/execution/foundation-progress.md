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
| E3 trustworthy mutations (Tasks 4–5) | not started | | |
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
