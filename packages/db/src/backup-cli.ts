import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { createBackup } from './backup';

/**
 * `pnpm backup -- --out <new-directory-outside-the-repository>`: logical backup of the synthetic
 * database named by CUSPATLAS_BACKUP_DATABASE_URL (an owner/maintenance connection that bypasses RLS).
 * Refuses non-synthetic databases and directories inside the repository. The URL is never printed.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    // pnpm forwards a literal `--` separator; drop it.
    args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')),
    options: { out: { type: 'string' } },
    strict: true,
  });
  const url = process.env.CUSPATLAS_BACKUP_DATABASE_URL;
  if (!url || !values.out) {
    process.stderr.write('usage: CUSPATLAS_BACKUP_DATABASE_URL=... pnpm backup -- --out <dir>\n');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const m = await createBackup(client, {
      outDir: resolve(values.out),
      repoRoot: resolve(import.meta.dirname, '../../..'),
    });
    process.stdout.write(
      `backup written: ${m.tables.length} tables, ${m.tables.reduce((n, t) => n + t.rows, 0)} rows, schema ${m.schemaVersion}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`backup failed: ${err instanceof Error ? err.message.split('\n')[0] : 'error'}\n`);
  process.exit(1);
});
