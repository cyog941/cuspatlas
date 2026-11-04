import {
  type ActorContext,
  isRefusalError,
  type RefusalCode,
  RefusalError,
  type SecurityReasonCode,
} from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, withAttemptRecording } from '../commands/boundary';
import { executeOnce } from '../commands/execute-once';
import type { CommandExecutor } from '../commands/executor';
import type { ActionName, AuthorizationDecision } from '../policy/authorize';
import { createSchedulingCursorCodec, type SchedulingCursorCodec } from './cursor';
import { notFound, type SchedulingDeps } from './resources';

/**
 * Shared plumbing of the appointment service (S8 requests, S10 booking, S11 attendance). Each
 * operation is guarded by the attempt boundary; authorization runs before validation and before
 * the tenant transaction, so a replay is reauthorized and no second pool connection is needed.
 */
export interface AppointmentBase {
  readonly deps: SchedulingDeps;
  readonly execute: CommandExecutor;
  readonly cursors: SchedulingCursorCodec;
  guarded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T>;
  /** Like `guarded`, but every typed refusal (conflict too) leaves a security attempt row. */
  recorded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T>;
  authorize(ctx: ActorContext, action: ActionName): Promise<AuthorizationDecision>;
  /** True when the caller holds `action` now; a probe never records an attempt by itself. */
  can(ctx: ActorContext, action: ActionName): Promise<boolean>;
}

/** Attempt reason of a booking-path refusal that carries no explicit internal reason. */
const BOOKING_REASON: Partial<Record<RefusalCode, SecurityReasonCode>> = {
  unauthenticated: 'token_invalid',
  forbidden: 'scope_missing',
  not_found: 'resource_hidden_or_missing',
  conflict: 'booking_conflict',
  stale_version: 'stale_version',
  invalid_request: 'request_invalid',
  validation_failed: 'request_invalid',
  idempotency_conflict: 'idempotency_conflict',
};

export function createAppointmentBase(deps: SchedulingDeps): AppointmentBase {
  const who = (ctx: ActorContext, operation: string) => ({
    correlationId: ctx.correlationId,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    operation,
  });
  const recording: AttemptRecordingDeps = deps.recording;
  const authorize = (ctx: ActorContext, action: ActionName) =>
    deps.authorize(ctx, action, { tenantId: ctx.tenantId, id: 'scheduling' });
  return {
    deps,
    execute: deps.execute ?? executeOnce,
    cursors: deps.cursors ?? createSchedulingCursorCodec(),
    guarded: (ctx, operation, work) => withAttemptRecording(recording, who(ctx, operation), work),
    async recorded(ctx, operation, work) {
      try {
        return await work();
      } catch (err) {
        if (!isRefusalError(err) || err.attemptRecorded || err.code === 'service_unavailable') throw err;
        try {
          await recording.sink.record({
            ...who(ctx, operation),
            reasonCode: err.reasonCode ?? BOOKING_REASON[err.code] ?? 'booking_refused',
          });
          err.attemptRecorded = true;
        } catch {
          recording.alert('security_attempt_sink_unavailable');
          const unavailable = new RefusalError({ code: 'service_unavailable', retryable: true });
          unavailable.attemptRecorded = true;
          throw unavailable;
        }
        throw err;
      }
    },
    authorize,
    async can(ctx, action) {
      try {
        await authorize(ctx, action);
        return true;
      } catch (err) {
        if (err instanceof RefusalError && err.code === 'forbidden') return false;
        throw err;
      }
    },
  };
}

/**
 * Location visibility for records that carry a location: a caller restricted to other locations
 * cannot tell such a record from a missing one (404), so a reference never confirms existence.
 */
export function assertVisibleLocation(decision: AuthorizationDecision, locationRef: string): void {
  if (decision.locationRefs !== null && !decision.locationRefs.includes(locationRef)) throw notFound();
}

export const limitOf = (raw: string | undefined, fallback = 25) =>
  raw === undefined ? fallback : Number(raw);
