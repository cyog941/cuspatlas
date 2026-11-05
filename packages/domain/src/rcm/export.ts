import {
  type ActorContext,
  BILLING_EXPORT_FORMAT,
  BILLING_EXPORT_TABLES,
  type BillingExport,
  isMoneyColumn,
  RefusalError,
} from '@cuspatlas/contracts';
import { type BillingBase, loadSettings } from '../billing/base';
import { recordSensitiveRead } from '../events/record-sensitive-read';

/** Every `*_minor` amount of an exported row as Money in the row's own currency (else the tenant's). */
export function toExportRow(row: Record<string, unknown>, currency: string): Record<string, unknown> {
  const own = typeof row.currency === 'string' ? row.currency : currency;
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      isMoneyColumn(k) && typeof v === 'number' ? { currency: own, minor: v } : v,
    ]),
  );
}

/**
 * B10 versioned billing export (B scope; M1 owns the full export contract): every billing and rcm
 * table of the caller tenant, read under the runtime role and RLS in one transaction, one array per
 * table ordered deterministically, the tenant column removed, every amount as Money and every
 * reference preserved. A tenant-wide human administrator only; sensitive-read logged.
 */
export function createBillingExportOperations(base: BillingBase) {
  const { deps } = base;
  return {
    exportBilling(ctx: ActorContext): Promise<BillingExport> {
      const op = 'billing.export';
      return base.guarded(ctx, op, async () => {
        const decision = await deps.authorize(ctx, op, { tenantId: ctx.tenantId, id: 'billing' });
        if (decision.locationRefs !== null) {
          throw new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });
        }
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { currency } = await loadSettings(tx);
          const tables: Record<string, Record<string, unknown>[]> = {};
          for (const table of BILLING_EXPORT_TABLES) {
            const { rows } = await tx.query<{ rows: Record<string, unknown>[] }>(
              `SELECT coalesce(jsonb_agg(to_jsonb(r) - 'tenant_id' ORDER BY (to_jsonb(r) - 'tenant_id')::text),
                 '[]'::jsonb) AS rows FROM cuspatlas.${table} r`,
            );
            tables[table] = (rows[0]?.rows ?? []).map((row) => toExportRow(row, currency));
          }
          const now = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'billingExport',
            resourceRefs: [],
            queryFields: [],
          });
          return { format: BILLING_EXPORT_FORMAT, exportedAt: now.toISOString(), currency, tables };
        });
      });
    },
  };
}
