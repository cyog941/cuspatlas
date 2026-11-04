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
import { seedSchedulingScopes, USER_A5 } from './support/scheduling-fixtures';
import { createTestTokenIssuer, TEST_AUDIENCE, type TestTokenIssuer } from './support/test-token-issuer';

/**
 * Resources-track rows for the shared negative harness (S7 and S9). Same table-driven shape as
 * tests/integration/negative-harness.test.ts so the rows can be folded into it: every command is
 * attempted cross-tenant, with a revoked membership, with a downgraded role, on REST and on MCP.
 * Every attempt must be refused with the same code on both transports, write nothing and leave a
 * security attempt row.
 */
const MCP_AUDIENCE = 'urn:cuspatlas:mcp:synthetic';

let db: TestDatabase;
let issuer: TestTokenIssuer;
let app: FastifyInstance;
let mcp: McpServerHandle;
let mcpUrl: string;
let logLines: string[];

type Actor = 'a1' | 'a2' | 'a4' | 'a5' | 'b1';
const rest: Record<string, string> = {};
const mcpTok: Record<string, string> = {};

/** Alpha objects every row targets. Created through the domain as a1 in beforeAll. */
const alpha = { location: 'loc-alpha', resource: '', otherResource: '' };

beforeAll(async () => {
  db = await openTestDatabase('resources_negative');
  await seedTenancy(db.admin);
  await seedSchedulingScopes(db.admin);
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
  const who: Record<Actor, [string, string]> = {
    a1: [USER_A1, T_ALPHA],
    a2: [USER_A2, T_ALPHA],
    a4: [USER_A4, T_ALPHA],
    a5: [USER_A5, T_ALPHA],
    b1: [USER_B1, T_BETA],
  };
  for (const [k, [sub, tid]] of Object.entries(who)) {
    rest[k] = await issuer.issue({ sub, tid });
    mcpTok[k] = await issuer.issue({ sub, tid, audience: MCP_AUDIENCE });
  }
  const post = (url: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${rest.a1}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      payload: JSON.stringify(body),
    });
  expect(
    (
      await post('/v1/scheduling/locations', {
        locationRef: alpha.location,
        displayLabel: 'Synthetic Location',
        timeZone: 'America/New_York',
      })
    ).statusCode,
  ).toBe(201);
  for (const key of ['resource', 'otherResource'] as const) {
    const r = await post('/v1/scheduling/resources', {
      kind: 'operatory',
      locationRef: alpha.location,
      displayLabel: `Operatory ${key}`,
    });
    expect(r.statusCode).toBe(201);
    alpha[key] = r.json().data.resourceRef;
  }
  expect(
    (
      await post(`/v1/scheduling/resources/${alpha.resource}/availability`, {
        effectiveFrom: '2030-01-07',
        weekly: [{ weekday: 1, start: '08:00', end: '17:00' }],
      })
    ).statusCode,
  ).toBe(201);
});

afterAll(async () => {
  await mcp?.close();
  await app?.close();
  await db?.close();
});

interface Row {
  readonly operation: string;
  readonly tool: string;
  readonly method: 'GET' | 'POST';
  readonly url: () => string;
  /** REST body (POST) or query (GET). */
  readonly body: () => Record<string, unknown>;
  /** MCP arguments: the body plus transport-only properties (path parameters, idempotency key). */
  readonly args: () => Record<string, unknown>;
  readonly write: boolean;
}

const key = () => `neg-${randomUUID()}`;
const blockBody = () => ({
  locationRef: alpha.location,
  startsAt: '2030-03-05T15:00:00Z',
  endsAt: '2030-03-05T16:00:00Z',
  reasonCode: 'meeting',
  resources: [{ kind: 'operatory', resourceRef: alpha.resource }],
});
const searchBody = () => ({
  locationRef: alpha.location,
  from: '2030-01-07',
  to: '2030-01-07',
  durationMinutes: 30,
  displayTimeZone: 'America/New_York',
  requirements: [{ kind: 'operatory', resourceRef: alpha.resource }],
});

