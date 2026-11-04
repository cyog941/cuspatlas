import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  ENGAGEMENT_PROPERTIES,
  type PortalRequestSubmit,
  RefusalError,
  type RequestCommandData,
  type TenantTransaction,
  validateEngagementEntityRef,
  validatePortalRequestSubmit,
} from '@cuspatlas/contracts';
import { checkEnvelope, type EngagementBase, who } from '../common';
import { mayContendFor, requirePortalAccess } from './access';

/**
 * E3: portal appointment requests are S8 requests. This module validates the closed portal input,
 * maps it onto S8's create payload (source channel `portal`, the path patient) and calls S8's own
 * create command with origin `portal` and the portal authority (E1 check for `scheduling`, plus abuse
 * bounds). There is no second request table and no portal path that books.
 *
 * Abuse bounds (recommended-pending-approval): at most 3 open or in-review portal requests per
 * patient and at most 10 portal submissions per principal in 24 hours; refused 429 with the limit.
 */
export const PORTAL_OPEN_REQUESTS_PER_PATIENT = 3;
export const PORTAL_SUBMISSIONS_PER_DAY = 10;

const limited = (reason: string, name: string, value: number) =>
  new RefusalError({
    code: 'rate_limited',
    reasonCode: 'portal_rate_limited',
    detail: { reason, limit: { name, value } },
  });

/**
 * Serializes the abuse-bound check of concurrent submissions (review hardening): the acting
 * principal's enrolment row (per-principal daily cap) and the patient row (per-patient open cap) are
 * locked FOR NO KEY UPDATE before anything share-locks them, so two submissions with different keys
 * cannot both count below the cap. Taken in the authorize hook (before the portal check share-locks
 * the principal) to avoid a share-to-update upgrade between concurrent submissions.
 *
 * Order (review hardening): a lock-free relationship pre-check first, so a principal with no
 * connection to the patient never takes (or waits on) a lock on that patient's row; then the locks;
 * then the caller rechecks authority in full (`requirePortalAccess`) with the locks held.
 */
export async function lockForBounds(tx: TenantTransaction, patientRef: string): Promise<void> {
  await tx.query(
    'SELECT 1 FROM cuspatlas.portal_principals WHERE principal_id = cuspatlas.current_actor_id() FOR NO KEY UPDATE',
  );
  if (validateEngagementEntityRef(patientRef) && (await mayContendFor(tx, patientRef))) {
    await tx.query('SELECT 1 FROM cuspatlas.patients WHERE id = $1 FOR NO KEY UPDATE', [patientRef]);
  }
}

async function bound(tx: TenantTransaction, patientRef: string): Promise<void> {
  const open = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM cuspatlas.appointment_requests
     WHERE subject_patient_id = $1 AND origin = 'portal' AND state IN ('open', 'in_review')`,
    [patientRef],
  );
  if ((open.rows[0]?.n ?? 0) >= PORTAL_OPEN_REQUESTS_PER_PATIENT) {
    throw limited(
      'portal_open_request_limit',
      'portalOpenRequestsPerPatient',
      PORTAL_OPEN_REQUESTS_PER_PATIENT,
    );
  }
  const recent = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM cuspatlas.appointment_requests
     WHERE created_by = cuspatlas.current_actor_id() AND origin = 'portal' AND created_at > now() - interval '24 hours'`,
  );
  if ((recent.rows[0]?.n ?? 0) >= PORTAL_SUBMISSIONS_PER_DAY) {
    throw limited('portal_submission_rate', 'portalSubmissionsPerDay', PORTAL_SUBMISSIONS_PER_DAY);
  }
}

export function createPortalRequestOperations(base: EngagementBase) {
  const { deps } = base;
  return {
    submitPortalRequest(
      ctx: ActorContext,
      patientRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<RequestCommandData>> {
      const op = 'portal.requests.submit';
      return base.guarded(ctx, op, async () => {
        checkEnvelope(envelope, op);
        assertValid<PortalRequestSubmit>(
          validatePortalRequestSubmit,
          envelope.payload,
          ENGAGEMENT_PROPERTIES,
        );
        if (!deps.appointments) {
          throw new RefusalError({
            code: 'service_unavailable',
            retryable: true,
            detail: { reason: 'aggregate_unavailable' },
          });
        }
        const p = envelope.payload;
        const payload = {
          patientRef,
          locationRef: p.locationRef,
          sourceChannel: 'portal',
          contactConsent: p.contactConsent,
          ...(p.appointmentTypeCode === undefined ? {} : { appointmentTypeCode: p.appointmentTypeCode }),
          ...(p.providerPreference === undefined ? {} : { providerPreference: p.providerPreference }),
          ...(p.preferredWindows === undefined ? {} : { preferredWindows: p.preferredWindows }),
          ...(p.flexibility === undefined ? {} : { flexibility: p.flexibility }),
        };
        try {
          return await deps.appointments.createRequest(
            ctx,
            { operation: 'scheduling.requests.create', idempotencyKey: envelope.idempotencyKey, payload },
            'portal',
            {
              authorize: async (tx, ref) => {
                await lockForBounds(tx, ref);
                await requirePortalAccess(tx, ref, ['scheduling']);
              },
              bound,
            },
          );
        } catch (err) {
          // Abuse-bound refusals are not denials, but they leave an attempt row with their reason.
          if (err instanceof RefusalError && err.code === 'rate_limited' && !err.attemptRecorded) {
            await deps.recording.sink.record({ ...who(ctx, op), reasonCode: 'portal_rate_limited' });
            err.attemptRecorded = true;
          }
          throw err;
        }
      });
    },
  };
}
