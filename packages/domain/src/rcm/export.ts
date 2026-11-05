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
 * H2 M-9: the migration rows exported with B are only the opening chain: every opening item, the
 * staged record each repeats, its package (the manifest and digests, without the source tables) and
 * profile. Other staged records, review items, applied records, reports and sign-offs are the
 * migration workspace and stay out of the export.
 */
const OPENING_CHAIN: Readonly<Record<string, { source: string; row: string }>> = {
  migration_source_profiles: {
    source: `(SELECT * FROM cuspatlas.migration_source_profiles WHERE id IN (SELECT p.profile_id
      FROM cuspatlas.migration_packages p WHERE p.id IN (SELECT package_id FROM cuspatlas.migration_opening_items)))`,
    row: `to_jsonb(r) - 'tenant_id'`,
  },
  migration_packages: {
    source: `(SELECT * FROM cuspatlas.migration_packages
      WHERE id IN (SELECT package_id FROM cuspatlas.migration_opening_items))`,
    row: `(to_jsonb(r) - 'tenant_id') || jsonb_build_object('raw', r.raw - 'tables')`,
  },
  migration_staged_records: {
    source: `(SELECT * FROM cuspatlas.migration_staged_records
      WHERE id IN (SELECT staged_record_id FROM cuspatlas.migration_opening_items))`,
    row: `to_jsonb(r) - 'tenant_id'`,
  },
};

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
            const chain = OPENING_CHAIN[table];
            const row = chain?.row ?? `to_jsonb(r) - 'tenant_id'`;
            const { rows } = await tx.query<{ rows: Record<string, unknown>[] }>(
              `SELECT coalesce(jsonb_agg(${row} ORDER BY (${row})::text), '[]'::jsonb) AS rows
               FROM ${chain?.source ?? `cuspatlas.${table}`} r`,
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
