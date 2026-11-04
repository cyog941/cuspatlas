import type { ReplayCodec, StoredResult } from '../commands/execute-once';

/**
 * Replay projection for the S12-S16 commands. Their command results are flat objects of server
 * references, server enumerations, instants, counts and flags (and lists of server references); no
 * caller text is ever part of a command result. `persist` checks that shape value by value and fails
 * closed on anything else, so a future field carrying caller text cannot reach the idempotency table
 * unnoticed.
 */
const SAFE = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^[a-z][a-z0-9_.:-]{0,79}$/,
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+Z)?$/,
];
const safe = (v: string) => SAFE.some((r) => r.test(v));
const LIST = 'listFields';
const OBJECTS = 'objectListFields';
const scalarSafe = (v: unknown) =>
  v === null || typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && safe(v));
const flatObject = (x: unknown) =>
  typeof x === 'object' && x !== null && !Array.isArray(x) && Object.values(x).every(scalarSafe);

export const flatCodec: ReplayCodec<Record<string, unknown>> = {
  persist(data): StoredResult {
    const out: Record<string, string | number | boolean | null> = { kind: 'success' };
    const lists: string[] = [];
    const objects: string[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (k === 'kind' || k === LIST || k === OBJECTS) throw new Error('Command result uses a reserved key');
      if (scalarSafe(v)) out[k] = v as string | number | boolean | null;
      else if (Array.isArray(v) && v.every((x) => typeof x === 'string' && safe(x) && !x.includes(','))) {
        out[k] = v.join(',');
        lists.push(k);
      } else if (Array.isArray(v) && v.length > 0 && v.every(flatObject)) {
        // A list of flat objects of server values only (for example skipped occurrences).
        out[k] = JSON.stringify(v);
        objects.push(k);
      } else {
        throw new Error('Command result is not a flat server projection');
      }
    }
    out[LIST] = lists.join(',');
    out[OBJECTS] = objects.join(',');
    return out;
  },
  restore(stored) {
    if (stored.kind !== 'success' || typeof stored[LIST] !== 'string' || typeof stored[OBJECTS] !== 'string')
      throw new Error('Stored result is malformed');
    const lists = new Set((stored[LIST] as string).split(',').filter((x) => x !== ''));
    const objects = new Set((stored[OBJECTS] as string).split(',').filter((x) => x !== ''));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(stored)) {
      if (k === 'kind' || k === LIST || k === OBJECTS) continue;
      if (objects.has(k)) {
        const parsed: unknown = JSON.parse(String(v));
        if (!Array.isArray(parsed) || !parsed.every(flatObject))
          throw new Error('Stored result is malformed');
        out[k] = parsed;
      } else out[k] = lists.has(k) ? (v === '' ? [] : String(v).split(',')) : v;
    }
    return out;
  },
};

/** Operations replayed through `flatCodec`; each later S task appends its commands here. */
export const EXTENDED_SCHEDULING_OPERATIONS: readonly string[] = [
  'scheduling.visitContext.pinMedicalHistory',
  'scheduling.visitContext.assignForm',
  'scheduling.visitContext.unassignForm',
  'scheduling.visitContext.linkLabCase',
  'scheduling.visitContext.relinkLabCase',
  'scheduling.series.create',
  'scheduling.series.extend',
  'scheduling.series.end',
];

export const EXTENDED_SCHEDULING_CODECS: Readonly<Record<string, ReplayCodec<unknown>>> = Object.fromEntries(
  EXTENDED_SCHEDULING_OPERATIONS.map((op) => [op, flatCodec as ReplayCodec<unknown>]),
);
