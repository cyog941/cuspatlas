import type { ValidateFunction } from 'ajv/dist/2020.js';
import type { ClinicalAuthor } from './clinical';
import schema from './clinical.schema.json' with { type: 'json' };
import type { PlanVersionState, ToothInput, ToothRef } from './clinical-chart';
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

/** C13 consent capture (C-D6 recommended-pending-approval). Treatment consent, not E's messaging consent. */
export type ConsentScope = 'treatment_plan' | 'procedure' | 'general_treatment';
export type ConsentMethod = 'in_person' | 'portal' | 'paper' | 'verbal_attested';
export type ConsentSigner =
  | { readonly kind: 'patient' }
  | { readonly kind: 'related_person'; readonly personRef: string };
export interface ConsentEvidence {
  readonly artifactRef: string;
  readonly digest: string;
}
export interface ConsentCapture {
  readonly patientRef: string;
  readonly scope: ConsentScope;
  readonly planVersionRef?: string;
  readonly planItemRef?: string;
  readonly method: ConsentMethod;
  readonly templateRef: string;
  readonly templateDigest: string;
  readonly attestationCode: string;
  readonly signer: ConsentSigner;
  readonly witnessRef?: string;
  readonly evidence?: ConsentEvidence;
}
export interface ConsentWithdraw {
  readonly expectedVersion: number;
  readonly reasonCode: string;
  readonly signer: ConsentSigner;
  readonly evidence?: ConsentEvidence;
}
export interface ConsentListQuery {
  readonly asOf?: string;
  readonly planVersionRef?: string;
}
export interface ConsentTemplateRegister {
  readonly templateRef: string;
  readonly digest: string;
}
export type ConsentSignerBasis = 'self_adult' | 'self_age_unknown' | 'relationship_consent_scope';
export interface ConsentSignerRecord {
  readonly kind: 'patient' | 'related_person';
  readonly personRef: string;
  readonly basis: ConsentSignerBasis;
  readonly relationshipRefs: readonly string[];
  readonly policyVersion: string | null;
  readonly evaluatedAt: string;
}
export interface ConsentWithdrawal {
  readonly reasonCode: string;
  readonly signer: ConsentSignerRecord;
  readonly evidence: ConsentEvidence | null;
  readonly recordedBy: string;
  readonly effectiveAt: string;
}
export interface Consent {
  readonly consentRef: string;
  readonly patientRef: string;
  readonly sourcePatientRef: string;
  readonly scope: ConsentScope;
  readonly planVersionRef: string | null;
  readonly planItemRef: string | null;
  readonly acceptanceRef: string | null;
  readonly method: ConsentMethod;
  readonly templateRef: string;
  readonly templateDigest: string;
  readonly templateStatus: 'registered' | 'unresolved';
  readonly attestationCode: string;
  readonly evidence: ConsentEvidence | null;
  readonly signer: ConsentSignerRecord;
  readonly witnessRef: string | null;
  readonly recordedBy: string;
  readonly effectiveAt: string;
  readonly version: number;
  readonly state: 'active' | 'withdrawn';
  readonly withdrawal: ConsentWithdrawal | null;
}
export interface ConsentTemplate {
  readonly templateRef: string;
  readonly digest: string;
  readonly registeredBy: string;
  readonly registeredAt: string;
}

