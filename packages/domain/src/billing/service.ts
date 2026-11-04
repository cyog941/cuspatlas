import { type BillingDeps, createBillingBase } from './base';
import { createChargeOperations } from './charges';
import { createEntryOperations } from './entries';

/**
 * The billing service (B1 journal; B2 adds payments and allocations). The only command/query layer
 * for the billing tables: REST and MCP call these functions, none of which takes a tenant from its
 * input. Synthetic data only; financial rules are recommended-pending-billing-approval (ADR 0008).
 */
export function createBillingService(deps: BillingDeps) {
  const base = createBillingBase(deps);
  return {
    ...createChargeOperations(base),
    ...createEntryOperations(base),
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
