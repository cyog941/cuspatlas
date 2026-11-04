import type {
  AllocationCommandData,
  ChargeCommandData,
  CoverageCommandData,
  EligibilityCommandData,
  EntryCommandData,
  PaymentCommandData,
  PlanCollectData,
  PlanCommandData,
  ReconcileCommandData,
  ReversalCommandData,
  StatementCommandData,
} from '@cuspatlas/contracts';
import type { ReplayCodec, StoredResult } from '../commands/execute-once';
import { flatCodec } from '../scheduling/ext-codecs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const malformed = () => new Error('Stored result is malformed');
export const storedRef = (v: unknown): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw malformed();
  return v;
};
export const storedRefOrNull = (v: unknown): string | null => (v === null ? null : storedRef(v));
export const success = (stored: StoredResult) => {
  if (stored.kind !== 'success') throw malformed();
};

/**
 * Billing replay projections (B1). Stored results hold server-issued references only; no amount,
 * caller text or patient reference is kept in the idempotency row. The path reference of a
 * reversal comes back from the replay request, whose payload has the identical canonical digest.
 */
const charge: ReplayCodec<ChargeCommandData> = {
  persist: (d): StoredResult => ({ kind: 'success', chargeRef: d.chargeRef, entryRef: d.entryRef }),
  restore(stored) {
    success(stored);
    return { chargeRef: storedRef(stored.chargeRef), entryRef: storedRef(stored.entryRef) };
  },
};

const reversal: ReplayCodec<ReversalCommandData> = {
  persist: (d): StoredResult => ({ kind: 'success', entryRef: d.entryRef }),
  restore(stored, payload) {
    success(stored);
    const original = (payload as { entryRef?: unknown } | null)?.entryRef;
    return { entryRef: storedRef(stored.entryRef), reversesEntryRef: storedRef(original) };
  },
};

// ---- B2.
const payment: ReplayCodec<PaymentCommandData> = {
  persist: (d): StoredResult => ({
    kind: 'success',
    outcome: d.outcome,
    paymentRef: d.paymentRef,
    attemptRef: d.attemptRef,
    entryRef: d.entryRef,
  }),
  restore(stored) {
    success(stored);
    const outcome = stored.outcome;
    if (outcome !== 'confirmed' && outcome !== 'declined' && outcome !== 'unknown') throw malformed();
    return {
      outcome,
      paymentRef: storedRefOrNull(stored.paymentRef),
      attemptRef: storedRefOrNull(stored.attemptRef),
      entryRef: storedRefOrNull(stored.entryRef),
    };
  },
};

const entry: ReplayCodec<EntryCommandData> = {
  persist: (d): StoredResult => ({ kind: 'success', entryRef: d.entryRef }),
  restore(stored) {
    success(stored);
    return { entryRef: storedRef(stored.entryRef) };
  },
};

const allocation: ReplayCodec<AllocationCommandData> = {
  persist: (d): StoredResult => ({ kind: 'success', allocationRefs: d.allocationRefs.join(',') }),
  restore(stored) {
    success(stored);
    if (typeof stored.allocationRefs !== 'string') throw malformed();
    return { allocationRefs: stored.allocationRefs.split(',').map(storedRef) };
  },
};

const reconcile: ReplayCodec<ReconcileCommandData> = {
  persist: (d): StoredResult => ({
    kind: 'success',
    outcome: d.outcome,
    paymentRef: d.paymentRef,
    entryRef: d.entryRef,
  }),
  restore(stored, payload) {
    success(stored);
    if (stored.outcome !== 'confirmed' && stored.outcome !== 'declined') throw malformed();
    return {
      attemptRef: storedRef((payload as { attemptRef?: unknown } | null)?.attemptRef),
      outcome: stored.outcome,
      paymentRef: storedRefOrNull(stored.paymentRef),
      entryRef: storedRefOrNull(stored.entryRef),
    };
  },
};

// ---- B3.
const storedVersion = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw malformed();
  return v;
};
const plan: ReplayCodec<PlanCommandData> = {
  persist: (d): StoredResult => ({
    kind: 'success',
    planRef: d.planRef,
    termsVersion: d.termsVersion,
    eventRef: d.eventRef,
  }),
  restore(stored) {
    success(stored);
    return {
      planRef: storedRef(stored.planRef),
      termsVersion: storedVersion(stored.termsVersion),
      eventRef: storedRefOrNull(stored.eventRef),
    };
  },
};
const PLAN_OUTCOMES = new Set(['confirmed', 'declined', 'unknown', 'blocked']);
const collect: ReplayCodec<PlanCollectData> = {
  persist: (d): StoredResult => ({
    kind: 'success',
    planRef: d.planRef,
    planAttemptRef: d.planAttemptRef,
    outcome: d.outcome,
    attemptRef: d.attemptRef,
    paymentRef: d.paymentRef,
  }),
  restore(stored) {
    success(stored);
    if (typeof stored.outcome !== 'string' || !PLAN_OUTCOMES.has(stored.outcome)) throw malformed();
    return {
      planRef: storedRef(stored.planRef),
      planAttemptRef: storedRef(stored.planAttemptRef),
      outcome: stored.outcome as PlanCollectData['outcome'],
      attemptRef: storedRefOrNull(stored.attemptRef),
      paymentRef: storedRefOrNull(stored.paymentRef),
    };
  },
};

