import type { ActorContext, CommandEnvelope } from '@cuspatlas/contracts';
import type { ActionName, ReadSurfaceService } from '@cuspatlas/domain';
import type { RouteContract } from './manifest';
import type { OpInput } from './scheduling-ops';

/**
 * One table for the A batch 3 read surfaces (A21 composers, A22 preferences, A24 navigation, A16
 * analytics, A17 administration, A18 huddle): the REST route contract, the MCP tool name (absent for a
 * REST-only operation) and the call into the shared read-surface service. REST registration
 * (read-ops-routes.ts), the MCP tools (apps/mcp/src/tools/read-ops.ts) and the drift checks derive from
 * it. Schema names are definitions of the foundation contract file (synthetic-task.schema.json).
 */
export interface ReadOp extends RouteContract {
  readonly operationId: ActionName;
  readonly tool?: string;
  readonly description: string;
  /** GET only: the foundation definition of the query object. */
  readonly query?: string;
  invoke(svc: ReadSurfaceService, actor: ActorContext, input: OpInput): Promise<unknown>;
}

export const READ_REFUSALS = ['400', '401', '403', '404', '503'] as const;
export const READ_COMMAND_REFUSALS = ['400', '401', '403', '404', '409', '422', '503'] as const;

export const readEnvelope = (operation: string, input: OpInput): CommandEnvelope<unknown> => ({
  operation,
  idempotencyKey: input.key,
  payload: input.body,
});
const param = (input: OpInput, name: string) => input.params[name] ?? '';

/** Path parameter -> foundation schema definition. */
export const READ_PARAM_DEFS: Readonly<Record<string, string>> = {
  appointmentRef: 'Uuid',
  viewRef: 'Uuid',
  measureKey: 'MeasureKey',
};

