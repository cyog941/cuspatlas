import { type AgentBaseDeps, createAgentBase } from './base';
import { createAgentPrincipals } from './principals';

export * from './codecs';
export { AGENT_RESOURCE } from './principals';

export type AgentServiceDeps = AgentBaseDeps;

/** Workstream A batch 2 services (A8-A13) over one base; REST, MCP and tests call these functions. */
export function createAgentService(deps: AgentServiceDeps) {
  const base = createAgentBase(deps);
  return { ...createAgentPrincipals(base) };
}
export type AgentService = ReturnType<typeof createAgentService>;