const ROWS: readonly Row[] = [
  {
    operation: 'scheduling.locations.define',
    tool: 'scheduling_locations_define',
    method: 'POST',
    url: () => '/v1/scheduling/locations',
    body: () => ({
      locationRef: 'loc-neg',
      displayLabel: 'Synthetic Location',
      timeZone: 'America/New_York',
    }),
    args: () => ({
      locationRef: 'loc-neg',
      displayLabel: 'Synthetic Location',
      timeZone: 'America/New_York',
      idempotencyKey: key(),
    }),
    write: true,
  },
  {
    operation: 'scheduling.locations.list',
    tool: 'scheduling_locations_list',
    method: 'GET',
    url: () => '/v1/scheduling/locations',
    body: () => ({}),
    args: () => ({}),
    write: false,
  },
  {
    operation: 'scheduling.locations.changeTimeZone',
    tool: 'scheduling_locations_change_time_zone',
    method: 'POST',
    url: () => `/v1/scheduling/locations/${alpha.location}/time-zone`,
    body: () => ({ timeZone: 'America/Chicago', expectedVersion: 1 }),
    args: () => ({
      locationRef: alpha.location,
      timeZone: 'America/Chicago',
      expectedVersion: 1,
      idempotencyKey: key(),
    }),
    write: true,
  },
  {
    operation: 'scheduling.resources.define',
    tool: 'scheduling_resources_define',
    method: 'POST',
    url: () => '/v1/scheduling/resources',
    body: () => ({ kind: 'operatory', locationRef: alpha.location, displayLabel: 'Operatory 7' }),
    args: () => ({
      kind: 'operatory',
      locationRef: alpha.location,
      displayLabel: 'Operatory 7',
      idempotencyKey: key(),
    }),
    write: true,
  },
  {
    operation: 'scheduling.resources.list',
    tool: 'scheduling_resources_list',
    method: 'GET',
    url: () => '/v1/scheduling/resources',
    body: () => ({}),
    args: () => ({}),
    write: false,
  },
  {
    operation: 'scheduling.resources.read',
    tool: 'scheduling_resources_get',
    method: 'GET',
    url: () => `/v1/scheduling/resources/${alpha.resource}`,
    body: () => ({}),
    args: () => ({ resourceRef: alpha.resource }),
    write: false,
  },
  {
    operation: 'scheduling.resources.setAvailability',
    tool: 'scheduling_resources_set_availability',
    method: 'POST',
    url: () => `/v1/scheduling/resources/${alpha.resource}/availability`,
    body: () => ({ effectiveFrom: '2030-06-03', weekly: [] }),
    args: () => ({
      resourceRef: alpha.resource,
      effectiveFrom: '2030-06-03',
      weekly: [],
      idempotencyKey: key(),
    }),
    write: true,
  },
  {
    operation: 'scheduling.resources.deactivate',
    tool: 'scheduling_resources_deactivate',
    method: 'POST',
    url: () => `/v1/scheduling/resources/${alpha.otherResource}/deactivate`,
    body: () => ({ expectedVersion: 1 }),
    args: () => ({ resourceRef: alpha.otherResource, expectedVersion: 1, idempotencyKey: key() }),
    write: true,
  },
  {
    operation: 'scheduling.timeBlocks.create',
    tool: 'scheduling_time_blocks_create',
    method: 'POST',
    url: () => '/v1/scheduling/time-blocks',
    body: blockBody,
    args: () => ({ ...blockBody(), idempotencyKey: key() }),
    write: true,
  },
  {
    operation: 'scheduling.resources.dataQuality',
    tool: 'scheduling_resources_data_quality',
    method: 'GET',
    url: () => '/v1/scheduling/data-quality/state-labelled-resources',
    body: () => ({}),
    args: () => ({}),
    write: false,
  },
  // S9: the only read that names a target in its body; cross-tenant is 404 like a targeted read.
  {
    operation: 'scheduling.availability.search',
    tool: 'availability_search',
    method: 'POST',
    url: () => '/v1/availability/search',
    body: searchBody,
    args: searchBody,
    write: false,
  },
];

/** Reads that hold no target return the tenant's own (empty) data to a foreign member, by design. */
const TENANT_SCOPED_READS = new Set([
  'scheduling.locations.list',
  'scheduling.resources.list',
  'scheduling.resources.dataQuality',
]);

interface Outcome {
  readonly status: number;
  readonly code: string | null;
  readonly raw: string;
}

