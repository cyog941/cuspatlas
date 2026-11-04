import { createClaimOperations } from '../rcm/claims';
import { createFakeClearinghouse } from '../rcm/clearinghouse';
import { createCoverageOperations } from '../rcm/coverage';
import { createRemittanceOperations } from '../rcm/remittance';
import { createRemittanceResolutionOperations } from '../rcm/remittance-resolution';
import { createAdjustmentOperations } from './adjustments';
import { createAllocationOperations } from './allocations';
import { type BillingDeps, createBillingBase } from './base';
import { createChargeOperations } from './charges';
import { createEntryOperations } from './entries';
import { createFeeOperations } from './fees';
import { createSyntheticPaymentProvider } from './payment-port';
import { createPaymentOperations } from './payments';
import { createPlanOperations } from './plans';
import { createProcedureConsumer } from './procedure-consumer';
import { createStatementOperations } from './statements';
import { createWorklistOperations } from './worklist';

/**
 * The billing service (B1 journal, B2 payments, allocations and undistributed funds). The only
 * command/query layer for the billing tables: REST and MCP call these functions, none of which takes
 * a tenant from its input. Synthetic data only; financial rules are recommended-pending-billing-
 * approval (ADR 0008); the payment provider is the synthetic port until B-S1 closes.
 */
export function createBillingService(deps: BillingDeps) {
  const base = createBillingBase(deps);
  const provider = deps.payments ?? createSyntheticPaymentProvider();
  const partner = deps.claims ?? createFakeClearinghouse();
  return {
    ...createChargeOperations(base),
    ...createEntryOperations(base),
    ...createPaymentOperations(base, provider),
    ...createPlanOperations(base, provider),
    ...createStatementOperations(base),
    ...createCoverageOperations(base, deps.eligibility),
    ...createAllocationOperations(base),
    ...createWorklistOperations(base),
    ...createFeeOperations(base),
    ...createProcedureConsumer(base),
    ...createAdjustmentOperations(base),
    ...createClaimOperations(base, partner),
    ...createRemittanceOperations(base, partner),
    ...createRemittanceResolutionOperations(base),
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
