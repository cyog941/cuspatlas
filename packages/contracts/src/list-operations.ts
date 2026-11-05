import { type ListEnvelope, type ListOrdering, listEnvelope } from './list-envelope';

/**
 * A20 / OR-01 registry of every catalog list operation. `tests/integration/list-catalog-conformance.test.ts`
 * classifies the catalog's lists (rule recorded in docs/execution/api-progress.md "A20/B11") and fails
 * when one is missing here or its success schema lacks the canonical envelope.
 *
 * The REST and MCP transports attach the envelope from this one table (`attachListEnvelope`), so both
 * surfaces answer the same envelope. Each entry states what the domain read does; it never changes it:
 * - `ordering` is the domain read's ORDER BY (key, direction, total tie-break).
 * - `limit` is `{ default, max }` when the read is capped, or `'parent'` for a collection bounded by its
 *   parent resource (one patient, encounter or plan version) that the server never truncates; the
 *   envelope then reports `limit` as the returned row count (at least 1).
 * - `cursor` is true when the read pages with `nextCursor` (fetching one row past the limit), so a full
 *   page without a cursor is complete. A capped read without a cursor reports `truncated` and
 *   `count.atLeast` when it returned a full page, because it cannot know whether more rows exist.
 * - `scope: 'location'` means the read filters rows by the caller's membership location restriction
 *   (reported from the live authorization decision) or by an explicit `locationRef` filter;
 *   `'tenant'` means the rows are not location-filtered (tenant-wide or bounded by a parent resource).
 * - `total` names a field of the response that already holds the exact match count; `lowerBound` names one
 *   that counts matches before the page cut but is itself capped by the read (work-item lists), so it only
 *   raises `count.atLeast` when the page is truncated.
 * - `placement: 'existing'` marks a response whose domain read already builds the OR-01 envelope.
 *   The A2 agent/AI and A14/A15 automation reads build it at the root beside `items`; both transports
 *   answer it in the shared response envelope instead (`toDataEnvelope`: rows under `data`, `envelope`).
 */
export interface ListOperationSpec {
  readonly rows: string;
  readonly ordering: ListOrdering;
  readonly limit: { readonly default: number; readonly max: number } | 'parent';
  readonly cursor: boolean;
  readonly scope: 'location' | 'tenant';
  readonly total?: string;
  /** A field holding a count of matches that may itself be capped (a lower bound, never reported as exact). */
  readonly lowerBound?: string;
  readonly placement?: 'envelope' | 'existing';
  /** Identifying filters (names, dates of birth, phone numbers) reported only as `provided`, never echoed. */
  readonly sensitiveFilters?: readonly string[];
}

