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
 *    (balanced, declared line count, kinds and accounts, exact reversal, sign rules);
 * 4. the invariants the database enforces by trigger (which the replica role skips) are re-checked by
 *    SQL: a second human decides an adjustment, a resolution needing approval and an appeal; an insurer
 *    line carries its coverage's payer; an entry is reversed at most once, a remittance reversed once;
 * 5. every amount and every currency column is in the tenant's currency (never converted).
 * Any failure rolls the whole import back. This is the B round-trip check, not the M1 migration import.
 */
const IDENT = /^[a-z_][a-z0-9_]*$/;
const quote = (name: string): string => {
  if (!IDENT.test(name)) throw new Error('Unexpected identifier in constraint catalog');
  return `"${name}"`;
};

/** Money back to its integer minor-unit column (and refuse a malformed amount). */
function fromExportRow(
  row: Readonly<Record<string, unknown>>,
  currencies: Set<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => {
      if (!isMoneyColumn(k) || v === null) return [k, v];
      const m = v as { currency?: unknown; minor?: unknown };
      if (typeof m !== 'object' || typeof m.currency !== 'string' || !Number.isSafeInteger(m.minor)) {
        throw new Error(`Malformed amount in column ${k}`);
      }
      currencies.add(m.currency);
      return [k, m.minor];
    }),
  );
}

/** Every amount (and every currency column) of the tenant is in the tenant's one currency (ADR 0008 M-3). */
async function assertCurrency(
  client: pg.PoolClient,
  tenantId: string,
  seen: ReadonlySet<string>,
): Promise<void> {
  const { rows } = await client.query<{ currency: string }>(
    'SELECT currency FROM cuspatlas.billing_settings WHERE tenant_id = $1',
    [tenantId],
  );
  const tenant = rows[0]?.currency ?? 'USD';
  for (const c of seen)
    if (c !== tenant) throw new Error(`Import carries an amount in currency ${c}, not the tenant currency`);
  const { rows: cols } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'cuspatlas' AND column_name = 'currency' AND table_name = ANY ($1::text[])
     ORDER BY table_name`,
    [[...BILLING_EXPORT_TABLES]],
  );
  for (const t of cols) {
    const bad = await client.query(
      `SELECT 1 FROM cuspatlas.${quote(t.table_name)} WHERE tenant_id = $1 AND currency <> $2 LIMIT 1`,
      [tenantId, tenant],
    );
    if (bad.rows.length > 0)
      throw new Error(`Import carries a currency column other than the tenant currency (${t.table_name})`);
  }
}

/** Trigger-enforced invariants re-checked by SQL, because `session_replication_role = replica` skips triggers. */
async function assertTriggerInvariants(client: pg.PoolClient, tenantId: string): Promise<void> {
  const checks: [string, string][] = [
    [
      'an adjustment is decided by someone other than its requester',
      `SELECT 1 FROM cuspatlas.billing_adjustment_decisions d
       JOIN cuspatlas.billing_adjustment_requests r ON r.id = d.request_id AND r.tenant_id = d.tenant_id
       WHERE d.tenant_id = $1 AND r.requested_by = d.decided_by LIMIT 1`,
    ],
    [
      'a resolution needing approval is decided by someone other than its requester',
      `SELECT 1 FROM cuspatlas.rcm_remittance_resolution_decisions d
       JOIN cuspatlas.rcm_remittance_line_resolutions r ON r.id = d.resolution_id AND r.tenant_id = d.tenant_id
       WHERE d.tenant_id = $1 AND (r.requested_by = d.decided_by OR NOT r.needs_approval) LIMIT 1`,
    ],
    [
      'an appeal is reviewed by someone other than its drafter',
      `SELECT 1 FROM cuspatlas.rcm_appeal_reviews v
       JOIN cuspatlas.rcm_appeals a ON a.id = v.appeal_id AND a.tenant_id = v.tenant_id
       WHERE v.tenant_id = $1 AND a.drafted_by = v.reviewed_by LIMIT 1`,
    ],
    [
      'an insurer line carries its coverage payer',
      `SELECT 1 FROM cuspatlas.billing_journal_lines l
       JOIN cuspatlas.rcm_coverages c ON c.id = l.coverage_id AND c.tenant_id = l.tenant_id
       WHERE l.tenant_id = $1 AND l.account = 'insurer_receivable' AND c.payer_ref IS DISTINCT FROM l.payer_ref LIMIT 1`,
    ],
    [
      'a journal entry is reversed at most once',
      `SELECT 1 FROM cuspatlas.billing_journal_entries WHERE tenant_id = $1 AND reverses_entry_id IS NOT NULL
       GROUP BY reverses_entry_id HAVING count(*) > 1 LIMIT 1`,
    ],
    [
      'a remittance is reversed at most once',
      `SELECT 1 FROM cuspatlas.rcm_remittance_reversals WHERE tenant_id = $1 GROUP BY remittance_id
       HAVING count(*) > 1 LIMIT 1`,
    ],
  ];
  for (const [rule, sql] of checks) {
    const bad = await client.query(sql, [tenantId]);
    if (bad.rows.length > 0) throw new Error(`Import breaks a trigger invariant: ${rule}`);
  }
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
  const currencies = new Set<string>();
  const prepared = BILLING_EXPORT_TABLES.map(
    (table) => [table, (doc.tables[table] ?? []).map((row) => fromExportRow(row, currencies))] as const,
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
    await assertCurrency(client, tenantId, currencies);
    await assertTriggerInvariants(client, tenantId);
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
