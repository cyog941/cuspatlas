# Development runbook (synthetic foundation)

Status: planned and locally tested on Windows only. The Linux CI workflow is configured but has not run yet. Nothing here authorizes deployment, real patient data, or a Supabase cloud connection. Passing tests is not deployment or PHI authorization.

## Prerequisites

- Node.js 24.x (`engines`: `>=24.13 <25`).
- Corepack (ships with Node). It supplies the pinned pnpm (`packageManager`: `pnpm@10.18.3`).
- Git. No Docker, no installed PostgreSQL, no Supabase CLI, no cloud account.

## Clean checkout, Windows (Git Bash or PowerShell) and Linux

```
git clone <repository-url> cuspatlas
cd cuspatlas
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm contract:check
corepack pnpm test
corepack pnpm scan:privacy
corepack pnpm sbom
```

`corepack enable` may need an elevated shell on some Windows installs; prefixing every command with `corepack` (as above) avoids it. `--frozen-lockfile` fails if the lockfile and manifests disagree; never bypass it. After switching branches that add workspaces, rerun the install (add `--offline` if the store is warm) so workspace links exist.

`corepack pnpm run ci` (the explicit `run` is required; bare `pnpm ci` is reserved by pnpm) runs the same verification chain locally (typecheck, lint, contract check, tests, privacy scan, SBOM).

## Embedded PostgreSQL

Integration tests start one real PostgreSQL 17 server per run through the `embedded-postgres` package (`tests/integration/support/global-setup.ts`):

- data directory in the OS temp folder, created per run, `persistent: false` (removed on stop);
- bound to `127.0.0.1` on a free port, per-run random passwords, never reachable off the machine;
- the migrations are applied once to a template database; each test file clones it into a database whose name contains `cuspatlas_synthetic`;
- the server log keeps statement text out (`log_min_error_statement=panic`).

On Linux the binaries come from `@embedded-postgres/linux-x64` (in the lockfile). `initdb` refuses to run as root, so run tests as a normal user (the GitHub runner user is non-root). On Windows the `windows-x64` binary is used.

## Running one suite

The wrapper `scripts/run-vitest.mjs` drops a literal `--`, so a filter goes after it:

```
corepack pnpm test -- tenant-isolation          # any file name fragment, both projects
corepack pnpm test:integration -- service-boundary
```

## Migrator against a disposable database

```
CUSPATLAS_MIGRATION_DATABASE_URL='postgres://<admin-user>@127.0.0.1:<port>/cuspatlas_synthetic_scratch' PGPASSWORD='<set-in-shell>' corepack pnpm migrate
```

(PowerShell: set `$env:CUSPATLAS_MIGRATION_DATABASE_URL` first.) The migrator refuses any target whose database name does not contain `cuspatlas_synthetic` (`packages/db/src/migrate.ts`). This is deliberate: a mistyped or copied production URL cannot be migrated. Point it only at a throwaway local database you created; never at a hosted project.

## Environment variables read by the API, MCP server and worker

Placeholders only. Never commit real values; `.env*` is gitignored.

