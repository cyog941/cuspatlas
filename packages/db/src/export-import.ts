import {
  BILLING_EXPORT_FORMAT,
  BILLING_EXPORT_TABLES,
  type BillingExport,
  CLINICAL_EXPORT_FORMAT,
  CLINICAL_EXPORT_TABLES,
  type ClinicalExport,
  ENGAGEMENT_EXPORT_FORMAT,
  ENGAGEMENT_EXPORT_TABLES,
  type EngagementExport,
  IMAGING_EXPORT_FORMAT,
  IMAGING_EXPORT_TABLES,
  type ImagingExport,
  SCHEDULING_EXPORT_FORMAT,
  SCHEDULING_EXPORT_TABLES,
  type SchedulingExport,
} from '@cuspatlas/contracts';
import type pg from 'pg';
import {
  assertBillingCurrency,
  assertBillingLedger,
  assertBillingProcedureRefs,
  assertBillingReferences,
  assertBillingTriggerInvariants,
  billingRowFromExport,
} from './billing-import';
import {
  assertClinicalForeignKeys,
  assertClinicalInvariants,
  type NoteDigestVerifier,
} from './clinical-import';
import { assertSyntheticDatabaseName } from './migrate';

/**
 * The export formats the synthetic round-trip import knows, each with its tables in FK order, and the
 * one import order of the platform: S17 scheduling (patients, locations, resources, appointments),
 * then I9 imaging (objects and associations of S patients; bytes travel separately as blob bundles),
 * then C18 clinical (which references S rows and names I imageRefs), then E9 engagement (which references S patients and
 * intents), then B10 billing (which references S patients and locations and C procedures by reference). S intents reference E suppression decisions, so S and E are not self-contained either;
 * every document of one call is loaded in one transaction and every foreign key is validated after
 * all of them are loaded, so cross-document references resolve regardless of the cycle.
 */
const FORMATS: Readonly<Record<string, readonly string[]>> = {
  [SCHEDULING_EXPORT_FORMAT]: SCHEDULING_EXPORT_TABLES,
  [IMAGING_EXPORT_FORMAT]: IMAGING_EXPORT_TABLES,
  [CLINICAL_EXPORT_FORMAT]: CLINICAL_EXPORT_TABLES,
  [ENGAGEMENT_EXPORT_FORMAT]: ENGAGEMENT_EXPORT_TABLES,
  [BILLING_EXPORT_FORMAT]: BILLING_EXPORT_TABLES,
};
export const IMPORT_ORDER: readonly string[] = [
  SCHEDULING_EXPORT_FORMAT,
  IMAGING_EXPORT_FORMAT,
  CLINICAL_EXPORT_FORMAT,
  ENGAGEMENT_EXPORT_FORMAT,
  BILLING_EXPORT_FORMAT,
];
export type ExportDocument =
  | SchedulingExport
  | ImagingExport
  | ClinicalExport
  | EngagementExport
  | BillingExport;

