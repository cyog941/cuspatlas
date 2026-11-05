import {
  type ActorContext,
  RefusalError,
  SCHEDULING_EXPORT_FORMAT,
  SCHEDULING_EXPORT_TABLES,
  type SchedulingExport,
} from '@cuspatlas/contracts';
import { transactionNow } from '../clock';
import { type ExportReadAudit, recordSensitiveRead } from '../events/record-sensitive-read';
import type { AppointmentBase } from './appointment-base';

/**
 * S17 minimal scheduling export (S scope; M1 owns the full export contract, manifest and
 * completeness validation). Every workstream S table of the caller tenant, read under the runtime
 * role and RLS in one transaction, one array of rows per table in foreign-key order, ordered
 * deterministically, with the tenant column removed (no record shape carries a tenant). Only a
 * tenant-wide human administrator may export; the read is sensitive-read logged.
 */
export function createExportOperations(base: AppointmentBase) {
  const { deps } = base;
  return {
    exportScheduling(ctx: ActorContext, audit?: ExportReadAudit): Promise<SchedulingExport> {
      const op = 'scheduling.export';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        if (decision.locationRefs !== null) {
          throw new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });
        }
        return deps.withTenantTransaction(ctx, async (tx) => {
          const tables: Record<string, Record<string, unknown>[]> = {};
          for (const table of SCHEDULING_EXPORT_TABLES) {
            const { rows } = await tx.query<{ rows: Record<string, unknown>[] }>(
              `SELECT coalesce(jsonb_agg(to_jsonb(r) - 'tenant_id' ORDER BY (to_jsonb(r) - 'tenant_id')::text),
                 '[]'::jsonb) AS rows FROM cuspatlas.${table} r`,
            );
            tables[table] = rows[0]?.rows ?? [];
          }
          const now = await transactionNow(tx);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: audit ? 'patientExport' : 'schedulingExport',
            resourceRefs: audit ? [...audit.subjectRefs] : [],
            queryFields: [],
          });
          return { format: SCHEDULING_EXPORT_FORMAT, exportedAt: now.toISOString(), tables };
        });
      });
    },
  };
}
