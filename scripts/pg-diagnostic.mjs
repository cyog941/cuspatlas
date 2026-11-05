// CI-only diagnostic (closeout B): why embedded PostgreSQL does not initialise on hosted Windows
// runners. Runs the bundled initdb and postgres binaries directly, captures their stdout/stderr to a
// log file, and prints it, so a non-blocking CI step shows the real cause. Synthetic, throwaway data
// directory under the OS temp dir; nothing is read from or written to the repository. Product code
// is untouched. Usage: node scripts/pg-diagnostic.mjs [logFile]
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const log = process.argv[2] ?? join(tmpdir(), 'cuspatlas-pg-diagnostic.log');
writeFileSync(log, '');
const note = (line) => appendFileSync(log, `${line}\n`);

const platformPackage = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
let bin;
try {
  // embedded-postgres is a dependency of the integration test package (tests/integration).
  const fromTests = createRequire(new URL('../tests/integration/package.json', import.meta.url));
  const fromEmbedded = createRequire(fromTests.resolve('embedded-postgres'));
  bin = await import(new URL(`file:///${fromEmbedded.resolve(platformPackage).replace(/\\/g, '/')}`).href);
} catch (err) {
  note(`cannot resolve ${platformPackage}: ${err instanceof Error ? err.message : String(err)}`);
}

note(`platform=${process.platform} arch=${process.arch} node=${process.version}`);
note(`user=${process.env.USERNAME ?? process.env.USER ?? '?'} temp=${tmpdir()}`);

function run(label, file, args, timeout = 60_000) {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout, windowsHide: true });
  note(`--- ${label}: status=${r.status} signal=${r.signal} error=${r.error ? r.error.message : 'none'}`);
  if (r.stdout) note(`stdout:\n${r.stdout}`);
  if (r.stderr) note(`stderr:\n${r.stderr}`);
  return r.status === 0;
}

const freePort = () =>
  new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? ok(addr.port) : fail(new Error('no port'))));
    });
  });

let ok = false;
const dataDir = mkdtempSync(join(tmpdir(), 'cuspatlas-pgdiag-'));
try {
  if (bin) {
    for (const name of ['initdb', 'postgres', 'pg_ctl'])
      note(`${name}=${bin[name]} exists=${existsSync(bin[name])}`);
    run('initdb --version', bin.initdb, ['--version']);
    run('postgres --version', bin.postgres, ['--version']);
    const pw = join(dataDir, '..', `pgdiag-pw-${process.pid}`);
    writeFileSync(pw, 'synthetic-diagnostic-only');
    const db = join(dataDir, 'data');
    const init = run('initdb', bin.initdb, [
      `--pgdata=${db}`,
      '--auth=password',
      '--username=postgres',
      `--pwfile=${pw}`,
      '--encoding=UTF8',
      '--locale=C',
    ]);
    rmSync(pw, { force: true });
    if (init) {
      // Start the server with its stderr captured; wait for readiness or exit (at most 30 s).
      const port = String(await freePort());
      ok = await new Promise((resolve) => {
        const child = spawn(bin.postgres, ['-D', db, '-p', port, '-c', 'listen_addresses=127.0.0.1'], {
          windowsHide: true,
        });
        let out = '';
        let finished = false;
        const done = (value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          note(`--- postgres start: ready=${value}\n${out}`);
          child.kill();
          resolve(value);
        };
        const timer = setTimeout(() => done(false), 30_000);
        const onData = (d) => {
          out += String(d);
          if (out.includes('ready to accept connections')) done(true);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (e) => {
          out += `spawn error: ${e.message}\n`;
          done(false);
        });
        child.on('exit', (code, signal) => {
          out += `exited code=${code} signal=${signal}\n`;
          done(false);
        });
      });
    }
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

note(`result=${ok ? 'initdb and postgres start succeeded' : 'FAILED'}`);
process.stdout.write(readFileSync(log, 'utf8'));
process.exitCode = ok ? 0 : 1;
