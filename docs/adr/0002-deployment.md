# ADR 0002: Synthetic deployment, database roles and backup model

Status: proposed by the F Task 8 implementation, 2026-11-04; not yet accepted by a human maintainer. Evidence category: configured and tested on one Windows host; the Linux CI run is pending the first push. This ADR describes how the synthetic foundation is run and tested. Nothing here is a PHI-ready, staging or production deployment, and nothing here authorizes one.

## Context

The foundation needs a reproducible way to run its guarantees against real PostgreSQL without Docker, a Supabase CLI stack or a cloud connection (runbook E0), and Tasks 5 and 6 deferred two questions here: which role runs privileged maintenance under FORCE row level security, and how backups and restores are taken and proved.

## Decision

### Deployment model (synthetic only)

- Tests: one embedded PostgreSQL 17.11 server per integration run (`embedded-postgres`, ADR 0001), data directory in the OS temp folder, `listen_addresses=127.0.0.1`, per-run random passwords, `persistent: false`. Migrations are applied once to a template database; each test file clones it into a database named `cuspatlas_synthetic_*`. The restore test may start a second throwaway cluster the same way.
- Local development: any disposable local PostgreSQL 17 database whose name contains `cuspatlas_synthetic`; the migrator, backup and restore refuse other names.
- The REST server (`pnpm start`, `apps/api/src/main.ts`) and the MCP server exist as code paths but were exercised only through tests (`app.inject` and an in-process listener on `port: 0`). No long-running deployment of either exists.
- Supabase: the development project recorded in SETUP.md is not used by this code. Mapping to Supabase Auth, PostgREST exposure and Supabase-managed backups need their own ADR and security-advisor review.

### Role separation

| Role | Attributes | Used for | Never used for |
|---|---|---|---|
| Owner / migration role (superuser of the embedded cluster in tests; a named owner role elsewhere) | owns schema `cuspatlas` | applying migrations, fixture seeding in tests, backup and restore | application requests, workers, MCP |
| Runtime role `cuspatlas_app` | LOGIN, NOSUPERUSER, NOBYPASSRLS, NOINHERIT, NOCREATEDB, NOCREATEROLE, NOREPLICATION; explicit table and column grants only | API, MCP, worker (per tenant under its own service principal), security-attempt sink | DDL, maintenance, backup |
| Maintenance role `cuspatlas_maintenance` (recommended, not created yet) | NOLOGIN by default, NOSUPERUSER, BYPASSRLS, NOCREATEDB, NOCREATEROLE; granted only what each job needs | idempotency retention purge (`purgeExpiredCommandIdempotency`), backups | requests, DDL, restore into other databases |

Maintenance-role decision (resolves the Task 5 and Task 6 deferral): outside tests, privileged maintenance runs as a dedicated `cuspatlas_maintenance` role with BYPASSRLS whose reach is limited by grants (for the purge: `USAGE` on the schema, `SELECT, DELETE` on `cuspatlas.command_idempotency` only; for backups: `SELECT` on the schema's tables and on `public.schema_migrations`), so a leaked maintenance credential cannot write domain tables or change the schema. BYPASSRLS is required because the tables use FORCE RLS and the alternative, a maintenance-specific RLS policy per table, would put a cross-tenant policy next to every tenant policy and is easier to widen by accident. The code already checks this positively (superuser or BYPASSRLS, otherwise a loud error) in the purge, the backup and the restore. In the embedded test cluster the superuser plays this role; no migration creates `cuspatlas_maintenance` yet, because creating a BYPASSRLS role is a deployment act that needs an accountable operator. Restore additionally needs CREATEDB and is an operator action, not a scheduled job.

### Backup and restore model

- Backup: logical, versioned (`cuspatlas-logical-backup/1`), one snapshot, every table of schema `cuspatlas`, per-table count and content digest, applied migrations with checksums, catalog fingerprint; no external binary (`pg_dump` is not shipped with the pinned binaries and host installs are out of scope). Details: docs/runbooks/restore.md.
- Restore: only into a new disposable database behind the target guard (explicit confirmed target, synthetic name, loopback host, not the source, not existing, digests, matching migrations, runtime role present and safe); schema from the reviewed migrations; data loaded with all constraints active; verification of counts, digests, catalog, migrations, forced RLS and runtime-role default deny. A missing runtime role is refused, not created.
- Restored pending external work does not blindly repeat: the worker's lease, quiet period and reconciliation-by-delivery-key rules (Task 6 and E4/E5 records) apply unchanged to restored `leased` and `reconciliation` events, and proposals keep their once-only guard (row state plus reservation).

### CI least privilege

`.github/workflows/ci.yml`: `permissions: contents: read`, no secrets, no `pull_request_target`, checkout without persisted credentials, actions pinned by commit SHA, pinned runner images, job timeouts, ephemeral embedded PostgreSQL only. Uploaded artifacts are the SBOM, the reduced test summary (counts and file status, no titles) and the signed evidence manifest with its public key; the raw test report and any backup are never uploaded, and the artifact set is scanned for the synthetic marker. Branch protection and required checks are a repository-admin step after the first green run.

## Consequences

- A clean checkout reproduces the full suite, restore proof and evidence manifest with no service other than the embedded server.
- The evidence manifest is signed with a per-run key: it proves the manifest was not changed after the run, not who ran it. A long-lived release-signing key held by the release owner is a later gate (AS-04 signed releases).
- Not decided here and required before any non-synthetic environment: hosting provider and BAA, network exposure and TLS, secret storage and rotation, backup storage, retention, encryption and immutability, recovery targets and drills, monitoring and on-call, Supabase Auth mapping, the creation and custody of `cuspatlas_maintenance`, and tenant scheduling for the worker.

## Explicit non-claims

This is not a PHI-ready or production deployment. The foundation is configured and tested on one host; it is not approved, not deployed, not compliant with HIPAA or any other regime, not certified and not clinically validated.
