import { createHash } from 'node:crypto';
import {
  IMAGING_EXPORT_FORMAT,
  IMAGING_EXPORT_TABLES,
  type ImagingBlobBundle,
  type ImagingExport,
  type ObjectStorePort,
} from '@cuspatlas/contracts';
import type pg from 'pg';
import { assertSyntheticDatabaseName } from './migrate';

/**
 * I9 imaging export re-import (synthetic round trip, mirroring the S17 scheduling import; the full
 * migration import with mapping, staging and dry run belongs to M). Privileged (superuser) and
 * synthetic-only: refuses an unknown format or table and a non-synthetic database. Rows are inserted in
 * the export's foreign-key order inside one transaction with `session_replication_role = replica` and
 * every foreign key of every imported table (composite (id, tenant_id) keys included) is validated
 * before the commit; any orphan or cross-tenant reference rolls the whole import back. The target must
 * already hold the tenant, the principals and the patients the rows reference (the scheduling export
 * carries patients). Object bytes are imported separately by `importImagingBlobs`.
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
    [[...IMAGING_EXPORT_TABLES]],
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

export async function importImagingExport(
  pool: pg.Pool,
  tenantId: string,
  doc: ImagingExport,
): Promise<Record<string, number>> {
  if (doc.format !== IMAGING_EXPORT_FORMAT) throw new Error('Unsupported imaging export format');
  const known = new Set<string>(IMAGING_EXPORT_TABLES);
  for (const t of Object.keys(doc.tables)) if (!known.has(t)) throw new Error('Unknown table in export');
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ d: string; su: boolean }>(
      'SELECT current_database() AS d, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su',
    );
    assertSyntheticDatabaseName(String(rows[0]?.d));
    if (rows[0]?.su !== true) throw new Error('Imaging import requires the privileged fixture role');
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const counts: Record<string, number> = {};
    for (const table of IMAGING_EXPORT_TABLES) {
      const list = doc.tables[table] ?? [];
      for (const row of list) {
        await client.query(
          `INSERT INTO cuspatlas.${table} SELECT * FROM jsonb_populate_record(NULL::cuspatlas.${table}, $1::jsonb)`,
          [
            JSON.stringify({
              ...row,
              tenant_id: tenantId,
              // The content key is re-derived (never carried by the export): tenant prefix plus digest.
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

/**
 * Imports content-addressed blob bundles into a (synthetic) object store for one tenant. Every blob
 * must be listed in the export's blob manifest and must hash to its digest and length; the store then
 * re-derives the content key from the bytes. Every listed blob must arrive; nothing unlisted is written.
 */
export async function importImagingBlobs(
  store: ObjectStorePort,
  tenantId: string,
  doc: ImagingExport,
  bundles: readonly ImagingBlobBundle[],
): Promise<{ blobs: number }> {
  const wanted = new Map(doc.blobs.map((b) => [b.digestSha256, b.byteLength]));
  const decoded: { digest: string; bytes: Uint8Array }[] = [];
  for (const bundle of bundles) {
    for (const b of bundle.blobs) {
      const bytes = new Uint8Array(Buffer.from(b.contentBase64, 'base64'));
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (!wanted.has(b.digestSha256)) throw new Error('Blob not listed in the export manifest');
      if (digest !== b.digestSha256 || bytes.byteLength !== wanted.get(b.digestSha256))
        throw new Error('Blob does not match its digest');
      decoded.push({ digest, bytes });
    }
  }
  const seen = new Set(decoded.map((d) => d.digest));
  for (const d of wanted.keys()) if (!seen.has(d)) throw new Error('Blob missing from the bundles');
  for (const d of decoded) {
    const { digestSha256 } = await store.putContent(tenantId, d.bytes);
    if (digestSha256 !== d.digest) throw new Error('Stored blob digest differs');
  }
  return { blobs: decoded.length };
}
