# Backup and restore runbook (synthetic foundation)

Status: configured and tested on one Windows host against the embedded PostgreSQL 17.11 test cluster (F Task 8). Linux CI runs the same tests once the branch is pushed. Synthetic data only. This is not a production backup procedure: there is no retention policy, no off-site or WORM copy, no encryption at rest of the backup files, and no recovery-time target. Do not point these tools at any hosted project.

## What a backup is

`packages/db/src/backup.ts` (CLI `corepack pnpm backup`) writes a versioned logical backup, format `cuspatlas-logical-backup/1`:

```
<out-dir>/
  manifest.json      format, synthetic flag, schemaVersion, applied migrations (version, name, checksum),
                     source database name, createdAt, tool versions (node, server, writer),
                     per table: rows, contentSha256, file, fileSha256; catalog fingerprint per section
  manifest.sha256    sha256 of manifest.json
  tables/<table>.ndjson   one JSON row per line, every table of schema cuspatlas
```

Why not `pg_dump`: the pinned `embedded-postgres` packages ship only `initdb`, `pg_ctl` and `postgres` (checked in `@embedded-postgres/windows-x64@17.11.0-beta.19/native/bin`; the Linux package is the same build family and was not inspected), there is no `pg_dump`, `pg_restore` or `psql` on the host, and host installs are out of scope. The backup therefore does not depend on any external binary and cannot silently fall back to a partial copy:

- tables are enumerated from the catalog, never from a hard-coded list;
- everything is read in one `REPEATABLE READ READ ONLY` snapshot with `row_security = off`, so a role that row level security would filter gets an error instead of a partial table, and the counts, digests and rows come from the same snapshot;
- the connection must be a superuser or BYPASSRLS role (checked positively; FORCE RLS applies to table owners too);
- the database name must contain `cuspatlas_synthetic`;
- the output directory must be new or empty and outside the repository.

The manifest holds names, counts and digests only (no connection data, credentials or row values; the privacy-log test checks the marker never reaches it). The data files DO contain row values. Treat them like a database dump: never commit them (`.gitignore` also ignores `*.dump`, `*.backup`), never upload them as CI artifacts, delete them when done.

The schema is not in the backup. Restore rebuilds it from the reviewed migrations whose checksums the manifest records, and then proves the rebuilt catalog equals the source's.

## Restore procedure

1. Start or choose a disposable local cluster (the integration suite starts one per run). The target database must not exist yet.
2. Make sure the runtime role exists in that cluster: `CREATE ROLE cuspatlas_app NOLOGIN;` if it is a fresh cluster. Restore refuses with `runtime_role_missing` otherwise (decision below). The first migration then enforces the role's frozen attributes (LOGIN, NOSUPERUSER, NOBYPASSRLS, NOINHERIT, NOCREATEDB, NOCREATEROLE, NOREPLICATION); set a password separately if anything should log in as it.
3. Run, with a superuser (or CREATEDB + BYPASSRLS) connection to the maintenance database on a loopback host:

```
CUSPATLAS_RESTORE_ADMIN_DATABASE_URL='postgres://<admin-user>@127.0.0.1:<port>/postgres' PGPASSWORD='<set-in-shell>' \
  corepack pnpm restore -- --backup <dir> --target cuspatlas_synthetic_restore_check --confirm-target cuspatlas_synthetic_restore_check
```

Exit codes: 0 restored and verified; 1 verification failed or error; 2 usage; 3 refused by the target guard. The URL and password are never printed.

## Target guard (runbook E0 item 7)

Checked in this order; every refusal happens before anything is created:

