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
