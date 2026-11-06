import type { ActorContext, CommandEnvelope, CommandResult, TenantTransaction } from '@cuspatlas/contracts';

/**
 * Domain commands hand their mutation to an executor inside the tenant transaction. The default is
 * the durable `executeOnce` (./execute-once.ts). `executeDirect` runs the handler once with no
 * reservation and exists only for tests that need to observe or fault the handler.
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
