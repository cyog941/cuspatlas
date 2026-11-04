import type { ActorContext } from '@cuspatlas/contracts';
import { schedulingSchema } from '@cuspatlas/contracts';
import type { ActionName } from '@cuspatlas/domain';
import { type Args, inputSchema, type ToolDefinition, type ToolDeps, without } from './synthetic-tasks';

const DEFS = schedulingSchema.$defs as Record<string, unknown>;
type Def = { properties: Record<string, object>; required?: string[] };
const def = (name: string) => DEFS[name] as Def;

/** Transport-only properties and the contract definition each one uses. */
const TRANSPORT: Record<string, string> = {
  idempotencyKey: 'IdempotencyKey',
  requestRef: 'RequestRef',
  appointmentRef: 'AppointmentRef',
  holdRef: 'HoldRef',
};

/**
 * Input schema = the REST body (or list query) definition's properties, plus the transport-only
 * properties (Idempotency-Key header and path parameters). Built mechanically from
 * scheduling.schema.json so REST and MCP cannot drift.
 */
function schemaFor(body: string | null, transport: readonly string[]) {
  const d = body === null ? { properties: {}, required: [] } : def(body);
  const props: Record<string, object | string> = { ...d.properties };
  for (const t of transport) props[t] = TRANSPORT[t] as string;
  return inputSchema(props, [...(d.required ?? []), ...transport], DEFS);
}

interface Spec {
  readonly name: string;
  readonly operationId: ActionName;
  readonly description: string;
  readonly body: string | null;
  readonly transport: readonly string[];
  readonly readOnly: boolean;
  run(deps: ToolDeps, actor: ActorContext, args: Args): Promise<unknown>;
}

const envelope = (operation: string, args: Args, ...pathParams: string[]) => ({
  operation,
  idempotencyKey: args.idempotencyKey as string,
  payload: without(args, 'idempotencyKey', ...pathParams),
});

