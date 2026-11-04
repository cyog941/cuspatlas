import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ENGAGEMENT_OPS, PORTAL_OPS, ROUTES, routeFor } from '@cuspatlas/api';
import { ACTION_POLICIES } from '@cuspatlas/domain';
import { TOOLS } from '@cuspatlas/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, email, openEngagementHarness } from './support/engagement-fixtures';

/**
 * E9 parity matrix, derived (never hand-listed) from ENGAGEMENT_OPS and PORTAL_OPS against the route
 * manifest, the registered Fastify routes, the MCP tool table, the action policy table, the OpenAPI
 * document and the E negative harness rows. A staff operation must exist on REST and MCP with one
 * policy and harness rows; a portal operation must exist on the portal transport only, with no staff
 * policy and no MCP tool. A missing tool, route, policy or harness row is a failing gap.
 */
type Row = {
  operationId: string;
  surface: 'staff' | 'portal' | 'worker';
  rest: boolean;
  registered: boolean;
  mcp: boolean;
  policy: boolean;
  openapi: boolean;
  harness: boolean;
};

const root = resolve(import.meta.dirname, '../..');
const openapi = readFileSync(resolve(root, 'docs/api/openapi.yaml'), 'utf8');
const harness = readFileSync(resolve(root, 'tests/integration/engagement-negative-harness.test.ts'), 'utf8');
const policies = ACTION_POLICIES as Record<string, { principals: readonly string[] }>;

/** The matrix and its gaps for a given tool table (so the gap detection itself can be tested). */
function matrix(
  tools: readonly { name: string; operationId?: string }[],
  registered: (op: string) => boolean,
) {
  const toolNames = new Set(tools.map((t) => t.name));
  const rows: Row[] = [
    ...ENGAGEMENT_OPS.map((o) => ({
      operationId: o.operationId,
      surface: 'staff' as const,
      rest: ROUTES.some((r) => r.operationId === o.operationId),
      registered: registered(o.operationId),
      mcp: toolNames.has(o.tool),
      policy: Object.hasOwn(policies, o.operationId),
      openapi: openapi.includes(`operationId: ${o.operationId}\n`),
      harness: harness.includes(`operation: '${o.operationId}'`),
    })),
    ...PORTAL_OPS.map((o) => ({
      operationId: o.operationId,
      surface: 'portal' as const,
      rest: ROUTES.some((r) => r.operationId === o.operationId),
      registered: registered(o.operationId),
      // Portal operations are never MCP tools and never admitted by a staff policy.
      mcp: !tools.some((t) => t.operationId === o.operationId),
      policy: !Object.hasOwn(policies, o.operationId),
      openapi: openapi.includes(`operationId: ${o.operationId}\n`),
      harness: harness.includes(`operation: '${o.operationId}'`),
    })),
    // The worker path: the messaging sender's own service-only policy (no REST, no MCP by design).
    {
      operationId: 'communications.deliver',
      surface: 'worker' as const,
      rest: !ROUTES.some((r) => r.operationId === 'communications.deliver'),
      registered: true,
      mcp: !tools.some((t) => t.operationId === 'communications.deliver'),
      policy: policies['communications.deliver']?.principals.join(',') === 'service',
      openapi: !openapi.includes('operationId: communications.deliver\n'),
      harness: harness.includes('membership_inactive'),
    },
  ];
  const gaps = rows.flatMap((r) =>
    (['rest', 'registered', 'mcp', 'policy', 'openapi', 'harness'] as const)
      .filter((k) => !r[k])
      .map((k) => `${r.operationId}:${k}`),
  );
  return { rows, gaps };
}

let db: TestDatabase;
let h: EngagementHarness;

beforeAll(async () => {
  db = await openTestDatabase('comms_parity');
  h = await openEngagementHarness(db, { mcp: true });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

const registered = (op: string) => {
  const r = routeFor(op);
  return h.app.hasRoute({ method: r.method.toUpperCase() as 'GET' | 'POST', url: r.fastifyPath });
};

describe('E9 parity matrix', () => {
  it('every E operation is on its surfaces with one policy and harness rows; no gaps', () => {
    const { rows, gaps } = matrix(TOOLS, registered);
    expect(gaps).toStrictEqual([]);
    const staff = rows.filter((r) => r.surface === 'staff').length;
    const portal = rows.filter((r) => r.surface === 'portal').length;
    expect(staff).toBe(ENGAGEMENT_OPS.length);
    expect(portal).toBe(PORTAL_OPS.length);
    // Every staff tool name is unique and every E tool maps back to a staff operation.
    const eTools = TOOLS.filter((t) => ENGAGEMENT_OPS.some((o) => o.tool === t.name));
    expect(new Set(eTools.map((t) => t.name)).size).toBe(ENGAGEMENT_OPS.length);
    process.stdout.write(
      `\nE PARITY MATRIX (${rows.length} rows: ${staff} staff REST+MCP, ${portal} portal REST-only, 1 worker)\n${rows
        .map((r) => `${r.surface.padEnd(6)} ${r.operationId}`)
        .join('\n')}\n`,
    );
  });

  it('a missing MCP tool, route or harness row is reported as a gap', () => {
    const victim = ENGAGEMENT_OPS[0]?.tool as string;
    const { gaps } = matrix(
      TOOLS.filter((t) => t.name !== victim),
      registered,
    );
    expect(gaps).toStrictEqual([`${ENGAGEMENT_OPS[0]?.operationId}:mcp`]);
    const unregistered = matrix(TOOLS, (op) => op !== 'portal.threads.read' && registered(op)).gaps;
    expect(unregistered).toStrictEqual(['portal.threads.read:registered']);
  });

  it('staff REST, MCP and the portal refuse the same foreign patient with the same denial', async () => {
    const stranger = randomUUID();
    const person = await h.person('Synthetic Parity Person', [email('e9.parity')]);
    const principal = await h.enroll(person, { channel: 'email', value: 'e9.parity@example.invalid' });
    const rest = await h.call('a1', 'GET', `/v1/patients/${stranger}/consents`);
    const mcp = await h.mcp('a1', 'communications_consents_list', { patientRef: stranger });
    const portal = await h.portal(principal, 'GET', `/portal/v1/patients/${stranger}/views/messages`);
    expect([rest.statusCode, rest.json().code]).toStrictEqual([404, 'not_found']);
    expect([mcp.status, mcp.code]).toStrictEqual([404, 'not_found']);
    expect([portal.statusCode, portal.json().code]).toStrictEqual([404, 'not_found']);
    // A portal principal is never staff: the staff route refuses it, and MCP has no portal tool.
    const token = await h.portalToken(principal);
    expect((await h.call(token, 'GET', `/v1/patients/${person}/consents`)).statusCode).toBe(401);
    expect(
      TOOLS.some(
        (t) => t.name.startsWith('portal_') && PORTAL_OPS.some((o) => o.operationId === t.operationId),
      ),
    ).toBe(false);
  });
});
