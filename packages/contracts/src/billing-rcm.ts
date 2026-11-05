import type { ValidateFunction } from 'ajv/dist/2020.js';
import schema from './billing.schema.json' with { type: 'json' };
import type { Money } from './money';
import { createAjv } from './validation';

/**
 * Types mirroring the B9 (fee schedules, adjustments, receivables report), C14-consumer, B6 (claims)
 * and B7 (remittance) definitions of billing.schema.json. The JSON Schema is authoritative.
 * Synthetic data only; every rule recommended-pending-billing-approval (ADR 0008); claims and
 * remittance run against a fake clearinghouse only (B-S2 open; no X12, no real payer, no CDT).
 */
export interface FeeItem {
  readonly codeRef: string;
  readonly fee: Money;
}
export interface FeeSchedulePublish {
  readonly scheduleRef: string;
  readonly purpose: 'practice' | 'allowance';
  readonly locationRef?: string;
  readonly effectiveFrom: string;
  readonly reasonCode?: string;
  readonly items: readonly FeeItem[];
}
export interface FeeScheduleCommandData {
  readonly feeScheduleRef: string;
  readonly versionRef: string;
  readonly versionNo: number;
}
export interface FeeResolveQuery {
  readonly codeRef: string;
  readonly serviceDate: string;
  readonly locationRef?: string;
  readonly coverageRef?: string;
}
export interface ResolvedFee {
  readonly fee: Money;
  readonly feeScheduleRef: string;
  readonly scheduleRef: string;
  readonly versionRef: string;
  readonly versionNo: number;
  readonly effectiveFrom: string;
}
export interface FeeResolution {
  readonly codeRef: string;
  readonly serviceDate: string;
  readonly practice: ResolvedFee | null;
  readonly allowance: ResolvedFee | null;
}
export interface ProcedureConsumeData {
  readonly procedureRef: string;
  readonly eventType: 'procedure.rendered.v1' | 'procedure.reversed.v1';
  readonly chargeRef: string;
  readonly entryRef: string;
  readonly replayed: boolean;
}
export type AdjustmentKind = 'contractual' | 'courtesy' | 'writeOff';
export interface AdjustmentPost {
  readonly kind: AdjustmentKind;
  readonly responsibility: 'patient' | 'insurer';
  readonly coverageRef?: string;
  /** Contractual only: the adjudicated claim of the coverage the adjustment belongs to. */
  readonly claimRef?: string;
  readonly amount: Money;
  readonly reasonCode: string;
}
export interface AdjustmentCommandData {
  readonly outcome: 'posted' | 'pending_approval' | 'rejected';
  readonly requestRef: string | null;
  readonly entryRef: string | null;
}
export interface AdjustmentDecision {
  readonly decision: 'approved' | 'rejected';
  readonly reasonCode?: string;
}
export interface ReceivablesQuery {
  readonly locationRef?: string;
}
export interface ReceivablesRow {
  readonly locationRef: string | null;
  readonly patientReceivable: Money;
  readonly insurerReceivable: Money;
  readonly charges: number;
}
export interface ReceivablesReport {
  readonly rows: readonly ReceivablesRow[];
  readonly scope: 'all_locations' | 'assigned_locations';
  readonly checkedAt: string;
}

const ajv = createAjv();
ajv.addSchema(schema);
export function billingDef(name: string): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`billing schema definition missing: ${name}`);
  return v;
}

export const validateFeeSchedulePublish = billingDef('FeeSchedulePublish');
export const validateFeeResolveQuery = billingDef('FeeResolveQuery');
export const validateAdjustmentPost = billingDef('AdjustmentPost');
export const validateAdjustmentDecision = billingDef('AdjustmentDecision');
export const validateReceivablesQuery = billingDef('ReceivablesQuery');
export const validateFeeResolution = billingDef('FeeResolution');
export const validateReceivablesReport = billingDef('ReceivablesReport');

