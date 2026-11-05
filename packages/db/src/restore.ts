import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import pg from 'pg';
import {
  appliedMigrations,
  assertBypassesRls,
  BACKUP_FORMAT,
  BACKUP_SCHEMA,
  type BackupManifest,
  catalogFingerprint,
  DETERMINISTIC_SETTINGS,
  listSchemaTables,
  MANIFEST_DIGEST_FILE,
  MANIFEST_FILE,
  quoteIdent,
  RUNTIME_ROLE,
  sha256,
  tableContent,
} from './backup';
import { assertSyntheticDatabaseName, listMigrations, migrate, syncAgentMemoryRegistry } from './migrate';

/**
 * Restore of a logical backup into a SEPARATE, NEW, disposable database (F Task 8, runbook E0 item 7).
 *
 * Target guard, all checked before anything is created:
 * - an explicit `target` and a `confirmTarget` that matches it exactly;
 * - the name contains `cuspatlas_synthetic` and is a plain identifier;
 * - the host is a loopback name (allowlist below);
 * - the target is not the backup's source database, not the maintenance database the connection
 *   uses, and does not exist yet (restore never writes into an existing database, so it can never
 *   restore over the source or over anything else);
 * - the manifest digest and every data-file digest match; the format is known;
 * - the backup's migrations equal this checkout's migrations (same versions, names, checksums);
 * - the connection role bypasses RLS and may create databases;
 * - the runtime role `cuspatlas_app` already exists in the target cluster with its frozen attributes.
 *   A missing role is REFUSED, not created: roles are cluster objects outside the target database,
 *   and creating a login role is an operator decision (docs/runbooks/restore.md).
 *
 * Restore never drops anything. If verification fails the new database stays for inspection and the
 * operator discards it (rollback = drop the disposable target). Errors carry codes, never connection
 * strings or credentials.
 */

export const RESTORE_HOST_ALLOWLIST: readonly string[] = ['127.0.0.1', '::1', 'localhost'];

export type RestoreRefusalCode =
  | 'target_unconfirmed'
  | 'target_not_synthetic'
  | 'host_not_allowed'
  | 'manifest_invalid'
  | 'manifest_digest_mismatch'
  | 'backup_digest_mismatch'
  | 'target_is_source'
  | 'target_is_connection_database'
  | 'target_exists'
  | 'schema_version_mismatch'
  | 'restore_role_insufficient'
  | 'runtime_role_missing'
  | 'runtime_role_unsafe';

const REFUSAL_TEXT: Record<RestoreRefusalCode, string> = {
  target_unconfirmed: 'pass --target and an identical --confirm-target',
  target_not_synthetic: 'target database name must contain cuspatlas_synthetic',
  host_not_allowed: 'restore target host must be a loopback address',
  manifest_invalid: 'backup manifest is missing or not a known format',
  manifest_digest_mismatch: 'backup manifest digest does not match manifest.sha256',
  backup_digest_mismatch: 'a backup data file is missing or its digest does not match the manifest',
  target_is_source: 'target is the database the backup was taken from',
  target_is_connection_database: 'target is the maintenance database of the restore connection',
  target_exists: 'target database already exists; restore only creates a new disposable database',
  schema_version_mismatch: 'backup migrations differ from this checkout; restore with the matching checkout',
  restore_role_insufficient: 'restore connection needs CREATEDB and a role that bypasses row level security',
  runtime_role_missing:
    'runtime role cuspatlas_app does not exist in the target cluster; create it (NOLOGIN is enough) and retry',
  runtime_role_unsafe: 'runtime role cuspatlas_app has superuser, BYPASSRLS or other forbidden attributes',
};

export class RestoreRefusedError extends Error {
  override readonly name = 'RestoreRefusedError';
  constructor(readonly code: RestoreRefusalCode) {
    super(`restore refused (${code}): ${REFUSAL_TEXT[code]}`);
  }
}

export class RestoreVerificationError extends Error {
  override readonly name = 'RestoreVerificationError';
  constructor(
    readonly target: string,
    readonly failures: readonly string[],
  ) {
    super(`restore verification failed (${failures.length}): ${failures.join('; ')}`);
  }
}

export interface RestoreConnection {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password?: string;
  /** Maintenance database used to CREATE DATABASE (for example `postgres`). */
  readonly database: string;
}

export interface RestoreOptions {
  readonly backupDir: string;
  readonly target: string | undefined;
  readonly confirmTarget: string | undefined;
  readonly migrationsDir: string;
}

export interface RestoreReport {
  readonly target: string;
  readonly tables: readonly { readonly name: string; readonly rows: number }[];
  readonly verified: true;
}

