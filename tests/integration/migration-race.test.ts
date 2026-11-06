import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { assertSyntheticDatabaseName, migrate } from '@cuspatlas/db';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

/**
 * Migration race: two migrators replaying every migration into two NEW databases of the same cluster at
 * the same time (what a restore, a drill and a second deploy do). Cluster-global catalog rows (the runtime
 * role in pg_authid) are shared by both, so this must never fail with `tuple concurrently updated`.
 */

const MIGRATIONS = resolve(import.meta.dirname, '../../supabase/migrations');
const ROUNDS = 10;

function adminConfig(database: string): pg.ClientConfig {
  return {
    host: '127.0.0.1',
    port: Number(process.env.CUSPATLAS_TEST_PG_PORT),
    user: 'postgres',
    password: process.env.CUSPATLAS_TEST_PG_ADMIN_PASSWORD,
    database,
  };
}

async function onRoot<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const root = new pg.Client(adminConfig('postgres'));
  await root.connect();
  try {
    return await fn(root);
  } finally {
    await root.end();
  }
}

async function migrateFresh(name: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const c = new pg.Client(adminConfig(name));
  await c.connect();
  try {
    await migrate(c, { dir: MIGRATIONS });
    return { ok: true };
  } catch (err) {
    const e = err as pg.DatabaseError;
    const { rows } = await c
      .query<{ v: string | null }>('SELECT max(version) AS v FROM public.schema_migrations')
      .catch(() => ({ rows: [{ v: null }] }));
    return {
      ok: false,
      detail: `${e.code ?? '?'} ${e.message} after ${rows[0]?.v ?? 'none'} at ${e.position ?? '?'}`,
    };
  } finally {
    await c.end();
  }
}

describe('migration race: concurrent migrators on one cluster', () => {
  it(`replays every migration into two fresh databases concurrently, ${ROUNDS} rounds, without a catalog race`, async () => {
    const failures: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const names = [0, 1].map(() => `cuspatlas_synthetic_mrace_${randomBytes(4).toString('hex')}`);
      for (const n of names) assertSyntheticDatabaseName(n);
      await onRoot(async (r) => {
        for (const n of names) await r.query(`CREATE DATABASE ${n} TEMPLATE template0 ENCODING 'UTF8'`);
      });
      try {
        const results = await Promise.all(names.map(migrateFresh));
        for (const res of results) if (!res.ok) failures.push(`round ${round}: ${res.detail}`);
      } finally {
        await onRoot(async (r) => {
          for (const n of names) await r.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
        });
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
