import type { ActorContext, CommandEnvelope } from '@cuspatlas/contracts';
import type { ActionName, AppointmentService } from '@cuspatlas/domain';
import type { RouteContract } from './manifest';

/**
 * One table for the S12-S16 operations: the REST route contract, the MCP tool name and the call into
 * the shared domain service. REST registration (scheduling-ops-routes.ts), the MCP tool list
 * (apps/mcp/src/tools/scheduling-ops.ts), the drift checks and the S17 parity matrix are all derived
 * from it, so an operation cannot exist on one surface only.
 */
export interface OpInput {
  /** Path parameters by name (never a tenant). */
  readonly params: Readonly<Record<string, string>>;
  /** JSON body of a POST, or the query object of a GET. */
  readonly body: unknown;
  /** Idempotency-Key header (REST) or `idempotencyKey` argument (MCP); validated by the domain. */
  readonly key: string;
}

export interface SchedulingOp extends RouteContract {
  readonly operationId: ActionName;
  readonly tool: string;
  readonly description: string;
  /** GET only: the scheduling.schema.json definition of the query object. */
  readonly query?: string;
  /** A POST that only reads (no Idempotency-Key; read-only tool). */
  readonly postRead?: boolean;
  invoke(svc: AppointmentService, actor: ActorContext, input: OpInput): Promise<unknown>;
}

const S = (name: string) => `scheduling:${name}`;
const COMMAND = ['400', '401', '403', '404', '409', '422', '503'] as const;
const READ = ['401', '403', '404', '503'] as const;
const LIST = ['400', '401', '403', '503'] as const;
const APPT = '/v1/scheduling/appointments/{appointmentRef}';

const env = (operation: string, input: OpInput): CommandEnvelope<unknown> => ({
  operation,
  idempotencyKey: input.key,
  payload: input.body,
});
const param = (input: OpInput, name: string) => input.params[name] ?? '';
const data = async (p: Promise<unknown>) => ({ data: await p });

