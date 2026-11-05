/**
 * OR-01 shared list envelope (docs/superpowers/specs/2026-11-04-operational-read-models.md). Every list
 * or worklist response carries it. Introduced by E10 because it was the first consumer; the A20 task
 * adopts this definition as the shared contract (and adds the catalog-wide conformance test), so A20
 * should move it into the shared schema rather than redefine it.
 *
 * It carries no colour, layout or component semantics. `count` is `{ exact }` for a fully counted
 * result and `{ atLeast }` when counting stopped early; an empty result states `{ exact: 0 }`.
 */
export type ListScope =
  | { readonly kind: 'tenant_wide' }
  | { readonly kind: 'assigned_locations'; readonly locationRefs: readonly string[] }
  | { readonly kind: 'location_set'; readonly locationRefs: readonly string[] };

export interface ListOrdering {
  readonly key: string;
  readonly direction: 'asc' | 'desc';
  /** The documented tie-break key that makes the order total and stable. */
  readonly tieBreak: string;
}

export type ListCount = { readonly exact: number } | { readonly atLeast: number };

export interface ListEnvelope {
  /** Server instant the list was read. */
  readonly asOf: string;
  /** Normalized filters, including defaults the server applied (scalars or lists of them). */
  readonly appliedFilters: Readonly<Record<string, unknown>>;
  readonly scope: ListScope;
  readonly limit: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly ordering: ListOrdering;
  readonly count: ListCount;
}

export function listEnvelope(e: {
  asOf: Date;
  appliedFilters: ListEnvelope['appliedFilters'];
  locationRefs: readonly string[] | null;
  limit: number;
  nextCursor: string | null;
  ordering: ListOrdering;
  total: number;
}): ListEnvelope {
  return {
    asOf: e.asOf.toISOString(),
    appliedFilters: e.appliedFilters,
    scope:
      e.locationRefs === null
        ? { kind: 'tenant_wide' }
        : { kind: 'assigned_locations', locationRefs: [...e.locationRefs] },
    limit: e.limit,
    truncated: e.nextCursor !== null,
    nextCursor: e.nextCursor,
    ordering: e.ordering,
    count: { exact: e.total },
  };
}

/**
 * The single JSON Schema for the OR-01 envelope. Each contract schema file that returns a list
 * carries these four `$defs` verbatim (a schema file is self-contained, so the definitions are
 * copied, not referenced across files); `tests/integration/list-envelope-conformance.test.ts`
 * fails when any copy differs from this one.
 */
export const LIST_ENVELOPE_SCHEMA_DEFS = {
  ListScope: {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    description:
      "OR-01 scope: tenant-wide, the caller's assigned locations, or an explicit location set (locationRefs present for the last two).",
    properties: {
      kind: { enum: ['tenant_wide', 'assigned_locations', 'location_set'] },
      locationRefs: {
        type: 'array',
        maxItems: 200,
        items: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' },
      },
    },
  },
  ListOrdering: {
    type: 'object',
    additionalProperties: false,
    required: ['key', 'direction', 'tieBreak'],
    properties: {
      key: { type: 'string', pattern: '^[A-Za-z.]{1,64}$' },
      direction: { enum: ['asc', 'desc'] },
      tieBreak: { type: 'string', pattern: '^[A-Za-z.]{1,64}$' },
    },
  },
  ListCount: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['exact'],
        properties: { exact: { type: 'integer', minimum: 0 } },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['atLeast'],
        properties: { atLeast: { type: 'integer', minimum: 0 } },
      },
    ],
  },
  ListEnvelope: {
    type: 'object',
    additionalProperties: false,
    description: 'OR-01 list envelope, shared by every list and worklist response.',
    required: ['asOf', 'appliedFilters', 'scope', 'limit', 'truncated', 'nextCursor', 'ordering', 'count'],
    properties: {
      asOf: { type: 'string', format: 'date-time', description: 'Server instant the list was read.' },
      appliedFilters: {
        type: 'object',
        description: 'Normalized filters, including the defaults the server applied.',
      },
      scope: { $ref: '#/$defs/ListScope' },
      limit: { type: 'integer', minimum: 1 },
      truncated: { type: 'boolean' },
      nextCursor: { type: ['string', 'null'] },
      ordering: { $ref: '#/$defs/ListOrdering' },
      count: { $ref: '#/$defs/ListCount' },
    },
  },
} as const;
