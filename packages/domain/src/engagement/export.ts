import {
  type ActorContext,
  assertValid,
  ENGAGEMENT_EXPORT_FORMAT,
  ENGAGEMENT_EXPORT_TABLES,
  ENGAGEMENT_PROPERTIES,
  type EngagementExport,
  RefusalError,
  validateEmptyQuery,
} from '@cuspatlas/contracts';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import type { EngagementBase } from './common';

/**
 * E9 minimal engagement export (E scope; M1 owns the full export contract, manifest and completeness
 * validation), following S17: every workstream E table of the caller's tenant (portal principals,
 * consent and verification facts, templates and channel policy, suppression decisions, recall
 * enrollments, intake forms, submissions and reviews, threads and messages, outbound delivery
 * metadata, attempts and receipts, telephony configuration, calls and links), read under the runtime
 * role and RLS in one transaction, one deterministic array per table in foreign-key order, with the
 * tenant column removed. Outbound messages are delivery metadata only (no body or recipient is stored
 * in E7 tables). S14 intents travel in the S export; the two documents re-import together and every
 * foreign key is validated across both. Only a tenant-wide human administrator may export; the read is
 * sensitive-read logged.
 */
export function createEngagementExportOperations(base: EngagementBase) {
  const { deps } = base;
  return {
    exportEngagement(ctx: ActorContext, query: unknown): Promise<EngagementExport> {
      const op = 'communications.export';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        if (decision.locationRefs !== null) {
          throw new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });
        }
        return deps.withTenantTransaction(ctx, async (tx) => {
          const tables: Record<string, Record<string, unknown>[]> = {};
          for (const table of ENGAGEMENT_EXPORT_TABLES) {
            const { rows } = await tx.query<{ rows: Record<string, unknown>[] }>(
              `SELECT coalesce(jsonb_agg(to_jsonb(r) - 'tenant_id' ORDER BY (to_jsonb(r) - 'tenant_id')::text),
                 '[]'::jsonb) AS rows FROM cuspatlas.${table} r`,
            );
            tables[table] = rows[0]?.rows ?? [];
          }
          const now = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'engagementExport',
            resourceRefs: [],
            queryFields: [],
          });
          return { format: ENGAGEMENT_EXPORT_FORMAT, exportedAt: now.toISOString(), tables };
        });
      });
    },
  };
}
