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
  | 'responsibilityTransfer'
  | 'insurerSettlement';
export type LedgerAccount =
  | 'patient_receivable'
  | 'insurer_receivable'
  | 'production_revenue'
  | 'unapplied_credit'
  | 'undeposited_funds'
  | 'settled_cash'
  | 'adjustment_expense'
  | 'insurer_clearing'
  | 'insurer_cash'
  // M5 opening facts (entry kind openingBalance only; keyed on the migration opening item).
  | 'opening_receivable'
  | 'opening_credit'
  | 'opening_equity';

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
  /** B5: the coverage an insurer receivable line names (null for legacy payer-only lines). */
  readonly coverageRef: string | null;
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
  readonly coverageRef: string | null;
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

// ---- B2 payments, allocations and undistributed funds.
export type PaymentMethod = 'cash' | 'check' | 'card_synthetic';
export type PaymentOutcome = 'confirmed' | 'declined' | 'unknown';
export interface PaymentRecord {
  readonly patientRef: string;
  readonly amount: Money;
  readonly method: PaymentMethod;
  readonly externalRef?: string;
  readonly instrumentRef?: string;
  readonly guarantorRef?: string;
  readonly receivedAt?: string;
}
export interface PaymentSettle {
  readonly settlementRef: string;
  readonly reasonCode?: string;
}
export interface PaymentAllocate {
  readonly allocations: readonly { readonly chargeRef: string; readonly amount: Money }[];
}
export interface PaymentRefund {
  readonly amount: Money;
  readonly reasonCode: string;
  readonly refundRef?: string;
}
export interface FundsTransfer {
  readonly fromPatientRef?: string;
  readonly toPatientRef: string;
  readonly amount: Money;
  readonly reasonCode: string;
}
export interface ResponsibilityTransfer {
  readonly direction: 'to_insurer' | 'to_patient';
  readonly coverageRef: string;
  readonly amount: Money;
  readonly reasonCode: string;
}
export interface AttemptReconcile {
  readonly reasonCode?: string;
}
export type BillingWorklistKind = 'unapplied_funds' | 'unknown_payment_outcome';
export interface BillingWorklistQuery {
  readonly kind?: BillingWorklistKind;
  readonly limit?: string;
}
export interface PaymentCommandData {
  readonly outcome: PaymentOutcome;
  readonly paymentRef: string | null;
  readonly attemptRef: string | null;
  readonly entryRef: string | null;
}
export interface EntryCommandData {
  readonly entryRef: string;
}
export interface AllocationCommandData {
  readonly allocationRefs: readonly string[];
}
export interface ReconcileCommandData {
  readonly attemptRef: string;
  readonly outcome: 'confirmed' | 'declined';
  readonly paymentRef: string | null;
  readonly entryRef: string | null;
}
export interface AllocationView {
  readonly allocationRef: string;
  readonly chargeRef: string;
  readonly patientRef: string;
  readonly amount: Money;
  readonly allocatedAt: string;
  readonly reversedByEntryRef: string | null;
}
export interface HolderAmount {
  readonly patientRef: string;
  readonly amount: Money;
}
export interface PaymentView {
  readonly paymentRef: string;
  readonly patientRef: string;
  readonly guarantorRef: string | null;
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly externalRef: string | null;
  readonly attemptRef: string | null;
  readonly receivedAt: string;
  readonly entryRef: string;
  readonly state: 'received' | 'reversed';
  readonly settlement: {
    readonly state: 'received' | 'partially_settled' | 'settled';
    readonly settled: Money;
    readonly unsettled: Money;
  };
  readonly allocated: Money;
  readonly refunded: Money;
  readonly unapplied: Money;
  readonly unappliedByPatient: readonly HolderAmount[];
  readonly allocations: readonly AllocationView[];
  readonly version: number;
}
export interface BillingWorkItem {
  readonly kind: BillingWorklistKind;
  readonly subjectRef: string;
  readonly patientRef: string;
  readonly amount: Money;
  readonly ageBasis: string;
  readonly owner: 'practice';
  readonly queue: 'billing';
  readonly reasonCode: 'unapplied_funds' | 'provider_outcome_unknown';
  readonly dueAt: string;
  readonly overdue: boolean;
  readonly suggestedAction: 'allocate_or_refund' | 'reconcile_attempt';
}
export interface BillingWorklist {
  readonly data: readonly BillingWorkItem[];
  readonly totalCount: number;
  readonly truncated: boolean;
  readonly checkedAt: string;
}