/** C14 rendered procedures and the billing boundary. No amount and no narrative on any shape. */
export type ProcedureDuplicateIntent = 'repeat_in_visit' | 'additional_visit';
export interface ProcedureRender {
  readonly sequence: number;
  readonly dateOfService: string;
  readonly renderingProviderRef: string;
  readonly planItemRef?: string;
  readonly codeRef?: string;
  readonly tooth?: ToothInput;
  readonly surfaces?: readonly string[];
  readonly chartEntryRef?: string;
  readonly providerOverrideReason?: string;
  readonly duplicateIntent?: ProcedureDuplicateIntent;
}
export interface ProcedureReplacement {
  readonly sequence?: number;
  readonly dateOfService?: string;
  readonly renderingProviderRef?: string;
  readonly codeRef?: string;
  readonly tooth?: ToothInput;
  readonly surfaces?: readonly string[];
  readonly providerOverrideReason?: string;
}
export interface ProcedureCorrect {
  readonly reasonCode: string;
  readonly replacement?: ProcedureReplacement;
}
/** The C14 -> B event payload (`procedure.rendered.v1` / `procedure.reversed.v1`). */
export interface ProcedureBillingEvent {
  readonly eventType: 'procedure.rendered.v1' | 'procedure.reversed.v1';
  readonly procedureRef: string;
  readonly patientRef: string;
  readonly encounterRef: string;
  readonly renderingProviderRef: string;
  readonly dateOfService: string;
  readonly codeRef: string;
  readonly toothSurface: { readonly toothRef: string; readonly surfaces: readonly string[] | null } | null;
  readonly planItemRef: string | null;
  readonly reversesProcedureRef: string | null;
  readonly replacesProcedureRef: string | null;
  readonly version: 1;
}
export interface RenderedProcedure {
  readonly procedureRef: string;
  readonly kind: 'rendered' | 'reversal';
  readonly state: 'active' | 'reversed' | 'reversal';
  readonly encounterRef: string;
  readonly patientRef: string;
  readonly sourcePatientRef: string;
  readonly sequence: number;
  readonly planItemRef: string | null;
  readonly provenance: 'planned' | 'unscheduled' | 'correction';
  readonly codeRef: string;
  readonly tooth: ToothRef | null;
  readonly surfaces: readonly string[] | null;
  readonly chartEntryRef: string | null;
  readonly chartDiscrepancy: 'none' | 'chart_entry_superseded' | 'chart_entry_entered_in_error';
  readonly dateOfService: string;
  readonly renderingProviderRef: string;
  readonly providerOverrideReason: string | null;
  readonly duplicateIntent: ProcedureDuplicateIntent | null;
  readonly reversesProcedureRef: string | null;
  readonly reversedByRef: string | null;
  readonly replacesProcedureRef: string | null;
  readonly replacedByRef: string | null;
  readonly reasonCode: string | null;
  readonly recordedBy: ClinicalAuthor;
  readonly recordedAt: string;
  readonly billingEvent: ProcedureBillingEvent;
}
export interface ProcedureCorrection {
  readonly original: RenderedProcedure;
  readonly reversal: RenderedProcedure;
  readonly replacement: RenderedProcedure | null;
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
export const validateConsentCapture = def('ConsentCapture');
export const validateConsentWithdraw = def('ConsentWithdraw');
export const validateConsentListQuery = def('ConsentListQuery');
export const validateConsentTemplateRegister = def('ConsentTemplateRegister');
export const validateConsentCommandResult = def('ConsentCommandResult');
export const validateConsentRead = def('ConsentRead');
export const validateConsentList = def('ConsentList');
export const validateConsentTemplateCommandResult = def('ConsentTemplateCommandResult');
export const validateProcedureRender = def('ProcedureRender');
export const validateProcedureCorrect = def('ProcedureCorrect');
export const validateProcedureCommandResult = def('ProcedureCommandResult');
export const validateProcedureCorrectionResult = def('ProcedureCorrectionResult');
export const validateProcedureRead = def('ProcedureRead');
export const validateProcedureList = def('ProcedureList');
export const validateProcedureBillingEvent = def('ProcedureBillingEvent');

// C15 encounter image links (I owns the image; C stores a link by imageRef only).
export interface ImageLinkCreate {
  readonly imageRef: string;
  readonly reasonCode?: string;
}
export interface ImageLinkRelink {
  readonly encounterRef: string;
  readonly reasonCode: string;
}
export interface ImageLinkUnlink {
  readonly reasonCode: string;
}
export type ImageResolutionStatus =
  | 'current'
  | 'association_changed'
  | 'unavailable'
  | 'not_found'
  | 'resolver_unavailable';
export interface EncounterImageLink {
  readonly imageLinkRef: string;
  readonly encounterRef: string;
  readonly patientRef: string;
  readonly imageRef: string;
  readonly state: 'active' | 'ended';
  readonly endKind: 'unlinked' | 'relinked' | null;
  readonly endReasonCode: string | null;
  readonly relinkedFromRef: string | null;
  readonly relinkedToRef: string | null;
  readonly linkedBy: string;
  readonly linkedByRole: ClinicalAuthor['role'];
  readonly linkedAt: string;
  readonly endedBy: string | null;
  readonly endedAt: string | null;
  readonly image: { readonly status: ImageResolutionStatus; readonly reviewRequired: boolean };
}
export const validateImageLinkCreate = def('ImageLinkCreate');
export const validateImageLinkRelink = def('ImageLinkRelink');
export const validateImageLinkUnlink = def('ImageLinkUnlink');
export const validateImageLinkCommandResult = def('ImageLinkCommandResult');
export const validateImageLinkRead = def('ImageLinkRead');
export const validateImageLinkList = def('ImageLinkList');
