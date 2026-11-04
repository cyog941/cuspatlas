import type { ChargeCommandData, ReversalCommandData } from '@cuspatlas/contracts';
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

export const BILLING_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<unknown>>> = {
  'billing.charges.post': charge as ReplayCodec<unknown>,
  'billing.entries.reverse': reversal as ReplayCodec<unknown>,
};
