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
    | 'polled';
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
