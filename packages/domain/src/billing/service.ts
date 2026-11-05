import { createClaimOperations } from '../rcm/claims';
import { createCoverageOperations } from '../rcm/coverage';
import { createBillingExportOperations } from '../rcm/export';
import { createRemittanceOperations } from '../rcm/remittance';
import { createRemittanceResolutionOperations } from '../rcm/remittance-resolution';
import { lateSecondaryDue } from '../rcm/secondary-due';
import { createWorkflowOperations, type WorkflowDrivers } from '../rcm/workflow';
import { createAdjustmentOperations } from './adjustments';
import { createAllocationOperations } from './allocations';
import { type BillingDeps, createBillingBase } from './base';
import { createChargeOperations } from './charges';
import { createEntryOperations } from './entries';
import { createFeeOperations } from './fees';
import { createPaymentOperations } from './payments';
import { createPlanOperations } from './plans';
import { createStatementReleaseOperations } from './portal-statements';
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
  // No implicit fakes: an absent adapter disables only its operations (typed 503 adapter_not_configured).
  const provider = deps.payments ?? null;
  const partner = deps.claims ?? null;
  let drivers: WorkflowDrivers | null = null;
  const service = {
    ...createChargeOperations(base),
    ...createEntryOperations(base),
    ...createPaymentOperations(base, provider),
    ...createPlanOperations(base, provider),
    ...createStatementOperations(base, (tx, patientIds) => lateSecondaryDue(tx, { patientIds })),
    ...createStatementReleaseOperations(base),
    ...createCoverageOperations(base, deps.eligibility),
    ...createAllocationOperations(base),
    ...createWorklistOperations(base),
    ...createFeeOperations(base),
    ...createProcedureConsumer(base),
    ...createAdjustmentOperations(base),
    ...createClaimOperations(base, partner, deps.attachments),
    ...createRemittanceOperations(base, partner),
    ...createRemittanceResolutionOperations(base),
    ...createBillingExportOperations(base),
  };
  // The CL workflow drives only these owning commands (never SQL writes of their tables).
  drivers = service;
  return {
    ...service,
    ...createWorkflowOperations(base, () => drivers as WorkflowDrivers),
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
