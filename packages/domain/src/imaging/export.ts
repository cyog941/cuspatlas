import {
  type ActorContext,
  assertValid,
  IMAGING_EXPORT_FORMAT,
  IMAGING_EXPORT_TABLES,
  IMAGING_PROPERTIES,
  type ImagingExport,
  RefusalError,
  validateImagingExportBlobsQuery,
} from '@cuspatlas/contracts';
import { type ExportReadAudit, recordSensitiveRead } from '../events/record-sensitive-read';
import { failed, type ImagingBase } from './base';

/** Largest blob page in bytes (REST only); a larger tenant pages with `after`. */
export const EXPORT_BLOB_PAGE_BYTES = 8 * 1024 * 1024;
/** Most rows one imaging export carries per table (larger tenants are an M-workstream concern). */
export const EXPORT_MAX_ROWS = 10_000;

/**
 * I9 imaging export. A versioned JSON document of every imaging record of the caller's tenant that a
 * re-import needs (object metadata with digests, provenance, association decisions and imageRefs,
 * mounts and slots, annotations, derived lineage, retention policies, legal holds and deletion
 * requests), read under the runtime role in one transaction, rows in foreign-key order with the
 * tenant column removed, plus the content-addressed blob manifest (digest and length of every
 * available object's bytes). Bytes travel separately as content-addressed blob bundles (REST only).
 * Not exported: read grants (short-lived credentials), ingress sessions (transient staging and
 * tenant-bound match keys) and bridge devices and jobs (a restored tenant pairs its devices again).
 * Only a tenant-wide human administrator may export; reads are sensitive-read logged.
 */
export function createExportOperations(base: ImagingBase) {
  const { deps } = base;
  const tenantWide = async (ctx: ActorContext, op: 'imaging.export' | 'imaging.export.blobs') => {
    const decision = await base.authorize(ctx, op);
    if (decision.locationRefs !== null)
      throw new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });
  };
  return {
    exportImaging(ctx: ActorContext, audit?: ExportReadAudit): Promise<ImagingExport> {
      const op = 'imaging.export';
      return base.guarded(ctx, op, async () => {
        await tenantWide(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const tables: Record<string, Record<string, unknown>[]> = {};
          for (const table of IMAGING_EXPORT_TABLES) {
            const n = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM cuspatlas.${table}`);
            if ((n.rows[0]?.n ?? 0) > EXPORT_MAX_ROWS)
              throw failed('export_too_large', { limit: { name: 'exportMaxRows', value: EXPORT_MAX_ROWS } });
            // The storage key is internal (it names the tenant prefix) and never leaves the service; the
            // import re-derives it from the target tenant and the digest.
            const drop = table === 'imaging_objects' ? "'tenant_id' - 'storage_key'" : "'tenant_id'";
            const { rows } = await tx.query<{ rows: Record<string, unknown>[] }>(
              `SELECT coalesce(jsonb_agg(to_jsonb(r) - ${drop} ORDER BY (to_jsonb(r) - ${drop})::text),
                 '[]'::jsonb) AS rows FROM cuspatlas.${table} r`,
            );
            tables[table] = rows[0]?.rows ?? [];
          }
          const blobs = await tx.query<{ digest_sha256: string; byte_length: string }>(
            `SELECT DISTINCT digest_sha256, byte_length FROM cuspatlas.imaging_objects WHERE state = 'available'
             ORDER BY digest_sha256`,
          );
          const now = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: audit ? 'patientExport' : 'imagingExport',
            resourceRefs: audit ? [...audit.subjectRefs] : [],
            queryFields: [],
          });
          return {
            format: IMAGING_EXPORT_FORMAT,
            exportedAt: now.toISOString(),
            tables,
            blobs: blobs.rows.map((b) => ({
              digestSha256: b.digest_sha256,
              byteLength: Number(b.byte_length),
            })),
          };
        });
      });
    },

    /**
     * One page of content-addressed blobs (REST only: bytes never travel on MCP), each verified against
     * its digest on read, in digest order after `after`. `next` is null on the last page.
     */
    exportImagingBlobs(ctx: ActorContext, query: unknown) {
      const op = 'imaging.export.blobs';
      return base.guarded(ctx, op, async () => {
        await tenantWide(ctx, op);
        assertValid(validateImagingExportBlobsQuery, query, IMAGING_PROPERTIES);
        const after = (query as { after?: string }).after ?? '';
        const store = base.store();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{ digest_sha256: string; storage_key: string }>(
            `SELECT DISTINCT ON (digest_sha256) digest_sha256, storage_key FROM cuspatlas.imaging_objects
             WHERE state = 'available' AND digest_sha256 > $1 ORDER BY digest_sha256 LIMIT 1000`,
            [after],
          );
          const blobs: { digestSha256: string; byteLength: number; contentBase64: string }[] = [];
          let size = 0;
          let next: string | null = null;
          for (const r of rows) {
            const bytes = await store.read(ctx.tenantId, r.storage_key, r.digest_sha256);
            if (blobs.length > 0 && size + bytes.byteLength > EXPORT_BLOB_PAGE_BYTES) {
              next = blobs[blobs.length - 1]?.digestSha256 ?? null;
              break;
            }
            size += bytes.byteLength;
            blobs.push({
              digestSha256: r.digest_sha256,
              byteLength: bytes.byteLength,
              contentBase64: Buffer.from(bytes).toString('base64'),
            });
          }
          if (next === null && rows.length === 1000) next = blobs[blobs.length - 1]?.digestSha256 ?? null;
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'imagingExport',
            resourceRefs: [],
            queryFields: after === '' ? [] : ['after'],
          });
          return { format: 'cuspatlas-imaging-blobs/1' as const, blobs, next };
        });
      });
    },
  };
}
