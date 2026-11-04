import { randomUUID } from 'node:crypto';
import { ROUTES } from '@cuspatlas/api';
import { TOOLS } from '@cuspatlas/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  openAppointmentHarness,
  seedLocation,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';

/**
 * S17 parity matrix: every workstream S operation (patients.* and scheduling.*) on REST and MCP,
 * derived from the route manifest and the registered tool list, so an operation with no tool (or a
 * tool with no route) fails here. Each operation is attempted twice per surface under the runtime
 * role: (1) by a member without any patient or scheduling scope, which must be the identical 403
 * denial with one `scope_missing` attempt row on both surfaces, and (2) by an authorized member with
 * an unknown body property, an unknown query property or a random reference, which must be the
 * identical typed refusal (400 or 404) on both surfaces, or the identical success for parameterless
 * reads. Worker path: no S operation is executed by the outbox worker (its policy denies unknown
 * operations); automated S execution goes through REST/MCP under a service principal and a standing
 * policy, covered in cancellation-recovery.test.ts.
 */
let db: TestDatabase;
let h: AppointmentHarness;

const isS = (operationId: string) =>
  operationId.startsWith('patients.') || operationId.startsWith('scheduling.');
const routes = ROUTES.filter((r) => isS(r.operationId));
const tools = TOOLS.filter((t) => isS(t.operationId));
const POST_READS = new Set(['scheduling.availability.search', 'scheduling.series.plan', 'patients.search']);
const SLUG_PARAMS = new Set(['locationRef']);

beforeAll(async () => {
  db = await openTestDatabase('scheduling_parity');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedLocation(h, 'loc-parity');
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

interface Row {
  readonly op: string;
  readonly tool: string;
  denial: string;
  probe: string;
}
const matrix: Row[] = [];

function pathOf(path: string, ref: string) {
  return path.replace(/\{(\w+)\}/g, (_m, p: string) => (SLUG_PARAMS.has(p) ? 'loc-parity' : ref));
}
function paramsOf(path: string, ref: string): Record<string, string> {
  return Object.fromEntries(
    [...path.matchAll(/\{(\w+)\}/g)].map((m) => [
      m[1] as string,
      SLUG_PARAMS.has(m[1] as string) ? 'loc-parity' : ref,
    ]),
  );
}

describe('S17 parity matrix (REST and MCP, every S operation)', () => {
  it('every S route has exactly one MCP tool and every S tool has a route', () => {
    expect(routes.length).toBeGreaterThan(70);
    expect(tools.map((t) => t.operationId).sort()).toStrictEqual(routes.map((r) => r.operationId).sort());
  });

  it.each(routes.map((r) => [r.operationId, r] as const))('%s', async (_op, route) => {
    const tool = tools.find((t) => t.operationId === route.operationId);
    expect(tool).toBeDefined();
    if (!tool) return;
    const ref = randomUUID();
    const keyed = route.method === 'post' && !POST_READS.has(route.operationId);
    const url = pathOf(route.path, ref);
    const params = paramsOf(route.path, ref);
    // (1) No patient or scheduling scope: identical 403 denial and one attempt row per surface.
    const restDenied = await h.call(
      'a5',
      route.method === 'get' ? 'GET' : 'POST',
      url,
      route.method === 'get' ? undefined : {},
      keyed ? randomUUID() : null,
    );
    const mcpDenied = await h.mcp('a5', tool.name, {
      ...params,
      ...(keyed ? { idempotencyKey: randomUUID() } : {}),
    });
    const reasons = async (correlationId: string | null) =>
      correlationId === null
        ? []
        : (
            await db.admin.query(
              'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
              [correlationId],
            )
          ).rows.map((r) => r.reason_code);
    const restReasons = await reasons(restDenied.headers['x-correlation-id'] as string);
    const mcpReasons = await reasons((mcpDenied.body.correlationId as string | undefined) ?? null);
    expect([restDenied.statusCode, restDenied.json().code, restReasons]).toStrictEqual([
      403,
      'forbidden',
      ['scope_missing'],
    ]);
    expect([mcpDenied.status, mcpDenied.code, mcpReasons]).toStrictEqual([
      403,
      'forbidden',
      ['scope_missing'],
    ]);
    // (2) Authorized caller, bad input or unknown reference: the identical typed outcome per surface.
    const bogus = { [`unknown${MARKER.replace(/[^A-Za-z]/g, '')}`]: 1 };
    const hasPath = Object.keys(params).length > 0;
    // A GET with a query definition gets an unknown query property; a parameterless GET gets nothing.
    const hasQuery = !hasPath && Object.keys(tool.inputSchema.properties).length > 0;
    const restProbe =
      route.method === 'get'
        ? await h.call('a1', 'GET', hasQuery ? `${url}?unknownProbe=1` : url)
        : await h.call('a1', 'POST', url, bogus, keyed ? randomUUID() : null);
    const mcpProbe = await h.mcp(
      'a1',
      tool.name,
      route.method === 'get'
        ? hasQuery
          ? { unknownProbe: '1' }
          : params
        : { ...params, ...bogus, ...(keyed ? { idempotencyKey: randomUUID() } : {}) },
    );
    const restOutcome = [restProbe.statusCode, restProbe.statusCode < 300 ? null : restProbe.json().code];
    const mcpOutcome = [mcpProbe.status, mcpProbe.code];
    if (restProbe.statusCode < 300) {
      // A parameterless read that ignores no input: success on both surfaces.
      expect(mcpOutcome).toStrictEqual([200, null]);
    } else {
      expect(mcpOutcome).toStrictEqual(restOutcome);
      expect([400, 404]).toContain(restProbe.statusCode);
    }
    expect(restProbe.body).not.toContain(MARKER.replace(/[^A-Za-z]/g, ''));
    matrix.push({
      op: route.operationId,
      tool: tool.name,
      denial: `403/${restReasons[0]} = 403/${mcpReasons[0]}`,
      probe: `${restOutcome.join('/')} = ${mcpOutcome.join('/')}`,
    });
  });

  afterAll(() => {
    const w = Math.max(...matrix.map((r) => r.op.length));
    process.stdout.write(
      `\nS PARITY MATRIX (${matrix.length} of ${routes.length} operations; worker path: none for S)\n${matrix
        .map((r) => `${r.op.padEnd(w)}  ${r.tool.padEnd(48)} denial ${r.denial}  probe ${r.probe}`)
        .join('\n')}\n`,
    );
  });
});
