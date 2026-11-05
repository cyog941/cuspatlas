import {
  type ActorContext,
  AGENTS_PROPERTIES,
  assertValid,
  type CommandEnvelope,
  type MembershipSource,
  RefusalError,
  validateAgentsIdempotencyKey,
  validateAgentsRef,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, withAttemptRecording } from '../commands/boundary';
import { executeOnce } from '../commands/execute-once';
import type { CommandExecutor } from '../commands/executor';
import { type CursorCodec, createCursorCodec } from '../cursor';
import type { ActionName, AuthorizationDecision, Authorize } from '../policy/authorize';

export interface AgentBaseDeps {
  readonly authorize: Authorize;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly recording: AttemptRecordingDeps;
  readonly execute?: CommandExecutor;
  readonly cursors?: CursorCodec;
  /** Live membership lookups of other principals (A10 proposer and approver rechecks). */
  readonly memberships?: MembershipSource;
}

/**
 * Shared plumbing of workstream A batch 2 services: authorization first (inside the attempt
 * boundary), then validation, then the tenant transaction; the tenant always comes from the context.
 */
export function createAgentBase(deps: AgentBaseDeps) {
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
    authorize(ctx: ActorContext, action: ActionName, id = 'agents'): Promise<AuthorizationDecision> {
      return deps.authorize(ctx, action, { tenantId: ctx.tenantId, id });
    },
    /** Offset page of a list (OR-01): limit default 25, max 100; the cursor is tenant-bound. */
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
export type AgentBase = ReturnType<typeof createAgentBase>;

export const notFound = () =>
  new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
export const failed = (reason: string, pointer?: string) =>
  new RefusalError({
    code: 'validation_failed',
    detail: pointer ? { reason, violations: [{ pointer, rule: reason }] } : { reason },
  });
export const conflict = (reason: string, blockingRefs?: readonly { kind: string; ref: string }[]) =>
  new RefusalError({
    code: 'conflict',
    detail: blockingRefs?.length ? { reason, blockingRefs } : { reason },
  });
export const stale = (currentVersion: number) =>
  new RefusalError({ code: 'stale_version', detail: { currentVersion } });

export function checkEnvelope(envelope: CommandEnvelope<unknown>, operation: string): void {
  if (envelope.operation !== operation) throw new RefusalError({ code: 'invalid_request' });
  assertValid(validateAgentsIdempotencyKey, envelope.idempotencyKey, new Set(['idempotencyKey']));
}

export function validate<T>(fn: Parameters<typeof assertValid>[0], value: unknown): asserts value is T {
  assertValid<T>(fn, value, AGENTS_PROPERTIES);
}

export function assertRef(ref: unknown): asserts ref is string {
  if (typeof ref !== 'string' || !validateAgentsRef(ref)) throw notFound();
}

export const pgCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null ? ((err as { code?: string }).code ?? undefined) : undefined;
