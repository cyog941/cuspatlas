import { randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import type { MembershipSource, SecurityAttemptInput, SecurityAttemptSink } from '@cuspatlas/contracts';
import {
  createDeviceCredentialSource,
  createMembershipSource,
  createPortalPrincipalSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { resolveBridgeSigningKey } from '@cuspatlas/domain';
import { buildMcpServer, type McpServerHandle } from '@cuspatlas/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { openTestDatabase, type TestDatabase } from './db';
import { createFakeScanner } from './fake-scanner';
import { seedTenancy, T_ALPHA, T_BETA } from './fixtures';
import { tempObjectStore } from './imaging-fixtures';
import { patientBody } from './patient-fixtures';
import { createTestTokenIssuer, type TestTokenIssuer } from './test-token-issuer';

export const MCP_AUDIENCE = 'urn:cuspatlas:mcp:synthetic';
export const PORTAL_AUDIENCE = 'urn:cuspatlas:portal:synthetic';

/** Matrix principals (synthetic): every staff scope, no scope, revoked, and the other tenant. */
export const M_HUMAN_ALL = '20000000-0000-4000-8000-0000000000c1';
export const M_HUMAN_NONE = '20000000-0000-4000-8000-0000000000c2';
export const M_HUMAN_REVOKED = '20000000-0000-4000-8000-0000000000c3';
export const M_HUMAN_BETA = '20000000-0000-4000-8000-0000000000c4';
export const M_SERVICE_ALL = '30000000-0000-4000-8000-0000000000c1';
export const M_SERVICE_NONE = '30000000-0000-4000-8000-0000000000c2';

export type Subject = 'humanAll' | 'humanNone' | 'humanRevoked' | 'humanBeta' | 'serviceAll' | 'serviceNone';

const SUBJECTS: Record<Subject, [string, 'human' | 'service', string, 'all' | 'none', boolean]> = {
  humanAll: [M_HUMAN_ALL, 'human', T_ALPHA, 'all', false],
  humanNone: [M_HUMAN_NONE, 'human', T_ALPHA, 'none', false],
  humanRevoked: [M_HUMAN_REVOKED, 'human', T_ALPHA, 'all', true],
  humanBeta: [M_HUMAN_BETA, 'human', T_BETA, 'all', false],
  serviceAll: [M_SERVICE_ALL, 'service', T_ALPHA, 'all', false],
  serviceNone: [M_SERVICE_NONE, 'service', T_ALPHA, 'none', false],
};

export interface McpResult {
  readonly isError: boolean;
  readonly code: string | null;
}

/** Full stack: staff REST, portal transport, device bridge and MCP over one runtime-role database. */
export interface CatalogStack {
  readonly db: TestDatabase;
  readonly app: FastifyInstance;
  readonly issuer: TestTokenIssuer;
  /** Every `memberships.load` call (proves a request went through `authorize`). */
  readonly membershipLoads: { actorId: string; tenantId: string }[];
  /** Every security attempt the independent sink persisted. */
  readonly attempts: SecurityAttemptInput[];
  token(who: Subject | string, audience?: string, tenantId?: string): Promise<string>;
  rest(token: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<LightMyRequestResponse>;
  readonly mcpUrl: string;
  /** The recording membership source, attempt sink and runtime-role transactions (for extra apps). */
  readonly membership: MembershipSource;
  readonly attemptSink: SecurityAttemptSink;
  readonly tenantTransactions: ReturnType<typeof createTenantTransactionRunner>;
  mcpAt(
    url: string,
    who: Subject,
    tool: string,
    args: Record<string, unknown>,
  ): ReturnType<CatalogStack['mcpCall']>;
  mcpListAt(url: string, who: Subject): ReturnType<CatalogStack['mcpList']>;
  mcp(who: Subject, tool: string, args: Record<string, unknown>): Promise<McpResult>;
  mcpCall(
    who: Subject,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; body: Record<string, unknown>; meta: Record<string, unknown> | null }>;
  mcpList(who: Subject): Promise<
    {
      name: string;
      description?: string | undefined;
      annotations?: { readOnlyHint?: boolean | undefined } | undefined;
    }[]
  >;
  close(): Promise<void>;
}

export async function startCatalogStack(label: string, allScopes: readonly string[]): Promise<CatalogStack> {
  const db = await openTestDatabase(label);
  await seedTenancy(db.admin);
  for (const [id, kind, tenant, scopes, revoked] of Object.values(SUBJECTS)) {
    await db.admin.query('INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, $2, $3)', [
      id,
      kind,
      `matrix-${kind}-${id.slice(-2)}`,
    ]);
    await db.admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes, location_refs, revoked_at)
       VALUES ($1, $2, $3, NULL, CASE WHEN $4 THEN now() ELSE NULL END)`,
      [tenant, id, scopes === 'all' ? allScopes : [], revoked],
    );
  }
  const issuer = await createTestTokenIssuer();
  const membershipLoads: CatalogStack['membershipLoads'] = [];
  const base = createMembershipSource(db.app);
  const membership: MembershipSource = {
    load: (actorId, tenantId) => {
      membershipLoads.push({ actorId, tenantId });
      return base.load(actorId, tenantId);
    },
  };
  const attempts: SecurityAttemptInput[] = [];
  const sink = createSecurityAttemptSink(db.sink);
  const recordingSink: SecurityAttemptSink = {
    record: async (a) => {
      const event = await sink.record(a);
      attempts.push(a);
      return event;
    },
  };
  const store = tempObjectStore();
  const tenantTransactions = createTenantTransactionRunner(db.app);
  const shared = {
    env: 'synthetic-test' as const,
    membership,
    attempts: recordingSink,
    tenantTransactions,
    scanner: createFakeScanner(),
    objectStore: store.store,
  };
  const stream = { write: () => undefined };
  const app = await buildApp({
    ...shared,
    logger: { level: 'error', stream },
    identity: issuer.verifierConfig,
    portalIdentity: { ...issuer.verifierConfig, audience: PORTAL_AUDIENCE },
    portalPrincipals: createPortalPrincipalSource(db.app),
    deviceCredentials: createDeviceCredentialSource(db.app),
    bridgeSigningKey: resolveBridgeSigningKey('synthetic-test', undefined),
  });
  const server: McpServerHandle = buildMcpServer({
    ...shared,
    identity: { ...issuer.verifierConfig, audience: MCP_AUDIENCE },
    restAudience: issuer.verifierConfig.audience,
    logger: { stream },
  });
  const mcpUrl = (await server.listen({ host: '127.0.0.1', port: 0 })).url;
  const tokens = new Map<string, string>();
  const token: CatalogStack['token'] = async (who, audience, tenantId) => {
    const subject = SUBJECTS[who as Subject];
    const sub = subject ? subject[0] : who;
    const tid = tenantId ?? (subject ? subject[2] : T_ALPHA);
    const k = `${sub}|${audience ?? ''}|${tid}`;
    let t = tokens.get(k);
    if (!t) {
      t = await issuer.issue({ sub, tid, ...(audience ? { audience } : {}) });
      tokens.set(k, t);
    }
    return t;
  };
  const rest: CatalogStack['rest'] = (tok, method, url, body) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${tok}`,
        ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
      },
      ...(method === 'POST' ? { payload: JSON.stringify(body ?? {}) } : {}),
    });
  const clients = new Map<string, Client>();
  const clientFor = async (who: Subject, url = mcpUrl): Promise<Client> => {
    let client = clients.get(`${who}|${url}`);
    if (!client) {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${await token(who, MCP_AUDIENCE)}` } },
      });
      client = new Client({ name: 'synthetic-catalog-matrix', version: '0.0.0' });
      await client.connect(transport);
      clients.set(`${who}|${url}`, client);
    }
    return client;
  };
  const mcpAt: CatalogStack['mcpAt'] = async (url, who, tool, args) => {
    const result = await (await clientFor(who, url)).callTool({ name: tool, arguments: args });
    return {
      isError: result.isError === true,
      body: (result.structuredContent ?? {}) as Record<string, unknown>,
      meta: (result._meta ?? null) as Record<string, unknown> | null,
    };
  };
  const mcpCall: CatalogStack['mcpCall'] = (who, tool, args) => mcpAt(mcpUrl, who, tool, args);
  const mcp: CatalogStack['mcp'] = async (who, tool, args) => {
    const r = await mcpCall(who, tool, args);
    return { isError: r.isError, code: (r.body as { code?: string }).code ?? null };
  };
  const mcpListAt: CatalogStack['mcpListAt'] = async (url, who) =>
    (await (await clientFor(who, url)).listTools()).tools;
  const mcpList: CatalogStack['mcpList'] = (who) => mcpListAt(mcpUrl, who);
  const close = async () => {
    for (const c of clients.values()) await c.close().catch(() => undefined);
    await server.close();
    await app.close();
    store.cleanup();
    await db.close();
  };
  return {
    db,
    app,
    issuer,
    membershipLoads,
    attempts,
    token,
    rest,
    mcpUrl,
    membership,
    attemptSink: recordingSink,
    tenantTransactions,
    mcpAt,
    mcpListAt,
    mcp,
    mcpCall,
    mcpList,
    close,
  };
}

/** Creates a synthetic patient and an enrolled, verified portal principal through staff commands. */
export async function enrollPortalPrincipal(
  s: CatalogStack,
): Promise<{ patientRef: string; principalRef: string }> {
  const staff = await s.token('humanAll');
  const p = await s.rest(
    staff,
    'POST',
    '/v1/patients',
    patientBody('Synthetic Matrix Person', {
      contact: {
        known: true,
        points: [{ channel: 'email', value: 'matrix@example.invalid', preference: 'preferred' }],
      },
    }),
  );
  if (p.statusCode !== 201) throw new Error(`patient create ${p.statusCode} ${p.body}`);
  const patientRef = (p.json() as { data: { patientRef: string } }).data.patientRef;
  const e = await s.rest(staff, 'POST', '/v1/portal/principals', {
    personRef: patientRef,
    contact: { channel: 'email', value: 'matrix@example.invalid' },
  });
  if (e.statusCode !== 201) throw new Error(`portal enroll ${e.statusCode} ${e.body}`);
  const principalRef = (e.json() as { data: { principalRef: string } }).data.principalRef;
  const v = await s.rest(staff, 'POST', `/v1/portal/principals/${principalRef}/verify`, {
    expectedVersion: 1,
    method: 'synthetic_attested',
  });
  if (v.statusCode !== 200) throw new Error(`portal verify ${v.statusCode} ${v.body}`);
  return { patientRef, principalRef };
}

/** Registers a pending synthetic bridge device (its ref is the device-kind subject in the matrix). */
export async function registerDevice(s: CatalogStack): Promise<string> {
  const r = await s.rest(await s.token('humanAll'), 'POST', '/v1/imaging/devices', {
    label: 'Synthetic Matrix Bridge',
    allowedJobKinds: ['import'],
    allowedPathPrefixes: ['exports'],
  });
  if (r.statusCode !== 201) throw new Error(`device register ${r.statusCode} ${r.body}`);
  return (r.json() as { data: { deviceRef: string } }).data.deviceRef;
}