export const SCHEDULING_OPS: readonly SchedulingOp[] = [
  // S12 visit context (references only; every producer-bound item is explicit when unavailable).
  {
    method: 'get',
    path: `${APPT}/visit-context`,
    operationId: 'scheduling.visitContext.read',
    protected: true,
    success: { status: '200', schema: S('VisitContext') },
    refusals: READ,
    tool: 'scheduling_visit_context_get',
    description:
      'Visit context of one appointment: patient, attendance and the producer-bound items (medical history C8, forms C13, note drafts C10, lab cases C16, treatment-plan items C11), each a resolvable reference or an explicit unavailable with its reason. Unavailable never counts as checked.',
    invoke: (svc, actor, i) => data(svc.getVisitContext(actor, param(i, 'appointmentRef'))),
  },
  {
    method: 'get',
    path: `${APPT}/visit-context/items`,
    operationId: 'scheduling.visitContext.items',
    protected: true,
    success: { status: '200', schema: S('VisitContextItemList') },
    refusals: READ,
    tool: 'scheduling_visit_context_items',
    description:
      'History of the visit-context references of one appointment (pins, assignments, links, relinks).',
    invoke: (svc, actor, i) => data(svc.listVisitContextItems(actor, param(i, 'appointmentRef'))),
  },
  {
    method: 'post',
    path: `${APPT}/visit-context/medical-history-pin`,
    operationId: 'scheduling.visitContext.pinMedicalHistory',
    protected: true,
    requestBody: S('VisitContextPin'),
    success: { status: '201', schema: S('VisitItemCommandResult') },
    refusals: COMMAND,
    tool: 'scheduling_visit_context_pin_medical_history',
    description:
      'Pin the current medical-history version (a version reference, never a copy). Refused with producer_unavailable until C8 exists.',
    invoke: (svc, actor, i) =>
      svc.pinMedicalHistorySnapshot(
        actor,
        param(i, 'appointmentRef'),
        env('scheduling.visitContext.pinMedicalHistory', i),
      ),
  },
  {
    method: 'post',
    path: `${APPT}/visit-context/forms`,
    operationId: 'scheduling.visitContext.assignForm',
    protected: true,
    requestBody: S('VisitFormAssign'),
    success: { status: '201', schema: S('VisitItemCommandResult') },
    refusals: COMMAND,
    tool: 'scheduling_visit_context_assign_form',
    description:
      'Assign a form to the visit (idempotent per form and appointment). Refused with producer_unavailable until C13 exists.',
    invoke: (svc, actor, i) =>
      svc.assignForm(actor, param(i, 'appointmentRef'), env('scheduling.visitContext.assignForm', i)),
  },
  {
    method: 'post',
    path: `${APPT}/visit-context/forms/{itemRef}/unassign`,
    operationId: 'scheduling.visitContext.unassignForm',
    protected: true,
    requestBody: S('VisitFormUnassign'),
    success: { status: '200', schema: S('VisitItemCommandResult') },
    refusals: COMMAND,
    tool: 'scheduling_visit_context_unassign_form',
    description: 'Unassign a form with a reason (explicit; the assignment stays in the item history).',
    invoke: (svc, actor, i) =>
      svc.unassignForm(
        actor,
        param(i, 'appointmentRef'),
        param(i, 'itemRef'),
        env('scheduling.visitContext.unassignForm', i),
      ),
  },
  {
    method: 'post',
    path: `${APPT}/visit-context/lab-cases`,
    operationId: 'scheduling.visitContext.linkLabCase',
    protected: true,
    requestBody: S('VisitLabLink'),
    success: { status: '201', schema: S('VisitItemCommandResult') },
    refusals: COMMAND,
    tool: 'scheduling_visit_context_link_lab_case',
    description:
      'Bind a lab case to the visit. A case bound to another appointment needs the relink command. Refused with producer_unavailable until C16 exists.',
    invoke: (svc, actor, i) =>
      svc.linkLabCase(actor, param(i, 'appointmentRef'), env('scheduling.visitContext.linkLabCase', i)),
  },
  {
    method: 'post',
    path: `${APPT}/visit-context/lab-cases/relink`,
    operationId: 'scheduling.visitContext.relinkLabCase',
    protected: true,
    requestBody: S('VisitLabRelink'),
    success: { status: '201', schema: S('VisitItemCommandResult') },
    refusals: COMMAND,
    tool: 'scheduling_visit_context_relink_lab_case',
    description: 'Move a lab case binding to this visit with a reason; both bindings stay in history.',
    invoke: (svc, actor, i) =>
      svc.relinkLabCase(actor, param(i, 'appointmentRef'), env('scheduling.visitContext.relinkLabCase', i)),
  },
  // S13 recurrence series (ADR 0009 S-D1: limit 26 per request, ceiling 52, explicit continuation).
  {
    method: 'post',
    path: '/v1/scheduling/series/plan',
    operationId: 'scheduling.series.plan',
    protected: true,
    requestBody: S('SeriesCreate'),
    success: { status: '200', schema: S('SeriesPlanResult') },
    refusals: ['400', '401', '403', '404', '422', '503'],
    postRead: true,
    tool: 'scheduling_series_plan',
    description:
      'Preview a series: every occurrence with its conflicts and the published limit. Read-only; writes nothing.',
    invoke: (svc, actor, i) => data(svc.planSeries(actor, i.body)),
  },
  {
    method: 'post',
    path: '/v1/scheduling/series',
    operationId: 'scheduling.series.create',
    protected: true,
    requestBody: S('SeriesCreate'),
    success: { status: '201', schema: S('SeriesCommandResult') },
    refusals: COMMAND,
    tool: 'scheduling_series_create',
    description:
      'Create a series: every occurrence is a real booking. Atomic by default (any conflict refuses all, with per-occurrence conflicts); skipConflicts creates only the free ones and enumerates the rest. Over the limit is 422 series_limit_exceeded naming the limit.',
    invoke: (svc, actor, i) => svc.createSeries(actor, env('scheduling.series.create', i)),
  },
  {
    method: 'get',
    path: '/v1/scheduling/series/{seriesRef}',
    operationId: 'scheduling.series.read',
    protected: true,
    success: { status: '200', schema: S('SeriesRead') },
    refusals: READ,
    tool: 'scheduling_series_get',
    description: 'Read a series with every occurrence (and its standing booking) and its exceptions.',
    invoke: (svc, actor, i) => data(svc.getSeries(actor, param(i, 'seriesRef'))),
  },
  {
    method: 'post',
    path: '/v1/scheduling/series/{seriesRef}/extend',
    operationId: 'scheduling.series.extend',
    protected: true,
    requestBody: S('SeriesExtend'),
    success: { status: '201', schema: S('SeriesCommandResult') },
    refusals: COMMAND,
    tool: 'scheduling_series_extend',
    description:
      'Continue a series explicitly with the next block of occurrences (same limit and atomicity).',
    invoke: (svc, actor, i) =>
      svc.extendSeries(actor, param(i, 'seriesRef'), env('scheduling.series.extend', i)),
  },
  {
    method: 'post',
    path: '/v1/scheduling/series/{seriesRef}/end',
    operationId: 'scheduling.series.end',
    protected: true,
    requestBody: S('SeriesEnd'),
    success: { status: '200', schema: S('SeriesCommandResult') },
    refusals: ['400', '401', '403', '404', '409', '503'],
    tool: 'scheduling_series_end',
    description:
      'End a series with a reason. Nothing is deleted or cancelled: future occurrences are listed for explicit reassignment.',
    invoke: (svc, actor, i) => svc.endSeries(actor, param(i, 'seriesRef'), env('scheduling.series.end', i)),
  },
  // S14 notification intents (channel none until S-S2 qualifies a channel; E6 decides, E7 delivers).
  {
    method: 'get',
    path: '/v1/scheduling/notifications/worklist',
    operationId: 'scheduling.notifications.worklist',
    protected: true,
    success: { status: '200', schema: S('WorkItemList') },
    refusals: LIST,
    query: 'NotificationWorklistQuery',
    tool: 'scheduling_notifications_worklist',
    description:
      'Work items for notification intents no verified channel will deliver (channel none): reason, explanation, evidence, owner, due time and next action. Nothing is ever sent by scheduling.',
    invoke: (svc, actor, i) => data(svc.notificationWorklist(actor, i.body)),
  },
  {
    method: 'get',
    path: '/v1/scheduling/notifications/{intentRef}',
    operationId: 'scheduling.notifications.read',
    protected: true,
    success: { status: '200', schema: S('NotificationIntentRead') },
    refusals: READ,
    tool: 'scheduling_notifications_get',
    description:
      'Read one notification intent: purpose, channel (none), delivery key, the E6-owned suppression decision placeholder and the E7 delivery state.',
    invoke: (svc, actor, i) => data(svc.readNotificationIntent(actor, param(i, 'intentRef'))),
  },
  // S15 waitlist (an offer is a short-lived hold; only the explicit acceptance books).
  {
    method: 'post',
    path: '/v1/scheduling/waitlist',
    operationId: 'scheduling.waitlist.add',
    protected: true,
    requestBody: S('WaitlistAdd'),
    success: { status: '201', schema: S('WaitlistEntryCommandResult') },
    refusals: COMMAND,
    tool: 'scheduling_waitlist_add',
    description:
      'Add a waitlist entry (desired window, duration, priority). Creates no appointment, hold or occupancy.',
    invoke: (svc, actor, i) => svc.addToWaitlist(actor, env('scheduling.waitlist.add', i)),
  },
  {
    method: 'get',
    path: '/v1/scheduling/waitlist',
    operationId: 'scheduling.waitlist.list',
    protected: true,
    success: { status: '200', schema: S('WaitlistEntryList') },
    refusals: LIST,
    query: 'WaitlistListQuery',
    tool: 'scheduling_waitlist_list',
    description:
      'List waitlist entries in priority order (at most 100), optionally for one location or state.',
    invoke: (svc, actor, i) => data(svc.listWaitlist(actor, i.body)),
  },
  {
    method: 'post',
    path: '/v1/scheduling/waitlist/{entryRef}/remove',
    operationId: 'scheduling.waitlist.remove',
    protected: true,
    requestBody: S('WaitlistRemove'),
    success: { status: '200', schema: S('WaitlistEntryCommandResult') },
    refusals: ['400', '401', '403', '404', '409', '503'],
    tool: 'scheduling_waitlist_remove',
    description: 'Remove an entry with a reason (a live offer must be answered first).',
    invoke: (svc, actor, i) =>
      svc.removeFromWaitlist(actor, param(i, 'entryRef'), env('scheduling.waitlist.remove', i)),
  },
  {
    method: 'post',
    path: '/v1/scheduling/waitlist/{entryRef}/offer',
    operationId: 'scheduling.waitlist.offer',
    protected: true,
    requestBody: S('WaitlistOffer'),
    success: { status: '201', schema: S('OfferCommandResult') },
    refusals: COMMAND,
    tool: 'scheduling_waitlist_offer',
    description:
      'Offer a window to one entry: a short-lived hold with an expiry and a waitlist_offer intent (channel none). Never books; a second offer for the same range is a conflict naming the hold.',
    invoke: (svc, actor, i) =>
      svc.offerSlot(actor, param(i, 'entryRef'), env('scheduling.waitlist.offer', i)),
  },
  {
    method: 'post',
    path: '/v1/scheduling/waitlist/offers/reconcile',
    operationId: 'scheduling.waitlist.reconcileOffers',
    protected: true,
    requestBody: S('OfferReconcile'),
    success: { status: '200', schema: S('OfferReconcileResult') },
    refusals: ['400', '401', '403', '409', '503'],
    tool: 'scheduling_waitlist_reconcile_offers',
    description:
      'Expire every offer whose hold expired (releases the hold, reopens the entry). No staff decision needed.',
    invoke: (svc, actor, i) => svc.reconcileOffers(actor, env('scheduling.waitlist.reconcileOffers', i)),
  },
  {
    method: 'get',
    path: '/v1/scheduling/waitlist-offers/{offerRef}',
    operationId: 'scheduling.waitlist.offers.read',
    protected: true,
    success: { status: '200', schema: S('OfferRead') },
    refusals: READ,
    tool: 'scheduling_waitlist_offer_get',
    description:
      'Read one offer with its hold, expiry, outcome and any standing policy it was executed under.',
    invoke: (svc, actor, i) => data(svc.readOffer(actor, param(i, 'offerRef'))),
  },
  {
    method: 'post',
    path: '/v1/scheduling/waitlist-offers/{offerRef}/respond',
    operationId: 'scheduling.waitlist.respond',
    protected: true,
    requestBody: S('OfferRespond'),
    success: { status: '200', schema: S('OfferRespondResult') },
    refusals: COMMAND,
    tool: 'scheduling_waitlist_respond',
    description:
      'Record the answer to an offer: accepted books through the S10 path from the hold; declined or withdrawn releases it. An expired offer is 409 offer_expired.',
    invoke: (svc, actor, i) =>
      svc.respondToOffer(actor, param(i, 'offerRef'), env('scheduling.waitlist.respond', i)),
  },
  // PT-02 cancellation recovery and its standing-policy gate.
  {
    method: 'get',
    path: '/v1/scheduling/recoveries',
    operationId: 'scheduling.recovery.list',
    protected: true,
    success: { status: '200', schema: S('WorkItemList') },
    refusals: LIST,
    query: 'RecoveryListQuery',
    tool: 'scheduling_recovery_list',
    description: 'Work items for slots freed by cancellation that are not yet filled.',
    invoke: (svc, actor, i) => data(svc.listRecoveries(actor, i.body)),
  },
  {
    method: 'get',
    path: '/v1/scheduling/recoveries/{recoveryRef}',
    operationId: 'scheduling.recovery.read',
    protected: true,
    success: { status: '200', schema: S('RecoveryRead') },
    refusals: READ,
    tool: 'scheduling_recovery_get',
    description:
      'A freed slot with ranked waitlist candidates (provider, duration, window, existing bookings) and excluded entries with reasons; consent is the E6 decision, referenced only. States the automation mode.',
    invoke: (svc, actor, i) => data(svc.readRecovery(actor, param(i, 'recoveryRef'))),
  },
  {
    method: 'post',
    path: '/v1/scheduling/recoveries/{recoveryRef}/execute',
    operationId: 'scheduling.recovery.execute',
    protected: true,
    requestBody: S('RecoveryExecute'),
    success: { status: '201', schema: S('OfferCommandResult') },
    refusals: COMMAND,
    tool: 'scheduling_recovery_execute',
    description:
      'Offer the freed slot to the named (or first) candidate. A person executing approves the prepared offer; a service principal needs a live standing policy, rechecked now and recorded on the offer.',
    invoke: (svc, actor, i) =>
      svc.executeRecovery(actor, param(i, 'recoveryRef'), env('scheduling.recovery.execute', i)),
  },
  {
    method: 'post',
    path: '/v1/scheduling/standing-policies',
    operationId: 'scheduling.standingPolicies.grant',
    protected: true,
    requestBody: S('StandingPolicyGrant'),
    success: { status: '201', schema: S('StandingPolicyCommandResult') },
    refusals: COMMAND,
    tool: 'scheduling_standing_policies_grant',
    description:
      'Grant a revocable standing policy (owner = the granting person; one service principal; one operation; locations; limits; expiry within 90 days). Human admins only.',
    invoke: (svc, actor, i) => svc.grantStandingPolicy(actor, env('scheduling.standingPolicies.grant', i)),
  },
  {
    method: 'get',
    path: '/v1/scheduling/standing-policies',
    operationId: 'scheduling.standingPolicies.list',
    protected: true,
    success: { status: '200', schema: S('StandingPolicyList') },
    refusals: ['401', '403', '503'],
    tool: 'scheduling_standing_policies_list',
    description:
      'List standing policies with their scope, limits, expiry and state (active, revoked, expired).',
    invoke: (svc, actor) => data(svc.listStandingPolicies(actor)),
  },
  {
    method: 'post',
    path: '/v1/scheduling/standing-policies/{policyRef}/revoke',
    operationId: 'scheduling.standingPolicies.revoke',
    protected: true,
    requestBody: S('StandingPolicyRevoke'),
    success: { status: '200', schema: S('StandingPolicyCommandResult') },
    refusals: ['400', '401', '403', '404', '409', '503'],
    tool: 'scheduling_standing_policies_revoke',
    description: 'Revoke a standing policy with a reason; the next execution under it is refused.',
    invoke: (svc, actor, i) =>
      svc.revokeStandingPolicy(actor, param(i, 'policyRef'), env('scheduling.standingPolicies.revoke', i)),
  },
];

/** The route contracts only (spread into ROUTES). */
export const SCHEDULING_OP_ROUTES: readonly RouteContract[] = SCHEDULING_OPS.map((o) => ({
  method: o.method,
  path: o.path,
  operationId: o.operationId,
  protected: o.protected,
  ...(o.requestBody === undefined ? {} : { requestBody: o.requestBody }),
  success: o.success,
  refusals: o.refusals,
}));

/** Path parameter names of an operation, in path order. */
export const pathParamsOf = (path: string): string[] =>
  [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
