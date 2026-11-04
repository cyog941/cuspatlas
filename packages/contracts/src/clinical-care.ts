import type { ValidateFunction } from 'ajv/dist/2020.js';
import schema from './clinical.schema.json' with { type: 'json' };
import type { PlanVersionState } from './clinical-chart';
import { createAjv } from './validation';

/**
 * Types mirroring the C12 (estimates, alternatives, acceptance), C13 (consent) and C14 (rendered
 * procedures) definitions of clinical.schema.json. The JSON Schema is authoritative. Synthetic data
 * only; semantics recommended-pending-clinical-approval. Money is the SHARED-CONTRACTS shape.
 */
export interface Money {
  readonly currency: string;
  readonly minor: number;
}

export type CoverageStatus = 'entered' | 'unknown' | 'stale';
export type EstimateAssumptionKind = 'coverage' | 'discount';

export interface EstimateLineInput {
  readonly planItemRef: string;
  readonly fee: Money;
}
export interface EstimateAssumptionInput {
  readonly kind: EstimateAssumptionKind;
  readonly sourceRef: string;
  readonly sourceAsOf: string;
}
export interface EstimateGenerate {
  readonly lines: readonly EstimateLineInput[];
  readonly assumptions?: readonly EstimateAssumptionInput[];
  readonly feeScheduleVersionRef?: string;
}
export interface EstimatePresent {
  readonly expectedEstimateNumber?: number;
}
export interface EstimateAccept {
  readonly expectedRevision: number;
  readonly scope: 'full' | 'phases';
  readonly phases?: readonly number[];
}
export interface PlanAlternativeCreate {
  readonly displayText?: string;
  readonly encounterRef?: string;
}

export type PatientResponsibility =
  | { readonly kind: 'unknown'; readonly label: 'coverage_unknown' }
  | { readonly kind: 'not_available'; readonly label: 'estimate_incomplete' }
  | {
      readonly kind: 'range';
      readonly low: Money;
      readonly high: Money;
      readonly basis: 'coverage_not_applied';
    };

export interface EstimateConsentBinding {
  readonly status: 'outstanding' | 'bound' | 'withdrawn';
  readonly consentRefs: readonly string[];
}
export interface PlanAcceptance {
  readonly acceptanceRef: string;
  readonly planVersionRef: string;
  readonly estimateRef: string;
  readonly scope: 'full';
  readonly acceptedBy: string;
  readonly acceptedAt: string;
  readonly estimatePresented: boolean;
  readonly consent: EstimateConsentBinding;
}
export interface Estimate {
  readonly estimateRef: string;
  readonly planRef: string;
  readonly planVersionRef: string;
  readonly patientRef: string;
  readonly number: number;
  readonly state: 'current' | 'superseded';
  readonly supersedesRef: string | null;
  readonly supersededByRef: string | null;
  readonly feeScheduleVersionRef: string | null;
  readonly complete: boolean;
  readonly lines: readonly {
    readonly planItemRef: string;
    readonly feeScheduleRef: string;
    readonly fee: Money;
  }[];
  readonly itemsWithoutFee: readonly string[];
  readonly assumptions: readonly EstimateAssumptionInput[];
  readonly coverageStatus: CoverageStatus;
  readonly grossAmount: Money | null;
  readonly patientResponsibility: PatientResponsibility;
  readonly notAGuarantee: true;
  readonly presentation: {
    readonly presentedBy: string;
    readonly presentedAt: string;
    readonly coverageStatus: CoverageStatus;
  } | null;
  readonly acceptance: PlanAcceptance | null;
  readonly createdBy: string;
  readonly createdAt: string;
}
export interface PlanAlternative {
  readonly planRef: string;
  readonly headVersionRef: string;
  readonly headState: PlanVersionState;
  readonly selection: 'accepted' | 'unselected' | 'undecided';
}

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: keyof typeof schema.$defs): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`schema definition missing: ${name}`);
  return v;
}

export const validateEstimateGenerate = def('EstimateGenerate');
export const validateEstimatePresent = def('EstimatePresent');
export const validateEstimateAccept = def('EstimateAccept');
export const validatePlanAlternativeCreate = def('PlanAlternativeCreate');
/** Response schemas, used by tests to prove REST and MCP results conform to the contract. */
export const validateEstimateCommandResult = def('EstimateCommandResult');
export const validateEstimateRead = def('EstimateRead');
export const validateEstimateList = def('EstimateList');
export const validatePlanAlternativeList = def('PlanAlternativeList');
