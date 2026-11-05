import {
  type ActorContext,
  AUTOMATION_PROPERTIES,
  assertValid,
  type CommandEnvelope,
  RefusalError,
  validateAutomationIdempotencyKey,
  validateAutomationRef,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, withAttemptRecording } from '../commands/boundary';
import { executeOnce } from '../commands/execute-once';
import type { CommandExecutor } from '../commands/executor';
import { type CursorCodec, createCursorCodec } from '../cursor';
import type { ActionName, AuthorizationDecision, Authorize } from '../policy/authorize';

export interface AutomationBaseDeps {
  readonly env: string;
  readonly authorize: Authorize;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly recording: AttemptRecordingDeps;
  readonly execute?: CommandExecutor;
  readonly cursors?: CursorCodec;
}

/**
 * Shared plumbing of the A14/A15 automation service: authorization first (inside the attempt
 * boundary), then validation, then the tenant transaction. Webhook and export administration is
 * tenant-wide: a location-restricted membership is refused, because events and exports span locations.
 */
export function createAutomationBase(deps: AutomationBaseDeps) {
  const cursors = deps.cursors ?? createCursorCodec();
  return {
    deps,
    execute: deps.execute ?? executeOnce,
    guarded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T> {
      return withAttemptRecording(
        deps.recording,
        { correlationId: ctx.correlationId, tenantId: ctx.tenantId, actorId: ctx.actorId, operation },
        work,
      );
    },
    async tenantWide(ctx: ActorContext, action: ActionName, id: string): Promise<AuthorizationDecision> {
      const decision = await deps.authorize(ctx, action, { tenantId: ctx.tenantId, id });
      if (decision.locationRefs !== null)
        throw new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });
      return decision;
    },
    page(ctx: ActorContext, q: { limit?: number; cursor?: string }) {
      const limit = q.limit ?? 25;
      const offset = q.cursor === undefined ? 0 : Number(cursors.decode(ctx.tenantId, q.cursor));
      if (!Number.isInteger(offset) || offset < 0) throw new RefusalError({ code: 'invalid_request' });
      return {
        limit,
        offset,
        next: (count: number, total: number) =>
          offset + count < total ? cursors.encode(ctx.tenantId, String(offset + count)) : null,
      };
    },
  };
}
export type AutomationBase = ReturnType<typeof createAutomationBase>;

export const notFound = () =>
  new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
export const failed = (reason: string) => new RefusalError({ code: 'validation_failed', detail: { reason } });
export const conflict = (reason: string, blockingRefs?: readonly { kind: string; ref: string }[]) =>
  new RefusalError({
    code: 'conflict',
    detail: blockingRefs?.length ? { reason, blockingRefs } : { reason },
  });
export const unavailable = () => new RefusalError({ code: 'service_unavailable', retryable: true });

export function checkEnvelope(envelope: CommandEnvelope<unknown>, operation: string): void {
  if (envelope.operation !== operation) throw new RefusalError({ code: 'invalid_request' });
  assertValid(validateAutomationIdempotencyKey, envelope.idempotencyKey, new Set(['idempotencyKey']));
}

export function validate<T>(fn: Parameters<typeof assertValid>[0], value: unknown): asserts value is T {
  assertValid<T>(fn, value, AUTOMATION_PROPERTIES);
}

export function assertRef(ref: string): void {
  if (!validateAutomationRef(ref)) throw notFound();
}

export const isPgError = (err: unknown, code: string) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
