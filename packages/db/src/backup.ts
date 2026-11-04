import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type pg from 'pg';
import { assertSyntheticDatabaseName } from './migrate';

/**
 * Versioned logical backup of the synthetic foundation (F Task 8).
 *
 * Why not `pg_dump`: the pinned `embedded-postgres` packages ship only `initdb`, `pg_ctl` and
 * `postgres` (checked in `@embedded-postgres/windows-x64@17.11.0-beta.19/native/bin`); there is no
 * `pg_dump`, `pg_restore` or `psql`, and host installs are out of scope. Instead of falling back to a
 * partial copy, the backup is a complete logical export over the ordinary protocol:
 *
 * - every table of schema `cuspatlas` (enumerated from the catalog, never a hard-coded list) is read
 *   inside ONE `REPEATABLE READ READ ONLY` snapshot with `row_security = off`, so a role that would be
 *   filtered by RLS gets an error instead of a silently partial table;
 * - rows are written as NDJSON (`row_to_json`), one file per table, plus per-table row count and a
 *   content digest computed by the server over the canonical row text;
 * - the schema is NOT copied: restore rebuilds it from the reviewed migrations whose checksums the
 *   manifest records, then proves the rebuilt catalog (RLS flags, policies, grants, triggers,
 *   functions, constraints, columns, indexes) matches the source fingerprint taken in the snapshot.
 *
 * The manifest holds names, counts and digests only: no connection data, credentials or row values.
 * The data files DO contain row values (synthetic labels). They are dumps: never commit them, never
 * upload them as CI artifacts, keep them outside the repository (enforced below).
 */

export const BACKUP_FORMAT = 'cuspatlas-logical-backup/1';
export const BACKUP_SCHEMA = 'cuspatlas';
export const RUNTIME_ROLE = 'cuspatlas_app';
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export interface BackupTable {
  readonly name: string;
  readonly rows: number;
  /** sha256 over the server's canonical row text, rows sorted, joined by newlines. */
  readonly contentSha256: string;
  readonly file: string;
  readonly fileSha256: string;
}

export interface BackupMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
}

export interface BackupManifest {
  readonly format: typeof BACKUP_FORMAT;
  readonly synthetic: true;
  /** Latest applied migration version. */
  readonly schemaVersion: string;
  readonly migrations: readonly BackupMigration[];
  readonly source: { readonly database: string };
  readonly createdAt: string;
  readonly tools: { readonly node: string; readonly server: string; readonly writer: string };
  readonly tables: readonly BackupTable[];
  /** Section name -> sha256 of the canonical catalog rows (see catalogFingerprint). */
  readonly catalog: Readonly<Record<string, string>>;
}

export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_DIGEST_FILE = 'manifest.sha256';

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error('unexpected identifier in catalog');
  return `"${name}"`;
}

/** Session settings that make row text and JSON deterministic across databases. */
export const DETERMINISTIC_SETTINGS = [
  "SET LOCAL TimeZone = 'UTC'",
  "SET LOCAL DateStyle = 'ISO, YMD'",
  "SET LOCAL IntervalStyle = 'postgres'",
  'SET LOCAL extra_float_digits = 3',
];

/** Positive check: only a role that bypasses RLS sees every row (FORCE RLS applies to owners). */
export async function assertBypassesRls(client: pg.ClientBase, purpose: string): Promise<void> {
  const { rows } = await client.query<{ ok: boolean }>(
    'SELECT (rolsuper OR rolbypassrls) AS ok FROM pg_catalog.pg_roles WHERE rolname = current_user',
  );
  if (rows[0]?.ok !== true) {
    throw new Error(`${purpose} needs a role that bypasses row level security (superuser or BYPASSRLS)`);
  }
}

