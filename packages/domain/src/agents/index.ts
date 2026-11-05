import { type AgentBaseDeps, createAgentBase } from './base';
import { createAgentGovernance } from './governance';
import { createAgentPrincipals } from './principals';
import { createActionProposals, type ProposalOwners } from './proposals';

export * from './codecs';
export { AGENT_CONSENT_RESOURCE, type BudgetTicket, measureResult } from './governance';
export { AGENT_RESOURCE } from './principals';
export {
  ACTION_PROPOSAL_POLICY_VERSION,
  ACTION_PROPOSAL_TTL_SECONDS,
  ELEVATED_OPERATION_NAMES,
  type ProposalOwners,
} from './proposals';

export type AgentServiceDeps = AgentBaseDeps & {
  /** A10: the owning services an approved proposal commits through (absent: 503 at commit). */
  readonly owners?: ProposalOwners;
};

/** Workstream A batch 2 services (A8-A13) over one base; REST, MCP and tests call these functions. */
export function createAgentService(deps: AgentServiceDeps) {
  const base = createAgentBase(deps);
  return {
    ...createAgentPrincipals(base),
    ...createAgentGovernance(base),
    ...createActionProposals(base, deps.owners ?? {}),
  };
}
export type AgentService = ReturnType<typeof createAgentService>;