| Variable | Read by | Meaning |
| --- | --- | --- |
| `CUSPATLAS_ENV` | API, MCP, worker | `synthetic-test`, `development` or `production`; anything else is refused. Integration tests set `synthetic-test`. |
| `CUSPATLAS_DATABASE_URL` | API, worker | runtime-role connection string (`postgres://<runtime-role>@127.0.0.1:5432/<db>`, password via `PGPASSWORD`) |
| `CUSPATLAS_ATTEMPT_DATABASE_URL` | API, worker | optional separate connection for security-attempt rows; defaults to the one above |
| `CUSPATLAS_HOST` | API | listen address, default `127.0.0.1` |
| `CUSPATLAS_PORT` | API | listen port, default `3000` |
| `CUSPATLAS_JWT_ISSUER` | API (`apps/api/src/auth.ts`) | expected token issuer, e.g. `https://issuer.example.invalid` |
| `CUSPATLAS_JWT_AUDIENCE` | API | expected REST audience, e.g. `cuspatlas-api` |
| `CUSPATLAS_JWT_PUBLIC_KEY_PEM` | API, MCP | PEM public key used to verify tokens (public key only) |
| `CUSPATLAS_MCP_AUDIENCE` | MCP (`apps/mcp/src/auth.ts`) | MCP resource identifier; required and must differ from `CUSPATLAS_JWT_AUDIENCE` |
| `CUSPATLAS_MIGRATION_DATABASE_URL` | migrator | see above |
| `CUSPATLAS_IDEMPOTENCY_DIGEST_KEY` | API, worker | base64, at least 32 bytes (`<base64-32-bytes>`): the keyed payload digest of idempotency records. Required outside `synthetic-test`; the test-only key is refused there. |
| `CUSPATLAS_CURSOR_KEY` | API | base64, at least 32 bytes: the HMAC key of every list cursor, shared by all instances so cursors survive restarts. Required outside `synthetic-test`; the test-only key is refused there. |
| `CUSPATLAS_CURSOR_KEY_PREVIOUS` | API | base64, optional: the previous cursor key during a rotation; accepted for decoding only, never for minting. |
| `CUSPATLAS_MATCH_KEY_PEPPER` | API, worker | base64 (`<base64-32-bytes>`): S4 match-key pepper (patient matching, E7 send-time contact verification). Required outside `synthetic-test`; the test-only pepper is refused there. |
| `CUSPATLAS_IMAGING_TOKEN_SECRET` | API, worker | base64, at least 32 bytes (`<base64-32-bytes>`): I1 read-grant secret. Optional; without it outside `synthetic-test` imaging read grants are a typed 503. The test-only secret is refused outside `synthetic-test`. |
| `CUSPATLAS_BRIDGE_SIGNING_KEY_PEM` | API, worker | Ed25519 PKCS8 private key PEM (`<ed25519-pkcs8-pem>`): I6 job-signing key. Optional; `synthetic-test` uses an ephemeral key, elsewhere bridge claims are a typed 503 without it. |
| `CUSPATLAS_OBJECT_STORE_DIR` | API, worker | local synthetic object store root (`<absolute-scratch-dir>`); the local adapter is refused under `production`. The worker's imaging reconcile is disabled without it. |
| `CUSPATLAS_WORKER_PRINCIPAL_ID` | worker | the worker's service principal (`<service-principal-uuid>`); its membership in each served tenant needs `outbox.deliver`, `exports.build`, `billing.write`, `communications.deliver`, `admin.configure` and (for backup verification) `migration.write` for every consumer to run (a missing scope is a recorded denial, never a bypass). |
| `CUSPATLAS_WORKER_TENANT_IDS` | worker | comma-separated tenant UUIDs the worker serves (`<tenant-uuid>,<tenant-uuid>`); there is no cross-tenant listing. |
| `CUSPATLAS_MAINTENANCE_DATABASE_URL` | worker | optional privileged connection (a role that bypasses RLS) for the idempotency purge and the patient-reference observation prune; without it maintenance is disabled with a logged reason. |
| `CUSPATLAS_WORKER_INTERVAL_MS` | worker | pause between ticks, default `5000` (100 to 3600000). |
| `CUSPATLAS_BACKUP_LOCATION` | worker | optional M9 backup to verify (`<absolute-backup-dir>`): a `pnpm backup` output directory, or a directory of them whose newest manifest wins. Without it backup verification is disabled and the worker logs `{"msg":"backup_verification_disabled","reason":"backup_location_not_configured"}` once. |
| `CUSPATLAS_RESTORE_ADMIN_DATABASE_URL` | worker, restore CLI | loopback maintenance database the isolated sample restore is created from (`postgres://<admin-user>@127.0.0.1:<port>/postgres`, password via `PGPASSWORD`); the sample is a new `cuspatlas_synthetic_backup_verify_*` database, dropped afterwards. Without it (and a location) the worker logs reason `restore_target_not_configured`. |
| `CUSPATLAS_BACKUP_VERIFY_INTERVAL_SECONDS` | worker | backup verification cadence, default `43200`, 60 to 86400 (the readiness freshness window). Due-ness comes from each tenant's last recorded verification, so a restart does not re-run early. |

