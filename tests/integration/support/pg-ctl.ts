import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * On Windows the server is started through the bundled `pg_ctl`, which drops administrator
 * privileges via a restricted token. embedded-postgres launches `postgres.exe` directly, which
 * PostgreSQL refuses under an administrator account (hosted Windows runners). `pg_ctl` also works
 * for non-admin users, so every win32 host takes this path; Linux and macOS use embedded-postgres.
 */
export async function pgCtlBinary(): Promise<string> {
  const fromEmbedded = createRequire(createRequire(import.meta.url).resolve('embedded-postgres'));
  const mod = (await import(
    pathToFileURL(fromEmbedded.resolve(`@embedded-postgres/windows-${process.arch}`)).href
  )) as { pg_ctl: string };
  return mod.pg_ctl;
}

export function startWithPgCtl(pgCtl: string, dataDir: string, port: number, logFile: string): void {
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

export function stopWithPgCtl(pgCtl: string, dataDir: string): void {
  spawnSync(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { windowsHide: true, timeout: 60_000 });
}