/** Reads and checks the manifest and every data file digest. Throws RestoreRefusedError. */
export function readVerifiedManifest(backupDir: string): BackupManifest {
  const mPath = join(backupDir, MANIFEST_FILE);
  const dPath = join(backupDir, MANIFEST_DIGEST_FILE);
  if (!existsSync(mPath) || !existsSync(dPath)) throw new RestoreRefusedError('manifest_invalid');
  const text = readFileSync(mPath, 'utf8');
  if (sha256(text) !== readFileSync(dPath, 'utf8').trim()) {
    throw new RestoreRefusedError('manifest_digest_mismatch');
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(text) as BackupManifest;
  } catch {
    throw new RestoreRefusedError('manifest_invalid');
  }
  if (
    manifest.format !== BACKUP_FORMAT ||
    manifest.synthetic !== true ||
    !Array.isArray(manifest.tables) ||
    !Array.isArray(manifest.migrations) ||
    typeof manifest.source?.database !== 'string'
  ) {
    throw new RestoreRefusedError('manifest_invalid');
  }
  for (const t of manifest.tables) {
    const file = normalize(t.file);
    if (!/^tables[\\/][a-z_][a-z0-9_]*\.ndjson$/.test(file))
      throw new RestoreRefusedError('manifest_invalid');
    const p = join(backupDir, file);
    if (!existsSync(p) || sha256(readFileSync(p)) !== t.fileSha256) {
      throw new RestoreRefusedError('backup_digest_mismatch');
    }
  }
  return manifest;
}

function checkTargetArguments(conn: RestoreConnection, opts: RestoreOptions): string {
  const target = opts.target;
  if (!target || target !== opts.confirmTarget) throw new RestoreRefusedError('target_unconfirmed');
  try {
    assertSyntheticDatabaseName(target);
  } catch {
    throw new RestoreRefusedError('target_not_synthetic');
  }
  if (!RESTORE_HOST_ALLOWLIST.includes(conn.host)) throw new RestoreRefusedError('host_not_allowed');
  return target;
}

function sameMigrations(a: readonly BackupManifest['migrations'][number][], dir: string): boolean {
  const files = listMigrations(dir).map((f) => ({ version: f.version, name: f.name, checksum: f.checksum }));
  return JSON.stringify(files) === JSON.stringify(a.map((m) => ({ ...m })));
}

/** Tables ordered so every foreign-key parent loads before its children. */
async function loadOrder(client: pg.ClientBase, tables: readonly string[]): Promise<string[]> {
  const { rows } = await client.query<{ child: string; parent: string }>(
    `SELECT c.relname AS child, p.relname AS parent FROM pg_catalog.pg_constraint k
     JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_class p ON p.oid = k.confrelid
     WHERE k.contype = 'f' AND k.connamespace = $1::regnamespace AND c.oid <> p.oid`,
    [BACKUP_SCHEMA],
  );
  const order: string[] = [];
  const pending = new Set(tables);
  while (pending.size > 0) {
    const ready = [...pending].filter((t) =>
      rows.every((r) => r.child !== t || !pending.has(r.parent) || r.parent === t),
    );
    if (ready.length === 0) throw new Error('foreign-key cycle in schema');
    for (const t of ready.sort()) {
      order.push(t);
      pending.delete(t);
    }
  }
  return order;
}

/**
 * Compares a restored database with its manifest: table set (schema vs backup, both directions),
 * per-table count and content digest, catalog fingerprint, applied migrations, RLS enabled and
 * forced everywhere, and default deny for the runtime role without tenant context. Returns failures.
 */