Audiences: the REST audience is `CUSPATLAS_JWT_AUDIENCE`; the MCP audience `CUSPATLAS_MCP_AUDIENCE` must differ from it, and the portal audience (configured in code by the API/MCP builders) must differ from both; the I6 bridge audience is the fixed `urn:cuspatlas:bridge:v1`. The worker verifies no tokens and needs none of them.

The MCP server also refuses to start with the REST audience or a test issuer outside `synthetic-test`. Cursor signing (HMAC) uses a key generated per process, so cursors do not survive a restart or work across instances; this is a known limitation.

## Worker (`corepack pnpm start:worker`)

`apps/worker/src/main.ts` composes the worker from the environment (`composeWorker` in `apps/worker/src/compose.ts`) with the API's startup rules: `CUSPATLAS_ENV` must be known, secrets go through the same domain resolvers (test-only values and missing required secrets are refused outside `synthetic-test`), and every database name must carry the `cuspatlas_synthetic` marker. It then ticks until SIGINT/SIGTERM; the tick in progress completes before the pools close. Each tick, per served tenant and under the worker principal (authorized freshly by the domain):

- F6 outbox: deferred proposal execution and C14 -> B procedure consumption (always on); CL-08 claim workflow timers (only with a clearinghouse); every other event to the delivery adapter (only with one). Without an adapter only the in-process aggregates are leased, so nothing waits on, or is handed to, an adapter that does not exist.
- E7 outbound messages (only with a messaging provider).
- E10 reply escalation (always on, needs `communications.deliver`): overdue needs-reply episodes escalate to the practice manager queue once per episode through `messaging.threads.escalate`, using each queue's reply-due policy, without a staff read; no read receipt is recorded and the thread is not changed.
- A15 export builds (`exports.build`, only with `CUSPATLAS_OBJECT_STORE_DIR` and an imaging token secret; needs its own worker scope `exports.build`, never granted to an agent): `exports.create` only records the request (`building`) and the caller polls `exports.read`. The worker leases each building request (a fenced attempt; an expired lease is taken over once), builds it as the requester's live membership (re-authorized for `exports.create` and every module export; a revoked requester fails it as `requester_inactive`), and promotes the package bytes under the imaging content lock, so the orphan-bytes sweep keeps them.
- `imaging.storage.reconcile` (only with `CUSPATLAS_OBJECT_STORE_DIR`): integrity sweep, abandoned ingress and staging, I7 bridge lease sweep, expired device nonces.
- Maintenance (only with `CUSPATLAS_MAINTENANCE_DATABASE_URL`): expired idempotency records, finished patient-reference observations.
- M9 backup verification (only with `CUSPATLAS_BACKUP_LOCATION` and `CUSPATLAS_RESTORE_ADMIN_DATABASE_URL`): when a served tenant's last recorded verification is older than `CUSPATLAS_BACKUP_VERIFY_INTERVAL_SECONDS`, the latest backup is verified once (manifest digests and an isolated sample restore) and recorded for each due tenant through `operations.backupVerifications.record`. A verification that cannot run is recorded as failed, never passed.

No real delivery adapter, messaging provider, clearinghouse or payment processor exists (E-S1 and the B partner/processor choices are open). Fakes can be supplied only in-process by tests (`syntheticProviders`) and are refused outside `synthetic-test`; started from the command line the worker therefore logs `worker_consumer_disabled` with a reason for outbox delivery, outbound messages and claim workflow timers and never sends anywhere. Log lines are JSON with fixed codes only. Example (placeholders only):

```sh
CUSPATLAS_ENV=development \
CUSPATLAS_DATABASE_URL='postgres://<runtime-role>@127.0.0.1:<port>/cuspatlas_synthetic_dev' \
CUSPATLAS_IDEMPOTENCY_DIGEST_KEY='<base64-32-bytes>' CUSPATLAS_MATCH_KEY_PEPPER='<base64-32-bytes>' \
CUSPATLAS_WORKER_PRINCIPAL_ID='<service-principal-uuid>' CUSPATLAS_WORKER_TENANT_IDS='<tenant-uuid>' \
PGPASSWORD='<set-in-shell>' corepack pnpm start:worker
```