export interface ImportOptions {
  /** Required with a C18 document: recomputes the note version digests (the domain's own function). */
  readonly verifyNoteDigests?: NoteDigestVerifier;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const quote = (name: string): string => {
  if (!IDENT.test(name)) throw new Error('Unexpected identifier in constraint catalog');
  return `"${name}"`;
};

/**
 * Anti-join validation of every foreign key of the imported S and E tables (MATCH SIMPLE semantics);
 * a single-column key between two tenant-scoped tables must stay inside the tenant too.
 */
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
    scoped: boolean;
  }>(
    `SELECT con.conname, cc.relname AS child, pc.relname AS parent,
       ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS child_cols,
       ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS parent_cols,
       (EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attname = 'tenant_id'
          AND NOT a.attisdropped)
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id'
          AND NOT a.attisdropped)
        AND NOT ARRAY(SELECT a.attname::text FROM unnest(con.conkey) k(attnum)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) @> ARRAY['tenant_id']) AS scoped
     FROM pg_constraint con
     JOIN pg_class cc ON cc.oid = con.conrelid
     JOIN pg_class pc ON pc.oid = con.confrelid
     JOIN pg_namespace n ON n.oid = cc.relnamespace AND n.nspname = 'cuspatlas'
     WHERE con.contype = 'f' AND cc.relname = ANY ($1::text[])
     ORDER BY cc.relname, con.conname`,
    [[...tables]],
  );
  for (const fk of rows) {
    const on = [
      ...fk.child_cols.map((c, i) => `p.${quote(fk.parent_cols[i] ?? '')} = c.${quote(c)}`),
      ...(fk.scoped ? ['p."tenant_id" = c."tenant_id"'] : []),
    ].join(' AND ');
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

/**
 * Re-imports export documents (S17 scheduling, I9 imaging, C18 clinical, E9 engagement, B10 billing) into a synthetic database
 * for one tenant, preserving every identifier. Privileged (superuser) and synthetic-only: it refuses an
 * unknown format, an unknown table, a repeated document and a database whose name is not synthetic.
 * The target must already hold the tenant and the principals and memberships the rows reference
 * (tenancy is A's, exported by none of these); I9 bytes are imported separately by
 * `importImagingBlobs`. Documents are loaded in the platform import order (S, I, C, E, B) whatever order they are given in, table by table in each export's foreign-key order,
 * inside one transaction with `session_replication_role = replica` (self-references and
 * cross-document cycles do not depend on row order and append-only guards do not refire on historical
 * rows; check and exclusion constraints stay active). Because triggers and foreign keys are off while
 * loading, before the commit:
 * - every foreign key of every imported S and E table is validated (single-column keys between
 *   tenant-scoped tables stay inside the tenant);
 * - every foreign key of every C table is validated with C18's stricter check (any tenant-scoped
 *   parent belongs to the importing tenant; principals are members of it), then C18's invariant query
 *   set and the note version digests (`verifyNoteDigests`, required with a C18 document);
 * - with a B10 document: every amount is converted back to minor units (a malformed one refused before
 *   anything is written), then B10's checks: every billing/rcm foreign key (tenant-blind single-column
 *   keys must name a parent of the same tenant), the tenant currency, the trigger-enforced invariants the
 *   replica role skips, and the database's own journal check of every entry (`verifiedEntries`).
 * Any failure rolls the whole import back. This is the round-trip check, not the M1 migration import
 * (no mapping, staging, dry run or reconciliation).
 */
export async function importExports(
  pool: pg.Pool,
  tenantId: string,
  docs: readonly ExportDocument[],
  options: ImportOptions = {},
): Promise<Record<string, number>> {
  for (const doc of docs) {
    const tables = FORMATS[doc.format];
    if (!tables) throw new Error('Unsupported export format');
    const known = new Set<string>(tables);
    for (const t of Object.keys(doc.tables)) if (!known.has(t)) throw new Error('Unknown table in export');
  }
  if (new Set(docs.map((d) => d.format)).size !== docs.length) throw new Error('Duplicate export document');
  const ordered = [...docs].sort((a, b) => IMPORT_ORDER.indexOf(a.format) - IMPORT_ORDER.indexOf(b.format));
  const clinical = ordered.some((d) => d.format === CLINICAL_EXPORT_FORMAT);
  const verifyNoteDigests = options.verifyNoteDigests;
  if (clinical && !verifyNoteDigests) throw new Error('A clinical import requires the note digest verifier');
  const billing = ordered.some((d) => d.format === BILLING_EXPORT_FORMAT);
  // B amounts back to integer minor units (and a malformed amount refused) before anything is written.
  const currencies = new Set<string>();
  const rowsOf = (doc: ExportDocument, table: string): readonly Record<string, unknown>[] => {
    const list = (doc.tables as Readonly<Record<string, readonly Record<string, unknown>[]>>)[table] ?? [];
    return doc.format === BILLING_EXPORT_FORMAT ? list.map((r) => billingRowFromExport(r, currencies)) : list;
  };
  const prepared = ordered.map((doc) => ({
    doc,
    tables: (FORMATS[doc.format] ?? []).map((table) => [table, rowsOf(doc, table)] as const),
  }));
  const plainTables = ordered
    .filter((d) => d.format !== CLINICAL_EXPORT_FORMAT && d.format !== BILLING_EXPORT_FORMAT)
    .flatMap((d) => FORMATS[d.format] ?? []);
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ d: string; su: boolean }>(
      'SELECT current_database() AS d, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su',
    );
    assertSyntheticDatabaseName(String(rows[0]?.d));
    if (rows[0]?.su !== true) throw new Error('Export import requires the privileged fixture role');
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const counts: Record<string, number> = {};
    for (const { doc, tables } of prepared) {
      for (const [table, list] of tables) {
        for (const row of list) {
          if (doc.format === BILLING_EXPORT_FORMAT) {
            await client.query(
              `INSERT INTO cuspatlas.${quote(table)} SELECT * FROM jsonb_populate_record(NULL::cuspatlas.${quote(table)}, $1::jsonb)`,
              [JSON.stringify({ ...row, tenant_id: tenantId })],
            );
            continue;
          }
          if (table === 'portal_principals') {
            // A portal principal's identity row is server-shaped (kind portal, handle from its id) and
            // carries no other data; it is recreated rather than exported.
            await client.query(
              `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1::uuid, 'portal', 'portal-' || $1::uuid::text)
               ON CONFLICT (id) DO NOTHING`,
              [String(row.principal_id)],
            );
            // A pre-existing principal of another kind (a staff member, a service) is never adopted.
            const kind = await client.query<{ kind: string }>(
              'SELECT kind FROM cuspatlas.principals WHERE id = $1::uuid',
              [String(row.principal_id)],
            );
            if (kind.rows[0]?.kind !== 'portal') {
              throw new Error('Import refused: a portal principal id belongs to a different principal kind');
            }
          }
          // Identity columns (append-only fact order) keep their exported values.
          await client.query(
            `INSERT INTO cuspatlas.${table} OVERRIDING SYSTEM VALUE
             SELECT * FROM jsonb_populate_record(NULL::cuspatlas.${table}, $1::jsonb)`,
            [
              JSON.stringify({
                ...row,
                tenant_id: tenantId,
                // I9: the content key is re-derived (never carried by the export): tenant prefix plus digest.
                ...(table === 'imaging_objects'
                  ? {
                      storage_key: `t/${tenantId}/sha256/${String(row.digest_sha256).slice(0, 2)}/${String(row.digest_sha256)}`,
                    }
                  : {}),
              }),
            ],
          );
        }
        counts[table] = list.length;
      }
    }
    await assertForeignKeys(client, tenantId, plainTables);
    if (clinical && verifyNoteDigests) {
      await assertClinicalForeignKeys(client, tenantId);
      await assertClinicalInvariants(client, tenantId, verifyNoteDigests);
    }
    if (billing) {
      await assertBillingReferences(client, tenantId);
      await assertBillingProcedureRefs(client, tenantId);
      await assertBillingCurrency(client, tenantId, currencies);
      await assertBillingTriggerInvariants(client, tenantId);
      counts.verifiedEntries = await assertBillingLedger(client, tenantId);
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
