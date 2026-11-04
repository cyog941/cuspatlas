import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertSyntheticDatabaseName, migrate } from '@cuspatlas/db';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

export const TEMPLATE_DB = 'cuspatlas_synthetic_template';

function freeLoopbackPort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? ok(addr.port) : fail(new Error('no port'))));
    });
  });
}

/**
 * Starts ONE real PostgreSQL 17 server per integration run, outside the repository, applies the
 * migrations to a template database as the superuser and sets a per-run password for the runtime
 * role. Test files clone the template; nothing here is reachable beyond 127.0.0.1.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cuspatlas-pg-'));
  const port = await freeLoopbackPort();
  const adminPassword = randomBytes(18).toString('base64url');
  const appPassword = randomBytes(18).toString('base64url');
  const serverLog: string[] = [];

  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: adminPassword,
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    // Keep client statement errors (which can quote row values) out of the server log.
    postgresFlags: [
      '-c',
      'listen_addresses=127.0.0.1',
      '-c',
      'log_error_verbosity=terse',
      '-c',
      'log_min_error_statement=panic',
    ],
    onLog: (m) => serverLog.push(String(m)),
    onError: (m) => serverLog.push(String(m)),
  });

  await server.initialise();
  await server.start();

  const admin = { host: '127.0.0.1', port, user: 'postgres', password: adminPassword };
  const root = new pg.Client({ ...admin, database: 'postgres' });
  await root.connect();
  assertSyntheticDatabaseName(TEMPLATE_DB);
  await root.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await root.end();

  const tpl = new pg.Client({ ...admin, database: TEMPLATE_DB });
  await tpl.connect();
  await migrate(tpl, { dir: resolve(import.meta.dirname, '../../../supabase/migrations') });
  const { rows } = await tpl.query<{ sql: string }>(
    `SELECT format('ALTER ROLE cuspatlas_app PASSWORD %L', $1::text) AS sql`,
    [appPassword],
  );
  await tpl.query(rows[0]?.sql ?? 'SELECT 1');
  await tpl.end();

  process.env.CUSPATLAS_TEST_PG_PORT = String(port);
  process.env.CUSPATLAS_TEST_PG_ADMIN_PASSWORD = adminPassword;
  process.env.CUSPATLAS_TEST_PG_APP_PASSWORD = appPassword;
  process.env.CUSPATLAS_TEST_PG_TEMPLATE = TEMPLATE_DB;

  return async () => {
    try {
      await server.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
}
