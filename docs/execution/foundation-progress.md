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
| E1 reproducible service (Task 1) | not started | | |
| E2 identity and contracts (Tasks 2–3) | not started | | |
| E3 trustworthy mutations (Tasks 4–5) | not started | | |
| E4 durable integrations (Task 6) | not started | | |
| E5 programmatic control (Tasks 7–7a) | not started | | |
| E6 reproducibility and recovery (Task 8) | not started | | |

## Command log

Each batch appends exact commands, exit codes and a safe result summary. No secrets, dumps, private URLs or raw fixtures.

### E0

- `git worktree add -b codex/foundation-core <outside-OneDrive path> 6f560db` → exit 0
- Scratchpad spike: `node spike.mjs` with `embedded-postgres@17.11.0-beta.19`, `pg@8.23.1` → exit 0, output summarized in the table above
