import { type AiDeps, createAiPipeline } from './ai';
import { type AgentBaseDeps, createAgentBase } from './base';
import { createAiEvaluations, evaluationGate } from './eval';
import { createAgentGovernance } from './governance';
import { createAgentPrincipals } from './principals';
import { createActionProposals, type ProposalOwners } from './proposals';

export {
  AI_DRAFT_RESOURCE,
  type AiDeps,
  type AiOwners,
  type AiSourceReaders,
  createAiSourceReaders,
  minimize,
} from './ai';
export * from './ai-port';
export * from './codecs';
export { AI_EVAL_CASE_SETS, AI_EVAL_THRESHOLDS, type EvalCase, evaluationGate, runEvaluation } from './eval';
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
  /** A11: model adapter (synthetic only), source readers and owning commands. */
  readonly ai?: AiDeps;
};

/** Workstream A batch 2 services (A8-A13) over one base; REST, MCP and tests call these functions. */
export function createAgentService(deps: AgentServiceDeps) {
  const base = createAgentBase(deps);
  return {
    ...createAgentPrincipals(base),
    ...createAgentGovernance(base),
    ...createActionProposals(base, deps.owners ?? {}),
    // A12: the evaluation gate of record guards enabling and running every use case.
    ...createAiPipeline(base, {
      gate: evaluationGate,
      ...(deps.ai ?? { model: null, readers: null, owners: {} }),
    }),
    ...createAiEvaluations(base, deps.ai?.model ?? null),
  };
}
export type AgentService = ReturnType<typeof createAgentService>;
