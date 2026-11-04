import { pathParamsOf, ROUTES, SCHEDULING_OPS } from '@cuspatlas/api';
import { schedulingSchema } from '@cuspatlas/contracts';
import { describe, expect, it } from 'vitest';
import { TOOLS } from './server';

type Schema = Record<string, unknown>;
const DEFS = schedulingSchema.$defs as Record<string, Schema>;

function resolve(schema: unknown, local: Record<string, Schema>): unknown {
  if (Array.isArray(schema)) return schema.map((s) => resolve(s, local));
  if (schema !== null && typeof schema === 'object') {
    const o = schema as Schema;
    if (typeof o.$ref === 'string') return resolve(local[o.$ref.replace('#/$defs/', '')], local);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolve(v, local)]));
  }
  return schema;
}

const isScheduling = (operationId: string) => operationId.startsWith('scheduling.');
const routes = ROUTES.filter((r) => isScheduling(r.operationId));
const tools = TOOLS.filter((t) => isScheduling(t.operationId));

/** The REST request shape of a scheduling route: its body definition, its list query, or nothing. */
const LIST_QUERIES: Record<string, string> = {
  'scheduling.resources.list': 'ResourceListQuery',
  'scheduling.locations.list': 'LocationListQuery',
  'scheduling.requests.list': 'AppointmentRequestListQuery',
  'scheduling.worklist.daily': 'WorklistQuery',
  ...Object.fromEntries(SCHEDULING_OPS.filter((o) => o.query).map((o) => [o.operationId, o.query as string])),
};
/** POST routes that only read: no Idempotency-Key and a read-only tool. */
const POST_READS = new Set([
  'scheduling.availability.search',
  ...SCHEDULING_OPS.filter((o) => o.postRead).map((o) => o.operationId),
]);
function restShape(route: (typeof routes)[number]): { properties: Schema; required?: string[] } {
  if (route.requestBody !== undefined) {
    return DEFS[route.requestBody.replace('scheduling:', '')] as { properties: Schema; required?: string[] };
  }
  const query = LIST_QUERIES[route.operationId];
  if (query) return DEFS[query] as { properties: Schema };
  return { properties: {}, required: [] };
}

/** Transport-only additions: the Idempotency-Key header of a mutating POST and the path parameters. */
function transportOf(route: (typeof routes)[number]): string[] {
  const out: string[] = [];
  if (route.method === 'post' && !POST_READS.has(route.operationId)) out.push('idempotencyKey');
  out.push(...pathParamsOf(route.path));
  return out.sort();
}

describe('REST/MCP contract drift (scheduling resources and availability)', () => {
  it('exposes exactly one tool per scheduling REST operation and no others', () => {
    expect(tools.map((t) => t.operationId).sort()).toStrictEqual(routes.map((r) => r.operationId).sort());
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) expect(t.name).toMatch(/^(scheduling|availability)_[a-z_]+$/);
  });

  it.each(tools.map((t) => [t.name, t] as const))('%s mirrors its REST input schema', (_n, tool) => {
    const route = routes.find((r) => r.operationId === tool.operationId);
    expect(route).toBeDefined();
    if (!route) return;
    expect(tool.readOnly).toBe(route.method === 'get' || POST_READS.has(route.operationId));
    const schema = tool.inputSchema;
    expect(schema.additionalProperties).toBe(false);
    const transport = transportOf(route);
    const rest = restShape(route);
    const bodyProps = Object.keys(rest.properties).sort();
    const toolProps = Object.keys(schema.properties);
    // Body properties keep their names; only transport properties are added (a path locationRef is
    // transport for the zone change and a body property elsewhere).
    expect(toolProps.filter((p) => !transport.includes(p)).sort()).toStrictEqual(bodyProps);
    expect(toolProps.filter((p) => transport.includes(p)).sort()).toStrictEqual(transport);
    expect(schema.required.filter((p) => !transport.includes(p)).sort()).toStrictEqual(
      [...(rest.required ?? [])].sort(),
    );
    expect(schema.required.filter((p) => transport.includes(p)).sort()).toStrictEqual(transport);
    const local = schema.$defs as Record<string, Schema>;
    for (const p of bodyProps) {
      expect(resolve(schema.properties[p], local)).toStrictEqual(resolve(rest.properties[p], DEFS));
    }
    const transportDefs: Record<string, string> = {
      idempotencyKey: 'IdempotencyKey',
      resourceRef: 'ResourceRefId',
      locationRef: 'LocationRef',
      requestRef: 'RequestRef',
      appointmentRef: 'AppointmentRef',
      holdRef: 'HoldRef',
      itemRef: 'VisitItemRef',
    };
    for (const p of transport) {
      expect(resolve(schema.properties[p], local)).toStrictEqual(
        resolve(DEFS[transportDefs[p] as string], DEFS),
      );
    }
    for (const [name, def] of Object.entries(local)) expect(def).toStrictEqual(DEFS[name]);
    // Scheduling tools never validate in the domain before the tool schema decides.
    expect(tool.onInvalid).not.toBe('domain');
  });
});
