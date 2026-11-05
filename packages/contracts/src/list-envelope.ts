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
  /** Normalized filters, including defaults the server applied. */
  readonly appliedFilters: Readonly<Record<string, string | number | boolean | null>>;
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
