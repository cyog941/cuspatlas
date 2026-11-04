import { type ActorContext, RefusalError, type TenantTransaction } from '@cuspatlas/contracts';
import { type EngagementBase, who } from '../common';
import { lockForBounds } from './requests';

/**
 * Portal abuse bounds for E4/E5 (review hardening; every number is recommended-pending-approval, the
 * practice and security owners settle them). Like E3 the counts are race-safe: the acting principal's
 * enrolment row and the patient row are locked FOR NO KEY UPDATE (after a lock-free relationship
 * pre-check, see `lockForBounds`) before anything is counted, so concurrent submissions with different
 * idempotency keys serialize and cannot both count below a cap. A refusal is 429 with the limit and
 * leaves an attempt row with its reason.
 */
export const PORTAL_OPEN_THREADS_PER_PATIENT = 10;
export const PORTAL_THREADS_PER_DAY = 30;
export const PORTAL_MESSAGES_PER_DAY = 50;
export const PORTAL_FORM_SUBMISSIONS_PER_DAY = 10;

export const limited = (reason: string, name: string, value: number) =>
  new RefusalError({
    code: 'rate_limited',
    reasonCode: 'portal_rate_limited',
    detail: { reason, limit: { name, value } },
  });

export { lockForBounds };

async function count(tx: TenantTransaction, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(sql, params);
  return rows[0]?.n ?? 0;
}

/** Messages a principal may post per 24 hours (a thread's first message counts). */
export async function boundMessages(tx: TenantTransaction): Promise<void> {
  const n = await count(
    tx,
    `SELECT count(*)::int AS n FROM cuspatlas.thread_messages
     WHERE author_id = cuspatlas.current_actor_id() AND author_kind = 'portal'
       AND created_at > now() - interval '24 hours'`,
  );
  if (n >= PORTAL_MESSAGES_PER_DAY) {
    throw limited('portal_message_rate', 'portalMessagesPerDay', PORTAL_MESSAGES_PER_DAY);
  }
}

/** Threads a principal may open per 24 hours, and open portal threads per patient. */
export async function boundThreads(tx: TenantTransaction, patientRef: string): Promise<void> {
  const open = await count(
    tx,
    `SELECT count(*)::int AS n FROM cuspatlas.message_threads
     WHERE patient_id = $1 AND opened_via = 'portal' AND state = 'open'`,
    [patientRef],
  );
  if (open >= PORTAL_OPEN_THREADS_PER_PATIENT) {
    throw limited('portal_open_thread_limit', 'portalOpenThreadsPerPatient', PORTAL_OPEN_THREADS_PER_PATIENT);
  }
  const recent = await count(
    tx,
    `SELECT count(*)::int AS n FROM cuspatlas.message_threads
     WHERE opened_by = cuspatlas.current_actor_id() AND opened_via = 'portal'
       AND created_at > now() - interval '24 hours'`,
  );
  if (recent >= PORTAL_THREADS_PER_DAY) {
    throw limited('portal_thread_rate', 'portalThreadsPerDay', PORTAL_THREADS_PER_DAY);
  }
  await boundMessages(tx);
}

/** Portal form submissions a principal may make per 24 hours. */
export async function boundFormSubmissions(tx: TenantTransaction): Promise<void> {
  const n = await count(
    tx,
    `SELECT count(*)::int AS n FROM cuspatlas.intake_submissions
     WHERE submitted_by = cuspatlas.current_actor_id() AND submitted_via = 'portal'
       AND submitted_at > now() - interval '24 hours'`,
  );
  if (n >= PORTAL_FORM_SUBMISSIONS_PER_DAY) {
    throw limited(
      'portal_form_submission_rate',
      'portalFormSubmissionsPerDay',
      PORTAL_FORM_SUBMISSIONS_PER_DAY,
    );
  }
}

/** Records the attempt row of an abuse-bound refusal (not a denial, but never silent). */
export async function recordLimited(
  base: EngagementBase,
  ctx: ActorContext,
  op: string,
  err: unknown,
): Promise<void> {
  if (err instanceof RefusalError && err.code === 'rate_limited' && !err.attemptRecorded) {
    await base.deps.recording.sink.record({ ...who(ctx, op), reasonCode: 'portal_rate_limited' });
    err.attemptRecorded = true;
  }
}
