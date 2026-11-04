import type { ReplayCodec, StoredResult } from '../commands/execute-once';

/**
 * Replay projection of imaging commands. Every command result is a flat object of server values:
 * references, enumerations, instants, SHA-256 digests, counts and flags (and lists of references).
 * Caller text (file names, labels, provenance text) never enters a command result, so it can never
 * reach `command_idempotency`; `persist` checks each value and fails closed on anything else.
 */
const SAFE = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^[0-9a-f]{64}$/,
  /^[a-z][a-z0-9_.:-]{0,79}$/,
  /^[a-z][A-Za-z]{0,63}$/,
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+Z)?$/,
];
const safe = (v: unknown) =>
  v === null ||
  typeof v === 'number' ||
  typeof v === 'boolean' ||
  (typeof v === 'string' && SAFE.some((r) => r.test(v)));
const LISTS = 'listFields';

export const imagingCodec: ReplayCodec<Record<string, unknown>> = {
  persist(data): StoredResult {
    const out: Record<string, string | number | boolean | null> = { kind: 'success' };
    const lists: string[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (k === 'kind' || k === LISTS) throw new Error('Command result uses a reserved key');
      if (safe(v)) out[k] = v as string | number | boolean | null;
      else if (Array.isArray(v) && v.every((x) => typeof x === 'string' && safe(x))) {
        out[k] = v.join(',');
        lists.push(k);
      } else throw new Error('Command result is not a flat server projection');
    }
    out[LISTS] = lists.join(',');
    return out;
  },
  restore(stored) {
    if (stored.kind !== 'success' || typeof stored[LISTS] !== 'string')
      throw new Error('Stored result is malformed');
    const lists = new Set(
      String(stored[LISTS])
        .split(',')
        .filter((x) => x !== ''),
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(stored)) {
      if (k === 'kind' || k === LISTS) continue;
      out[k] = lists.has(k) ? (v === '' ? [] : String(v).split(',')) : v;
    }
    return out;
  },
};

/** Imaging commands replayed through `imagingCodec`; each imaging task appends its commands. */
export const IMAGING_OPERATIONS: readonly string[] = [
  'imaging.objects.revokeGrant',
  'imaging.storage.reconcile',
  'imaging.ingress.begin',
  'imaging.ingress.upload',
  'imaging.ingress.complete',
  'imaging.associations.confirm',
  'imaging.associations.correct',
  'imaging.mounts.create',
  'imaging.mounts.revise',
  'imaging.annotations.create',
  'imaging.annotations.supersede',
  'imaging.derived.create',
];

export const IMAGING_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<unknown>>> = Object.fromEntries(
  IMAGING_OPERATIONS.map((op) => [op, imagingCodec as ReplayCodec<unknown>]),
);
