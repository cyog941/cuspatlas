import { resolve } from 'node:path';
import pg from 'pg';
import { migrate } from './migrate';

/**
 * `pnpm migrate`: applies supabase/migrations with the privileged connection named by
 * CUSPATLAS_MIGRATION_DATABASE_URL. Refuses targets whose database name lacks cuspatlas_synthetic.
 * The URL is never printed.
 */
async function main(): Promise<void> {
  const url = process.env.CUSPATLAS_MIGRATION_DATABASE_URL;
  if (!url) {
    process.stderr.write('CUSPATLAS_MIGRATION_DATABASE_URL is not set\n');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { applied } = await migrate(client, {
      dir: resolve(import.meta.dirname, '../../../supabase/migrations'),
    });
    process.stdout.write(
      `applied ${applied.length} migration(s)${applied.length ? `: ${applied.join(', ')}` : ''}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`migration failed: ${err instanceof Error ? err.name : 'error'}\n`);
  process.exit(1);
});
