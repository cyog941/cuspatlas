import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryRegistryRows } from '@cuspatlas/contracts';
import type pg from 'pg';

const FILE_PATTERN = /^(\d{14})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

export function listMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      const m = FILE_PATTERN.exec(f);
      if (!m?.[1] || !m[2]) throw new Error(`Migration file name does not match <YYYYMMDDHHMMSS>_<name>.sql`);
      const sql = readFileSync(join(dir, f), 'utf8');
      return { version: m[1], name: m[2], sql, checksum: createHash('sha256').update(sql).digest('hex') };
    })
    .sort((a, b) => a.version.localeCompare(b.version));
}

/** Refuses any target whose database name lacks the synthetic marker. */
export function assertSyntheticDatabaseName(name: string): void {
  if (!/^[a-z0-9_]{1,63}$/.test(name) || !name.includes('cuspatlas_synthetic')) {
    throw new Error('Refusing database target: name must contain cuspatlas_synthetic');
  }
}

export const SHARED_CATALOG_RETRY_ATTEMPTS = 6;
const SHARED_CATALOG_RETRY_BASE_MS = 25;
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/**
 * Migration race (cluster-global catalog rows). Roles live in the shared catalog pg_authid, one row per
 * cluster, while the advisory lock in migrate() is scoped to the current database. Two migrators replaying
 * into two databases of one cluster (a restore or drill next to another migrator) both run
 * `ALTER ROLE cuspatlas_app ...` (20261103230000): the second blocks on the first's uncommitted row
 * version and then fails with XX000 `tuple concurrently updated`. On a cluster without the role, the
 * guarded `CREATE ROLE` of both fails the second with 23505 on `pg_authid_rolname_index`. PostgreSQL has
 * no cross-database lock an unprivileged migration role can take (a row lock on pg_database needs UPDATE
 * on it), so the migrator retries exactly these two errors. Each migration file is one transaction that
 * has been rolled back in full, so re-running it is equivalent to one run. Every other error is thrown.
 */
export function isSharedCatalogRace(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown; constraint?: unknown };
  if (e.code === 'XX000') return e.message === 'tuple concurrently updated';
  if (e.code === '23505') return e.constraint === 'pg_authid_rolname_index';
  return false;
}

/**
 * Applies pending migrations in version order, each in its own transaction, under an advisory lock.
 * An already-applied migration whose file changed is an error, never silently re-applied. A migration
 * that loses a shared-catalog race with a migrator in another database of the cluster is re-run
 * (bounded, see isSharedCatalogRace).
 */
export async function migrate(
  client: pg.ClientBase,
  opts: { dir: string; readonly seedRegistry?: boolean },
): Promise<{ applied: string[] }> {
  const { rows: dbRows } = await client.query<{ db: string }>('SELECT current_database() AS db');
  assertSyntheticDatabaseName(dbRows[0]?.db ?? '');

  const files = listMigrations(opts.dir);
  await client.query('SELECT pg_advisory_lock(7402061)');
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query('REVOKE ALL ON public.schema_migrations FROM PUBLIC');
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM public.schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    const applied: string[] = [];
    for (const f of files) {
      const prior = done.get(f.version);
      if (prior !== undefined) {
        if (prior !== f.checksum) throw new Error(`Applied migration ${f.version} has changed on disk`);
        continue;
      }
      for (let attempt = 1; ; attempt++) {
        await client.query('BEGIN');
        try {
          await client.query(f.sql);
          await client.query(
            'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [f.version, f.name, f.checksum],
          );
          await client.query('COMMIT');
          break;
        } catch (err) {
          await client.query('ROLLBACK');
          if (attempt >= SHARED_CATALOG_RETRY_ATTEMPTS || !isSharedCatalogRace(err)) throw err;
          await sleep(SHARED_CATALOG_RETRY_BASE_MS * 2 ** (attempt - 1) * (1 + Math.random()));
        }
      }
      applied.push(`${f.version}_${f.name}`);
    }
    // A restore loads the registry rows from its backup instead (and syncs only when the backup has none).
    if (opts.seedRegistry !== false) await syncAgentMemoryRegistry(client);
    return { applied };
  } finally {
    await client.query('SELECT pg_advisory_unlock(7402061)');
  }
}

/**
 * Closeout D review fixes: seeds cuspatlas.agent_memory_registry (registered memory key prefixes, codes
 * and catalog operation ids) from @cuspatlas/contracts after every run, so the database allowlist matches
 * the code deployed with it. One transaction: rows no longer registered are removed, new ones added. A
 * no-op before the registry migration has been applied.
 */
export async function syncAgentMemoryRegistry(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('cuspatlas.agent_memory_registry') IS NOT NULL AS present",
  );
  if (rows[0]?.present !== true) return;
  const reg = memoryRegistryRows();
  const kinds = reg.map((r) => r.kind);
  const values = reg.map((r) => r.value);
  await client.query('BEGIN');
  try {
    await client.query(
      `DELETE FROM cuspatlas.agent_memory_registry r WHERE NOT EXISTS (
         SELECT 1 FROM unnest($1::text[], $2::text[]) AS x(kind, value) WHERE x.kind = r.kind AND x.value = r.value)`,
      [kinds, values],
    );
    await client.query(
      `INSERT INTO cuspatlas.agent_memory_registry (kind, value)
       SELECT x.kind, x.value FROM unnest($1::text[], $2::text[]) AS x(kind, value) ON CONFLICT DO NOTHING`,
      [kinds, values],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