export async function listSchemaTables(client: pg.ClientBase): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY 1`,
    [BACKUP_SCHEMA],
  );
  return rows.map((r) => r.name);
}

/** Row count and content digest of one table, computed by the server. */
export async function tableContent(
  client: pg.ClientBase,
  table: string,
): Promise<{ rows: number; contentSha256: string }> {
  const t = `${BACKUP_SCHEMA}.${quoteIdent(table)}`;
  const { rows } = await client.query<{ n: number; d: string }>(
    `SELECT count(*)::int AS n,
       encode(sha256(convert_to(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), ''), 'UTF8')), 'hex') AS d
     FROM ${t} t`,
  );
  return { rows: rows[0]?.n ?? 0, contentSha256: rows[0]?.d ?? '' };
}

const CATALOG_QUERIES: Readonly<Record<string, string>> = {
  tables: `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'cuspatlas' AND c.relkind IN ('r', 'p') ORDER BY 1`,
  columns: `SELECT table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'cuspatlas' ORDER BY 1, 3`,
  constraints: `SELECT conrelid::regclass::text AS rel, conname, pg_catalog.pg_get_constraintdef(oid) AS def
    FROM pg_catalog.pg_constraint WHERE connamespace = 'cuspatlas'::regnamespace ORDER BY 1, 2`,
  indexes: `SELECT tablename, indexname, indexdef FROM pg_catalog.pg_indexes
    WHERE schemaname = 'cuspatlas' ORDER BY 1, 2`,
  policies: `SELECT tablename, policyname, permissive, roles::text, cmd, qual, with_check
    FROM pg_catalog.pg_policies WHERE schemaname = 'cuspatlas' ORDER BY 1, 2`,
  tableGrants: `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'cuspatlas' AND grantee IN ('cuspatlas_app', 'PUBLIC') ORDER BY 1, 2, 3`,
  columnGrants: `SELECT table_name, column_name, grantee, privilege_type FROM information_schema.column_privileges
    WHERE table_schema = 'cuspatlas' AND grantee IN ('cuspatlas_app', 'PUBLIC') ORDER BY 1, 2, 3, 4`,
  triggers: `SELECT tgrelid::regclass::text AS rel, tgname, tgenabled, pg_catalog.pg_get_triggerdef(oid) AS def
    FROM pg_catalog.pg_trigger WHERE NOT tgisinternal
      AND tgrelid IN (SELECT oid FROM pg_catalog.pg_class WHERE relnamespace = 'cuspatlas'::regnamespace)
    ORDER BY 1, 2`,
  functions: `SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
      md5(p.prosrc) AS src, p.prosecdef, p.proconfig::text AS config,
      has_function_privilege('cuspatlas_app', p.oid, 'EXECUTE') AS app_exec
    FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'cuspatlas'::regnamespace ORDER BY 1, 2`,
  schema: `SELECT has_schema_privilege('cuspatlas_app', 'cuspatlas', 'USAGE') AS app_usage,
      has_schema_privilege('cuspatlas_app', 'cuspatlas', 'CREATE') AS app_create,
      has_schema_privilege('public', 'cuspatlas', 'USAGE') AS public_usage`,
};

/**
 * Digest per catalog section. Owner and grantor names are excluded on purpose (a restore cluster may
 * use another owner); everything that decides what the runtime role can see or do is included.
 */
export async function catalogFingerprint(client: pg.ClientBase): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [section, sql] of Object.entries(CATALOG_QUERIES)) {
    const { rows } = await client.query(sql);
    out[section] = sha256(JSON.stringify(rows));
  }
  return out;
}

export async function appliedMigrations(client: pg.ClientBase): Promise<BackupMigration[]> {
  const { rows } = await client.query<BackupMigration>(
    'SELECT version, name, checksum FROM public.schema_migrations ORDER BY version',
  );
  return rows.map((r) => ({ version: r.version, name: r.name, checksum: r.checksum }));
}

function assertOutsideRepository(outDir: string, repoRoot: string): void {
  const rel = relative(resolve(repoRoot), resolve(outDir));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error('Refusing backup directory inside the repository (dumps must never be committed)');
  }
}

export interface BackupOptions {
  /** New or empty directory, outside the repository. */
  readonly outDir: string;
  /** Repository root used for the outside-the-repository check. */
  readonly repoRoot: string;
}

/**
 * Takes a backup through `client` (an owner/maintenance connection that bypasses RLS) of the
 * synthetic database it is connected to. Throws, writing nothing it cannot complete, on a
 * non-synthetic database, a role filtered by RLS, a non-empty target directory or a directory inside
 * the repository.
 */
export async function createBackup(client: pg.ClientBase, opts: BackupOptions): Promise<BackupManifest> {
  assertOutsideRepository(opts.outDir, opts.repoRoot);
  if (existsSync(opts.outDir) && readdirSync(opts.outDir).length > 0) {
    throw new Error('Refusing backup directory that is not empty');
  }
  const { rows: dbRows } = await client.query<{ db: string; server: string }>(
    "SELECT current_database() AS db, current_setting('server_version') AS server",
  );
  const database = dbRows[0]?.db ?? '';
  assertSyntheticDatabaseName(database);
  await assertBypassesRls(client, 'Backup');

  const files: { file: string; body: string }[] = [];
  const tables: BackupTable[] = [];
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let migrations: BackupMigration[];
  let catalog: Record<string, string>;
  try {
    // row_security = off makes a filtered read an error instead of a silently partial table.
    await client.query('SET LOCAL row_security = off');
    for (const s of DETERMINISTIC_SETTINGS) await client.query(s);
    migrations = await appliedMigrations(client);
    catalog = await catalogFingerprint(client);
    for (const name of await listSchemaTables(client)) {
      const { rows } = await client.query<{ j: string }>(
        `SELECT row_to_json(t)::text AS j FROM ${BACKUP_SCHEMA}.${quoteIdent(name)} t ORDER BY t::text`,
      );
      const body = rows.map((r) => `${r.j}\n`).join('');
      const content = await tableContent(client, name);
      if (content.rows !== rows.length) throw new Error('row count changed inside the backup snapshot');
      const file = `tables/${name}.ndjson`;
      files.push({ file, body });
      tables.push({ name, ...content, file, fileSha256: sha256(body) });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
  const last = migrations[migrations.length - 1];
  if (!last) throw new Error('Refusing backup of a database without applied migrations');

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    synthetic: true,
    schemaVersion: last.version,
    migrations,
    source: { database },
    createdAt: new Date().toISOString(),
    tools: { node: process.version, server: dbRows[0]?.server ?? '', writer: BACKUP_FORMAT },
    tables,
    catalog,
  };
  mkdirSync(join(opts.outDir, 'tables'), { recursive: true });
  for (const f of files) writeFileSync(join(opts.outDir, f.file), f.body);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(opts.outDir, MANIFEST_FILE), manifestText);
  writeFileSync(join(opts.outDir, MANIFEST_DIGEST_FILE), `${sha256(manifestText)}\n`);
  return manifest;
}
