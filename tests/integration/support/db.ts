import { randomBytes } from 'node:crypto';
import { assertSyntheticDatabaseName } from '@cuspatlas/db';
import pg from 'pg';

export interface TestDatabase {
  readonly name: string;
  /** Superuser pool: fixture setup and read-back only. Never used to assert a denial. */
  readonly admin: pg.Pool;
  /** Runtime-role pool (cuspatlas_app): every denial assertion goes through this. */
  readonly app: pg.Pool;
  /** Independent runtime-role pool used by the security-attempt sink. */
  readonly sink: pg.Pool;
  appPool(max: number): pg.Pool;
  close(): Promise<void>;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`integration globalSetup did not provide ${name}`);
  return v;
}

/** Clones the migrated template into a fresh database whose name carries the synthetic marker. */
export async function openTestDatabase(label: string): Promise<TestDatabase> {
  const port = Number(env('CUSPATLAS_TEST_PG_PORT'));
  const admin = {
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: env('CUSPATLAS_TEST_PG_ADMIN_PASSWORD'),
  };
  const app = {
    host: '127.0.0.1',
    port,
    user: 'cuspatlas_app',
    password: env('CUSPATLAS_TEST_PG_APP_PASSWORD'),
  };
  const name = `cuspatlas_synthetic_${label.replace(/[^a-z0-9]/g, '_')}_${randomBytes(4).toString('hex')}`;
  assertSyntheticDatabaseName(name);

  const root = new pg.Client({ ...admin, database: 'postgres' });
  await root.connect();
  await root.query(`CREATE DATABASE ${name} TEMPLATE ${env('CUSPATLAS_TEST_PG_TEMPLATE')}`);
  await root.end();

  const pools: pg.Pool[] = [];
  const make = (cfg: pg.PoolConfig) => {
    const p = new pg.Pool({ ...cfg, database: name });
    p.on('error', () => undefined);
    pools.push(p);
    return p;
  };

  return {
    name,
    admin: make({ ...admin, max: 2 }),
    app: make({ ...app, max: 4 }),
    sink: make({ ...app, max: 2 }),
    appPool: (max: number) => make({ ...app, max }),
    async close() {
      await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
      const r = new pg.Client({ ...admin, database: 'postgres' });
      await r.connect();
      await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await r.end();
    },
  };
}