Tests boot the same composition in-process against the test database (`tests/integration/worker-main.test.ts`); no separate OS process is started.

## Privacy scan

`corepack pnpm scan:privacy` (`scripts/privacy-scan.mjs`) scans every tracked file, plus any file or directory passed as an argument, for: the synthetic marker string (exported from `tests/integration/support/marker.ts`, never spelled in docs or workflows) outside its allowlist (tests, execution and planning docs, the acceptance-scenario doc, the contracts tests, the script itself); private-key blocks; JWT-looking strings; service-role-like keys; database URLs that embed credentials; and the development project reference outside `docs/SETUP.md`, `docs/DEEPSEEK-HANDOFF.md` and the execution and planning docs. It prints `file:line: rule` and exits 1 on any hit; it never prints the matched text. Arguments are scanned with no allowlist, which is how CI checks the artifact directory:

```
corepack pnpm scan:privacy                       # tracked tree
node scripts/privacy-scan.mjs artifacts          # generated evidence
```

It is a tripwire, not a guarantee. It does not replace review, and it does not detect all PHI.

## SBOM and evidence manifest

`corepack pnpm sbom` writes (gitignored) `artifacts/sbom.cdx.json` (CycloneDX 1.5, components from `pnpm-lock.yaml`, licenses from `pnpm licenses list`, root component carrying the git commit as a property) and `artifacts/evidence-manifest.json`. `sbom` writes the manifest as a skeleton; `corepack pnpm evidence` then populates it with the AS-01..AS-04 controls and signs it, and `corepack pnpm evidence-verify` checks it (see "Backup, restore and evidence" below). Components for other platforms' optional binaries have no license entry because `pnpm licenses` only sees the installed tree; they are marked `NOASSERTION`, not guessed.

## Backup, restore and evidence

- `corepack pnpm backup -- --out <dir>` and `corepack pnpm restore -- --backup <dir> --target <name> --confirm-target <name>`: logical backup and guarded restore into a new disposable synthetic database. Procedure, target guard and limits: [restore runbook](restore.md). Deployment and role model: [ADR 0002](../adr/0002-deployment.md).
- `corepack pnpm evidence` (`scripts/evidence.mjs`) and `corepack pnpm evidence-verify` (`scripts/evidence-verify.mjs`): signed AS-01..AS-04 evidence manifest from [docs/assurance/controls.json](../assurance/controls.json); review claims are checked against [docs/assurance/reviewers.md](../assurance/reviewers.md). Both run in `corepack pnpm run ci` after `sbom`; they need `artifacts/test-summary.json`, which `run ci` produces.

## What CI runs and why it is least privilege

`.github/workflows/ci.yml`, on pull requests and pushes to `main` and `codex/**`:

- `verify` (ubuntu-24.04): frozen install, typecheck, lint, contract drift check, the full test suite (integration against embedded PostgreSQL), a count-only test summary, privacy scan, SBOM, a marker scan of the generated artifacts, then upload of the SBOM, evidence manifest skeleton and test summary (14 days retention).
- `windows-smoke` (windows-2022): frozen install and the `service-boundary` integration suite only.

Controls: workflow `permissions: contents: read`; no secrets are referenced; no `pull_request_target`; checkout does not persist credentials; every action is pinned by full commit SHA with a version comment; the runner images are pinned; each job has a timeout; a new push cancels older runs of the same ref. Branch protection and required checks are not configured here: a repository admin must do that after the checks have run at least once.

Dependabot or manual SHA bumps must be reviewed like any other supply-chain change.

## Known limitations

- Evidence so far is Windows-only and local. The Linux run is unverified until the first push triggers CI.
- No Supabase cloud connection, Supabase advisors, deployment, or real provider exists.
- Cursor HMAC key is per process (see above).
- The privacy scan and SBOM are partial controls (see above); the artifact scan guards only the three uploaded files.
- Passing tests, a green CI run, or an SBOM is not authorization to deploy, to hold PHI, or a compliance or clinical-validation claim.