export const validatePaymentRecord = def('PaymentRecord');
export const validatePaymentSettle = def('PaymentSettle');
export const validatePaymentAllocate = def('PaymentAllocate');
export const validatePaymentRefund = def('PaymentRefund');
export const validateFundsTransfer = def('FundsTransfer');
export const validateResponsibilityTransfer = def('ResponsibilityTransfer');
export const validateAttemptReconcile = def('AttemptReconcile');
export const validateBillingWorklistQuery = def('WorklistQuery');

// ---- B3 payment plans (recommended-pending-billing-approval; card execution B-S1).
export type PlanWorklistKind = 'missing_signature' | 'expired_card' | 'failed_autopay' | 'overdue';
export type PlanAttemptOutcome = 'confirmed' | 'declined' | 'unknown' | 'blocked';
export interface PlanCreate {
  readonly patientRef: string;
  readonly guarantorRef?: string;
  readonly contractTotal: Money;
  readonly installmentCount: number;
  readonly firstDueOn: string;
  readonly timeZone: string;
}
export interface PlanAuthorize {
  readonly expectedVersion: number;
  readonly authorizationRef: string;
  readonly evidenceRef: string;
}
export interface PlanAmend {
  readonly expectedVersion: number;
  readonly contractTotal: Money;
  readonly installmentCount: number;
  readonly firstDueOn: string;
  readonly reasonCode: string;
}
export interface PlanAutopay {
  readonly expectedVersion: number;
  readonly state: 'active' | 'paused';
  readonly instrumentRef?: string;
  readonly cardExpiry?: string;
  readonly authorizationRef?: string;
}
export interface PlanCollect {
  readonly periodNo: number;
  readonly amount?: Money;
  readonly retry?: boolean;
}
export interface PlanClose {
  readonly expectedVersion: number;
  readonly outcome: 'voided' | 'defaulted';
  readonly reasonCode: string;
}
export interface PlanWorklistQuery {
  readonly kind?: PlanWorklistKind;
  readonly limit?: string;
}
export interface PlanCommandData {
  readonly planRef: string;
  readonly termsVersion: number;
  readonly eventRef: string | null;
}
export interface PlanCollectData {
  readonly planRef: string;
  readonly planAttemptRef: string;
  readonly outcome: PlanAttemptOutcome;
  readonly attemptRef: string | null;
  readonly paymentRef: string | null;
}
export interface PlanInstallment {
  readonly periodNo: number;
  readonly dueOn: string;
  readonly amount: Money;
  readonly collected: Money;
  readonly state: 'scheduled' | 'due' | 'overdue' | 'partially_paid' | 'paid';
}
export interface PlanAttemptView {
  readonly planAttemptRef: string;
  readonly termsVersion: number;
  readonly periodNo: number;
  readonly attemptNo: number;
  readonly outcome: PlanAttemptOutcome;
  readonly blockReason: 'card_expired' | null;
  readonly amount: Money;
  readonly attemptRef: string | null;
  readonly paymentRef: string | null;
  readonly attemptedAt: string;
}
export type PlanEventKind =
  | 'authorized'
  | 'autopay_enrolled'
  | 'autopay_paused'
  | 'autopay_resumed'
  | 'voided'
  | 'defaulted';