export const LIST_OPERATIONS: Readonly<Record<string, ListOperationSpec>> = {
  // A2 (A8-A12) lists: offset-cursor pages over tenant-wide rows (no location filter). The agent service
  // builds the OR-01 envelope; REST and MCP answer `{ data, envelope }` (`toDataEnvelope`).
  'actions.proposals.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'proposalRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  'agents.audit.list': {
    rows: 'data',
    ordering: { key: 'occurredAt', direction: 'asc', tieBreak: 'eventRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  'agents.sponsors.offers.list': {
    rows: 'data',
    ordering: { key: 'offeredAt', direction: 'asc', tieBreak: 'offerRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  'agents.memory.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'memoryRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  'agents.sessions.list': {
    rows: 'data',
    ordering: { key: 'startedAt', direction: 'asc', tieBreak: 'sessionRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  'agents.taskPolicies.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'policyRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  'agents.tasks.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'taskRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  'agents.tasks.runs.list': {
    rows: 'data',
    ordering: { key: 'startedAt', direction: 'asc', tieBreak: 'runRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  'agents.consents.list': {
    rows: 'data',
    ordering: { key: 'grantedAt', direction: 'desc', tieBreak: 'consentRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  'agents.principals.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'agentRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  'ai.drafts.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'draftRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  'ai.evaluations.list': {
    rows: 'data',
    ordering: { key: 'ranAt', direction: 'desc', tieBreak: 'runRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  // The fixed use-case registry, returned whole (never truncated); `useCase` is unique.
  'ai.useCases.list': {
    rows: 'data',
    ordering: { key: 'useCase', direction: 'asc', tieBreak: 'useCase' },
    limit: { default: 25, max: 100 },
    cursor: false,
    scope: 'tenant',
    placement: 'existing',
  },
  'billing.ledger.list': {
    rows: 'data',
    ordering: { key: 'postedAt', direction: 'asc', tieBreak: 'entryRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
  },
  'billing.plans.worklist': {
    rows: 'data',
    ordering: { key: 'dueAt', direction: 'asc', tieBreak: 'planRef' },
    limit: { default: 50, max: 100 },
    cursor: false,
    scope: 'tenant',
    total: 'totalCount',
  },
  'billing.worklist.list': {
    rows: 'data',
    ordering: { key: 'dueAt', direction: 'asc', tieBreak: 'subjectRef' },
    limit: { default: 50, max: 100 },
    cursor: false,
    scope: 'tenant',
    total: 'totalCount',
  },
  'clinical.consents.list': {
    rows: 'data',
    ordering: { key: 'effectiveAt', direction: 'asc', tieBreak: 'consentRef' },
    limit: { default: 500, max: 500 },
    cursor: false,
    scope: 'tenant',
  },
  'clinical.encounters.list': {
    rows: 'data',
    ordering: { key: 'encounterRef', direction: 'asc', tieBreak: 'encounterRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'location',
  },
  'clinical.estimates.list': {
    rows: 'data',
    ordering: { key: 'number', direction: 'asc', tieBreak: 'estimateRef' },
    limit: 'parent',
    cursor: false,
    scope: 'tenant',
  },
  'clinical.imageLinks.list': {
    rows: 'data.links',
    ordering: { key: 'linkedAt', direction: 'asc', tieBreak: 'imageLinkRef' },
    limit: { default: 500, max: 500 },
    cursor: false,
    scope: 'location',
  },
  'clinical.labCases.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'labCaseRef' },
    limit: { default: 200, max: 200 },
    cursor: false,
    scope: 'tenant',
  },
  'clinical.labCases.worklist': {
    rows: 'data.items',
    ordering: { key: 'dueAt', direction: 'asc', tieBreak: 'workItemRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'tenant',
    lowerBound: 'data.count',
  },
  'clinical.notes.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'noteRef' },
    limit: { default: 50, max: 50 },
    cursor: false,
    scope: 'location',
  },
  'clinical.perio.listExams': {
    rows: 'data',
    ordering: { key: 'recordedAt', direction: 'asc', tieBreak: 'perioExamRef' },
    limit: 'parent',
    cursor: false,
    scope: 'tenant',
  },
  'clinical.procedures.list': {
    rows: 'data.procedures',
    ordering: { key: 'recordedAt', direction: 'asc', tieBreak: 'procedureRef' },
    limit: { default: 500, max: 500 },
    cursor: false,
    scope: 'location',
  },
  'clinical.referrals.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'referralRef' },
    limit: { default: 200, max: 200 },
    cursor: false,
    scope: 'tenant',
  },
  'clinical.referrals.worklist': {
    rows: 'data.items',
    ordering: { key: 'dueAt', direction: 'asc', tieBreak: 'workItemRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'tenant',
    lowerBound: 'data.count',
  },
  'clinical.treatmentPlans.alternatives': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'planRef' },
    limit: 'parent',
    cursor: false,
    scope: 'tenant',
  },
  'clinical.treatmentPlans.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'planRef' },
    limit: 'parent',
    cursor: false,
    scope: 'tenant',
  },
  'communications.channelPolicies.list': {
    rows: 'data',
    ordering: { key: 'purpose', direction: 'asc', tieBreak: 'policyRef' },
    limit: 'parent',
    cursor: false,
    scope: 'tenant',
  },
  'communications.consents.list': {
    rows: 'data.records',
    ordering: { key: 'seq', direction: 'asc', tieBreak: 'consentRef' },
    limit: { default: 200, max: 200 },
    cursor: false,
    scope: 'tenant',
  },
  'communications.deliveries.worklist': {
    rows: 'data.items',
    ordering: { key: 'dueAt', direction: 'asc', tieBreak: 'workItemRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'location',
    lowerBound: 'data.count',
  },
  'communications.recall.enrollments': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'enrollmentRef' },
    limit: { default: 500, max: 500 },
    cursor: false,
    scope: 'location',
  },
  'imaging.annotations.list': {
    rows: 'data.annotations',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'annotationRef.version' },
    limit: { default: 500, max: 500 },
    cursor: false,
    scope: 'tenant',
  },
  'imaging.bridge.worklist': {
    rows: 'data.items',
    ordering: { key: 'group', direction: 'asc', tieBreak: 'itemRef' },
    limit: { default: 300, max: 300 },
    cursor: false,
    scope: 'tenant',
    lowerBound: 'data.count',
  },
  'imaging.devices.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'deviceRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'tenant',
  },
  'imaging.legalHolds.list': {
    rows: 'data',
    ordering: { key: 'placedAt', direction: 'desc', tieBreak: 'holdRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'tenant',
  },
  'imaging.objects.list': {
    rows: 'data',
    ordering: { key: 'receivedAt', direction: 'desc', tieBreak: 'objectRef' },
    limit: { default: 25, max: 100 },
    cursor: false,
    scope: 'tenant',
  },
  'imaging.retention.policies': {
    rows: 'data',
    ordering: { key: 'recordClass', direction: 'asc', tieBreak: 'version' },
    limit: 'parent',
    cursor: false,
    scope: 'tenant',
  },
  'intake.forms.list': {
    rows: 'data',
    ordering: { key: 'formRef', direction: 'asc', tieBreak: 'formVersion' },
    limit: { default: 200, max: 200 },
    cursor: false,
    scope: 'tenant',
  },
  'intake.reviews.worklist': {
    rows: 'data.items',
    ordering: { key: 'dueAt', direction: 'asc', tieBreak: 'workItemRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'tenant',
    lowerBound: 'data.count',
  },
  'intake.submissions.list': {
    rows: 'data',
    ordering: { key: 'submittedAt', direction: 'asc', tieBreak: 'submissionRef' },
    limit: { default: 200, max: 200 },
    cursor: false,
    scope: 'tenant',
  },
  'messaging.threads.list': {
    rows: 'data.items',
    ordering: { key: 'lastMessageAt', direction: 'desc', tieBreak: 'threadRef' },
    limit: { default: 50, max: 100 },
    cursor: true,
    scope: 'location',
    placement: 'existing',
  },
  'messaging.threads.worklist': {
    rows: 'data.items',
    ordering: { key: 'dueAt', direction: 'asc', tieBreak: 'workItemRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'location',
    lowerBound: 'data.count',
  },
  'migration.archive.references': {
    rows: 'data',
    ordering: { key: 'archiveVersion', direction: 'asc', tieBreak: 'entryRef' },
    limit: { default: 10000, max: 10000 },
    cursor: false,
    scope: 'tenant',
  },
  'migration.openingItems.list': {
    rows: 'data.items',
    ordering: { key: 'sourceRef', direction: 'asc', tieBreak: 'openingItemRef' },
    limit: 'parent',
    cursor: false,
    scope: 'tenant',
  },
  'migration.provenance.read': {
    rows: 'data',
    ordering: { key: 'appliedAt', direction: 'asc', tieBreak: 'provenanceRef' },
    limit: { default: 500, max: 500 },
    cursor: false,
    scope: 'tenant',
  },
  'migration.reviewItems.list': {
    rows: 'data',
    ordering: { key: 'category', direction: 'asc', tieBreak: 'subjectKey' },
    limit: { default: 1000, max: 1000 },
    cursor: false,
    scope: 'tenant',
  },
  // Closeout A6: the tenant reviewer list (live and ended); Closeout C: signed keyset cursor pages.
  'migration.reviewers.list': {
    rows: 'data',
    ordering: { key: 'assignedAt', direction: 'asc', tieBreak: 'assignmentRef' },
    limit: { default: 500, max: 500 },
    cursor: true,
    scope: 'tenant',
  },
  'operations.alerts.list': {
    rows: 'data.items',
    // Fixed obligation evaluation order (operator, escalation, verification, SLA); one item per unmet obligation.
    ordering: { key: 'obligationOrder', direction: 'asc', tieBreak: 'workItemRef' },
    limit: 'parent',
    cursor: false,
    scope: 'tenant',
    total: 'data.count',
  },
  // Closeout A2 downtime log: tenant-wide reads; Closeout C: signed keyset cursor pages of up to 500 rows.
  'operations.downtime.entries.list': {
    rows: 'data',
    ordering: { key: 'capturedAt', direction: 'asc', tieBreak: 'entryRef' },
    limit: { default: 500, max: 500 },
    cursor: true,
    scope: 'tenant',
  },
  'operations.downtime.windows.list': {
    rows: 'data',
    ordering: { key: 'startedAt', direction: 'desc', tieBreak: 'windowRef' },
    limit: { default: 500, max: 500 },
    cursor: true,
    scope: 'tenant',
  },
  'patients.duplicates.find': {
    rows: 'data',
    ordering: { key: 'score', direction: 'desc', tieBreak: 'candidateRef' },
    limit: { default: 20, max: 20 },
    cursor: false,
    scope: 'tenant',
  },
  'patients.merges.list': {
    rows: 'data',
    ordering: { key: 'mergedAt', direction: 'asc', tieBreak: 'mergeRef' },
    limit: { default: 50, max: 50 },
    cursor: false,
    scope: 'tenant',
  },
  'patients.relationships.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'relationshipRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'tenant',
  },
  'patients.search': {
    rows: 'data',
    ordering: { key: 'patientRef', direction: 'asc', tieBreak: 'patientRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    sensitiveFilters: ['name', 'birthDate', 'phone'],
  },
  'portal.grants.list': {
    rows: 'data.grants',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'grantRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'tenant',
  },
  'rcm.claims.worklist': {
    rows: 'data.data',
    ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'claimRef' },
    limit: { default: 200, max: 200 },
    cursor: false,
    scope: 'tenant',
  },
  // B11 / OR-07: OR-D3 work priority (deadline proximity, exception severity, age), tie-break claimRef.
  'rcm.claims.queues': {
    rows: 'data.items',
    ordering: { key: 'workPriority', direction: 'asc', tieBreak: 'claimRef' },
    limit: { default: 50, max: 100 },
    cursor: false,
    scope: 'tenant',
    total: 'data.queueCount',
  },
  'scheduling.attendance.list': {
    rows: 'data',
    ordering: { key: 'sequence', direction: 'asc', tieBreak: 'attendanceRef' },
    limit: 'parent',
    cursor: false,
    scope: 'location',
  },
  'scheduling.availability.search': {
    rows: 'data.windows',
    ordering: { key: 'startsAt', direction: 'asc', tieBreak: 'resourceRefs' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'location',
    placement: 'existing',
  },
  'scheduling.followUp.worklist': {
    rows: 'data.items',
    ordering: { key: 'dueAt', direction: 'asc', tieBreak: 'workItemRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'location',
    lowerBound: 'data.count',
  },
  'scheduling.locations.list': {
    rows: 'data',
    ordering: { key: 'locationRef', direction: 'asc', tieBreak: 'locationRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'location',
  },
  'scheduling.notifications.worklist': {
    rows: 'data.items',
    ordering: { key: 'dueAt', direction: 'asc', tieBreak: 'workItemRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'location',
    lowerBound: 'data.count',
  },
  'scheduling.presence.list': {
    rows: 'data.items',
    ordering: { key: 'setAt', direction: 'asc', tieBreak: 'principalRef' },
    limit: { default: 200, max: 200 },
    cursor: false,
    scope: 'location',
    placement: 'existing',
  },
  'scheduling.recall.policies': {
    rows: 'data',
    ordering: { key: 'category', direction: 'asc', tieBreak: 'version' },
    limit: { default: 200, max: 200 },
    cursor: false,
    scope: 'tenant',
  },
  'scheduling.recovery.list': {
    rows: 'data.items',
    ordering: { key: 'dueAt', direction: 'asc', tieBreak: 'workItemRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'location',
    lowerBound: 'data.count',
  },
  'scheduling.requests.list': {
    rows: 'data',
    ordering: { key: 'requestRef', direction: 'asc', tieBreak: 'requestRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'location',
  },
  'scheduling.resources.list': {
    rows: 'data',
    ordering: { key: 'resourceRef', direction: 'asc', tieBreak: 'resourceRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'location',
  },
  'scheduling.staging.list': {
    rows: 'data.items',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'entryRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'location',
    placement: 'existing',
  },
  'scheduling.standingPolicies.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'policyRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'tenant',
  },
  'scheduling.visitContext.items': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'itemRef' },
    limit: { default: 200, max: 200 },
    cursor: false,
    scope: 'location',
  },
  'scheduling.waitlist.list': {
    rows: 'data',
    ordering: { key: 'priority', direction: 'asc', tieBreak: 'entryRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'location',
  },
  'scheduling.worklist.daily': {
    rows: 'data.appointments',
    ordering: { key: 'startsAt', direction: 'asc', tieBreak: 'appointmentRef' },
    limit: { default: 200, max: 200 },
    cursor: false,
    scope: 'location',
  },
  'syntheticTasks.list': {
    rows: 'data',
    ordering: { key: 'taskRef', direction: 'asc', tieBreak: 'taskRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'location',
  },
  'telephony.calls.list': {
    rows: 'data',
    ordering: { key: 'occurredAt', direction: 'desc', tieBreak: 'callRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'tenant',
  },
  // The whole registry (bounded by the contracts, never truncated).
  // A17: audit search (bounded, newest first, no cursor; envelope built by the domain read).
  'admin.audit.search': {
    rows: 'data',
    ordering: { key: 'occurredAt', direction: 'desc', tieBreak: 'eventRef' },
    limit: { default: 100, max: 200 },
    cursor: false,
    scope: 'tenant',
    placement: 'existing',
  },
  // A16: the measure catalog (registry order; envelope built by the domain read).
  'analytics.measures.list': {
    rows: 'data',
    ordering: { key: 'registry', direction: 'asc', tieBreak: 'measureKey' },
    limit: 'parent',
    cursor: false,
    scope: 'tenant',
    placement: 'existing',
  },
  // A22 (OR-12): the caller's own preferences (envelope built by the domain read).
  'preferences.savedViews.list': {
    rows: 'data',
    ordering: { key: 'name', direction: 'asc', tieBreak: 'viewRef' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'tenant',
    placement: 'existing',
  },
  'preferences.favourites.list': {
    rows: 'data',
    ordering: { key: 'operation', direction: 'asc', tieBreak: 'operation' },
    limit: { default: 100, max: 100 },
    cursor: false,
    scope: 'tenant',
    placement: 'existing',
  },
  'preferences.recentPatients.list': {
    rows: 'data',
    ordering: { key: 'openedAt', direction: 'desc', tieBreak: 'patientRef' },
    limit: { default: 50, max: 50 },
    cursor: false,
    scope: 'tenant',
    placement: 'existing',
  },
  'vocabularies.list': {
    rows: 'data',
    ordering: { key: 'name', direction: 'asc', tieBreak: 'name' },
    limit: 'parent',
    cursor: false,
    scope: 'tenant',
  },
  // Workstream A batch 4 (A15): export requests, tenant-wide, newest first.
  'exports.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'exportRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  // Workstream A batch 4 (A14): tenant-wide reads (location-restricted members are refused).
  'webhooks.deliveries.failures.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'deliveryRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  'webhooks.deliveries.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'deliveryRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
  // The closed event catalog, returned whole (never truncated); `eventType` is unique.
  'webhooks.eventTypes.list': {
    rows: 'data',
    ordering: { key: 'eventType', direction: 'asc', tieBreak: 'eventType' },
    limit: { default: 25, max: 100 },
    cursor: false,
    scope: 'tenant',
    placement: 'existing',
  },
  'webhooks.subscriptions.list': {
    rows: 'data',
    ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'subscriptionRef' },
    limit: { default: 25, max: 100 },
    cursor: true,
    scope: 'tenant',
    placement: 'existing',
  },
};

/** Transport-only arguments that are not filters. */
const NOT_FILTERS = new Set(['cursor', 'idempotencyKey']);

function at(body: unknown, path: string): unknown {
  let node = body;
  for (const k of path.split('.'))
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[k] : undefined;
  return node;
}

/**
 * Adds the OR-01 envelope to a list response (top-level `envelope`, keeping every existing field).
 * `filters` is the validated request (path parameters plus query or tool arguments); `locationRefs`
 * is the restriction the authorization decision applied (null = unrestricted).
 */
export function attachListEnvelope(
  spec: ListOperationSpec,
  body: unknown,
  ctx: { asOf: Date; filters: Readonly<Record<string, unknown>>; locationRefs: readonly string[] | null },
): unknown {
  if (spec.placement === 'existing' || !body || typeof body !== 'object') return body;
  const rows = at(body, spec.rows);
  if (!Array.isArray(rows)) return body;
  const requested = Number(ctx.filters.limit);
  const limit =
    spec.limit === 'parent'
      ? Math.max(rows.length, 1)
      : Math.min(
          Math.max(Number.isInteger(requested) && requested > 0 ? requested : spec.limit.default, 1),
          spec.limit.max,
        );
  const cursor = at(body, 'nextCursor') ?? at(body, 'data.nextCursor') ?? null;
  const nextCursor = typeof cursor === 'string' ? cursor : null;
  const flagged = at(body, 'truncated') === true || at(body, 'data.truncated') === true;
  const total = spec.total === undefined ? undefined : at(body, spec.total);
  const bound = spec.lowerBound === undefined ? undefined : at(body, spec.lowerBound);
  const atLeast = Math.max(rows.length, typeof bound === 'number' ? bound : 0);
  const fullPage = spec.limit !== 'parent' && !spec.cursor && (rows.length >= limit || atLeast > rows.length);
  const truncated = nextCursor !== null || flagged || fullPage;
  const appliedFilters: Record<string, unknown> = {};
  const merged: Record<string, unknown> = { ...ctx.filters, ...(spec.limit === 'parent' ? {} : { limit }) };
  for (const k of Object.keys(merged).sort())
    if (!NOT_FILTERS.has(k) && merged[k] !== undefined)
      appliedFilters[k] = spec.sensitiveFilters?.includes(k) ? 'provided' : merged[k];
  const explicit =
    typeof ctx.filters.locationRef === 'string'
      ? [ctx.filters.locationRef]
      : Array.isArray(ctx.filters.locationRefs)
        ? (ctx.filters.locationRefs as string[])
        : null;
  const envelope: ListEnvelope = {
    ...listEnvelope({
      asOf: ctx.asOf,
      appliedFilters,
      locationRefs: spec.scope === 'location' ? ctx.locationRefs : null,
      limit,
      nextCursor,
      ordering: spec.ordering,
      total: rows.length,
    }),
    ...(spec.scope === 'location' && explicit !== null
      ? { scope: { kind: 'location_set' as const, locationRefs: explicit } }
      : {}),
    truncated,
    count: typeof total === 'number' ? { exact: total } : truncated ? { atLeast } : { exact: rows.length },
  };
  return { ...(body as Record<string, unknown>), envelope };
}

const ENVELOPE_KEYS = [
  'asOf',
  'appliedFilters',
  'scope',
  'limit',
  'truncated',
  'nextCursor',
  'ordering',
  'count',
];

/**
 * Closeout D: the A2 agent/AI reads and the A14/A15 automation reads build the OR-01 envelope at the
 * root beside `items`. Their REST and MCP answers use the shared response envelope instead: the rows
 * under `data`, the envelope under `envelope`, and every other field (`phiPolicy`, `catalogVersion`)
 * kept at the root. A body without root `items` is returned unchanged.
 */
export function toDataEnvelope(body: unknown): unknown {
  if (!body || typeof body !== 'object' || !Array.isArray((body as Record<string, unknown>).items))
    return body;
  const { items, ...rest } = body as Record<string, unknown>;
  const envelope: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) (ENVELOPE_KEYS.includes(k) ? envelope : extra)[k] = v;
  return { data: items, envelope, ...extra };
}