// ---- B6 claims (fake clearinghouse only).
export interface ClaimPrepare {
  readonly patientRef: string;
  readonly coverageRef: string;
  readonly procedureRefs: readonly string[];
}
export interface ClaimVersioned {
  readonly expectedVersion: number;
}
export interface ClaimAttach extends ClaimVersioned {
  readonly objectRef: string;
  readonly kind: 'radiograph' | 'photo' | 'narrative' | 'perio_chart';
}
export interface ClaimReplace extends ClaimVersioned {
  readonly reasonCode: string;
  readonly procedureRefs?: readonly string[];
}
export interface ClaimSubmit extends ClaimVersioned {
  readonly authorization:
    | { readonly mode: 'explicit' }
    | { readonly mode: 'policy'; readonly policyRef: string };
}
export interface ClaimIssue {
  readonly code: string;
  readonly owner: 'billing' | 'front_office' | 'clinical';
  readonly sourceRef: string | null;
}
export interface ClaimCommandData {
  readonly claimRef: string;
  readonly versionRef: string;
  readonly versionNo: number;
  readonly outcome:
    | 'prepared'
    | 'versioned'
    | 'valid'
    | 'invalid'
    | 'transmitted'
    | 'rejected'
    | 'unknown'
    | 'polled'
    | 'packaged';
  readonly submissionRef?: string | null;
  readonly issueCount?: number;
  readonly eventCount?: number;
}
export interface ClaimWorkItem {
  readonly kind: string;
  readonly claimRef: string;
  readonly owner: 'billing' | 'front_office' | 'clinical' | 'billing_manager';
  readonly reasonCode: string;
  readonly dueAt: string;
  readonly overdue: boolean;
  readonly sourceRef: string | null;
}
export interface AppealDraft {
  readonly basisCode: string;
  readonly denialEventRef: string;
  readonly attachmentRefs?: readonly string[];
}
export interface AppealReview {
  readonly decision: 'approve_and_send' | 'reject';
}
export interface AppealCommandData {
  readonly appealRef: string;
  readonly state: 'draft' | 'sent' | 'send_unknown' | 'rejected';
}
export interface SubmissionPolicyCreate {
  readonly maxBilled: Money;
  readonly payerRef?: string;
}
export interface PolicyCommandData {
  readonly policyRef: string;
  readonly state: 'active' | 'revoked';
}
export const validateClaimPrepare = billingDef('ClaimPrepare');
export const validateClaimVersioned = billingDef('ClaimVersioned');
export const validateClaimAttach = billingDef('ClaimAttach');
export const validateClaimReplace = billingDef('ClaimReplace');
export const validateClaimSubmit = billingDef('ClaimSubmit');
export const validateClaimWorklistQuery = billingDef('ClaimWorklistQuery');
export const validateAppealDraft = billingDef('AppealDraft');
export const validateAppealReview = billingDef('AppealReview');
export const validateSubmissionPolicyCreate = billingDef('SubmissionPolicyCreate');
export const validateSubmissionPolicyRevoke = billingDef('SubmissionPolicyRevoke');
export const validateClaimReadResult = billingDef('ClaimReadResult');

// ---- B7 remittance (synthetic ERA-like structure, fake clearinghouse only).
export interface RemittanceCommandData {
  readonly remittanceRef: string;
  readonly outcome: 'ingested' | 'duplicate' | 'settled' | 'reversed';
  readonly posted: number;
  readonly review: number;
  readonly denied: number;
}
export const validateRemittanceIngest = billingDef('RemittanceIngest');
export const validateRemittanceSettle = billingDef('RemittanceSettle');
export const validateRemittanceReverse = billingDef('RemittanceReverse');
/** Shape of a fetched advice: every amount a non-negative integer (a malformed advice is 422). */
export const validateRemittanceAdvice = billingDef('RemittanceAdvice');

// ---- B7 review-line resolution and claims-workflow policy data.
export type RemittanceResolutionAction =
  | 'match_claim_line'
  | 'post_with_adjustment'
  | 'route_to_appeal'
  | 'write_off';