export interface PlanEventView {
  readonly eventRef: string;
  readonly kind: PlanEventKind;
  readonly termsVersion: number;
  readonly authorizationRef: string | null;
  readonly evidenceRef: string | null;
  readonly instrumentRef: string | null;
  readonly cardExpiry: string | null;
  readonly reasonCode: string | null;
  readonly actorRef: string;
  readonly recordedAt: string;
}
export interface PlanTermsView {
  readonly termsVersion: number;
  readonly contractTotal: Money;
  readonly installmentCount: number;
  readonly firstDueOn: string;
  readonly collectedBasis: Money;
  readonly reasonCode: string | null;
  readonly agreedAt: string;
}
export interface PaymentPlanView {
  readonly planRef: string;
  readonly patientRef: string;
  readonly guarantorRef: string;
  readonly guarantorBasis: 'relationship' | 'self';
  readonly timeZone: string;
  readonly termsVersion: number;
  readonly contractTotal: Money;
  readonly installment: Money;
  readonly installmentCount: number;
  readonly collected: Money;
  readonly balance: Money;
  readonly overdue: Money;
  readonly overdueSince: string | null;
  readonly nextDueOn: string | null;
  readonly authorizationState: 'unsigned' | 'authorized';
  readonly autoPayState: 'not_enrolled' | 'active' | 'paused' | 'failed' | 'blocked';
  readonly cardExpiryState: 'current' | 'expiring' | 'expired' | 'absent';
  readonly cardExpiry: string | null;
  readonly instrumentRef: string | null;
  readonly planState: 'open' | 'completed' | 'voided' | 'defaulted';
  readonly closedReasonCode: string | null;
  readonly installments: readonly PlanInstallment[];
  readonly attempts: readonly PlanAttemptView[];
  readonly events: readonly PlanEventView[];
  readonly terms: readonly PlanTermsView[];
  readonly asOf: string;
  readonly version: number;
}
export interface PlanWorkItem {
  readonly kind: PlanWorklistKind;
  readonly planRef: string;
  readonly patientRef: string;
  readonly guarantorRef: string;
  readonly amount: Money;
  readonly owner: 'practice';
  readonly queue: 'billing';
  readonly reasonCode:
    | 'authorization_missing'
    | 'card_expired'
    | 'card_expiring'
    | 'autopay_declined'
    | 'installment_overdue';
  readonly dueAt: string;
  readonly overdue: boolean;
  readonly suggestedAction:
    | 'obtain_signed_authorization'
    | 'obtain_new_instrument_and_authorization'
    | 'contact_guarantor_or_retry'
    | 'contact_guarantor';
  readonly evidenceRefs: readonly {
    readonly kind: 'planAttempt' | 'paymentAttempt' | 'planEvent';
    readonly ref: string;
  }[];
}
export interface PlanWorklist {
  readonly data: readonly PlanWorkItem[];
  readonly totalCount: number;
  readonly truncated: boolean;
  readonly checkedAt: string;
}

export const validatePlanCreate = def('PlanCreate');
export const validatePlanAuthorize = def('PlanAuthorize');
export const validatePlanAmend = def('PlanAmend');
export const validatePlanAutopay = def('PlanAutopay');
export const validatePlanCollect = def('PlanCollect');
export const validatePlanClose = def('PlanClose');
export const validatePlanWorklistQuery = def('PlanWorklistQuery');

// ---- B4 statements (recommended-pending-billing-approval; delivery belongs to E7).
export interface StatementGenerate {
  readonly guarantorRef: string;
  readonly cutoffAt: string;
  readonly basis: 'posted_through_cutoff';
}
export interface StatementCommandData {
  readonly statementRef: string;
  readonly statementVersion: number;
  readonly snapshotDigest: string;
  readonly supersedesStatementRef: string | null;
}
export interface StatementLine {
  readonly entryRef: string;
  readonly kind: EntryKind;
  readonly postedAt: string;
  readonly serviceDate: string | null;
  readonly chargeRef: string | null;
  readonly paymentRef: string | null;
  readonly amount: Money;
}
export interface StatementAccount {
  readonly accountPatientRef: string;
  readonly coveredPatientRefs: readonly string[];
  readonly total: Money;
  readonly lines: readonly StatementLine[];
}
export type StatementStaleReason =
  | 'posted_after_cutoff'
  | 'pre_cutoff_changed'
  | 'account_membership_changed'
  | 'superseded';
