import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  ENGAGEMENT_PROPERTIES,
  RefusalError,
  validatePortalOfferRespond,
} from '@cuspatlas/contracts';
import { checkEnvelope, type EngagementBase, notFound } from '../common';
import { requirePortalAccess } from './access';

/**
 * The S15 seam implemented on the portal side: the patient (or a guardian or proxy holding
 * `scheduling` for them) accepts or declines a waitlist offer through S's own `respondToOffer` with a
 * portal authority. Acceptance books through S10's insert path from the hold, exactly as a staff
 * acceptance; a service principal never answers an offer and only staff withdraw one. The offer must
 * belong to the patient the portal route names: anything else is the same 404 as a missing offer.
 */
export function createPortalOfferOperations(base: EngagementBase) {
  const { deps } = base;
  return {
    respondToPortalOffer(
      ctx: ActorContext,
      patientRef: string,
      offerRef: string,
      envelope: CommandEnvelope<unknown>,
    ) {
      const op = 'portal.offers.respond';
      return base.guarded(ctx, op, async () => {
        checkEnvelope(envelope, op);
        assertValid(validatePortalOfferRespond, envelope.payload, ENGAGEMENT_PROPERTIES);
        if (!deps.appointments) {
          throw new RefusalError({
            code: 'service_unavailable',
            retryable: true,
            detail: { reason: 'aggregate_unavailable' },
          });
        }
        const p = envelope.payload as { expectedVersion: number; outcome: 'accepted' | 'declined' };
        return deps.appointments.respondToOffer(
          ctx,
          offerRef,
          {
            operation: 'scheduling.waitlist.respond',
            idempotencyKey: envelope.idempotencyKey,
            payload: {
              expectedVersion: p.expectedVersion,
              outcome: p.outcome,
              ...(p.outcome === 'declined' ? { reasonCode: 'patient_declined' } : {}),
            },
          },
          {
            authorize: async (tx, offerPatient) => {
              if (offerPatient !== patientRef) throw notFound();
              await requirePortalAccess(tx, patientRef, ['scheduling']);
            },
          },
        );
      });
    },
  };
}
