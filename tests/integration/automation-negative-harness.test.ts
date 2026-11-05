import { AUTOMATION_OPS } from '@cuspatlas/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentHandle, type AgentStack, startAgentStack } from './support/agent-stack';
import { T_ALPHA } from './support/fixtures';

/**
 * Workstream A batch 4 negative harness (A14 webhooks, A15 exports): every operation of the
 * AUTOMATION_OPS table is listed here by id and tool with the principal classes it admits, and each is
 * refused for a staff caller without the scope, for a principal kind it excludes, for an agent
 * credential on REST, and (for human-only operations) for an agent on MCP. Agents can never register
 * or revoke a subscription, rotate a secret, replay a delivery, or request, grant or download an
 * export. Synthetic data only.
 */
type Admits = 'human' | 'humanAndService';
const CASES: Record<string, { tool: string; admits: Admits }> = {
  'webhooks.eventTypes.list': { tool: 'webhooks_event_types_list', admits: 'humanAndService' },
  'webhooks.subscriptions.create': { tool: 'webhooks_subscriptions_create', admits: 'human' },
  'webhooks.subscriptions.list': { tool: 'webhooks_subscriptions_list', admits: 'humanAndService' },
  'webhooks.subscriptions.rotateSecret': { tool: 'webhooks_subscriptions_rotate_secret', admits: 'human' },
  'webhooks.subscriptions.revoke': { tool: 'webhooks_subscriptions_revoke', admits: 'human' },
  'webhooks.deliveries.list': { tool: 'webhooks_deliveries_list', admits: 'humanAndService' },
  'webhooks.deliveries.failures.list': {
    tool: 'webhooks_deliveries_failures_list',
    admits: 'humanAndService',
  },
  'webhooks.deliveries.replay': { tool: 'webhooks_deliveries_replay', admits: 'human' },
  'exports.create': { tool: 'exports_create', admits: 'human' },
  'exports.list': { tool: 'exports_list', admits: 'humanAndService' },
  'exports.read': { tool: 'exports_read', admits: 'humanAndService' },
  'exports.grant': { tool: 'exports_grant', admits: 'human' },
  'exports.download': { tool: 'exports_download', admits: 'human' },
};

let s: AgentStack;
let agent: AgentHandle;

beforeAll(async () => {
  s = await startAgentStack('automation_negative_harness');
  agent = await s.createAgent(['syntheticTasks.read', 'webhooks.read']);
}, 120_000);
afterAll(async () => {
  await s?.close();
});

const restOf = (op: (typeof AUTOMATION_OPS)[number]) => ({
  method: (op.method === 'get' ? 'GET' : 'POST') as 'GET' | 'POST',
  url: op.path,
});

describe('workstream A batch 4 negative harness', () => {
  it('names every AUTOMATION_OPS operation with its tool and admitted principals', () => {
    expect(Object.keys(CASES).sort()).toStrictEqual(AUTOMATION_OPS.map((o) => o.operationId).sort());
    for (const op of AUTOMATION_OPS) expect(CASES[op.operationId]?.tool, op.operationId).toBe(op.tool);
  });

  it('a staff member without the scope is refused on REST and MCP alike', async () => {
    for (const op of AUTOMATION_OPS) {
      const { method, url } = restOf(op);
      expect((await s.call('humanNone', method, url, {})).status, op.operationId).toBe(403);
      expect((await s.mcp('humanNone', op.tool, {})).code, op.operationId).toBe('forbidden');
    }
  });

  it('a service principal is refused every human-only operation', async () => {
    for (const op of AUTOMATION_OPS.filter((o) => CASES[o.operationId]?.admits === 'human')) {
      const { method, url } = restOf(op);
      expect((await s.call('serviceAll', method, url, {})).status, op.operationId).toBe(403);
      expect((await s.mcp('serviceAll', op.tool, {})).code, op.operationId).toBe('forbidden');
    }
  });

  it('an agent credential is refused on REST for every operation', async () => {
    const tok = await s.issuer.issue({ sub: agent.agentRef, tid: T_ALPHA, sid: agent.credentialRef });
    for (const op of AUTOMATION_OPS) {
      const { method, url } = restOf(op);
      expect((await s.rest(tok, method, url, {})).statusCode, op.operationId).toBe(403);
    }
  });

  it('an agent on MCP is refused every human-only operation', async () => {
    const client = await s.agentClient(agent.agentRef, agent.credentialRef);
    for (const op of AUTOMATION_OPS.filter((o) => CASES[o.operationId]?.admits === 'human')) {
      const r = await s.agentCall(client, op.tool, {});
      expect(r.isError, op.operationId).toBe(true);
      expect(r.body.code, op.operationId).toBe('forbidden');
    }
  });

  it('the export path carries no licence, plan or feature-key gate in its catalog descriptors', async () => {
    const { buildCatalog } = await import('../../scripts/catalog/build-catalog');
    for (const o of buildCatalog().filter((x) => /^(webhooks|exports)\./.test(x.operation))) {
      expect(JSON.stringify(o), o.operation).not.toMatch(/entitlement|licen[cs]e|featureKey|plan[A-Z]|tier/i);
    }
  });
});
