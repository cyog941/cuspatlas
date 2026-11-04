import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  RefusalError,
  type SecurityReasonCode,
  validateEngagementEntityRef,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, withAttemptRecording } from '../commands/boundary';
import type { CommandExecutor } from '../commands/executor';
import type { ActionName, AuthorizationDecision, Authorize } from '../policy/authorize';
import type { AppointmentService } from '../scheduling/appointments';

/** Dependencies of the engagement (E) service; the same shape every other domain service takes. */
export interface EngagementDeps {
  readonly authorize: Authorize;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly recording: AttemptRecordingDeps;
  readonly execute?: CommandExecutor;
  /** S8/S10 appointment service: the one request aggregate the portal delegates to (E3). */
  readonly appointments?: AppointmentService;
  /** S4 match-key pepper: enrollment compares contact digests, never plaintext values. */
  readonly matchKeyPepper: Uint8Array;
}

export const notFound = () =>
  new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
export const conflict = (reason: string) => new RefusalError({ code: 'conflict', detail: { reason } });
export const failedAt = (pointer: string, rule: string) =>
  new RefusalError({ code: 'validation_failed', detail: { violations: [{ pointer, rule }] } });
export const forbidden = (reasonCode: SecurityReasonCode, reason?: string) =>
  new RefusalError({ code: 'forbidden', reasonCode, ...(reason ? { detail: { reason } } : {}) });

const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
export function checkEnvelope(envelope: CommandEnvelope<unknown>, operation: string): void {
  if (envelope.operation !== operation) throw new RefusalError({ code: 'invalid_request' });
  if (typeof envelope.idempotencyKey !== 'string' || !KEY.test(envelope.idempotencyKey)) {
    throw new RefusalError({
      code: 'invalid_request',
      detail: { violations: [{ pointer: '/idempotencyKey', rule: 'pattern' }] },
    });
  }
}

export function assertRef(ref: string): void {
  if (!validateEngagementEntityRef(ref)) throw notFound();
}

/** Attempt identity of a command: always the authenticated context, never caller input. */
export const who = (ctx: ActorContext, operation: string) => ({
  correlationId: ctx.correlationId,
  tenantId: ctx.tenantId,
  actorId: ctx.actorId,
  operation,
});

export interface EngagementBase {
  readonly deps: EngagementDeps;
  guarded<T>(ctx: ActorContext, operation: string, work: () => Promise<T>): Promise<T>;
  authorize(ctx: ActorContext, action: ActionName): Promise<AuthorizationDecision>;
  /** True when the caller holds the action; a refusal other than `forbidden` propagates. */
  can(ctx: ActorContext, action: ActionName): Promise<boolean>;
}

export function createEngagementBase(deps: EngagementDeps): EngagementBase {
  return {
    deps,
    guarded: (ctx, operation, work) => withAttemptRecording(deps.recording, who(ctx, operation), work),
    authorize: (ctx, action) => deps.authorize(ctx, action, { tenantId: ctx.tenantId, id: 'engagement' }),
    async can(ctx, action) {
      try {
        await deps.authorize(ctx, action, { tenantId: ctx.tenantId, id: 'engagement' });
        return true;
      } catch (err) {
        if (err instanceof RefusalError && err.code === 'forbidden') return false;
        throw err;
      }
    },
  };
}

/** Validates against an engagement schema definition (property names only in violations). */
export { assertValid };
