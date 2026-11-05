import { randomUUID } from 'node:crypto';
import { BILLING_OPS, ROUTES } from '@cuspatlas/api';
import { TOOLS } from '@cuspatlas/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';
import { openRcmHarness, type RcmHarness } from './support/rcm-fixtures';

/**
 * B10 parity matrix: every workstream B operation (billing.* and rcm.*) on REST and MCP, derived from
 * the route manifest and the registered tool list, so an operation without a tool (or a tool without a
 * route) fails here. Each operation is attempted under the runtime role (1) by a member without any
 * billing scope: the identical 403 with one attempt row on both surfaces; and (2) by an authorized member
 * with an unknown body or query property, or a random reference: the identical typed outcome on both
 * surfaces (400, 403 for a service-only operation, 404) or the identical success for a parameterless
 * read. Worker path: billing.procedures.consume and rcm.workflows.fireTimer are also executed by the
 * outbox worker (the same domain functions; billing-fees-procedures and rcm-workflow prove them).
 */
let db: TestDatabase;
let r: RcmHarness;

const isB = (operationId: string) => operationId.startsWith('billing.') || operationId.startsWith('rcm.');
const routes = ROUTES.filter((x) => isB(x.operationId));
const tools = TOOLS.filter((t) => isB(t.operationId));
const WORKER = new Set(['billing.procedures.consume', 'rcm.workflows.fireTimer']);
const SLUGS: Record<string, string> = { lineNo: '1' };
const unkeyed = new Set<string>(BILLING_OPS.filter((o) => o.unkeyed === true).map((o) => o.operationId));

beforeAll(async () => {
  db = await openTestDatabase('billing_parity');
  r = await openRcmHarness(db, { mcp: true });
});

afterAll(async () => {
  await r?.h.close();
  await db?.close();
});

interface Row {
  readonly op: string;
  readonly tool: string;
  denial: string;
  probe: string;
}
const matrix: Row[] = [];
const paramsOf = (path: string, ref: string) =>
  Object.fromEntries(
    [...path.matchAll(/\{(\w+)\}/g)].map((m) => [m[1] as string, SLUGS[m[1] as string] ?? ref]),
  );
const urlOf = (path: string, ref: string) => path.replace(/\{(\w+)\}/g, (_m, p: string) => SLUGS[p] ?? ref);

describe('B10 parity matrix (REST and MCP, every billing and rcm operation)', () => {
  it('every billing and rcm route has exactly one MCP tool and every tool a route', () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(tools.map((t) => t.operationId).sort()).toStrictEqual(routes.map((x) => x.operationId).sort());
  });

  it.each(routes.map((x) => [x.operationId, x] as const))('%s', async (_op, route) => {
    const tool = tools.find((t) => t.operationId === route.operationId);
    expect(tool).toBeDefined();
    if (!tool) return;
    const ref = randomUUID();
    const keyed = route.method === 'post' && !unkeyed.has(route.operationId);
    const url = urlOf(route.path, ref);
    const params = paramsOf(route.path, ref);
    const reasons = async (correlationId: string | null) =>
      correlationId === null
        ? []
        : (
            await db.admin.query(
              'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
              [correlationId],
            )
          ).rows.map((x) => x.reason_code);
    // (1) No billing scope at all: identical 403 and one attempt row per surface.
    const restDenied = await r.h.call(
      'a5',
      route.method === 'get' ? 'GET' : 'POST',
      url,
      route.method === 'get' ? undefined : {},
      keyed ? randomUUID() : null,
    );
    const mcpDenied = await r.h.mcp('a5', tool.name, {
      ...params,
      ...(keyed ? { idempotencyKey: randomUUID() } : {}),
    });
    const restReasons = await reasons(restDenied.headers['x-correlation-id'] as string);
    const mcpReasons = await reasons((mcpDenied.body.correlationId as string | undefined) ?? null);
    expect([restDenied.statusCode, restDenied.json().code]).toStrictEqual([403, 'forbidden']);
    expect([mcpDenied.status, mcpDenied.code]).toStrictEqual([403, 'forbidden']);
    expect(restReasons).toHaveLength(1);
    expect(mcpReasons).toStrictEqual(restReasons);
    // (2) Authorized caller with a bogus property or unknown reference: identical typed outcome.
    const bogus = { [`unknown${MARKER.replace(/[^A-Za-z]/g, '')}`]: 1 };
    const hasPath = Object.keys(params).length > 0;
    const hasQuery =
      route.method === 'get' && !hasPath && Object.keys(tool.inputSchema.properties).length > 0;
    const who = WORKER.has(route.operationId) ? 'svcA1' : 'a1';
    const restProbe =
      route.method === 'get'
        ? await r.h.call(who, 'GET', hasQuery ? `${url}?unknownProbe=1` : url)
        : await r.h.call(
            who,
            'POST',
            url,
            unkeyed.has(route.operationId) ? {} : bogus,
            keyed ? randomUUID() : null,
          );
    const mcpProbe = await r.h.mcp(
      who,
      tool.name,
      route.method === 'get'
        ? hasQuery
          ? { unknownProbe: '1' }
          : params
        : unkeyed.has(route.operationId)
          ? params
          : { ...params, ...bogus, ...(keyed ? { idempotencyKey: randomUUID() } : {}) },
    );
    const restOutcome = [restProbe.statusCode, restProbe.statusCode < 300 ? null : restProbe.json().code];
    const mcpOutcome = [mcpProbe.status, mcpProbe.code];
    if (restProbe.statusCode < 300) expect(mcpOutcome).toStrictEqual([restProbe.statusCode, null]);
    else {
      expect(mcpOutcome).toStrictEqual(restOutcome);
      expect([400, 404]).toContain(restProbe.statusCode);
    }
    expect(restProbe.body).not.toContain(MARKER.replace(/[^A-Za-z]/g, ''));
    matrix.push({
      op: route.operationId,
      tool: tool.name,
      denial: `403/${restReasons[0]} = 403/${mcpReasons[0]}`,
      probe: `${restOutcome.join('/')} = ${mcpOutcome.join('/')}${WORKER.has(route.operationId) ? ' (+worker)' : ''}`,
    });
  });

  afterAll(() => {
    const w = Math.max(...matrix.map((x) => x.op.length));
    process.stdout.write(
      `\nB PARITY MATRIX (${matrix.length} of ${routes.length} operations; worker path: ${[...WORKER].join(', ')})\n${matrix
        .map((x) => `${x.op.padEnd(w)}  ${x.tool.padEnd(36)} denial ${x.denial}  probe ${x.probe}`)
        .join('\n')}\n`,
    );
  });
});
