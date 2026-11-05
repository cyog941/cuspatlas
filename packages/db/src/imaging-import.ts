import { createHash } from 'node:crypto';
import {
  IMAGING_EXPORT_FORMAT,
  IMAGING_EXPORT_TABLES,
  type ImagingBlobBundle,
  type ImagingExport,
  type ObjectStorePort,
} from '@cuspatlas/contracts';
import type pg from 'pg';
import { importExports } from './export-import';

/**
 * I9 imaging export re-import (synthetic round trip, mirroring the S17 scheduling import; the full
 * migration import with mapping, staging and dry run belongs to M). Privileged (superuser) and
 * synthetic-only: refuses an unknown format or table and a non-synthetic database. Rows are inserted in
 * the export's foreign-key order inside one transaction with `session_replication_role = replica` and
 * every foreign key of every imported table (composite (id, tenant_id) keys included) is validated
 * before the commit; any orphan or cross-tenant reference rolls the whole import back. The target must
 * already hold the tenant, the principals and the patients the rows reference (the scheduling export
 * carries patients; prefer one `importExports` call with every document). Object bytes are imported
 * separately by `importImagingBlobs`.
 */
export function importImagingExport(
  pool: pg.Pool,
  tenantId: string,
  doc: ImagingExport,
): Promise<Record<string, number>> {
  if (doc.format !== IMAGING_EXPORT_FORMAT)
    return Promise.reject(new Error('Unsupported imaging export format'));
  return importExports(pool, tenantId, [doc]);
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
