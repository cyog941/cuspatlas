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
