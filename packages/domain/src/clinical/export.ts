import {
  type ActorContext,
  CLINICAL_EXPORT_FORMAT,
  CLINICAL_EXPORT_TABLES,
  type ClinicalExport,
  RefusalError,
} from '@cuspatlas/contracts';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import type { ClinicalBase } from './base';

/**
 * C18 clinical export (synthetic round-trip scope; M1 owns the full export contract, manifest and
 * completeness validation). Every workstream C table of the caller tenant, read under the runtime role
 * and RLS in one transaction, one array per table in foreign-key order, ordered deterministically,
 * with the tenant column removed. Correction chains, consent withdrawals and note version digests are
 * rows like any other, so references are preserved. Image objects export from I, not here. Only a
 * tenant-wide human administrator may export; the read is sensitive-read logged.
 */
export function createClinicalExportOperations(base: ClinicalBase) {
  const { deps } = base;
  return {
    exportClinical(ctx: ActorContext): Promise<ClinicalExport> {
      const op = 'clinical.export';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        if (decision.locationRefs !== null) {
          throw new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });
        }
        return deps.withTenantTransaction(ctx, async (tx) => {
          const tables: Record<string, Record<string, unknown>[]> = {};
          for (const table of CLINICAL_EXPORT_TABLES) {
            const { rows } = await tx.query<{ rows: Record<string, unknown>[] }>(
              `SELECT coalesce(jsonb_agg(to_jsonb(r) - 'tenant_id' ORDER BY (to_jsonb(r) - 'tenant_id')::text),
                 '[]'::jsonb) AS rows FROM cuspatlas.${table} r`,
            );
            tables[table] = rows[0]?.rows ?? [];
          }
          const now = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'clinicalExport',
            resourceRefs: [],
            queryFields: [],
          });
          return { format: CLINICAL_EXPORT_FORMAT, exportedAt: now.toISOString(), tables };
        });
      });
    },
  };
}
