import { loadSettings } from '../billing/base';
import { createMigrationBase, type MigrationDeps } from './base';
import { createIdentityOperations } from './identity';
import { createIntakeOperations } from './intake';
import { createOpeningOperations, financialPlanner, postOpening } from './opening';
import { type ApplyHooks, createImportOperations } from './plan';
import { createReconciliationOperations } from './reconciliation';

/**
 * The migration service (workstream M: M2-M6). The only command/query layer for the migration
 * tables; REST and MCP call these functions, none of which takes a tenant from its input. Patients,
 * merges and ledger postings go through the owning workstream commands and posting primitives.
 * Synthetic source packages only (M-S1, M-S2, M-S3 blocked-on-discovery).
 */
export function createMigrationService(deps: MigrationDeps) {
  const base = createMigrationBase(deps);
  const identity = createIdentityOperations(base);
  const applyHooks: ApplyHooks = {
    financial: financialPlanner(),
    postFinancial: postOpening,
    currency: async (tx) => (await loadSettings(tx)).currency,
  };
  return {
    ...createIntakeOperations(base, identity.hooks),
    mergeIdentityGroup: identity.mergeIdentityGroup,
    readProvenance: identity.readProvenance,
    ...createOpeningOperations(base),
    ...createImportOperations(base, applyHooks),
    ...createReconciliationOperations(base, applyHooks),
  };
}

export type MigrationService = ReturnType<typeof createMigrationService>;
