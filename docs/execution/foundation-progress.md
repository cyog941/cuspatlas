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
| E2 identity and contracts (Tasks 2–3) | in progress (Task 2 verified, Task 3 in progress) | see E2 log | |
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
