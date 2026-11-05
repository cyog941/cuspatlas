import { loadSettings } from '../billing/base';
import { createMigrationBase, failed, type MigrationDeps } from './base';
import { createIntakeOperations } from './intake';
import { createImportOperations } from './plan';

/**
 * The migration service (workstream M: M2-M6). The only command/query layer for the migration
 * tables; REST and MCP call these functions, none of which takes a tenant from its input. Patients,
 * merges and ledger postings go through the owning workstream commands and posting primitives.
 * Synthetic source packages only (M-S1, M-S2, M-S3 blocked-on-discovery).
 */
export function createMigrationService(deps: MigrationDeps) {
  const base = createMigrationBase(deps);
  return {
    ...createIntakeOperations(base, {
      afterStage: async () => 0,
      existingPatient: async () => {
        throw failed('decision_not_allowed');
      },
    }),
    ...createImportOperations(base, {
      financial: null,
      currency: async (tx) => (await loadSettings(tx)).currency,
    }),
  };
}

export type MigrationService = ReturnType<typeof createMigrationService>;
