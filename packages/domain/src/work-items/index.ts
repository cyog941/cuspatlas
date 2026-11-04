import type { WorkCoverage, WorkItem, WorkItemListData } from '@cuspatlas/contracts';

/**
 * Minimal exception-first work-item model (docs/PRACTICE-TIME-AND-AUTOMATION.md, "Exception-first
 * operation"). Proposed shared contract, owned by workstream S until a shared module adopts it: every
 * open item states why it exists (reason code and a safe server-authored explanation), its evidence
 * references, the queue that owns it, its due time, a suggested next action and who owes that action,
 * and the dependencies blocking automation. Work items are projections computed from stored facts;
 * they are not a second state machine.
 */
export type { WorkCoverage, WorkItem, WorkItemListData };

export const AVAILABLE: WorkCoverage = { status: 'available' };

/** An unavailable list names its owner and reason; it is never presented as an empty one. */
export const unavailable = (reason: string, owner: string): WorkCoverage => ({
  status: 'unavailable',
  reason,
  owner,
});

/** Fills the defaults every S work item shares (practice-owned, routine, no named principal). */
export function workItem(
  item: Omit<WorkItem, 'owner' | 'nextActionOwedBy' | 'priority' | 'priorityRationale'> &
    Partial<Pick<WorkItem, 'owner' | 'nextActionOwedBy' | 'priority' | 'priorityRationale'>>,
): WorkItem {
  return {
    owner: { queue: 'front_desk', principalRef: null },
    nextActionOwedBy: 'practice',
    priority: 'routine',
    priorityRationale: 'default_routine',
    ...item,
  };
}

/** Orders items by due time (unknown last), then reference, and bounds the page to 100. */
export function workList(asOf: Date, coverage: WorkCoverage, items: readonly WorkItem[]): WorkItemListData {
  const sorted = [...items].sort(
    (a, b) =>
      (a.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.dueAt)) -
        (b.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.dueAt)) ||
      a.workItemRef.localeCompare(b.workItemRef),
  );
  return { asOf: asOf.toISOString(), coverage, count: sorted.length, items: sorted.slice(0, 100) };
}
