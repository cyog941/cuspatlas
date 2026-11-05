import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
 * On Windows the server is started through the bundled `pg_ctl`, which drops administrator
 * privileges via a restricted token. embedded-postgres launches `postgres.exe` directly, which
 * PostgreSQL refuses under an administrator account (hosted Windows runners). `pg_ctl` also works
 * for non-admin users, so every win32 host takes this path; Linux and macOS use embedded-postgres.
 */
async function pgCtlBinary(): Promise<string> {
  const fromEmbedded = createRequire(createRequire(import.meta.url).resolve('embedded-postgres'));
  const mod = (await import(
    pathToFileURL(fromEmbedded.resolve(`@embedded-postgres/windows-${process.arch}`)).href
  )) as { pg_ctl: string };
  return mod.pg_ctl;
}

function startWithPgCtl(pgCtl: string, dataDir: string, port: number, logFile: string): void {
  const opts = [
    `-p ${port}`,
    '-c listen_addresses=127.0.0.1',
    '-c log_error_verbosity=terse',
    '-c log_min_error_statement=panic',
  ].join(' ');
  const r = spawnSync(pgCtl, ['-D', dataDir, '-o', opts, '-l', logFile, '-w', '-t', '90', 'start'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  if (r.status !== 0) {
    let logTail = '';
    try {
      logTail = readFileSync(logFile, 'utf8').trim().slice(-800);
    } catch {}
    throw new Error(`pg_ctl start exited ${r.status}: ${r.stderr || r.stdout} ${logTail}`.trim());
  }
}

function stopWithPgCtl(pgCtl: string, dataDir: string): void {
  spawnSync(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { windowsHide: true, timeout: 60_000 });
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

  // Surface the server's own log on failure and never leave a data directory behind.
  const usePgCtl = process.platform === 'win32';
  const pgCtl = usePgCtl ? await pgCtlBinary() : '';
  const pgLog = `${dataDir}.log`;
  for (const phase of ['initialise', 'start'] as const) {
    try {
      if (phase === 'start' && usePgCtl) {
        startWithPgCtl(pgCtl, join(dataDir), port, pgLog);
        continue;
      }
      await server[phase]();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const tail = serverLog.slice(-8).join(' | ');
      // CI diagnostic (hosted Windows): the whole server log goes to a file the CI step prints.
      const diag = process.env.CUSPATLAS_PG_DIAG_FILE;
      if (diag) {
        try {
          writeFileSync(diag, [`phase=${phase}`, `reason=${reason}`, ...serverLog].join(' | '));
        } catch {}
      }
      try {
        if (usePgCtl) stopWithPgCtl(pgCtl, dataDir);
        else await server.stop();
      } catch {}
      if (usePgCtl) {
        try {
          serverLog.push(readFileSync(pgLog, 'utf8'));
          if (diag) writeFileSync(diag, [`phase=${phase}`, `reason=${reason}`, ...serverLog].join(' | '));
        } catch {}
        rmSync(pgLog, { force: true });
      }
      rmSync(dataDir, { recursive: true, force: true });
      throw new Error(`embedded PostgreSQL failed to ${phase}: ${reason}; server log tail: ${tail}`);
    }
  }

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
      if (usePgCtl) stopWithPgCtl(pgCtl, dataDir);
      else await server.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      if (usePgCtl) rmSync(pgLog, { force: true });
    }
  };
}