// ---- B4.
const statement: ReplayCodec<StatementCommandData> = {
  persist: (d): StoredResult => ({
    kind: 'success',
    statementRef: d.statementRef,
    statementVersion: d.statementVersion,
    snapshotDigest: d.snapshotDigest,
    supersedesStatementRef: d.supersedesStatementRef,
  }),
  restore(stored) {
    success(stored);
    if (typeof stored.snapshotDigest !== 'string' || !/^[0-9a-f]{64}$/.test(stored.snapshotDigest))
      throw malformed();
    return {
      statementRef: storedRef(stored.statementRef),
      statementVersion: storedVersion(stored.statementVersion),
      snapshotDigest: stored.snapshotDigest,
      supersedesStatementRef: storedRefOrNull(stored.supersedesStatementRef),
    };
  },
};

// ---- B5.
const coverage: ReplayCodec<CoverageCommandData> = {
  persist: (d): StoredResult => ({
    kind: 'success',
    coverageRef: d.coverageRef,
    coverageVersion: d.coverageVersion,
  }),
  restore(stored) {
    success(stored);
    return {
      coverageRef: storedRef(stored.coverageRef),
      coverageVersion: storedVersion(stored.coverageVersion),
    };
  },
};
const ELIGIBILITY_STATES = new Set(['verified', 'unverified', 'unknown', 'unparsed']);
const eligibilityCodec: ReplayCodec<EligibilityCommandData> = {
  persist: (d): StoredResult => ({ kind: 'success', eligibilityRef: d.eligibilityRef, state: d.state }),
  restore(stored) {
    success(stored);
    if (typeof stored.state !== 'string' || !ELIGIBILITY_STATES.has(stored.state)) throw malformed();
    return {
      eligibilityRef: storedRef(stored.eligibilityRef),
      state: stored.state as EligibilityCommandData['state'],
    };
  },
};

export const BILLING_PLAN_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<unknown>>> = {
  'billing.plans.create': plan as ReplayCodec<unknown>,
  'billing.plans.authorize': plan as ReplayCodec<unknown>,
  'billing.plans.amend': plan as ReplayCodec<unknown>,
  'billing.plans.autopay': plan as ReplayCodec<unknown>,
  'billing.plans.close': plan as ReplayCodec<unknown>,
  'billing.plans.collect': collect as ReplayCodec<unknown>,
  'billing.statements.generate': statement as ReplayCodec<unknown>,
  'rcm.coverages.record': coverage as ReplayCodec<unknown>,
  'rcm.coverages.change': coverage as ReplayCodec<unknown>,
  'rcm.eligibility.record': eligibilityCodec as ReplayCodec<unknown>,
};

export const BILLING_PAYMENT_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<unknown>>> = {
  'billing.payments.record': payment as ReplayCodec<unknown>,
  'billing.payments.settle': entry as ReplayCodec<unknown>,
  'billing.payments.refund': entry as ReplayCodec<unknown>,
  'billing.funds.transfer': entry as ReplayCodec<unknown>,
  'billing.responsibility.transfer': entry as ReplayCodec<unknown>,
  'billing.payments.allocate': allocation as ReplayCodec<unknown>,
  'billing.payments.reconcile': reconcile as ReplayCodec<unknown>,
};

/** B6/B7/B9 commands with flat server-value results (references, enumerations, numbers). */
export const BILLING_FLAT_OPERATIONS: readonly string[] = [
  'billing.feeSchedules.publish',
  'billing.adjustments.post',
  'billing.adjustments.decide',
  'rcm.claims.prepare',
  'rcm.claims.validate',
  'rcm.claims.attach',
  'rcm.claims.replace',
  'rcm.claims.submit',
  'rcm.appeals.draft',
  'rcm.appeals.review',
  'rcm.submissionPolicies.create',
  'rcm.submissionPolicies.revoke',
  'rcm.remittances.ingest',
  'rcm.remittances.settle',
  'rcm.remittances.reverse',
];

/** Every billing operation that runs through executeOnce (B1 and B2). */
export const BILLING_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<unknown>>> = {
  'billing.charges.post': charge as ReplayCodec<unknown>,
  'billing.entries.reverse': reversal as ReplayCodec<unknown>,
  ...BILLING_PAYMENT_REPLAY_CODECS,
  ...BILLING_PLAN_REPLAY_CODECS,
  ...Object.fromEntries(BILLING_FLAT_OPERATIONS.map((op) => [op, flatCodec as ReplayCodec<unknown>])),
};