| Refusal code | Condition |
|---|---|
| `target_unconfirmed` | `--target` missing, or `--confirm-target` missing or not identical |
| `target_not_synthetic` | target name does not contain `cuspatlas_synthetic` or is not a plain lowercase identifier |
| `host_not_allowed` | host is not `127.0.0.1`, `::1` or `localhost` |
| `manifest_invalid` | manifest or digest file missing, unknown format, malformed table entry |
| `manifest_digest_mismatch` | `manifest.json` does not match `manifest.sha256` |
| `backup_digest_mismatch` | a data file is missing or does not match its recorded sha256 |
| `target_is_source` | target equals the backup's source database name |
| `schema_version_mismatch` | the backup's migrations differ from this checkout's (restore with the matching checkout) |
| `target_is_connection_database` | target is the maintenance database the restore connects to |
| `restore_role_insufficient` | the restore role is neither superuser nor CREATEDB + BYPASSRLS |
| `target_exists` | a database with the target name already exists (so restore can never write over the source or anything else) |
| `runtime_role_missing` / `runtime_role_unsafe` | `cuspatlas_app` is absent, or has superuser, BYPASSRLS, CREATEDB, CREATEROLE or REPLICATION |

Restore never drops, truncates or alters anything outside the new target database (the migrator's `ALTER ROLE` on `cuspatlas_app` is the only cluster-level statement, and it only enforces the frozen attributes).

Decision on a missing runtime role: refuse, do not create. Roles are cluster objects outside the target database, creating a login role is an operator decision, and a silently created role could carry a password or attributes nobody reviewed. The refusal message tells the operator exactly what to create.

## What restore verifies

After `CREATE DATABASE <target> TEMPLATE template0`, the migrator rebuilds the schema, rows are loaded in foreign-key order in one transaction (all constraints apply; no trigger is disabled), and `verifyRestoredDatabase` must report no failure:

- the set of tables in the rebuilt schema equals the set in the backup, in both directions (a backup that skipped a table fails even if its manifest was made consistent);
- per table: restored row count and server-side content digest equal the backup's;
- catalog fingerprint equal to the source's, per section: RLS enabled/forced flags, columns, constraints, indexes, policies, table and column grants to `cuspatlas_app` and `PUBLIC`, triggers (definition and enabled state), functions (source digest, security definer, settings, runtime-role EXECUTE) and schema privileges;
- applied migrations equal the manifest's;
- RLS enabled and forced on every table;
- default deny: as `cuspatlas_app` without tenant context every selectable table returns zero rows.

`tests/integration/restore-smoke.test.ts` additionally proves on the restored database: identical counts, task versions, outbox states/attempts/leases/dead-letter reasons, receipts, idempotency reservations (committed and failed), proposal states and approval provenance; cross-tenant denial under the runtime role; a restored `leased` or `reconciliation` event is never sent before a delivery-key lookup completes and its `attempt` continues monotonically; a restored committed proposal replays without executing again; restored expired proposals fail `proposal_expired`; an approved proposal whose task moved fails `stale_version`; the migrator refuses the restored database after an applied-migration checksum is tampered. Deliberately damaged backups are detected: table omitted with a consistent manifest, rows dropped with a recomputed file digest, one flipped byte, an edited manifest, target equal to the source or an existing database, a target without the synthetic marker, an unconfirmed target, a non-loopback host, and a cluster without the runtime role (refused, then restored and verified once the role is created).

## What is NOT verified

- Production retention, immutability (WORM), off-site copies, encryption of backup files, key custody and access control of backup storage.
- Recovery-time and recovery-point targets, timed restore drills and large data volumes (the backup holds each table in memory; synthetic scale only).
- Point-in-time recovery or WAL archiving; restore of a backup taken on another migration set (restore with the matching checkout).
- Authenticity of a backup: `manifest.sha256` detects accidental or naive edits, not an attacker who rewrites the manifest and its digest. The verification against the rebuilt schema and the row counts catches omissions, not forged rows.
- Supabase-managed backups, storage buckets, auth schema or anything outside schema `cuspatlas`.
- A clinical or PHI restore. None of this authorizes holding real patient data.

## Rollback

The restore target is disposable. To roll back, discard it: `DROP DATABASE <target> WITH (FORCE);` on the same loopback cluster (the test suite drops its targets in `afterAll`), and delete the backup directory. On a verification failure the target is left in place for inspection and the CLI prints its name; discard it the same way. Nothing else was changed, so nothing else needs to be undone.
