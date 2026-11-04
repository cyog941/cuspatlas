import type { ValidateFunction } from 'ajv/dist/2020.js';
import schema from './billing.schema.json' with { type: 'json' };
import type { Money } from './money';
import { collectPropertyNames, createAjv } from './validation';

/**
 * Types mirroring billing.schema.json (B1 journal, B2 payments and allocations). The JSON Schema is
 * authoritative for validation. Every amount is the shared Money type; no scalar amount field exists.
 */
export type EntryKind =
  | 'charge'
  | 'patientPayment'
  | 'insurerPayment'
  | 'adjustment'
  | 'refund'
  | 'writeOff'
  | 'transfer'
  | 'openingBalance'
  | 'allocation'
  | 'settlement'
  | 'responsibilityTransfer';
export type LedgerAccount =
  | 'patient_receivable'
  | 'insurer_receivable'
  | 'production_revenue'
  | 'unapplied_credit'
  | 'undeposited_funds'
  | 'settled_cash';

export interface ChargePost {
  readonly patientRef: string;
  readonly procedureRef: string;
  readonly procedureCode?: string;
  readonly serviceDate: string;
  readonly amount: Money;
  readonly replacesChargeRef?: string;
}
export interface EntryReverse {
  readonly reasonCode: string;
}
export interface LedgerQuery {
  readonly limit?: string;
  readonly cursor?: string;
}
export interface BalanceQuery {
  readonly currency?: string;
  readonly asOf?: string;
}
export interface JournalLine {
  readonly lineNo: number;
  readonly account: LedgerAccount;
  readonly amount: Money;
  readonly patientRef: string;
  readonly chargeRef: string | null;
  readonly paymentRef: string | null;
  readonly payerRef: string | null;
}
export interface JournalEntry {
  readonly entryRef: string;
  readonly kind: EntryKind;
  readonly currency: string;
  readonly chargeRef: string | null;
  readonly paymentRef: string | null;
  readonly reversesEntryRef: string | null;
  readonly reversedByEntryRef: string | null;
  readonly reasonCode: string | null;
  readonly externalRef: string | null;
  readonly serviceDate: string | null;
  readonly postedAt: string;
  readonly postedByRef: string;
  readonly lines: readonly JournalLine[];
}
export interface PayerAmount {
  readonly payerRef: string;
  readonly amount: Money;
}
export interface ChargeView {
  readonly chargeRef: string;
  readonly patientRef: string;
  readonly procedureRef: string;
  readonly procedureCode: string | null;
  readonly serviceDate: string;
  readonly amount: Money;
  readonly entryRef: string;
  readonly state: 'posted' | 'reversed';
  readonly reversalEntryRef: string | null;
  readonly replacesChargeRef: string | null;
  readonly replacedByChargeRef: string | null;
  readonly patientResponsibility: Money;
  readonly insurerResponsibility: readonly PayerAmount[];
  readonly allocated: Money;
  readonly version: number;
}
export interface ChargeCommandData {
  readonly chargeRef: string;
  readonly entryRef: string;
}
export interface ReversalCommandData {
  readonly entryRef: string;
  readonly reversesEntryRef: string;
}
export interface PatientBalance {
  readonly patientRef: string;
  readonly accountPatientRef: string;
  readonly coveredPatientRefs: readonly string[];
  readonly currency: string;
  readonly asOf: string;
  readonly patientResponsibility: Money;
  readonly insurerResponsibility: Money;
  readonly unappliedCredit: Money;
  readonly balance: Money;
  readonly entryCount: number;
  readonly lastPostedAt: string | null;
}

export const billingSchema = schema;
export const BILLING_PROPERTIES: ReadonlySet<string> = collectPropertyNames(schema);

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: keyof typeof schema.$defs): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`billing schema definition missing: ${name}`);
  return v;
}

export const validateBillingIdempotencyKey = def('IdempotencyKey');
export const validateBillingEntityRef = def('EntryRef');
export const validateChargePost = def('ChargePost');
export const validateEntryReverse = def('EntryReverse');
export const validateLedgerQuery = def('LedgerQuery');
export const validateBalanceQuery = def('BalanceQuery');
