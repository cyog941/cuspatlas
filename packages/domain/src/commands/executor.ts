import type { ActorContext, CommandEnvelope, CommandResult, TenantTransaction } from '@cuspatlas/contracts';

/**
 * Seam for Task 5. Domain commands hand their mutation to an executor inside the tenant transaction.
 * `executeDirect` runs it once with no reservation; `executeOnce` (Task 5) plugs in with the same
 * signature to add the durable idempotency reservation, payload digest and replay reauthorization
 * in the same transaction.
 */
export type CommandExecutor = <T>(
  ctx: ActorContext,
  envelope: CommandEnvelope<unknown>,
  tx: TenantTransaction,
  handler: () => Promise<{ data: T; version: number }>,
) => Promise<CommandResult<T>>;

export const executeDirect: CommandExecutor = async (ctx, _envelope, _tx, handler) => {
  const { data, version } = await handler();
  return { data, version, correlationId: ctx.correlationId, replayed: false };
};
