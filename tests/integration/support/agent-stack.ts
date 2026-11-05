import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CatalogOperation } from '../../../packages/contracts/src/catalog/catalog';
import { buildCatalog } from '../../../scripts/catalog/build-catalog';
import { buildScopeRegistry } from '../../../scripts/catalog/scopes';
import { type CatalogStack, M_HUMAN_ALL, MCP_AUDIENCE, startCatalogStack } from './catalog-stack';
import { T_ALPHA } from './fixtures';

/**
 * Workstream A batch 2 test support (synthetic only): the full catalog stack, every registered scope
 * for the human and service subjects, and helpers that create agent principals through the real
 * command and call MCP with the agent's own credential.
 */
export const catalog: CatalogOperation[] = buildCatalog();
export const allScopes: string[] = buildScopeRegistry(catalog).scopes.map((x) => x.name);

export interface AgentCall {
  readonly isError: boolean;
  readonly body: Record<string, unknown>;
}

export interface AgentHandle {
  readonly agentRef: string;
  readonly credentialRef: string;
  readonly version: number;
}

export interface AgentStack extends CatalogStack {
  /** POST/GET as one of the stack subjects; returns status and parsed JSON. */
  call(
    who: string,
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    key?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  createAgent(scopes: readonly string[], purpose?: string, sponsor?: string): Promise<AgentHandle>;
  /** An MCP client holding the agent's credential (sid = credentialRef), connected once. */
  agentClient(agentRef: string, credentialRef: string): Promise<Client>;
  agentCall(client: Client, tool: string, args: Record<string, unknown>): Promise<AgentCall>;
  /** One-shot agent MCP call on a fresh connection. */
  agentTool(a: AgentHandle, tool: string, args: Record<string, unknown>): Promise<AgentCall>;
}

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

export async function startAgentStack(label: string): Promise<AgentStack> {
  const s = await startCatalogStack(label, allScopes);
  const clients: Client[] = [];
  const call: AgentStack['call'] = async (who, method, url, body, key) => {
    const tok = await s.token(who);
    const r = await s.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${tok}`,
        ...(method === 'POST'
          ? { 'content-type': 'application/json', 'idempotency-key': key ?? randomUUID() }
          : {}),
      },
      ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}),
    });
    return { status: r.statusCode, body: r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {} };
  };
  const createAgent: AgentStack['createAgent'] = async (scopes, purpose, sponsor) => {
    const r = await call(sponsor ?? 'humanAll', 'POST', '/v1/agents/principals', {
      purpose: purpose ?? 'synthetic test agent',
      scopes,
      expiresAt: inDays(30),
    });
    if (r.status !== 201) throw new Error(`agent create failed ${r.status} ${JSON.stringify(r.body)}`);
    const d = r.body.data as Record<string, unknown>;
    return {
      agentRef: d.agentRef as string,
      credentialRef: d.credentialRef as string,
      version: r.body.version as number,
    };
  };
  const agentClient: AgentStack['agentClient'] = async (agentRef, credentialRef) => {
    const tok = await s.issuer.issue({
      sub: agentRef,
      tid: T_ALPHA,
      sid: credentialRef,
      audience: MCP_AUDIENCE,
    });
    const transport = new StreamableHTTPClientTransport(new URL(s.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${tok}` } },
    });
    const client = new Client({ name: 'synthetic-agent', version: '0.0.0' });
    await client.connect(transport);
    clients.push(client);
    return client;
  };
  const agentCall: AgentStack['agentCall'] = async (client, tool, args) => {
    try {
      const r = await client.callTool({ name: tool, arguments: args });
      return { isError: r.isError === true, body: (r.structuredContent ?? {}) as Record<string, unknown> };
    } catch (err) {
      const m = /\{.*\}/.exec(String((err as Error).message));
      return {
        isError: true,
        body: m ? (JSON.parse(m[0]) as Record<string, unknown>) : { code: 'transport_error' },
      };
    }
  };
  const agentTool: AgentStack['agentTool'] = async (a, tool, args) => {
    let client: Client;
    try {
      client = await agentClient(a.agentRef, a.credentialRef);
    } catch (err) {
      const m = /\{.*\}/.exec(String((err as Error).message));
      return {
        isError: true,
        body: m ? (JSON.parse(m[0]) as Record<string, unknown>) : { code: 'transport_error' },
      };
    }
    return agentCall(client, tool, args);
  };
  const close = async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await s.close();
  };
  return { ...s, call, createAgent, agentClient, agentCall, agentTool, close };
}

export const SPONSOR = M_HUMAN_ALL;
export { inDays };