export interface RemittanceLineResolve {
  readonly action: RemittanceResolutionAction;
  readonly claimRef?: string;
  readonly claimLineNo?: number;
  readonly reasonCode: string;
}
export interface RemittanceResolutionDecide {
  readonly decision: 'approved' | 'rejected';
  readonly reasonCode?: string;
}
export interface RemittanceResolutionCommandData {
  readonly resolutionRef: string;
  readonly remittanceRef: string;
  readonly lineNo: number;
  readonly action: RemittanceResolutionAction;
  readonly state: 'posted' | 'pending_approval' | 'routed' | 'rejected';
  readonly entryRefs: readonly string[];
}
export interface WorkflowPolicyPublish {
  readonly payerRef?: string;
  readonly acknowledgementDueMinutes: number;
  readonly followUpMinutes: number;
  readonly exceptionDueMinutes: number;
  readonly maxEscalations: number;
  readonly writeOffLimit: Money;
}
export interface WorkflowPolicyCommandData {
  readonly policyRef: string;
  readonly versionNo: number;
}
export const validateRemittanceLineResolve = billingDef('RemittanceLineResolve');
export const validateRemittanceResolutionDecide = billingDef('RemittanceResolutionDecide');
export const validateWorkflowPolicyPublish = billingDef('WorkflowPolicyPublish');

// ---- B8 secondary claims (fake clearinghouse only).
export interface SecondaryClaimPrepare {
  readonly coverageRef: string;
}
export const validateSecondaryClaimPrepare = billingDef('SecondaryClaimPrepare');

// ---- Closed-loop claims workflow (CL-01..CL-12), attachment packages (CL-04), visit preparation (CL-01).
export interface AttachmentPackageCreate {
  readonly expectedVersion: number;
  readonly items: readonly { readonly objectRef: string; readonly digest: string }[];
}
export interface WorkflowCommandData {
  readonly workflowRef: string;
  readonly outcome: 'started' | 'advanced' | 'closed';
  readonly changes: number;
  readonly openExceptions: number;
}
export type WorkflowOwner = 'billing' | 'front_office' | 'clinical' | 'billing_manager';
export interface ClaimWorkflowView {
  readonly workflowRef: string;
  readonly claimRef: string;
  readonly workflowPolicyRef: string | null;
  readonly submissionPolicyRef: string | null;
  readonly claims: readonly { readonly claimRef: string; readonly rank: number; readonly state: string }[];
  readonly steps: readonly {
    readonly step: string;
    readonly subjectKind: string;
    readonly subjectRef: string;
    readonly outcome: string;
    readonly attempt: number;
    readonly inputVersions: Record<string, unknown>;
    readonly authority: Record<string, unknown>;
    readonly nextExpected: string | null;
    readonly recordedAt: string;
  }[];
  readonly exceptions: readonly {
    readonly exceptionRef: string;
    readonly issueKey: string;
    readonly occurrence: number;
    readonly reasonCode: string;
    readonly owner: WorkflowOwner;
    readonly owedBy: 'practice' | 'patient' | 'payer' | 'platform';
    readonly sourceRef: string | null;
    readonly state: 'open' | 'resolved';
    readonly escalationLevel: number;
    readonly openedAt: string;
    readonly dueAt: string;
  }[];
  readonly timers: readonly {
    readonly timerRef: string;
    readonly kind: 'payer_follow_up' | 'exception_escalation';
    readonly subjectRef: string;
    readonly level: number;
    readonly dueAt: string;
    readonly firedOutcome: string | null;
  }[];
  readonly responsibilities: readonly {
    readonly chargeRef: string;
    readonly patient: Money;
    readonly insurer: readonly { readonly coverageRef: string | null; readonly amount: Money }[];
  }[];
  readonly closure: {
    readonly closedAt: string;
    readonly breakdown: readonly Record<string, unknown>[];
  } | null;
  readonly version: number;
}
export interface VisitPreparation {
  readonly patientRef: string;
  readonly serviceDate: string;
  readonly coverages: readonly {
    readonly coverageRef: string;
    readonly rank: string;
    readonly payerRef: string;
    readonly coverageStatus: string;
    readonly eligibilityState: string | null;
    readonly freshness: string | null;
    readonly eligibilityRef: string | null;
  }[];
  readonly missing: readonly {
    readonly code: string;
    readonly owner: WorkflowOwner;
    readonly sourceRef: string | null;
  }[];
  readonly ready: boolean;
  readonly paymentAssurance: 'none';
  readonly checkedAt: string;
}
export const validateAttachmentPackageCreate = billingDef('AttachmentPackageCreate');
export const validateClaimWorkflowStart = billingDef('ClaimWorkflowStart');
export const validateClaimWorkflowClose = billingDef('ClaimWorkflowClose');
export const validateVisitPreparationQuery = billingDef('VisitPreparationQuery');
