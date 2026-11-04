import type { ActorContext, CommandEnvelope, TenantTransaction } from '@cuspatlas/contracts';
import { createAppointmentBase } from './appointment-base';
import { bookingAttendanceGuard, createAttendanceOperations } from './attendance';
import { createBookingOperations, loadAppointment } from './booking';
import { createRequestOperations, type LinkHook, linkRequestToBookingIn } from './requests';
import type { SchedulingDeps } from './resources';

/**
 * The appointment service: S8 requests, S10 booking and S11 attendance. The only
 * command/query layer for these tables; REST and MCP call these functions, none of which takes a
 * tenant from its input.
 */
export function createAppointmentService(deps: SchedulingDeps) {
  const base = createAppointmentBase(deps);
  // close(scheduled) links an existing booking: both records carry the link afterwards.
  const link: LinkHook = async (tx, decision, request, appointmentRef, reasonCode, operation) => {
    const appt = await loadAppointment(tx, decision, appointmentRef, 'FOR UPDATE OF a');
    const version = await linkRequestToBookingIn(tx, operation, request, appt, reasonCode);
    if (appt.request_id === null) {
      await tx.query(
        `INSERT INTO cuspatlas.appointment_lifecycle_events (tenant_id, appointment_id, kind, reason_code,
           appointment_version, actor_id)
         VALUES (cuspatlas.current_tenant_id(), $1, 'request_linked', $2, $3, cuspatlas.current_actor_id())`,
        [appt.id, reasonCode, appt.version + 1],
      );
    }
    return version;
  };
  const requests = createRequestOperations(base, link);
  const booking = createBookingOperations(base);
  const attendance = createAttendanceOperations(base);
  const bookingStillActive = async (tx: TenantTransaction, appointmentId: string) => {
    const { rows } = await tx.query<{ status: string }>(
      'SELECT status FROM cuspatlas.appointments WHERE id = $1',
      [appointmentId],
    );
    return rows[0]?.status === 'booked';
  };
  return {
    ...requests,
    ...booking,
    ...attendance,
    reopenRequest: (ctx: ActorContext, requestRef: string, envelope: CommandEnvelope<unknown>) =>
      requests.reopenRequest(ctx, requestRef, envelope, bookingStillActive),
    rescheduleAppointment: (ctx: ActorContext, appointmentRef: string, envelope: CommandEnvelope<unknown>) =>
      booking.rescheduleAppointment(ctx, appointmentRef, envelope, (tx, id, reason) =>
        bookingAttendanceGuard(tx, 'scheduling.appointments.reschedule', id, 'rescheduled', reason),
      ),
    cancelAppointment: (ctx: ActorContext, appointmentRef: string, envelope: CommandEnvelope<unknown>) =>
      booking.cancelAppointment(ctx, appointmentRef, envelope, (tx, id, reason) =>
        bookingAttendanceGuard(tx, 'scheduling.appointments.cancel', id, 'cancelled', reason),
      ),
  };
}

export type AppointmentService = ReturnType<typeof createAppointmentService>;
