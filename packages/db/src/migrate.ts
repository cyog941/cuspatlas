import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Applies pending migrations in version order, each in its own transaction, under an advisory lock.
 * An already-applied migration whose file changed is an error, never silently re-applied.
 */
export async function migrate(client: pg.ClientBase, opts: { dir: string }): Promise<{ applied: string[] }> {
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
      await client.query('BEGIN');
      try {
        await client.query(f.sql);
        await client.query(
          'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [f.version, f.name, f.checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      applied.push(`${f.version}_${f.name}`);
    }
    return { applied };
  } finally {
    await client.query('SELECT pg_advisory_unlock(7402061)');
  }
}
