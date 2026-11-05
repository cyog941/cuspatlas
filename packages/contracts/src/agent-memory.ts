import { CATALOG_INDEX } from './agents';
import { VOCABULARIES } from './vocabularies';

/**
 * Closeout D5 and the Closeout D review fixes (synthetic engineering implementation,
 * recommended-pending-approval): the positive allowlist for agent memory keys and non-phi values.
 *
 * What it guarantees: a non-phi note's key and value come only from registered, closed sets or from
 * bounded machine grammars (a UUID reference, a bounded counter, a flag, an ISO duration, a UTC instant
 * not earlier than the tenant's creation). A name-shaped word, a phrase or other free text cannot be
 * written as a non-phi key or value, in the domain or in the database.
 *
 * What it does not guarantee: a short counter (at most 4 digits) can still coincide with a short
 * identifier, a UUID reference or an instant can still carry bits chosen by a writer who deliberately
 * encodes data, and an instant after the tenant's creation can still be a newborn's birth date. The PHI
 * heuristic (names, birth-date match keys, patient refs) is an extra refusal layer over keys and values,
 * not a proof. Free text is accepted only classified phi under the tenant's explicit PHI policy.
 *
 * The registry rows (`memoryRegistryRows`) are seeded into `cuspatlas.agent_memory_registry` by the
 * migrator after every migration run, so the database checks the same sets independently.
 */

/** Registered key namespaces: a key is `<prefix>.<suffix>`. */
export const MEMORY_KEY_PREFIXES = ['pref', 'task', 'cursor', 'op', 'state'] as const;

/** The code grammar (lower-case dotted identifier); a registered code must also match it. */
export const MEMORY_CODE_GRAMMAR = /^[a-z][a-z0-9]*([._:-][a-z0-9]+){0,7}$/;

/** Memory-specific codes besides the state vocabularies (closed set; no personal names). */
export const MEMORY_DECLARED_CODES = [
  'morning',
  'afternoon',
  'evening',
  'weekday',
  'weekend',
  'ascending',
  'descending',
  'enabled',
  'disabled',
  'low',
  'normal',
  'high',
  'urgent',
  'daily',
  'weekly',
  'monthly',
  'done',
  'skipped',
  'blocked',
  'recall',
  'reminder',
  'followup',
  'batch',
  'window',
  'summary',
] as const;

/** Every registered memory code: the state vocabulary codes that match the grammar, plus the declared set. */
export const MEMORY_CODES: ReadonlySet<string> = new Set(
  [
    ...[...VOCABULARIES.values()].flatMap((v) => v.entries.map((e) => e.code)),
    ...MEMORY_DECLARED_CODES,
  ].filter((c) => c.length <= 64 && MEMORY_CODE_GRAMMAR.test(c)),
);

/** Every registered memory operation: the catalog operation ids. */
export const MEMORY_OPERATIONS: ReadonlySet<string> = new Set(CATALOG_INDEX.keys());

/** A counter is an integer in this range (at most 4 digits). */
export const MEMORY_COUNTER_MIN = -9999;
export const MEMORY_COUNTER_MAX = 9999;

const REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/;

/**
 * The structured non-phi value kinds and their grammars. A Map (never a plain object), so an inherited
 * name such as `constructor` or `__proto__` is never a kind. The instant floor (the tenant's creation)
 * needs the tenant, so it is checked by the caller (`memoryInstantFloorOk`) and by the database.
 */
const STRUCTURED_KINDS: ReadonlyMap<string, (v: string) => boolean> = new Map<string, (v: string) => boolean>(
  [
    ['code', (v) => MEMORY_CODES.has(v)],
    ['counter', (v) => /^-?[0-9]{1,4}$/.test(v)],
    ['flag', (v) => v === 'true' || v === 'false'],
    ['instant', (v) => INSTANT.test(v) && !Number.isNaN(Date.parse(v))],
    [
      'duration',
      (v) =>
        /^P([0-9]{1,4}D)?(T([0-9]{1,4}H)?([0-9]{1,4}M)?([0-9]{1,4}S)?)?$/.test(v) &&
        !/^PT?$/.test(v) &&
        !v.endsWith('T'),
    ],
    ['operation', (v) => MEMORY_OPERATIONS.has(v)],
    ['reference', (v) => REFERENCE.test(v)],
  ],
);

export const MEMORY_STRUCTURED_KINDS: readonly string[] = [...STRUCTURED_KINDS.keys()];

/** True when `kind` is a registered structured kind and `value` matches its grammar. */
export function memoryValueMatches(kind: unknown, value: unknown): boolean {
  if (typeof kind !== 'string' || typeof value !== 'string') return false;
  const grammar = STRUCTURED_KINDS.get(kind);
  return grammar?.(value) === true;
}

/** An instant is not earlier than the tenant's creation (a birth date before it cannot be stored). */
export function memoryInstantFloorOk(value: string, tenantCreatedAt: Date): boolean {
  const t = Date.parse(value);
  return !Number.isNaN(t) && t >= tenantCreatedAt.getTime();
}

export interface MemoryKeyParts {
  readonly prefix: string;
  readonly suffix: string;
  /** The value kind the suffix is classified as (screened with the same rules as a value of it). */
  readonly suffixKind: 'code' | 'operation' | 'reference';
}

/** Parses a namespaced key; null unless the prefix is registered and the suffix is a registered value. */
export function parseMemoryKey(key: unknown): MemoryKeyParts | null {
  if (typeof key !== 'string' || key.length > 64) return null;
  const dot = key.indexOf('.');
  if (dot < 1) return null;
  const prefix = key.slice(0, dot);
  const suffix = key.slice(dot + 1);
  if (!(MEMORY_KEY_PREFIXES as readonly string[]).includes(prefix)) return null;
  if (REFERENCE.test(suffix)) return { prefix, suffix, suffixKind: 'reference' };
  if (MEMORY_CODES.has(suffix)) return { prefix, suffix, suffixKind: 'code' };
  if (MEMORY_OPERATIONS.has(suffix)) return { prefix, suffix, suffixKind: 'operation' };
  return null;
}

/** The rows the migrator seeds into cuspatlas.agent_memory_registry (kind, value), sorted. */
export function memoryRegistryRows(): { kind: 'key_prefix' | 'code' | 'operation'; value: string }[] {
  return [
    ...MEMORY_KEY_PREFIXES.map((value) => ({ kind: 'key_prefix' as const, value })),
    ...[...MEMORY_CODES].map((value) => ({ kind: 'code' as const, value })),
    ...[...MEMORY_OPERATIONS].map((value) => ({ kind: 'operation' as const, value })),
  ].sort((a, b) => (a.kind === b.kind ? (a.value < b.value ? -1 : 1) : a.kind < b.kind ? -1 : 1));
}