async function viaRest(row: Row, actor: Actor): Promise<Outcome> {
  const res = await app.inject({
    method: row.method,
    url: row.url(),
    headers: {
      authorization: `Bearer ${rest[actor]}`,
      ...(row.method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': key() } : {}),
    },
    ...(row.method === 'POST'
      ? { payload: JSON.stringify(row.body()) }
      : { query: row.body() as Record<string, string> }),
  });
  let code: string | null = null;
  try {
    code = typeof res.json().code === 'string' ? res.json().code : null;
  } catch {}
  return { status: res.statusCode, code, raw: res.body };
}

async function viaMcp(row: Row, actor: Actor): Promise<Outcome> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${mcpTok[actor]}` } },
  });
  const client = new Client({ name: 'synthetic-negative-client', version: '0.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: row.tool, arguments: row.args() });
    const raw = JSON.stringify(result);
    if (result.isError === true) {
      const body = result.structuredContent as { code: RefusalCode };
      return { status: REFUSAL_HTTP_STATUS[body.code], code: body.code, raw };
    }
    return { status: 200, code: null, raw };
  } catch (e) {
    // Protocol-level refusal (for example a revoked membership): HTTP status plus the refusal body.
    const err = e as { code?: unknown; message?: string };
    if (typeof err.code !== 'number') throw e;
    const m = /"code":"([a-z_]+)"/.exec(String(err.message));
    return { status: err.code, code: m?.[1] ?? null, raw: String(err.message) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

const WRITE_TABLES = [
  'scheduling_locations',
  'scheduling_resources',
  'scheduling_availability_versions',
  'scheduling_time_blocks',
  'scheduling_occupancy',
  'audit_events',
  'outbox_events',
];
const counts = async () =>
  Promise.all(
    WRITE_TABLES.map(
      async (t) => (await db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${t}`)).rows[0].n,
    ),
  );
const attemptCount = async () =>
  (await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.security_attempt_events')).rows[0]
    .n as number;

type Case = 'cross-tenant' | 'revoked' | 'downgraded';
const CASES: readonly Case[] = ['cross-tenant', 'revoked', 'downgraded'];

function actorFor(row: Row, c: Case): Actor {
  if (c === 'cross-tenant') return 'b1';
  if (c === 'revoked') return 'a2';
  // Downgraded: a read-only scheduler for writes; a member without any scheduling scope for reads.
  return row.write ? 'a4' : 'a5';
}

function expected(row: Row, c: Case): { status: number; code: string } | 'tenant-own-data' {
  if (c === 'revoked' || c === 'downgraded') return { status: 403, code: 'forbidden' };
  if (TENANT_SCOPED_READS.has(row.operation)) return 'tenant-own-data';
  if (row.operation === 'scheduling.locations.define') return 'tenant-own-data';
  return { status: 404, code: 'not_found' };
}

const matrix: { operation: string; case: Case; transport: string; status: number; code: string | null }[] =
  [];

describe('resources-track negative rows (cross-tenant, revoked, downgraded) on REST and MCP', () => {
  for (const row of ROWS) {
    for (const c of CASES) {
      it(`${row.operation} ${c}`, async () => {
        const actor = actorFor(row, c);
        const want = expected(row, c);
        const before = await counts();
        const attemptsBefore = await attemptCount();
        const r = await viaRest(row, actor);
        const m = await viaMcp(row, actor);
        matrix.push({ operation: row.operation, case: c, transport: 'rest', status: r.status, code: r.code });
        matrix.push({ operation: row.operation, case: c, transport: 'mcp', status: m.status, code: m.code });
        for (const o of [r, m]) expect(o.raw).not.toContain(MARKER);
        if (want === 'tenant-own-data') {
          // Beta sees only beta: no alpha identifier crosses the boundary, and a beta define writes
          // a beta row, never an alpha one.
          for (const o of [r, m]) {
            expect(o.raw).not.toContain(alpha.resource);
            expect(o.raw).not.toContain(alpha.otherResource);
          }
          const alphaRows = await db.admin.query(
            `SELECT count(*)::int AS n FROM cuspatlas.scheduling_locations WHERE tenant_id = $1`,
            [T_ALPHA],
          );
          expect(alphaRows.rows[0].n).toBe(1);
          return;
        }
        expect([r.status, r.code]).toStrictEqual([want.status, want.code]);
        expect([m.status, m.code]).toStrictEqual([want.status, want.code]);
        expect(await counts()).toStrictEqual(before);
        // One durable attempt row per refused transport call.
        expect(await attemptCount()).toBe(attemptsBefore + 2);
      });
    }
  }

  it('a role downgraded after the token was issued is refused on the next command', async () => {
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = array_remove(scopes, 'admin.configure') WHERE principal_id = $1`,
      [USER_A1],
    );
    try {
      const row = ROWS.find((x) => x.operation === 'scheduling.resources.define');
      if (!row) throw new Error('missing row');
      const before = await counts();
      expect(await viaRest(row, 'a1')).toMatchObject({ status: 403, code: 'forbidden' });
      expect(await viaMcp(row, 'a1')).toMatchObject({ status: 403, code: 'forbidden' });
      expect(await counts()).toStrictEqual(before);
    } finally {
      await db.admin.query(
        `UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY['admin.configure'] WHERE principal_id = $1`,
        [USER_A1],
      );
    }
  });

  it('records the matrix (every row, every case, both transports)', () => {
    expect(matrix).toHaveLength(ROWS.length * CASES.length * 2);
    expect(logLines.join('\n')).not.toContain(MARKER);
  });
});
