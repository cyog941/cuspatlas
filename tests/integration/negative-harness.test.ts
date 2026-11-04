import { randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import { REFUSAL_HTTP_STATUS, type RefusalCode } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { buildMcpServer, type McpServerHandle } from '@cuspatlas/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { seedTenancy, T_ALPHA, T_BETA, USER_A1, USER_A2, USER_A4, USER_B1 } from './support/fixtures';
import { MARKER } from './support/marker';
import { patientBody, seedPatientScopes, USER_A5 } from './support/patient-fixtures';
import { createTestTokenIssuer, TEST_AUDIENCE, type TestTokenIssuer } from './support/test-token-issuer';

/**
 * Shared negative harness for workstream S (Global Constraints of the scheduling and patients plan).
 * Every S command is attempted cross-tenant, with a revoked membership, with a downgraded role and
 * through MCP, under the runtime role. Append a row to COMMANDS for each new command; the
 * dimensions below run for every row unchanged.
 */

const MCP_AUDIENCE = 'urn:cuspatlas:mcp:synthetic';

let db: TestDatabase;
let issuer: TestTokenIssuer;
let app: FastifyInstance;
let mcp: McpServerHandle;
let mcpUrl: string;
let logLines: string[];
const rest: Record<string, string> = {};
const mcpTokens: Record<string, string> = {};

/** Fixture references created once per run (alpha tenant unless stated). */
export interface HarnessFixture {
  readonly alphaPatient: string;
  readonly [name: string]: string;
}
let fixture: HarnessFixture;

type Method = 'GET' | 'POST';
interface RestCall {
  readonly method: Method;
  readonly url: string;
  readonly body?: unknown;
  /** Mutations carry an Idempotency-Key header; reads do not. */
  readonly keyed: boolean;
  readonly status: number;
}

export interface HarnessCommand {
  /** Operation id (also the security-attempt `operation`). */
  readonly operation: string;
  readonly tool: string;
  /** What another tenant's member gets: hidden (404) for targeted commands, an empty page for searches. */
  readonly crossTenant: 'not_found' | 'empty_page' | 'own_tenant_only';
  /** Who stands for "downgraded": a member lacking this command's scope. */
  readonly downgradedTo: 'readOnly' | 'noPatientScopes';
  rest(f: HarnessFixture): RestCall;
  mcpArgs(f: HarnessFixture): Record<string, unknown>;
}

const P = (f: HarnessFixture) => f.alphaPatient;
const SOON = new Date(Date.now() + 7 * 86_400_000).toISOString();

/** S4 rows. S5, S6 and the scheduling tasks append their commands here. */
export const COMMANDS: HarnessCommand[] = [
  {
    operation: 'patients.create',
    tool: 'patients_create',
    crossTenant: 'own_tenant_only',
    downgradedTo: 'readOnly',
    rest: () => ({
      method: 'POST',
      url: '/v1/patients',
      body: patientBody(`Synthetic ${MARKER}`),
      keyed: true,
      status: 201,
    }),
    mcpArgs: () => ({ ...patientBody(`Synthetic ${MARKER}`), idempotencyKey: randomUUID() }),
  },
  {
    operation: 'patients.read',
    tool: 'patients_get',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({ method: 'GET', url: `/v1/patients/${P(f)}`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ patientRef: P(f) }),
  },
  {
    operation: 'patients.search',
    tool: 'patients_search',
    crossTenant: 'empty_page',
    downgradedTo: 'noPatientScopes',
    rest: () => ({
      method: 'POST',
      url: '/v1/patients/search',
      body: { name: 'Synthetic Harness' },
      keyed: false,
      status: 200,
    }),
    mcpArgs: () => ({ name: 'Synthetic Harness' }),
  },
  {
    operation: 'patients.updateDemographics',
    tool: 'patients_update_demographics',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/${P(f)}/demographics`,
      body: { expectedVersion: 1, preferredName: { known: true, value: MARKER } },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      patientRef: P(f),
      expectedVersion: 1,
      preferredName: { known: true, value: MARKER },
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'patients.setStatus',
    tool: 'patients_set_status',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/${P(f)}/status`,
      body: {
        expectedVersion: 1,
        status: 'inactive',
        effectiveAt: '2026-10-01T00:00:00Z',
        reasonCode: 'moved_away',
      },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      patientRef: P(f),
      expectedVersion: 1,
      status: 'inactive',
      effectiveAt: '2026-10-01T00:00:00Z',
      reasonCode: 'moved_away',
      idempotencyKey: randomUUID(),
    }),
  },
  // S5 relationship commands.
  {
    operation: 'patients.relationships.add',
    tool: 'patients_add_relationship',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/${P(f)}/relationships`,
      body: {
        counterpartyRef: f.alphaCounterparty,
        kind: 'proxy',
        scopes: ['demographics'],
        effectiveUntil: SOON,
      },
      keyed: true,
      status: 201,
    }),
    mcpArgs: (f) => ({
      patientRef: P(f),
      counterpartyRef: f.alphaCounterparty,
      kind: 'proxy',
      scopes: ['demographics'],
      effectiveUntil: SOON,
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'patients.relationships.list',
    tool: 'patients_list_relationships',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({ method: 'GET', url: `/v1/patients/${P(f)}/relationships`, keyed: false, status: 200 }),
    mcpArgs: (f) => ({ patientRef: P(f) }),
  },
  {
    operation: 'patients.relationships.revoke',
    tool: 'patients_revoke_relationship',
    crossTenant: 'not_found',
    downgradedTo: 'readOnly',
    rest: (f) => ({
      method: 'POST',
      url: `/v1/patients/${P(f)}/relationships/${f.alphaRelationship}/revoke`,
      body: { expectedVersion: 1, reasonCode: 'patient_request' },
      keyed: true,
      status: 200,
    }),
    mcpArgs: (f) => ({
      patientRef: P(f),
      relationshipRef: f.alphaRelationship,
      expectedVersion: 1,
      reasonCode: 'patient_request',
      idempotencyKey: randomUUID(),
    }),
  },
  {
    operation: 'patients.access.resolve',
    tool: 'patients_resolve_access',
    crossTenant: 'not_found',
    downgradedTo: 'noPatientScopes',
    rest: (f) => ({
      method: 'GET',
      url: `/v1/patients/${P(f)}/access?counterpartyRef=${f.alphaCounterparty}`,
      keyed: false,
      status: 200,
    }),
    mcpArgs: (f) => ({ patientRef: P(f), counterpartyRef: f.alphaCounterparty }),
  },
];

beforeAll(async () => {
  db = await openTestDatabase('negative_harness');
  await seedTenancy(db.admin);
  await seedPatientScopes(db.admin);
  issuer = await createTestTokenIssuer();
  logLines = [];
  const stream = { write: (l: string) => logLines.push(l) };
  const membership = createMembershipSource(db.app);
  const attempts = createSecurityAttemptSink(db.sink);
  const tenantTransactions = createTenantTransactionRunner(db.app);
  app = await buildApp({
    env: 'synthetic-test',
    logger: { level: 'info', stream },
    identity: issuer.verifierConfig,
    membership,
    attempts,
    tenantTransactions,
  });
  mcp = buildMcpServer({
    env: 'synthetic-test',
    identity: { ...issuer.verifierConfig, audience: MCP_AUDIENCE },
    restAudience: TEST_AUDIENCE,
    membership,
    attempts,
    tenantTransactions,
    logger: { stream },
  });
  mcpUrl = (await mcp.listen({ host: '127.0.0.1', port: 0 })).url;
  for (const [who, sub, tid] of [
    ['owner', USER_A1, T_ALPHA],
    ['crossTenant', USER_B1, T_BETA],
    ['revoked', USER_A2, T_ALPHA],
    ['readOnly', USER_A4, T_ALPHA],
    ['noPatientScopes', USER_A5, T_ALPHA],
  ] as const) {
    rest[who] = await issuer.issue({ sub, tid });
    mcpTokens[who] = await issuer.issue({ sub, tid, audience: MCP_AUDIENCE });
  }
  const created = await app.inject({
    method: 'POST',
    url: '/v1/patients',
    headers: {
      authorization: `Bearer ${rest.owner}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    payload: JSON.stringify(patientBody('Synthetic Harness Patient')),
  });
  expect(created.statusCode).toBe(201);
  const owner = (url: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${rest.owner}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      payload: JSON.stringify(body),
    });
  const alphaPatient = created.json().data.patientRef;
  const counterparty = await owner('/v1/patients', patientBody('Synthetic Harness Counterparty'));
  const alphaCounterparty = counterparty.json().data.patientRef;
  const rel = await owner(`/v1/patients/${alphaPatient}/relationships`, {
    counterpartyRef: alphaCounterparty,
    kind: 'guarantor',
    scopes: ['financial'],
  });
  expect(rel.statusCode).toBe(201);
  fixture = { alphaPatient, alphaCounterparty, alphaRelationship: rel.json().data.relationshipRef };
});

