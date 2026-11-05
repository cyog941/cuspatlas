import type { ValidateFunction } from 'ajv/dist/2020.js';
import schema from './agents.schema.json' with { type: 'json' };
import type { CatalogOperation } from './catalog/catalog';
import operations from './catalog/operations.json' with { type: 'json' };
import registry from './catalog/scopes.json' with { type: 'json' };
import { collectPropertyNames, createAjv } from './validation';

/**
 * Workstream A batch 2 contracts (A8-A13): agent principals, consent and budgets, generalized action
 * proposals, the draft-only AI pipeline, the evaluation gate and the prescribing envelope. Synthetic
 * only; every limit below is recommended-pending-approval (A-D2, A-D4, A-D9, A-S1..A-S3).
 */
export const agentsSchema = schema;
export const AGENTS_SCHEMA_ID = schema.$id;
export const AGENTS_PROPERTIES: ReadonlySet<string> = collectPropertyNames(schema);

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: keyof typeof schema.$defs): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`schema definition missing: ${name}`);
  return v;
}

export const validateAgentsIdempotencyKey = def('IdempotencyKey');
export const validateAgentsRef = def('Uuid');
export const validateAgentCreate = def('AgentCreate');
export const validateAgentTransition = def('AgentTransition');
export const validateAgentSponsorChange = def('AgentSponsorChange');
export const validateAgentSponsorDecision = def('AgentSponsorDecision');
export const validateAgentQuery = def('AgentQuery');
export const validateAgentListQuery = def('AgentListQuery');
export const validateAgentAuditQuery = def('AgentAuditQuery');

export const validateAgentConsentRecord = def('ConsentRecord');
export const validateAgentConsentRevoke = def('ConsentRevoke');
export const validateAgentConsentListQuery = def('ConsentListQuery');
export const validateAgentBudgetQuery = def('BudgetQuery');

// A23 agent workspace (sessions, scoped memory, scheduled tasks under a standing policy).
export const validateAgentSessionListQuery = def('SessionListQuery');
export const validateAgentSessionQuery = def('SessionQuery');
export const validateAgentSessionEnd = def('SessionEnd');
export const validateAgentMemoryWrite = def('MemoryWrite');
export const validateAgentMemoryQuery = def('MemoryQuery');
export const validateAgentMemoryListQuery = def('MemoryListQuery');
export const validateAgentSponsorOfferListQuery = def('SponsorOfferListQuery');
export const validateAgentMemoryDelete = def('MemoryDelete');
export const validateAgentMemoryPolicySet = def('MemoryPolicySet');
export const validateAgentTaskPolicyRecord = def('TaskPolicyRecord');
export const validateAgentTaskPolicyRevoke = def('TaskPolicyRevoke');
export const validateAgentTaskPolicyListQuery = def('TaskPolicyListQuery');
export const validateAgentTaskSchedule = def('TaskSchedule');
export const validateAgentTaskCancel = def('TaskCancel');
export const validateAgentTaskListQuery = def('TaskListQuery');
export const validateAgentTaskRunListQuery = def('TaskRunListQuery');

export const validateActionPrepare = def('ActionPrepare');
export const validateActionApprove = def('ActionApprove');
export const validateActionCommit = def('ActionCommit');
export const validateActionAbandon = def('ActionAbandon');
export const validateActionQuery = def('ActionQuery');
export const validateActionListQuery = def('ActionListQuery');

export const validateAiDraftCreate = def('AiDraftCreate');
export const validateAiDraftAccept = def('AiDraftAccept');
export const validateAiDraftReject = def('AiDraftReject');
export const validateAiDraftQuery = def('AiDraftQuery');
export const validateAiDraftListQuery = def('AiDraftListQuery');
export const validateAiUseCaseConfigure = def('AiUseCaseConfigure');
export const validateAiUseCaseListQuery = def('AiUseCaseListQuery');

export const validateAiEvaluationRun = def('AiEvaluationRun');
export const validateAiEvaluationListQuery = def('AiEvaluationListQuery');

export const validatePrescriptionDraftCreate = def('PrescriptionDraftCreate');
export const validatePrescriptionSubmit = def('PrescriptionSubmit');
export const validatePrescriptionCancel = def('PrescriptionCancel');

export type AgentState = 'active' | 'suspended' | 'revoked';

/** The generated operation catalog by operation id (A9 consent checks, budget sensitivity). */
export const CATALOG_INDEX: ReadonlyMap<string, CatalogOperation> = new Map(
  (operations as unknown as CatalogOperation[]).map((o) => [o.operation, o]),
);

export interface AgentBudget {
  readonly periodSeconds: number;
  readonly callsPerPeriod: number;
  readonly recordsPerPeriod: number;
  readonly phiFieldsPerPeriod: number;
  readonly recordsPerCall: number;
  readonly phiFieldsPerCall: number;
}

/** A-D9 (open): maximum agent lifetime. Recommended 90 days, pending security review. */
export const AGENT_MAX_LIFETIME_DAYS = 90;

/**
 * A-D2 human-only, non-delegable scopes, whatever the catalog says: signing, access management,
 * approval of agent proposals, AI draft review and prescription submission.
 */
export const NON_DELEGABLE_SCOPES: ReadonlySet<string> = new Set([
  'clinical.sign',
  'clinical.oversight',
  'agents.manage',
  'actions.approve',
  'ai.review',
  'prescriptions.submit',
]);

/**
 * The agent scope ceiling (A-D9 "recorded maximum scope set"): every registered scope that at least
 * one service-admitting operation uses (scopes.json `humanOnly: false`), minus the non-delegable set.
 * Generated from the operation catalog, so a new human-only operation never widens it.
 */
export const AGENT_SCOPE_CEILING: ReadonlySet<string> = new Set(
  (registry.scopes as readonly { name: string; humanOnly: boolean }[])
    .filter((x) => !x.humanOnly && !NON_DELEGABLE_SCOPES.has(x.name))
    .map((x) => x.name),
);
