import {
  ENGAGEMENT_EXPORT_FORMAT,
  ENGAGEMENT_EXPORT_TABLES,
  type EngagementExport,
  SCHEDULING_EXPORT_FORMAT,
  SCHEDULING_EXPORT_TABLES,
  type SchedulingExport,
} from '@cuspatlas/contracts';
import type pg from 'pg';
import { assertSyntheticDatabaseName } from './migrate';

export { ENGAGEMENT_EXPORT_FORMAT, SCHEDULING_EXPORT_FORMAT };

/** The export formats the synthetic round-trip import knows, each with its tables in FK order. */
const FORMATS: Readonly<Record<string, readonly string[]>> = {
  [SCHEDULING_EXPORT_FORMAT]: SCHEDULING_EXPORT_TABLES,
  [ENGAGEMENT_EXPORT_FORMAT]: ENGAGEMENT_EXPORT_TABLES,
};
type ExportDocument = SchedulingExport | EngagementExport;

/**
 * Re-imports a minimal scheduling export (S17) into a synthetic database for one tenant, preserving
 * every identifier. Privileged (superuser) and synthetic-only: it refuses an unknown format, an
 * unknown table and a database whose name is not synthetic. The target must already hold the tenant
 * and the principals the rows reference (seeded tenancy). Rows are inserted table by table in the
 * foreign-key order of the export inside one transaction with `session_replication_role = replica`, so
 * a self-reference inside one table (a merged patient pointing at its survivor) does not depend on
 * row order; check and exclusion constraints stay active. Foreign keys are not enforced in that mode,
 * so every foreign key of every imported table, composite (id, tenant_id) keys included, is validated
 * before the commit and any orphan or cross-tenant reference rolls the whole import back. This is the S round-trip check, not the M1
 * migration import (no mapping, staging, dry run or reconciliation).
 */
const IDENT = /^[a-z_][a-z0-9_]*$/;
const quote = (name: string): string => {
  if (!IDENT.test(name)) throw new Error('Unexpected identifier in constraint catalog');
  return `"${name}"`;
};

/** Anti-join validation of every foreign key of the imported tables (MATCH SIMPLE semantics). */
async function assertForeignKeys(
  client: pg.PoolClient,
  tenantId: string,
  tables: readonly string[],
): Promise<void> {
  const { rows } = await client.query<{
    conname: string;
    child: string;
    parent: string;
    child_cols: string[];
    parent_cols: string[];
  }>(
    `SELECT con.conname, cc.relname AS child, pc.relname AS parent,
       ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS child_cols,
       ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS parent_cols
     FROM pg_constraint con
     JOIN pg_class cc ON cc.oid = con.conrelid
     JOIN pg_class pc ON pc.oid = con.confrelid
     JOIN pg_namespace n ON n.oid = cc.relnamespace AND n.nspname = 'cuspatlas'
     WHERE con.contype = 'f' AND cc.relname = ANY ($1::text[])
     ORDER BY cc.relname, con.conname`,
    [[...tables]],
  );
  for (const fk of rows) {
    const on = fk.child_cols
      .map((c, i) => `p.${quote(fk.parent_cols[i] ?? '')} = c.${quote(c)}`)
      .join(' AND ');
    const present = fk.child_cols.map((c) => `c.${quote(c)} IS NOT NULL`).join(' AND ');
    const orphan = await client.query(
      `SELECT 1 FROM cuspatlas.${quote(fk.child)} c
       WHERE ${present} AND c.tenant_id = $1
         AND NOT EXISTS (SELECT 1 FROM cuspatlas.${quote(fk.parent)} p WHERE ${on}) LIMIT 1`,
      [tenantId],
    );
    if (orphan.rows.length > 0) {
      throw new Error(`Import violates foreign key ${fk.conname} of ${fk.child}`);
    }
  }
}

export function importSchedulingExport(
  pool: pg.Pool,
  tenantId: string,
  doc: SchedulingExport,
  companions: readonly ExportDocument[] = [],
): Promise<Record<string, number>> {
  return importExports(pool, tenantId, [doc, ...companions]);
}

/**
 * Imports several export documents (S17 scheduling, E9 engagement) in one transaction, in the order
 * given, and validates every foreign key of every imported table across all of them before the
 * commit: S intents reference E suppression decisions and E rows reference S patients and intents,
 * so neither document is self-contained once both workstreams have written.
 */
export async function importExports(
  pool: pg.Pool,
  tenantId: string,
  docs: readonly ExportDocument[],
): Promise<Record<string, number>> {
  const plan: string[] = [];
  for (const doc of docs) {
    const tables = FORMATS[doc.format];
    if (!tables) throw new Error('Unsupported export format');
    const known = new Set<string>(tables);
    for (const t of Object.keys(doc.tables)) if (!known.has(t)) throw new Error('Unknown table in export');
    plan.push(...tables);
  }
  if (new Set(plan).size !== plan.length) throw new Error('Duplicate export document');
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
    for (const doc of docs) {
      for (const table of FORMATS[doc.format] ?? []) {
        const list = doc.tables[table] ?? [];
        for (const row of list) {
          await client.query(
            `INSERT INTO cuspatlas.${table} SELECT * FROM jsonb_populate_record(NULL::cuspatlas.${table}, $1::jsonb)`,
            [JSON.stringify({ ...row, tenant_id: tenantId })],
          );
        }
        counts[table] = list.length;
      }
    }
    await assertForeignKeys(client, tenantId, plan);
    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
