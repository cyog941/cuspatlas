import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A20 / OR-01: the location restriction a list read was actually authorized under. The REST and MCP
 * transports run each list operation inside `runInListScope`; `authorize` records the live
 * membership restriction of every successful decision made during that call, so the envelope's
 * `scope` states what policy applied rather than what the client asked for. The most restrictive
 * decision wins (a restricted decision is never widened by a later unrestricted one).
 */
export interface ListScopeRecord {
  decided: boolean;
  locationRefs: readonly string[] | null;
}

const store = new AsyncLocalStorage<ListScopeRecord>();

export function newListScope(): ListScopeRecord {
  return { decided: false, locationRefs: null };
}

/** Runs one list call; `authorize` records into `scope` (the caller keeps the reference). */
export function runInListScope<T>(scope: ListScopeRecord, run: () => T): T {
  return store.run(scope, run);
}

export function recordListScope(locationRefs: readonly string[] | null): void {
  const s = store.getStore();
  if (!s) return;
  if (!s.decided || s.locationRefs === null) s.locationRefs = locationRefs;
  else if (locationRefs !== null) s.locationRefs = s.locationRefs.filter((l) => locationRefs.includes(l));
  s.decided = true;
}