export interface StatementFreshness {
  readonly state: 'fresh' | 'stale';
  readonly reasons: readonly StatementStaleReason[];
  readonly currentTotal: Money;
  readonly postedAfterCutoff: number;
  readonly lastPostedAt: string | null;
  readonly checkedAt: string;
}
export interface StatementView {
  readonly statementRef: string;
  readonly guarantorRef: string;
  readonly statementVersion: number;
  readonly cutoffAt: string;
  readonly basis: 'posted_through_cutoff';
  readonly currency: string;
  readonly total: Money;
  readonly amountDue: Money;
  readonly creditBalance: Money;
  readonly totalClass: 'due' | 'zero' | 'credit';
  readonly coveredPatientRefs: readonly string[];
  readonly accounts: readonly StatementAccount[];
  readonly snapshotDigest: string;
  readonly integrity: 'verified' | 'mismatch';
  readonly supersedesStatementRef: string | null;
  readonly supersededByStatementRef: string | null;
  readonly generatedAt: string;
  readonly generatedByRef: string;
  readonly delivery: { readonly channel: 'none'; readonly state: 'not_requested'; readonly owner: 'E7' };
  readonly freshness: StatementFreshness;
}

export const validateStatementGenerate = def('StatementGenerate');

// ---- B5 coverage and eligibility (recommended-pending-billing-approval; live eligibility B-S3).
export type BenefitRank = 'primary' | 'secondary' | 'tertiary';
export type SubscriberRelationship = 'self' | 'spouse' | 'child' | 'other';
export type EligibilitySource = 'entered' | 'fake_adapter';
export type EligibilityState = 'verified' | 'unverified' | 'unknown' | 'unparsed';
/** B5 coverage status (review S3: a verified inactive member is inactive, never entered). */
export type CoverageResolutionStatus = 'entered' | 'inactive' | 'unknown' | 'stale';
export interface CoverageRecordInput {
  readonly patientRef: string;
  readonly payerRef: string;
  readonly rank: BenefitRank;
  readonly subscriberRef?: string;
  readonly relationshipToSubscriber: SubscriberRelationship;
  readonly memberRef: string;
  readonly groupRef?: string;
  readonly feeScheduleRef?: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil?: string;
  readonly overlapOverride?: { readonly reasonCode: string };
}
export interface CoverageChangeInput extends Omit<CoverageRecordInput, 'patientRef' | 'payerRef'> {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export interface BenefitLimit {
  readonly kind: 'annual_maximum' | 'deductible' | 'remaining_maximum' | 'deductible_remaining';
  readonly amount: Money;
}
export interface BenefitFrequency {
  readonly categoryCode: string;
  readonly count: number;
  readonly periodMonths: number;
  /** Services already used in the current period, when the source reports it. */
  readonly used?: number;
}
/** C12 structured benefit placeholder: the insurer share of a category's allowed amount (whole percent). */
export interface BenefitCoinsurance {
  readonly categoryCode: string;
  readonly insurerPercent: number;
}
/** C12 structured benefit placeholder: the date a category's waiting period is satisfied. */
export interface BenefitWaitingPeriod {
  readonly categoryCode: string;
  readonly satisfiedOn: string;
}
export interface EligibilityInput {
  readonly source: EligibilitySource;
  readonly serviceDate: string;
  readonly freshnessHours?: number;
  readonly retrievedAt?: string;
  readonly benefits?: {
    readonly activeStatus?: 'active' | 'inactive' | 'unknown';
    readonly limits?: readonly BenefitLimit[];
    readonly frequencies?: readonly BenefitFrequency[];
    readonly coinsurance?: readonly BenefitCoinsurance[];
    readonly waitingPeriods?: readonly BenefitWaitingPeriod[];
  };
}
export interface CoverageQuery {
  readonly serviceDate: string;
}
export interface CoverageCommandData {
  readonly coverageRef: string;
  readonly coverageVersion: number;
}
export interface EligibilityCommandData {
  readonly eligibilityRef: string;
  readonly state: EligibilityState;
}
export interface BenefitProvenance {
  readonly source: EligibilitySource;
  readonly capturedAt: string;
  readonly recordedByRef: string;
  readonly receiptRef: string | null;
}
export interface Benefits {
  readonly status?: {
    readonly value: 'active' | 'inactive' | 'unknown';
    readonly provenance: BenefitProvenance;
  };
  readonly limits?: { readonly items: readonly BenefitLimit[]; readonly provenance: BenefitProvenance };
  readonly frequencies?: {
    readonly items: readonly BenefitFrequency[];
    readonly provenance: BenefitProvenance;
  };
  readonly coinsurance?: {
    readonly items: readonly BenefitCoinsurance[];
    readonly provenance: BenefitProvenance;
  };
  readonly waitingPeriods?: {
    readonly items: readonly BenefitWaitingPeriod[];
    readonly provenance: BenefitProvenance;
  };
}
export interface EligibilityView {
  readonly eligibilityRef: string;
  readonly coverageVersion: number;
  readonly source: EligibilitySource;
  readonly state: EligibilityState;
  readonly serviceDate: string;
  readonly retrievedAt: string;
  readonly freshUntil: string;
  readonly freshnessHours: number;
  readonly benefits: Benefits;
  readonly rawEvidenceDigest: string | null;
  readonly recordedByRef: string;
}
export interface CoverageVersionView {
  readonly coverageVersion: number;
  readonly rank: BenefitRank;
  readonly subscriberRef: string;
  readonly relationshipToSubscriber: SubscriberRelationship;
  readonly memberRef: string;
  readonly groupRef: string | null;
  readonly feeScheduleRef: string | null;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly overlapOverrideReasonCode: string | null;
  readonly reasonCode: string | null;
  readonly recordedAt: string;
  readonly recordedByRef: string;
}
export interface CoverageView {
  readonly coverageRef: string;
  readonly patientRef: string;
  readonly payerRef: string;
  readonly current: CoverageVersionView;
  readonly history: readonly CoverageVersionView[];
  readonly eligibility: readonly EligibilityView[];
  readonly version: number;
}
/** The read C12 estimates use (EstimateView.coverageStatus); B never constructs an estimate. */
export interface CoverageSummary {
  readonly coverageRef: string;
  readonly coverageVersion: number;
  readonly payerRef: string;
  readonly rank: BenefitRank;
  readonly subscriberRef: string;
  readonly relationshipToSubscriber: SubscriberRelationship;
  readonly feeScheduleRef: string | null;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly coverageStatus: CoverageResolutionStatus;
  readonly eligibility: (EligibilityView & { readonly freshness: 'current' | 'stale' }) | null;
  readonly latestAttempt: {
    readonly eligibilityRef: string;
    readonly state: EligibilityState;
    readonly retrievedAt: string;
  } | null;
  readonly paymentAssurance: 'none';
}
export interface CoverageResolution {
  readonly patientRef: string;
  readonly serviceDate: string;
  readonly coverages: readonly CoverageSummary[];
  readonly checkedAt: string;
}

export const validateCoverageRecord = def('CoverageRecord');
export const validateCoverageChange = def('CoverageChange');
export const validateEligibilityRecord = def('EligibilityRecord');
export const validateCoverageQuery = def('CoverageQuery');
