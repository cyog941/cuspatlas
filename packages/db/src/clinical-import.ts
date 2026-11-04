import { CLINICAL_EXPORT_FORMAT, CLINICAL_EXPORT_TABLES, type ClinicalExport } from '@cuspatlas/contracts';
import type pg from 'pg';
import { assertSyntheticDatabaseName } from './migrate';

export { CLINICAL_EXPORT_FORMAT };

/**
 * Re-imports a clinical export (C18) into a synthetic database for one tenant, preserving every
 * identifier, after the S17 scheduling export it references (patients, locations, resources,
 * appointments) has been imported. The same method as the S17 round trip: privileged and
 * synthetic-only, unknown formats and tables refused, rows inserted in the export's foreign-key order
 * inside one transaction with `session_replication_role = replica` (cycles such as an accepted plan
 * version naming its acceptance do not depend on order, and append-only guards do not refire on
 * historical rows; check and exclusion constraints stay active), then every foreign key of every
 * clinical table, composite keys included, validated before the commit. Any orphan or cross-tenant
 * reference rolls the whole import back. Not the M1 migration import.
 */
const IDENT = /^[a-z_][a-z0-9_]*$/;
const quote = (name: string): string => {
  if (!IDENT.test(name)) throw new Error('Unexpected identifier in constraint catalog');
  return `"${name}"`;
};

async function assertForeignKeys(client: pg.PoolClient, tenantId: string): Promise<void> {
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
    [[...CLINICAL_EXPORT_TABLES]],
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
    if (orphan.rows.length > 0) throw new Error(`Import violates foreign key ${fk.conname} of ${fk.child}`);
  }
}

export async function importClinicalExport(
  pool: pg.Pool,
  tenantId: string,
  doc: ClinicalExport,
): Promise<Record<string, number>> {
  if (doc.format !== CLINICAL_EXPORT_FORMAT) throw new Error('Unsupported clinical export format');
  const known = new Set<string>(CLINICAL_EXPORT_TABLES);
  for (const t of Object.keys(doc.tables)) if (!known.has(t)) throw new Error('Unknown table in export');
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ d: string; su: boolean }>(
      'SELECT current_database() AS d, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su',
    );
    assertSyntheticDatabaseName(String(rows[0]?.d));
    if (rows[0]?.su !== true) throw new Error('Clinical import requires the privileged fixture role');
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const counts: Record<string, number> = {};
    for (const table of CLINICAL_EXPORT_TABLES) {
      const list = doc.tables[table] ?? [];
      for (const row of list) {
        await client.query(
          `INSERT INTO cuspatlas.${table} SELECT * FROM jsonb_populate_record(NULL::cuspatlas.${table}, $1::jsonb)`,
          [JSON.stringify({ ...row, tenant_id: tenantId })],
        );
      }
      counts[table] = list.length;
    }
    await assertForeignKeys(client, tenantId);
    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