export async function verifyRestoredDatabase(
  client: pg.ClientBase,
  manifest: BackupManifest,
): Promise<string[]> {
  const failures: string[] = [];
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query('SET LOCAL row_security = off');
    for (const s of DETERMINISTIC_SETTINGS) await client.query(s);
    const schemaTables = await listSchemaTables(client);
    const backed = new Map(manifest.tables.map((t) => [t.name, t]));
    for (const name of schemaTables) {
      const want = backed.get(name);
      if (!want) {
        failures.push(`table ${name} exists in the schema but is missing from the backup`);
        continue;
      }
      const got = await tableContent(client, name);
      if (got.rows !== want.rows)
        failures.push(`table ${name}: ${got.rows} rows restored, ${want.rows} backed up`);
      else if (got.contentSha256 !== want.contentSha256)
        failures.push(`table ${name}: content digest differs`);
    }
    for (const name of backed.keys()) {
      if (!schemaTables.includes(name)) failures.push(`table ${name} is in the backup but not in the schema`);
    }
    const catalog = await catalogFingerprint(client);
    for (const [section, digest] of Object.entries(manifest.catalog)) {
      if (catalog[section] !== digest) failures.push(`catalog section ${section} differs from the source`);
    }
    for (const section of Object.keys(catalog)) {
      if (!(section in manifest.catalog))
        failures.push(`catalog section ${section} missing from the manifest`);
    }
    const migrations = await appliedMigrations(client);
    if (JSON.stringify(migrations) !== JSON.stringify(manifest.migrations)) {
      failures.push('applied migrations differ from the backup');
    }
    const { rows: rls } = await client.query<{ relname: string; ok: boolean }>(
      `SELECT c.relname, (c.relrowsecurity AND c.relforcerowsecurity) AS ok FROM pg_catalog.pg_class c
       WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('r', 'p')`,
      [BACKUP_SCHEMA],
    );
    for (const r of rls)
      if (!r.ok) failures.push(`table ${r.relname}: row level security not enabled and forced`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }

  // Default deny: the runtime role, without any tenant context, must see zero rows everywhere.
  await client.query('BEGIN READ ONLY');
  try {
    await client.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
    for (const name of manifest.tables.map((t) => t.name)) {
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT has_table_privilege(current_user, $1, 'SELECT') AS ok`,
        [`${BACKUP_SCHEMA}.${name}`],
      );
      if (!rows[0]?.ok) continue;
      const seen = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${BACKUP_SCHEMA}.${quoteIdent(name)}`,
      );
      if ((seen.rows[0]?.n ?? 0) !== 0)
        failures.push(`table ${name}: runtime role sees rows without tenant context`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
  return failures;
}

async function checkCluster(admin: pg.ClientBase, target: string): Promise<void> {
  const { rows: cur } = await admin.query<{ db: string }>('SELECT current_database() AS db');
  if (cur[0]?.db === target) throw new RestoreRefusedError('target_is_connection_database');
  const { rows: who } = await admin.query<{ ok: boolean }>(
    `SELECT (rolsuper OR (rolcreatedb AND rolbypassrls)) AS ok FROM pg_catalog.pg_roles
     WHERE rolname = current_user`,
  );
  if (who[0]?.ok !== true) throw new RestoreRefusedError('restore_role_insufficient');
  const exists = await admin.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [target]);
  if (exists.rowCount) throw new RestoreRefusedError('target_exists');
  const { rows: role } = await admin.query<{ unsafe: boolean }>(
    `SELECT (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication) AS unsafe
     FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [RUNTIME_ROLE],
  );
  if (!role[0]) throw new RestoreRefusedError('runtime_role_missing');
  if (role[0].unsafe) throw new RestoreRefusedError('runtime_role_unsafe');
}

/**
 * Restores `opts.backupDir` into the new database `opts.target` on the cluster reached by `conn`.
 * Throws RestoreRefusedError before creating anything when a guard fails, and
 * RestoreVerificationError (target left for inspection) when the restored data does not reconcile.
 */
export async function restoreBackup(conn: RestoreConnection, opts: RestoreOptions): Promise<RestoreReport> {
  const target = checkTargetArguments(conn, opts);
  const manifest = readVerifiedManifest(opts.backupDir);
  if (manifest.source.database === target) throw new RestoreRefusedError('target_is_source');
  if (!sameMigrations(manifest.migrations, opts.migrationsDir)) {
    throw new RestoreRefusedError('schema_version_mismatch');
  }

  const admin = new pg.Client({ ...conn });
  await admin.connect();
  try {
    await checkCluster(admin, target);
    // Identifier already validated by assertSyntheticDatabaseName (lowercase letters, digits, _).
    await admin.query(`CREATE DATABASE ${target} TEMPLATE template0 ENCODING 'UTF8'`);
  } finally {
    await admin.end();
  }

  const client = new pg.Client({ ...conn, database: target });
  await client.connect();
  try {
    await assertBypassesRls(client, 'Restore');
    // Schema, roles' grants, RLS and policies come from the reviewed migrations, not from the dump.
    // The agent memory registry is restored from the backup like any table (not seeded here).
    await migrate(client, { dir: opts.migrationsDir, seedRegistry: false });

    const schemaTables = await listSchemaTables(client);
    const backed = new Map(manifest.tables.map((t) => [t.name, t]));
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL row_security = off');
      // Lets the migration bind guards accept historical rows during this load only (RLS-bypassing role).
      await client.query("SET LOCAL cuspatlas.restore_load = 'on'");
      for (const s of DETERMINISTIC_SETTINGS) await client.query(s);
      for (const name of await loadOrder(client, schemaTables)) {
        const t = backed.get(name);
        if (!t) continue; // reported by verification below; never invent data
        const lines = readFileSync(join(opts.backupDir, normalize(t.file)), 'utf8')
          .split('\n')
          .filter((l) => l.length > 0);
        const rel = `${BACKUP_SCHEMA}.${quoteIdent(name)}`;
        for (let i = 0; i < lines.length; i += 200) {
          const batch = `[${lines.slice(i, i + 200).join(',')}]`;
          await client.query(
            `INSERT INTO ${rel} SELECT * FROM json_populate_recordset(NULL::${rel}, $1::json)`,
            [batch],
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }

    const failures = await verifyRestoredDatabase(client, manifest);
    if (failures.length > 0) throw new RestoreVerificationError(target, failures);
    // A backup taken before the registry existed has no rows for it: seed it from the deployed contracts.
    if (!backed.has('agent_memory_registry')) await syncAgentMemoryRegistry(client);
    return {
      target,
      tables: manifest.tables.map((t) => ({ name: t.name, rows: t.rows })),
      verified: true,
    };
  } finally {
    await client.end();
  }
}
