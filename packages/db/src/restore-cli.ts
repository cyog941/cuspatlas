import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RestoreRefusedError, RestoreVerificationError, restoreBackup } from './restore';

/**
 * `pnpm restore -- --backup <dir> --target <name> --confirm-target <name>`: restores into a NEW
 * disposable database on the cluster reached by CUSPATLAS_RESTORE_ADMIN_DATABASE_URL (maintenance
 * database, e.g. `postgres`, loopback host only). Exit 0 verified, 1 verification failure or error,
 * 2 usage, 3 refused by the target guard. The URL and credentials are never printed.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    // pnpm forwards a literal `--` separator; drop it.
    args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')),
    options: {
      backup: { type: 'string' },
      target: { type: 'string' },
      'confirm-target': { type: 'string' },
    },
    strict: true,
  });
  const url = process.env.CUSPATLAS_RESTORE_ADMIN_DATABASE_URL;
  if (!url || !values.backup) {
    process.stderr.write(
      'usage: CUSPATLAS_RESTORE_ADMIN_DATABASE_URL=... pnpm restore -- --backup <dir> --target <name> --confirm-target <name>\n',
    );
    return 2;
  }
  const u = new URL(url);
  const password = u.password ? decodeURIComponent(u.password) : process.env.PGPASSWORD;
  try {
    const report = await restoreBackup(
      {
        host: u.hostname.replace(/^\[|\]$/g, ''),
        port: Number(u.port || 5432),
        user: decodeURIComponent(u.username),
        ...(password ? { password } : {}),
        database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
      },
      {
        backupDir: resolve(values.backup),
        target: values.target,
        confirmTarget: values['confirm-target'],
        migrationsDir: resolve(import.meta.dirname, '../../../supabase/migrations'),
      },
    );
    process.stdout.write(`restored and verified ${report.target}: ${report.tables.length} tables\n`);
    return 0;
  } catch (err) {
    if (err instanceof RestoreRefusedError) {
      process.stderr.write(`${err.message}\n`);
      return 3;
    }
    if (err instanceof RestoreVerificationError) {
      process.stderr.write(`${err.message}\ndiscard the disposable target ${err.target}\n`);
      return 1;
    }
    process.stderr.write(`restore failed: ${err instanceof Error ? err.name : 'error'}\n`);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    process.stderr.write('usage error\n');
    process.exit(2);
  },
);
