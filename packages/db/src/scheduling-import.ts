import {
  SCHEDULING_EXPORT_FORMAT,
  SCHEDULING_EXPORT_TABLES,
  type SchedulingExport,
} from '@cuspatlas/contracts';
import type pg from 'pg';
import { assertSyntheticDatabaseName } from './migrate';

export { SCHEDULING_EXPORT_FORMAT };

/**
 * Re-imports a minimal scheduling export (S17) into a synthetic database for one tenant, preserving
 * every identifier. Privileged (superuser) and synthetic-only: it refuses an unknown format, an
 * unknown table and a database whose name is not synthetic. The target must already hold the tenant
 * and the principals the rows reference (seeded tenancy). Rows are inserted table by table in the
 * foreign-key order of the export inside one transaction with `session_replication_role = replica`, so
 * a self-reference inside one table (a merged patient pointing at its survivor) does not depend on
 * row order; check and exclusion constraints stay active. This is the S round-trip check, not the M1
 * migration import (no mapping, staging, dry run or reconciliation).
 */
export async function importSchedulingExport(
  pool: pg.Pool,
  tenantId: string,
  doc: SchedulingExport,
): Promise<Record<string, number>> {
  if (doc.format !== SCHEDULING_EXPORT_FORMAT) throw new Error('Unsupported scheduling export format');
  const known = new Set<string>(SCHEDULING_EXPORT_TABLES);
  for (const t of Object.keys(doc.tables)) if (!known.has(t)) throw new Error('Unknown table in export');
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ d: string; su: boolean }>(
      'SELECT current_database() AS d, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su',
    );
    assertSyntheticDatabaseName(String(rows[0]?.d));
    if (rows[0]?.su !== true) throw new Error('Scheduling import requires the privileged fixture role');
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const counts: Record<string, number> = {};
    for (const table of SCHEDULING_EXPORT_TABLES) {
      const list = doc.tables[table] ?? [];
      for (const row of list) {
        await client.query(
          `INSERT INTO cuspatlas.${table} SELECT * FROM jsonb_populate_record(NULL::cuspatlas.${table}, $1::jsonb)`,
          [JSON.stringify({ ...row, tenant_id: tenantId })],
        );
      }
      counts[table] = list.length;
    }
    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
