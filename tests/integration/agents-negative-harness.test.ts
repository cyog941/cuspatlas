import { AGENT_OPS } from '@cuspatlas/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentHandle, type AgentStack, startAgentStack } from './support/agent-stack';
import { T_ALPHA } from './support/fixtures';

/**
 * Workstream A batch 2 negative harness (A8-A13): every operation of the AGENT_OPS table is listed
 * here by id and tool with the principal classes it admits, and each is refused for a staff caller
 * without the scope, for a principal kind it excludes, for an agent credential on REST, and (for
 * human-only operations) for an agent on MCP. Agents can never manage agents, approve proposals,
 * review or accept AI drafts, or submit prescriptions. Synthetic data only.
 */
type Admits = 'human' | 'humanAndService';
const CASES: Record<string, { tool: string; admits: Admits }> = {
  'agents.principals.create': { tool: 'agents_principals_create', admits: 'human' },
  'agents.principals.suspend': { tool: 'agents_principals_suspend', admits: 'human' },
  'agents.principals.resume': { tool: 'agents_principals_resume', admits: 'human' },
  'agents.principals.revoke': { tool: 'agents_principals_revoke', admits: 'human' },
  'agents.credentials.rotate': { tool: 'agents_credentials_rotate', admits: 'human' },
  'agents.sponsors.change': { tool: 'agents_sponsors_change', admits: 'human' },
  'agents.principals.read': { tool: 'agents_principals_get', admits: 'humanAndService' },
  'agents.principals.list': { tool: 'agents_principals_list', admits: 'human' },
  'agents.audit.list': { tool: 'agents_audit_list', admits: 'human' },
  'agents.consents.record': { tool: 'agents_consents_record', admits: 'human' },
  'agents.consents.revoke': { tool: 'agents_consents_revoke', admits: 'human' },
  'agents.consents.list': { tool: 'agents_consents_list', admits: 'human' },
  'agents.budgets.read': { tool: 'agents_budgets_get', admits: 'humanAndService' },
};

let s: AgentStack;
let agent: AgentHandle;

beforeAll(async () => {
  s = await startAgentStack('agents_negative_harness');
  agent = await s.createAgent(['syntheticTasks.read', 'agents.read']);
}, 120_000);
afterAll(async () => {
  await s?.close();
});

const restOf = (op: (typeof AGENT_OPS)[number]) => ({
  method: op.method === 'get' ? 'GET' : 'POST',
  url: op.path,
});

describe('workstream A batch 2 negative harness', () => {
  it('names every AGENT_OPS operation with its tool and admitted principals', () => {
    expect(Object.keys(CASES).sort()).toStrictEqual(AGENT_OPS.map((o) => o.operationId).sort());
    for (const op of AGENT_OPS) expect(CASES[op.operationId]?.tool, op.operationId).toBe(op.tool);
  });

  it('a staff member without the scope is refused on REST and MCP alike', async () => {
    for (const op of AGENT_OPS) {
      const { method, url } = restOf(op);
      const r = await s.call('humanNone', method as 'GET' | 'POST', url, {});
      expect(r.status, op.operationId).toBe(403);
      const m = await s.mcp('humanNone', op.tool, {});
      expect(m.code, op.operationId).toBe('forbidden');
    }
  });

  it('a service principal is refused every human-only operation', async () => {
    for (const op of AGENT_OPS.filter((o) => CASES[o.operationId]?.admits === 'human')) {
      const { method, url } = restOf(op);
      expect((await s.call('serviceAll', method as 'GET' | 'POST', url, {})).status, op.operationId).toBe(
        403,
      );
      expect((await s.mcp('serviceAll', op.tool, {})).code, op.operationId).toBe('forbidden');
    }
  });

  it('an agent credential is refused on REST for every operation', async () => {
    const tok = await s.issuer.issue({ sub: agent.agentRef, tid: T_ALPHA, sid: agent.credentialRef });
    for (const op of AGENT_OPS) {
      const { method, url } = restOf(op);
      const r = await s.rest(tok, method as 'GET' | 'POST', url, {});
      expect(r.statusCode, op.operationId).toBe(403);
    }
  });

  it('an agent on MCP is refused every human-only operation', async () => {
    const client = await s.agentClient(agent.agentRef, agent.credentialRef);
    for (const op of AGENT_OPS.filter((o) => CASES[o.operationId]?.admits === 'human')) {
      const r = await s.agentCall(client, op.tool, {});
      expect(r.isError, op.operationId).toBe(true);
      expect(r.body.code, op.operationId).toBe('forbidden');
    }
  });

  it('another tenant cannot see an agent; hidden and missing are one 404', async () => {
    const other = await s.call('humanBeta', 'GET', `/v1/agents/principals/state?agentRef=${agent.agentRef}`);
    const missing = await s.call(
      'humanAll',
      'GET',
      '/v1/agents/principals/state?agentRef=00000000-0000-4000-8000-000000000000',
    );
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(other.body.code).toBe(missing.body.code);
  });
});
