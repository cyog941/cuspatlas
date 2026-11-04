import type {
  AllocationCommandData,
  ChargeCommandData,
  EntryCommandData,
  PaymentCommandData,
  ReconcileCommandData,
  ReversalCommandData,
} from '@cuspatlas/contracts';
import type { ReplayCodec, StoredResult } from '../commands/execute-once';

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

export const BILLING_PAYMENT_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<unknown>>> = {
  'billing.payments.record': payment as ReplayCodec<unknown>,
  'billing.payments.settle': entry as ReplayCodec<unknown>,
  'billing.payments.refund': entry as ReplayCodec<unknown>,
  'billing.funds.transfer': entry as ReplayCodec<unknown>,
  'billing.responsibility.transfer': entry as ReplayCodec<unknown>,
  'billing.payments.allocate': allocation as ReplayCodec<unknown>,
  'billing.payments.reconcile': reconcile as ReplayCodec<unknown>,
};

/** Every billing operation that runs through executeOnce (B1 and B2). */
export const BILLING_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<unknown>>> = {
  'billing.charges.post': charge as ReplayCodec<unknown>,
  'billing.entries.reverse': reversal as ReplayCodec<unknown>,
  ...BILLING_PAYMENT_REPLAY_CODECS,
};
