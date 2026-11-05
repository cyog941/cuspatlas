import {
  BILLING_EXPORT_FORMAT,
  BILLING_EXPORT_TABLES,
  type BillingExport,
  isMoneyColumn,
} from '@cuspatlas/contracts';
import type pg from 'pg';
import { assertSyntheticDatabaseName } from './migrate';

export { BILLING_EXPORT_FORMAT };

/**
 * Re-imports a billing export (B10) into a synthetic database for one tenant, preserving every
 * identifier. Privileged (superuser) and synthetic-only: an unknown format or table, a non-synthetic
 * database or a non-superuser role is refused. The target must already hold the tenant, its principals
 * and the scheduling records the rows reference (patients, locations: import the S export first).
 * Rows are inserted with `session_replication_role = replica` inside one transaction (so row order
 * never matters; triggers do not run), then, before the commit:
 * 1. every foreign key of every billing and rcm table is validated by anti-join, composite
 *    (id, tenant_id) keys included;
 * 2. every single-column foreign key whose parent has a tenant column is checked to name a parent of
 *    the same tenant (a tenant-blind key could otherwise point at another tenant's row);
 * 3. the journal invariants are re-verified for every imported entry with the database's own check
 *    (balanced, declared line count, kinds and accounts, exact reversal, sign rules).
 * Any failure rolls the whole import back. This is the B round-trip check, not the M1 migration import.
 */
const IDENT = /^[a-z_][a-z0-9_]*$/;
const quote = (name: string): string => {
  if (!IDENT.test(name)) throw new Error('Unexpected identifier in constraint catalog');
  return `"${name}"`;
};

/** Money back to its integer minor-unit column (and refuse a malformed amount). */
function fromExportRow(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => {
      if (!isMoneyColumn(k) || v === null) return [k, v];
      const m = v as { currency?: unknown; minor?: unknown };
      if (typeof m !== 'object' || typeof m.currency !== 'string' || !Number.isSafeInteger(m.minor)) {
        throw new Error(`Malformed amount in column ${k}`);
      }
      return [k, m.minor];
    }),
  );
}

async function assertReferences(client: pg.PoolClient, tenantId: string): Promise<void> {
  const { rows } = await client.query<{
    conname: string;
    child: string;
    parent: string;
    child_cols: string[];
    parent_cols: string[];
    parent_tenant: boolean;
  }>(
    `SELECT con.conname, cc.relname AS child, pc.relname AS parent,
       ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS child_cols,
       ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS parent_cols,
       EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id'
               AND NOT a.attisdropped) AS parent_tenant
     FROM pg_constraint con
     JOIN pg_class cc ON cc.oid = con.conrelid
     JOIN pg_class pc ON pc.oid = con.confrelid
     JOIN pg_namespace n ON n.oid = cc.relnamespace AND n.nspname = 'cuspatlas'
     WHERE con.contype = 'f' AND cc.relname = ANY ($1::text[])
     ORDER BY cc.relname, con.conname`,
    [[...BILLING_EXPORT_TABLES]],
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
    if (fk.parent_tenant && !fk.child_cols.includes('tenant_id') && fk.parent !== 'tenants') {
      const foreign = await client.query(
        `SELECT 1 FROM cuspatlas.${quote(fk.child)} c JOIN cuspatlas.${quote(fk.parent)} p ON ${on}
         WHERE c.tenant_id = $1 AND p.tenant_id <> c.tenant_id LIMIT 1`,
        [tenantId],
      );
      if (foreign.rows.length > 0) {
        throw new Error(`Import names another tenant's row through foreign key ${fk.conname} of ${fk.child}`);
      }
    }
  }
}

/** The database's own journal check for every imported entry (raises on any broken invariant). */
async function assertLedger(client: pg.PoolClient, tenantId: string): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM cuspatlas.billing_journal_entries WHERE tenant_id = $1 ORDER BY posted_at, id',
    [tenantId],
  );
  for (const e of rows) {
    try {
      await client.query('SELECT cuspatlas.billing_check_entry($1, $2)', [tenantId, e.id]);
    } catch (err) {
      throw new Error(`Import breaks a journal invariant (entry ${e.id}): ${(err as Error).message}`);
    }
  }
  return rows.length;
}

export async function importBillingExport(
  pool: pg.Pool,
  tenantId: string,
  doc: BillingExport,
): Promise<Record<string, number>> {
  if (doc.format !== BILLING_EXPORT_FORMAT) throw new Error('Unsupported billing export format');
  const known = new Set<string>(BILLING_EXPORT_TABLES);
  for (const t of Object.keys(doc.tables)) if (!known.has(t)) throw new Error('Unknown table in export');
  // Every amount is converted (and a malformed one refused) before anything is written.
  const prepared = BILLING_EXPORT_TABLES.map(
    (table) => [table, (doc.tables[table] ?? []).map(fromExportRow)] as const,
  );
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ d: string; su: boolean }>(
      'SELECT current_database() AS d, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su',
    );
    assertSyntheticDatabaseName(String(rows[0]?.d));
    if (rows[0]?.su !== true) throw new Error('Billing import requires the privileged fixture role');
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const counts: Record<string, number> = {};
    for (const [table, list] of prepared) {
      for (const row of list) {
        await client.query(
          `INSERT INTO cuspatlas.${quote(table)} SELECT * FROM jsonb_populate_record(NULL::cuspatlas.${quote(table)}, $1::jsonb)`,
          [JSON.stringify({ ...row, tenant_id: tenantId })],
        );
      }
      counts[table] = list.length;
    }
    await assertReferences(client, tenantId);
    counts.verifiedEntries = await assertLedger(client, tenantId);
    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
