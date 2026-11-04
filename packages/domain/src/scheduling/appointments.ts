import type { ActorContext, CommandEnvelope, TenantTransaction } from '@cuspatlas/contracts';
import { createAppointmentBase } from './appointment-base';
import { createRequestOperations, type LinkHook } from './requests';
import { notFound, type SchedulingDeps } from './resources';

/**
 * The appointment service: S8 requests (S10 booking and S11 attendance join it). The only
 * command/query layer for these tables; REST and MCP call these functions, none of which takes a
 * tenant from its input.
 */
export function createAppointmentService(deps: SchedulingDeps) {
  const base = createAppointmentBase(deps);
  // No booking exists before S10; a link names an appointment that cannot exist yet.
  const link: LinkHook = async () => {
    throw notFound();
  };
  const requests = createRequestOperations(base, link);
  const bookingStillActive = async (_tx: TenantTransaction, _appointmentId: string) => false;
  return {
    ...requests,
    reopenRequest: (ctx: ActorContext, requestRef: string, envelope: CommandEnvelope<unknown>) =>
      requests.reopenRequest(ctx, requestRef, envelope, bookingStillActive),
  };
}

export type AppointmentService = ReturnType<typeof createAppointmentService>;
