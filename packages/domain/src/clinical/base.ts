import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type RefusalDetail,
  RefusalError,
  validateClinicalIdempotencyKey,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, withAttemptRecording } from '../commands/boundary';
import { executeOnce } from '../commands/execute-once';
import type { CommandExecutor } from '../commands/executor';
import { type CursorCodec, createCursorCodec } from '../cursor';
import type { ActionName, AuthorizationDecision, Authorize } from '../policy/authorize';

/**
 * Dependencies of the clinical service (C5, C8). The same shape as every other domain service: one
 * policy layer (`authorize`), runtime-role tenant transactions, the independent attempt sink and the
 * durable executor. Nothing here takes a tenant from caller input.
 */
export interface ClinicalDeps {
  readonly authorize: Authorize;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly recording: AttemptRecordingDeps;
  /** Defaults to the durable executeOnce; tests may inject a different executor. */
  readonly execute?: CommandExecutor;
  /** Defaults to a per-process random HMAC key. */
  readonly cursors?: CursorCodec;
}

export interface ClinicalBase {
  readonly deps: ClinicalDeps;
  readonly execute: CommandExecutor;
  readonly cursors: CursorCodec;
  /** Attempt boundary: a denial (401/403/404) leaves a security attempt row after rollback. */
  guarded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T>;
  authorize(ctx: ActorContext, action: ActionName): Promise<AuthorizationDecision>;
}

export function createClinicalBase(deps: ClinicalDeps): ClinicalBase {
  return {
    deps,
    execute: deps.execute ?? executeOnce,
    cursors: deps.cursors ?? createCursorCodec(),
    guarded: (ctx, operation, work) =>
      withAttemptRecording(
        deps.recording,
        { correlationId: ctx.correlationId, tenantId: ctx.tenantId, actorId: ctx.actorId, operation },
        work,
      ),
    authorize: (ctx, action) => deps.authorize(ctx, action, { tenantId: ctx.tenantId, id: 'clinical' }),
  };
}

export const notFound = () =>
  new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
export const failedAt = (pointer: string, rule: string) =>
  new RefusalError({ code: 'validation_failed', detail: { violations: [{ pointer, rule }] } });
export const conflict = (reason: string, extra: Omit<RefusalDetail, 'reason'> = {}) =>
  new RefusalError({ code: 'conflict', detail: { reason, ...extra } });

/** The envelope must name the operation it is sent to, and carry a well-formed key (checked after authorization). */
export function checkEnvelope(envelope: CommandEnvelope<unknown>, operation: string): void {
  if (envelope.operation !== operation) throw new RefusalError({ code: 'invalid_request' });
  assertValid(validateClinicalIdempotencyKey, envelope.idempotencyKey, new Set(['idempotencyKey']));
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const limitOf = (raw: string | undefined, fallback = 25) =>
  raw === undefined ? fallback : Number(raw);
