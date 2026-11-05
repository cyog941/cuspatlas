import {
  type ActorContext,
  MIGRATION_EXPORT_FORMAT,
  MIGRATION_EXPORT_TABLES,
  type MigrationExport,
  RefusalError,
  validateOperationsEmptyQuery,
} from '@cuspatlas/contracts';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { OPENING_CHAIN } from '../rcm/export';
import { failed, type MigrationBase, validate } from './base';

/** Most rows one migration export carries per table (larger workspaces page in a later version). */
export const MIGRATION_EXPORT_MAX_ROWS = 50_000;

/**
 * M10 migration export: the migration workspace an audit needs, read under the runtime role and RLS
 * in one transaction, rows ordered deterministically with the tenant column removed. The opening
 * chain travels with B10; this document carries the complement of those rows, so S/I/C/E/B plus this
 * document re-import without identifier loss. A tenant-wide human administrator only.
 */
export function createMigrationExportOperations(base: MigrationBase) {
  const { deps } = base;
  return {
    exportMigration(ctx: ActorContext, query: unknown): Promise<MigrationExport> {
      const op = 'migration.export';
      return base.guarded(ctx, op, async () => {
        const decision = await deps.authorize(ctx, op, { tenantId: ctx.tenantId, id: 'migration' });
        if (decision.locationRefs !== null)
          throw new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });
        validate<Record<string, never>>(validateOperationsEmptyQuery, query ?? {});
        return deps.withTenantTransaction(ctx, async (tx) => {
          const tables: Record<string, Record<string, unknown>[]> = {};
          for (const table of MIGRATION_EXPORT_TABLES) {
            const chain = OPENING_CHAIN[table];
            const source = chain
              ? `(SELECT * FROM cuspatlas.${table} WHERE id NOT IN (SELECT id FROM ${chain.source} c))`
              : `cuspatlas.${table}`;
            const n = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${source} r`);
            if ((n.rows[0]?.n ?? 0) > MIGRATION_EXPORT_MAX_ROWS) throw failed('export_too_large');
            const { rows } = await tx.query<{ rows: Record<string, unknown>[] }>(
              `SELECT coalesce(jsonb_agg(to_jsonb(r) - 'tenant_id' ORDER BY (to_jsonb(r) - 'tenant_id')::text),
                 '[]'::jsonb) AS rows FROM ${source} r`,
            );
            tables[table] = rows[0]?.rows ?? [];
          }
          const at = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'migrationExport',
            resourceRefs: [],
            queryFields: [],
          });
          return { format: MIGRATION_EXPORT_FORMAT, exportedAt: at.toISOString(), tables };
        });
      });
    },
  };
}