afterAll(async () => {
  await mcp?.close();
  await app?.close();
  await db?.close();
});

interface Outcome {
  readonly status: number;
  readonly code: string | null;
  readonly correlationId: string | null;
  readonly body: Record<string, unknown> | null;
  readonly raw: string;
}

async function viaRest(who: string, call: RestCall): Promise<Outcome> {
  const res = await app.inject({
    method: call.method,
    url: call.url,
    headers: {
      authorization: `Bearer ${rest[who]}`,
      ...(call.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(call.keyed ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(call.body === undefined ? {} : { payload: JSON.stringify(call.body) }),
  });
  const body = res.json() as Record<string, unknown>;
  return {
    status: res.statusCode,
    code: typeof body.code === 'string' ? body.code : null,
    correlationId: res.headers['x-correlation-id'] as string,
    body,
    raw: `${res.body}${JSON.stringify(res.headers)}`,
  };
}

async function viaMcp(
  who: string,
  tool: string,
  args: Record<string, unknown>,
  okStatus: number,
): Promise<Outcome> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${mcpTokens[who]}` } },
  });
  const client = new Client({ name: 'synthetic-harness', version: '0.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args });
    const body = result.structuredContent as Record<string, unknown>;
    const refused = result.isError === true;
    return {
      status: refused ? REFUSAL_HTTP_STATUS[body.code as RefusalCode] : okStatus,
      code: refused ? (body.code as string) : null,
      correlationId: typeof body.correlationId === 'string' ? body.correlationId : null,
      body,
      raw: JSON.stringify(result),
    };
  } catch (e) {
    // Protocol-level refusal (authentication or membership) carries the HTTP status.
    const err = e as { code?: unknown; message?: string };
    if (typeof err.code !== 'number') throw e;
    const message = String(err.message);
    const start = message.indexOf('{');
    const body = start >= 0 ? (JSON.parse(message.slice(start)) as Record<string, unknown>) : null;
    return {
      status: err.code,
      code: body && typeof body.code === 'string' ? body.code : null,
      correlationId: body && typeof body.correlationId === 'string' ? body.correlationId : null,
      body,
      raw: message,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function attemptReasons(correlationId: string | null): Promise<string[]> {
  if (correlationId === null) return [];
  const { rows } = await db.admin.query(
    'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
    [correlationId],
  );
  return rows.map((r) => r.reason_code);
}

/** Snapshot of the alpha fixture and every write surface, to prove a denial changed nothing. */
async function state(): Promise<string> {
  const q = async (sql: string) => JSON.stringify((await db.admin.query(sql)).rows);
  return [
    await q(`SELECT version FROM cuspatlas.patients WHERE id = '${fixture.alphaPatient}'`),
    await q('SELECT count(*)::int AS n FROM cuspatlas.patients'),
    await q('SELECT count(*)::int AS n, sum(version)::int AS v FROM cuspatlas.patient_relationships'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.audit_events'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.outbox_events'),
    await q('SELECT count(*)::int AS n FROM cuspatlas.command_idempotency'),
  ].join('|');
}

type Dimension = 'crossTenant' | 'revoked' | 'downgraded';
const DIMENSIONS: Dimension[] = ['crossTenant', 'revoked', 'downgraded'];

function expected(
  cmd: HarnessCommand,
  d: Dimension,
): { status: number; code: string | null; reason: string | null } {
  if (d === 'revoked') return { status: 403, code: 'forbidden', reason: 'membership_inactive' };
  if (d === 'downgraded') return { status: 403, code: 'forbidden', reason: 'scope_missing' };
  if (cmd.crossTenant === 'not_found')
    return { status: 404, code: 'not_found', reason: 'resource_hidden_or_missing' };
  return { status: cmd.rest(fixture).status, code: null, reason: null };
}

const whoFor = (cmd: HarnessCommand, d: Dimension) => (d === 'downgraded' ? cmd.downgradedTo : d);

describe('negative harness: every S command, every dimension, REST and MCP', () => {
  const cases = COMMANDS.flatMap((cmd) => DIMENSIONS.map((d) => [cmd.operation, d, cmd] as const));

  it.each(cases)('%s %s', async (_op, d, cmd) => {
    const want = expected(cmd, d);
    const who = whoFor(cmd, d);
    const before = await state();
    const r = await viaRest(who, cmd.rest(fixture));
    const m = await viaMcp(who, cmd.tool, cmd.mcpArgs(fixture), cmd.rest(fixture).status);
    for (const [surface, o] of [
      ['REST', r],
      ['MCP', m],
    ] as const) {
      expect([surface, o.status, o.code]).toStrictEqual([surface, want.status, want.code]);
      // A refusal never echoes caller text (successes legitimately return the caller's own data).
      if (want.code !== null) expect(o.raw).not.toContain(MARKER);
      if (want.reason !== null) {
        expect([surface, await attemptReasons(o.correlationId)]).toStrictEqual([surface, [want.reason]]);
      }
    }
    if (want.code === null && cmd.crossTenant === 'empty_page') {
      // Another tenant searching sees only its own (empty) tenant, never alpha's patients.
      for (const o of [r, m]) expect(o.body?.data).toStrictEqual([]);
    }
    if (want.code !== null) expect(await state()).toBe(before);
    if (cmd.crossTenant === 'own_tenant_only' && d === 'crossTenant') {
      // A create by another tenant's member lands in its own tenant only.
      const { rows } = await db.admin.query(
        'SELECT DISTINCT tenant_id FROM cuspatlas.patients WHERE created_by = $1',
        [USER_B1],
      );
      expect(rows).toStrictEqual([{ tenant_id: T_BETA }]);
    }
  });

  it('the owner succeeds with the same calls (the harness is not vacuous)', async () => {
    for (const cmd of COMMANDS.filter(
      (c) => c.operation === 'patients.read' || c.operation === 'patients.search',
    )) {
      const r = await viaRest('owner', cmd.rest(fixture));
      expect([cmd.operation, r.status]).toStrictEqual([cmd.operation, cmd.rest(fixture).status]);
    }
  });

  it('no caller-supplied tenant is accepted by any S body or tool', async () => {
    for (const cmd of COMMANDS) {
      const call = cmd.rest(fixture);
      if (call.body === undefined) continue;
      const r = await viaRest('owner', { ...call, body: { ...(call.body as object), tenantId: T_BETA } });
      expect([cmd.operation, r.status]).toStrictEqual([cmd.operation, 400]);
      const m = await viaMcp('owner', cmd.tool, { ...cmd.mcpArgs(fixture), tenantId: T_BETA }, 200);
      expect([cmd.operation, m.code]).toStrictEqual([cmd.operation, 'invalid_request']);
    }
    expect(logLines.join('\n')).not.toContain(MARKER);
  });
});
