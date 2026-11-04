import type { AppointmentService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { routeFor } from './manifest';

/** The Idempotency-Key, validated by the domain after authorization (the scheduling-route pattern). */
function key(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  return typeof raw === 'string' ? raw : '';
}

type Handler = (request: FastifyRequest) => Promise<unknown>;

/**
 * Thin REST adapter for S8 requests (and, later, S10 booking and S11 attendance). Authentication
 * runs in `onRequest`; no tenant is read from the path, query, headers or body. Staff routes set the
 * request origin to 'staff'; the portal will call the same domain command with 'portal'.
 */
export function registerAppointmentRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; appointments: AppointmentService },
): void {
  const a = deps.appointments;
  const mount = (operationId: string, handler: Handler) => {
    const r = routeFor(operationId);
    const opts = { onRequest: authenticateOnRequest(deps.authenticator, r.operationId) };
    if (r.method === 'get') {
      app.get(r.fastifyPath, opts, async (request) => handler(request));
    } else {
      app.post(r.fastifyPath, opts, async (request, reply) =>
        reply.code(Number(r.success.status)).send(await handler(request)),
      );
    }
  };
  const env = (operation: string, request: FastifyRequest) => ({
    operation,
    idempotencyKey: key(request),
    payload: request.body,
  });
  const param = (request: FastifyRequest, name: string) =>
    (request.params as Record<string, string>)[name] ?? '';

  mount('scheduling.requests.create', (r) =>
    a.createRequest(requireActor(r), env('scheduling.requests.create', r), 'staff'),
  );
  mount('scheduling.requests.list', (r) => a.listRequests(requireActor(r), { ...(r.query as object) }));
  mount('scheduling.requests.read', async (r) => ({
    data: await a.getRequest(requireActor(r), param(r, 'requestRef')),
  }));
  mount('scheduling.requests.updatePreferences', (r) =>
    a.updateRequestPreferences(
      requireActor(r),
      param(r, 'requestRef'),
      env('scheduling.requests.updatePreferences', r),
    ),
  );
  mount('scheduling.requests.review', (r) =>
    a.reviewRequest(requireActor(r), param(r, 'requestRef'), env('scheduling.requests.review', r)),
  );
  mount('scheduling.requests.close', (r) =>
    a.closeRequest(requireActor(r), param(r, 'requestRef'), env('scheduling.requests.close', r)),
  );
  mount('scheduling.requests.reopen', (r) =>
    a.reopenRequest(requireActor(r), param(r, 'requestRef'), env('scheduling.requests.reopen', r)),
  );
  mount('scheduling.requests.unbookedReport', async (r) => ({
    data: await a.unbookedRequests(requireActor(r)),
  }));
}

/** S10 booking and holds: refusals (conflict 409, denied 403/404) are thrown and mapped centrally. */
export function registerBookingRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; appointments: AppointmentService },
): void {
  const a = deps.appointments;
  const on = (operationId: string) => ({ onRequest: authenticateOnRequest(deps.authenticator, operationId) });
  const env = (operation: string, request: FastifyRequest) => ({
    operation,
    idempotencyKey: key(request),
    payload: request.body,
  });
  const param = (request: FastifyRequest, name: string) =>
    (request.params as Record<string, string>)[name] ?? '';
  const post = (operationId: string, run: (r: FastifyRequest) => Promise<unknown>) => {
    const r = routeFor(operationId);
    app.post(r.fastifyPath, on(operationId), async (request, reply) =>
      reply.code(Number(r.success.status)).send(await run(request)),
    );
  };
  post('scheduling.appointments.book', (r) =>
    a.bookAppointment(requireActor(r), env('scheduling.appointments.book', r)),
  );
  const read = routeFor('scheduling.appointments.read');
  app.get(read.fastifyPath, on(read.operationId), async (r) => ({
    data: await a.getAppointment(requireActor(r), param(r, 'appointmentRef')),
  }));
  post('scheduling.appointments.reschedule', (r) =>
    a.rescheduleAppointment(
      requireActor(r),
      param(r, 'appointmentRef'),
      env('scheduling.appointments.reschedule', r),
    ),
  );
  post('scheduling.appointments.cancel', (r) =>
    a.cancelAppointment(
      requireActor(r),
      param(r, 'appointmentRef'),
      env('scheduling.appointments.cancel', r),
    ),
  );
  post('scheduling.holds.create', (r) => a.holdSlot(requireActor(r), env('scheduling.holds.create', r)));
  post('scheduling.holds.release', (r) =>
    a.releaseHold(requireActor(r), param(r, 'holdRef'), env('scheduling.holds.release', r)),
  );
  post('scheduling.holds.reconcile', (r) =>
    a.reconcileHolds(requireActor(r), env('scheduling.holds.reconcile', r)),
  );
}

/** S11 attendance and the daily worklist. */
export function registerAttendanceRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; appointments: AppointmentService },
): void {
  const a = deps.appointments;
  const on = (operationId: string) => ({ onRequest: authenticateOnRequest(deps.authenticator, operationId) });
  const param = (request: FastifyRequest, name: string) =>
    (request.params as Record<string, string>)[name] ?? '';
  const rec = routeFor('scheduling.attendance.record');
  app.post(rec.fastifyPath, on(rec.operationId), async (r, reply) =>
    reply.code(201).send(
      await a.recordAttendance(requireActor(r), param(r, 'appointmentRef'), {
        operation: 'scheduling.attendance.record',
        idempotencyKey: key(r),
        payload: r.body,
      }),
    ),
  );
  const list = routeFor('scheduling.attendance.list');
  app.get(list.fastifyPath, on(list.operationId), async (r) => ({
    data: await a.listAttendance(requireActor(r), param(r, 'appointmentRef')),
  }));
  const status = routeFor('scheduling.attendance.visitStatus');
  app.get(status.fastifyPath, on(status.operationId), async (r) => ({
    data: await a.getVisitStatus(requireActor(r), param(r, 'appointmentRef')),
  }));
  const worklist = routeFor('scheduling.worklist.daily');
  app.get(worklist.fastifyPath, on(worklist.operationId), async (r) => ({
    data: await a.dailyWorklist(requireActor(r), { ...(r.query as object) }),
  }));
}
