import { randomUUID } from 'node:crypto';
import type { ActorContext, MembershipSource } from '@cuspatlas/contracts';
import type { AgentService, AgentToolInvoker, Authorize } from '@cuspatlas/domain';

/**
 * A23 scheduled agent tasks. Per tenant, under the worker's own service principal: claim the due tasks
 * of the invoker's MCP deployment (the domain rechecks each task's standing policy and the agent, and
 * stops a task whose policy is revoked or expired), then run each claim AS THE AGENT through the MCP
 * tool path (consent, budget, argument validation and authorization, exactly as an interactive call),
 * with the agent's live membership reloaded first, and record the outcome. The worker never calls a
 * domain handler directly for an agent.
 */
export interface AgentTaskRunnerDeps {
  readonly workerPrincipalId: string;
  readonly authorize: Authorize;
  readonly memberships: MembershipSource;
  readonly agents: Pick<AgentService, 'claimDueAgentTasks' | 'finishAgentTaskRun'>;
  readonly invoker: AgentToolInvoker;
}

export interface AgentTaskOutcome {
  readonly taskRef: string;
  readonly outcome: string;
}

export function createAgentTaskRunner(deps: AgentTaskRunnerDeps) {
  const workerCtx = (tenantId: string): ActorContext => ({
    tenantId,
    actorId: deps.workerPrincipalId,
    principal: 'service',
    sessionId: randomUUID(),
    scopes: ['outbox.deliver'],
    correlationId: randomUUID(),
  });
  return {
    async runDue(tenantId: string, limit = 20): Promise<AgentTaskOutcome[]> {
      const ctx = workerCtx(tenantId);
      await deps.authorize(ctx, 'agents.tasks.dispatch', { tenantId, id: 'agentTasks' });
      const { claims, settled } = await deps.agents.claimDueAgentTasks(ctx, deps.invoker.deployment, limit);
      const out: AgentTaskOutcome[] = [...settled];
      for (const c of claims) {
        let outcome: string;
        const m = await deps.memberships.load(c.agentRef, tenantId);
        if (!m?.active || !m.agent) {
          outcome = 'agent_inactive';
        } else {
          const actor: ActorContext = {
            tenantId,
            actorId: c.agentRef,
            principal: 'service',
            sessionId: m.agent.credentialRef,
            scopes: m.scopes,
            correlationId: c.correlationId,
            agent: { agentRef: m.agent.agentRef, sponsorRef: m.agent.sponsorRef },
          };
          try {
            outcome = (await deps.invoker.invoke(actor, c.operation, c.arguments)).code;
          } catch {
            outcome = 'failed';
          }
        }
        await deps.agents.finishAgentTaskRun(ctx, c.runRef, outcome);
        out.push({ taskRef: c.taskRef, outcome });
      }
      return out;
    },
  };
}
export type AgentTaskRunner = ReturnType<typeof createAgentTaskRunner>;