export const READ_OPS: readonly ReadOp[] = [
  {
    method: 'get',
    path: '/v1/schedule/view',
    operationId: 'schedule.view',
    protected: true,
    query: 'ScheduleViewQuery',
    success: { status: '200', schema: 'ScheduleViewResult' },
    refusals: READ_REFUSALS,
    tool: 'schedule_view',
    description:
      'A21 (OR-03, OR-09): one location and local date range (at most 14 days) in one call: booked appointments with type, time, resources, request link and attendance state with allowed next transitions; time blocks as single objects spanning their resources; unavailable intervals per resource with reason (closed, blocked, outside_availability), distinct from free time; counters with scope. grain=detailed adds per-appointment components (patient summary, coverage verification, balance, planned procedures), each ok, restricted (caller may not see it) or unavailable (producer missing) with its own freshness. Writes nothing.',
    invoke: (svc, actor, i) => svc.readScheduleView(actor, i.body),
  },
  {
    method: 'get',
    path: '/v1/appointments/{appointmentRef}/detail',
    operationId: 'appointments.detail',
    protected: true,
    success: { status: '200', schema: 'AppointmentDetailResult' },
    refusals: READ_REFUSALS,
    tool: 'appointments_detail',
    description:
      'A21 (OR-10): one appointment with its patient summary (name, age, chart identifier; phone only with communications read), coverage verification status and carrier, balance summary, planned procedures with tooth and surfaces, attendance with next transitions, and a chart reference. Each component is ok, restricted or unavailable with its own freshness. Writes nothing.',
    invoke: (svc, actor, i) => svc.readAppointmentDetail(actor, param(i, 'appointmentRef')),
  },
  {
    method: 'get',
    path: '/v1/navigation',
    operationId: 'navigation.read',
    protected: true,
    success: { status: '200', schema: 'NavigationRead' },
    refusals: ['401', '403', '503'],
    tool: 'navigation_get',
    description:
      'A24 (OR-14): the navigable capabilities of the operation catalog grouped by area (scheduling, clinical, financial, communications, imaging, administration, migration), filtered by the live permissions of the caller: a capability appears only when its entry operation is allowed and lists only allowed operations. Navigation grants nothing; every operation still authorizes its own resource.',
    invoke: (svc, actor) => svc.readNavigation(actor),
  },
  {
    method: 'get',
    path: '/v1/admin/audit',
    operationId: 'admin.audit.search',
    protected: true,
    query: 'AuditSearchQuery',
    success: { status: '200', schema: 'AuditSearchResult' },
    refusals: READ_REFUSALS,
    tool: 'admin_audit_search',
    description:
      'A17: search the committed-change audit, security attempts and sensitive reads of the tenant (source, actorRef, principal, operation, from, to; newest first; at most 200). principal=service selects agent activity. Read only, human only, audit.read; the search itself is recorded as a sensitive read.',
    invoke: (svc, actor, i) => svc.searchAudit(actor, i.body),
  },
  {
    method: 'get',
    path: '/v1/admin/access-review',
    operationId: 'admin.access.review',
    protected: true,
    success: { status: '200', schema: 'AccessReview' },
    refusals: ['401', '403', '503'],
    tool: 'admin_access_review',
    description:
      'A17: access review of the tenant: staff memberships (human and service principals) with scopes, locations, grant and revocation instants and last activity; portal principals and imaging devices with state. Each entry names the command that revokes it. Human only, access.manage.',
    invoke: (svc, actor) => svc.reviewAccess(actor),
  },
  {
    method: 'post',
    path: '/v1/admin/access/revocations',
    operationId: 'admin.access.revoke',
    protected: true,
    requestBody: 'AccessRevoke',
    success: { status: '201', schema: 'AccessRevokeResult' },
    refusals: READ_COMMAND_REFUSALS,
    tool: 'admin_access_revoke',
    description:
      'A17: revoke one staff membership (human or service principal) of the tenant with a reason code. Effective on the next REST request, MCP call or queued job of that principal (every call reloads the membership). The caller cannot revoke itself (409). Portal principals and devices are revoked with portal.principals.revoke and imaging.devices.revoke. Human only, access.manage.',
    invoke: (svc, actor, i) => svc.revokeAccess(actor, readEnvelope('admin.access.revoke', i)),
  },
  {
    method: 'get',
    path: '/v1/analytics/measures',
    operationId: 'analytics.measures.list',
    protected: true,
    success: { status: '200', schema: 'MeasureCatalog' },
    refusals: ['401', '403', '503'],
    tool: 'analytics_measures_list',
    description:
      'A16 (PT-06): the registered measure definitions: key, definition version, owner, plain definition text, unit, date basis, filters, the read actions each requires and its small-cell suppression rule (threshold 11 by default, pending approval).',
    invoke: (svc, actor) => svc.listMeasures(actor),
  },
  {
    method: 'get',
    path: '/v1/analytics/measures/{measureKey}',
    operationId: 'analytics.measures.read',
    protected: true,
    query: 'MeasureQuery',
    success: { status: '200', schema: 'MeasureRead' },
    refusals: READ_REFUSALS,
    tool: 'analytics_measures_read',
    description:
      'A16 (PT-06): one measure value with its definition version, as-of instant, date basis, applied filters and freshness. A population from 1 to threshold-1 is suppressed (no value, no population); a zero denominator is undefined, never zero. Needs analytics.read and the measure owner read action (financial measures: the B11 scopes).',
    invoke: (svc, actor, i) => svc.readMeasure(actor, param(i, 'measureKey'), i.body),
  },
  {
    method: 'get',
    path: '/v1/me/saved-views',
    operationId: 'preferences.savedViews.list',
    protected: true,
    success: { status: '200', schema: 'SavedViewList' },
    refusals: ['401', '403', '503'],
    tool: 'preferences_saved_views_list',
    description:
      "A22 (OR-12): the saved list and report views of the caller (filters only, never another user's), with the list envelope.",
    invoke: (svc, actor) => svc.listSavedViews(actor),
  },
  {
    method: 'post',
    path: '/v1/me/saved-views',
    operationId: 'preferences.savedViews.save',
    protected: true,
    requestBody: 'SavedViewSave',
    success: { status: '201', schema: 'SavedViewCommandResult' },
    refusals: READ_COMMAND_REFUSALS,
    tool: 'preferences_saved_views_save',
    description:
      'A22 (OR-12): save (or replace by name) a view of a registered list operation. Filters only: an identifying filter (name, birth date, phone) or a cursor is refused, and a name may hold letters, spaces, dots, dashes and underscores only, so no patient identity is stored.',
    invoke: (svc, actor, i) => svc.saveView(actor, readEnvelope('preferences.savedViews.save', i)),
  },
  {
    method: 'post',
    path: '/v1/me/saved-views/{viewRef}/delete',
    operationId: 'preferences.savedViews.delete',
    protected: true,
    requestBody: 'EmptyCommand',
    success: { status: '201', schema: 'SavedViewDeleteResult' },
    refusals: READ_COMMAND_REFUSALS,
    tool: 'preferences_saved_views_delete',
    description: "A22 (OR-12): delete one of the caller's saved views (another user's view is 404).",
    invoke: (svc, actor, i) =>
      svc.deleteView(actor, param(i, 'viewRef'), readEnvelope('preferences.savedViews.delete', i)),
  },
  {
    method: 'get',
    path: '/v1/me/favourite-reports',
    operationId: 'preferences.favourites.list',
    protected: true,
    success: { status: '200', schema: 'FavouriteReportList' },
    refusals: ['401', '403', '503'],
    tool: 'preferences_favourites_list',
    description:
      'A22 (OR-12): the favourite reports (catalog read operations) of the caller, with the list envelope.',
    invoke: (svc, actor) => svc.listFavourites(actor),
  },
  {
    method: 'post',
    path: '/v1/me/favourite-reports',
    operationId: 'preferences.favourites.add',
    protected: true,
    requestBody: 'FavouriteReportChange',
    success: { status: '201', schema: 'FavouriteReportCommandResult' },
    refusals: READ_COMMAND_REFUSALS,
    tool: 'preferences_favourites_add',
    description: 'A22 (OR-12): mark a catalog read operation as a favourite report of the caller.',
    invoke: (svc, actor, i) =>
      svc.changeFavourite(actor, true, readEnvelope('preferences.favourites.add', i)),
  },
  {
    method: 'post',
    path: '/v1/me/favourite-reports/remove',
    operationId: 'preferences.favourites.remove',
    protected: true,
    requestBody: 'FavouriteReportChange',
    success: { status: '201', schema: 'FavouriteReportCommandResult' },
    refusals: READ_COMMAND_REFUSALS,
    tool: 'preferences_favourites_remove',
    description: 'A22 (OR-12): remove a favourite report of the caller.',
    invoke: (svc, actor, i) =>
      svc.changeFavourite(actor, false, readEnvelope('preferences.favourites.remove', i)),
  },
  {
    method: 'get',
    path: '/v1/me/recent-patients',
    operationId: 'preferences.recentPatients.list',
    protected: true,
    success: { status: '200', schema: 'RecentPatientList' },
    refusals: ['401', '403', '503'],
    tool: 'preferences_recent_patients_list',
    description:
      'A22 (OR-12, OR-D5): the patients the caller opened in the last 7 days, references only, newest first (at most 50). Expired entries are purged on every access and never returned; never shared across users or tenants.',
    invoke: (svc, actor) => svc.listRecentPatients(actor),
  },
  {
    method: 'post',
    path: '/v1/me/recent-patients',
    operationId: 'preferences.recentPatients.record',
    protected: true,
    requestBody: 'RecentPatientRecord',
    success: { status: '201', schema: 'RecentPatientCommandResult' },
    refusals: READ_COMMAND_REFUSALS,
    tool: 'preferences_recent_patients_record',
    description:
      "A22 (OR-12): remember that the caller opened a patient (reference only; needs patients.read; another tenant's patient is 404).",
    invoke: (svc, actor, i) =>
      svc.recordRecentPatient(actor, readEnvelope('preferences.recentPatients.record', i)),
  },
  {
    method: 'post',
    path: '/v1/me/recent-patients/clear',
    operationId: 'preferences.recentPatients.clear',
    protected: true,
    requestBody: 'EmptyCommand',
    success: { status: '201', schema: 'RecentPatientClearResult' },
    refusals: READ_COMMAND_REFUSALS,
    tool: 'preferences_recent_patients_clear',
    description: 'A22 (OR-12): clear the recent-patient list of the caller.',
    invoke: (svc, actor, i) =>
      svc.clearRecentPatients(actor, readEnvelope('preferences.recentPatients.clear', i)),
  },
];

export const READ_OP_ROUTES: readonly RouteContract[] = READ_OPS.map((o) => ({
  method: o.method,
  path: o.path,
  operationId: o.operationId,
  protected: o.protected,
  ...(o.requestBody === undefined ? {} : { requestBody: o.requestBody }),
  success: o.success,
  refusals: o.refusals,
}));