const SPECS: readonly Spec[] = [
  {
    name: 'scheduling_requests_create',
    operationId: 'scheduling.requests.create',
    description:
      'Record an appointment request (staff origin). It holds no resource and blocks no slot; the patient must be schedulable.',
    body: 'AppointmentRequestCreate',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.appointments.createRequest(actor, envelope('scheduling.requests.create', args), 'staff'),
  },
  {
    name: 'scheduling_requests_list',
    operationId: 'scheduling.requests.list',
    description: 'List open and in-review requests (or one state), one bounded page at a time.',
    body: 'AppointmentRequestListQuery',
    transport: [],
    readOnly: true,
    run: (d, actor, args) => d.appointments.listRequests(actor, { ...args }),
  },
  {
    name: 'scheduling_requests_get',
    operationId: 'scheduling.requests.read',
    description:
      'Read one appointment request with its transition history. Hidden and missing are identical.',
    body: null,
    transport: ['requestRef'],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.appointments.getRequest(actor, args.requestRef as string) };
    },
  },
  {
    name: 'scheduling_requests_update_preferences',
    operationId: 'scheduling.requests.updatePreferences',
    description: 'Update request preferences if expectedVersion matches. Refused once the request is closed.',
    body: 'AppointmentRequestPreferences',
    transport: ['requestRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.appointments.updateRequestPreferences(
        actor,
        args.requestRef as string,
        envelope('scheduling.requests.updatePreferences', args, 'requestRef'),
      ),
  },
  {
    name: 'scheduling_requests_review',
    operationId: 'scheduling.requests.review',
    description: 'Move an open request to in_review (a recorded transition).',
    body: 'AppointmentRequestReview',
    transport: ['requestRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.appointments.reviewRequest(
        actor,
        args.requestRef as string,
        envelope('scheduling.requests.review', args, 'requestRef'),
      ),
  },
  {
    name: 'scheduling_requests_close',
    operationId: 'scheduling.requests.close',
    description:
      'Close a request with a reason. scheduled needs the booking reference; expired needs the configured expiry policy.',
    body: 'AppointmentRequestClose',
    transport: ['requestRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.appointments.closeRequest(
        actor,
        args.requestRef as string,
        envelope('scheduling.requests.close', args, 'requestRef'),
      ),
  },
  {
    name: 'scheduling_requests_reopen',
    operationId: 'scheduling.requests.reopen',
    description: 'Reopen a closed request with a reason (never automatic; a standing booking blocks it).',
    body: 'AppointmentRequestReopen',
    transport: ['requestRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.appointments.reopenRequest(
        actor,
        args.requestRef as string,
        envelope('scheduling.requests.reopen', args, 'requestRef'),
      ),
  },
  {
    name: 'scheduling_requests_unbooked_report',
    operationId: 'scheduling.requests.unbookedReport',
    description: 'Report requests that reached a terminal state without ever becoming a booking.',
    body: null,
    transport: [],
    readOnly: true,
    async run(d, actor) {
      return { data: await d.appointments.unbookedRequests(actor) };
    },
  },
  {
    name: 'scheduling_appointments_book',
    operationId: 'scheduling.appointments.book',
    description:
      'Book an appointment (directly or from a hold or request). Conflicts are a typed refusal with an inspectable, visibility-filtered conflict list; nothing is written.',
    body: 'BookingCreate',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.appointments.bookAppointment(actor, envelope('scheduling.appointments.book', args)),
  },
  {
    name: 'scheduling_appointments_get',
    operationId: 'scheduling.appointments.read',
    description:
      'Read one appointment with its resources, overrides and lifecycle. Hidden and missing are identical.',
    body: null,
    transport: ['appointmentRef'],
    readOnly: true,
    async run(d, actor, args) {
      return { data: await d.appointments.getAppointment(actor, args.appointmentRef as string) };
    },
  },
  {
    name: 'scheduling_appointments_reschedule',
    operationId: 'scheduling.appointments.reschedule',
    description:
      'Move a booking: books the new window and records the original as rescheduled, linked both ways.',
    body: 'AppointmentReschedule',
    transport: ['appointmentRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.appointments.rescheduleAppointment(
        actor,
        args.appointmentRef as string,
        envelope('scheduling.appointments.reschedule', args, 'appointmentRef'),
      ),
  },
  {
    name: 'scheduling_appointments_cancel',
    operationId: 'scheduling.appointments.cancel',
    description: 'Cancel a booking with a reason (a recorded fact; the appointment is never deleted).',
    body: 'AppointmentCancel',
    transport: ['appointmentRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.appointments.cancelAppointment(
        actor,
        args.appointmentRef as string,
        envelope('scheduling.appointments.cancel', args, 'appointmentRef'),
      ),
  },
  {
    name: 'scheduling_holds_create',
    operationId: 'scheduling.holds.create',
    description:
      'Hold resources for a window until an expiry. An expired hold stops blocking without staff action.',
    body: 'HoldCreate',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) => d.appointments.holdSlot(actor, envelope('scheduling.holds.create', args)),
  },
  {
    name: 'scheduling_holds_release',
    operationId: 'scheduling.holds.release',
    description: 'Release an active hold with a reason.',
    body: 'HoldRelease',
    transport: ['holdRef', 'idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.appointments.releaseHold(
        actor,
        args.holdRef as string,
        envelope('scheduling.holds.release', args, 'holdRef'),
      ),
  },
  {
    name: 'scheduling_holds_reconcile',
    operationId: 'scheduling.holds.reconcile',
    description: 'Release every expired hold in the caller locations (reconciliation path).',
    body: 'HoldReconcile',
    transport: ['idempotencyKey'],
    readOnly: false,
    run: (d, actor, args) =>
      d.appointments.reconcileHolds(actor, envelope('scheduling.holds.reconcile', args)),
  },
];

/**
 * MCP twins of the appointment routes. Every handler calls the same domain service REST uses,
 * which authorizes before it validates; invalid arguments are refused after authorization for the
 * same action, so a caller without access gets the identical denial and attempt row.
 */
export const APPOINTMENT_TOOLS: readonly ToolDefinition[] = SPECS.map((s) => ({
  name: s.name,
  operationId: s.operationId,
  description: s.description,
  inputSchema: schemaFor(s.body, s.transport),
  readOnly: s.readOnly,
  onInvalid: { action: s.operationId },
  run: (deps, actor, args) => s.run(deps, actor, args),
}));
