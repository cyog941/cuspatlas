import type { ValidateFunction } from 'ajv/dist/2020.js';
import schema from './action-proposal.schema.json' with { type: 'json' };
import { collectPropertyNames, createAjv } from './validation';

/** Types mirroring action-proposal.schema.json. The JSON Schema is authoritative for validation. */
export type ProposalOperation = 'syntheticTasks.create' | 'syntheticTasks.relabel';
export type ProposalState = 'prepared' | 'approved' | 'committed' | 'expired' | 'rejected';
export type ProposalExecution = 'manual' | 'deferred';

export interface CreateProposalPayload {
  readonly label: string;
  readonly locationRef?: string;
}
export interface RelabelProposalPayload {
  readonly taskRef: string;
  readonly label: string;
  readonly expectedVersion: number;
}
export type ProposalPayload = CreateProposalPayload | RelabelProposalPayload;

export interface ProposalPrepare {
  readonly operation: ProposalOperation;
  readonly payload: ProposalPayload;
}
export interface ProposalApprove {
  readonly payloadDigest: string;
  readonly execution?: ProposalExecution;
}
export interface ProposalCommit {
  readonly payload: ProposalPayload;
}

export interface ProposalSummary {
  readonly proposalRef: string;
  readonly operation: ProposalOperation;
  readonly state: ProposalState;
  readonly payloadDigest: string;
  readonly policyVersion: string;
  readonly expiresAt: string;
  readonly resourceRef: string | null;
  readonly resourceVersion: number | null;
}

export interface Proposal extends ProposalSummary {
  readonly payload: ProposalPayload;
  readonly proposerRef: string;
  readonly proposerKind: 'human' | 'service';
  readonly approval: {
    readonly approverRef: string;
    readonly approvedAt: string;
    readonly policyVersion: string;
    readonly payloadDigest: string;
    readonly execution: ProposalExecution;
  } | null;
  readonly result: { readonly taskRef: string; readonly version: number } | null;
  readonly version: number;
}

export const actionProposalSchema = schema;
export const ACTION_PROPOSAL_SCHEMA_ID = schema.$id;
export const ACTION_PROPOSAL_PROPERTIES: ReadonlySet<string> = collectPropertyNames(schema);

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: keyof typeof schema.$defs): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`schema definition missing: ${name}`);
  return v;
}

export const validateProposalPrepare = def('ProposalPrepare');
export const validateProposalApprove = def('ProposalApprove');
export const validateProposalCommit = def('ProposalCommit');
export const validateCreateProposalPayload = def('CreatePayload');
export const validateRelabelProposalPayload = def('RelabelPayload');
export const validateProposalRef = def('ProposalRef');
