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
];

void LIST;

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
