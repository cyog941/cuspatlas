import { ROUTES } from '@cuspatlas/api';
import { clinicalSchema } from '@cuspatlas/contracts';
import { describe, expect, it } from 'vitest';
import { TOOLS } from './server';

type Schema = Record<string, unknown>;
const DEFS = clinicalSchema.$defs as Record<string, Schema>;

function resolve(schema: unknown, local: Record<string, Schema>): unknown {
  if (Array.isArray(schema)) return schema.map((s) => resolve(s, local));
  if (schema !== null && typeof schema === 'object') {
    const o = schema as Schema;
    if (typeof o.$ref === 'string') return resolve(local[o.$ref.replace('#/$defs/', '')], local);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolve(v, local)]));
  }
  return schema;
}

const isClinical = (operationId: string) => operationId.startsWith('clinical.');
const routes = ROUTES.filter((r) => isClinical(r.operationId));
const tools = TOOLS.filter((t) => isClinical(t.operationId));

/** List queries of clinical GET routes (the MCP twin takes them as arguments). */
const LIST_QUERIES: Record<string, string> = {
  'clinical.encounters.list': 'EncounterListQuery',
  'clinical.history.read': 'HistoryReadQuery',
  'clinical.noteTemplates.applicable': 'NoteTemplateApplicableQuery',
};
const PATH_PARAMS: Record<string, string> = {
  encounterRef: 'EncounterRef',
  patientRef: 'PatientRef',
  itemRef: 'HistoryItemRef',
  historyVersionRef: 'HistoryVersionRef',
  templateRef: 'NoteTemplateRef',
  templateVersionRef: 'NoteTemplateVersionRef',
};

function restShape(route: (typeof routes)[number]): { properties: Schema; required?: string[] } {
  if (route.requestBody !== undefined) {
    return DEFS[route.requestBody.replace('clinical:', '')] as { properties: Schema; required?: string[] };
  }
  const query = LIST_QUERIES[route.operationId];
  if (query) return DEFS[query] as { properties: Schema };
  return { properties: {}, required: [] };
}

function transportOf(route: (typeof routes)[number]): string[] {
  const out: string[] = [];
  if (route.method === 'post') out.push('idempotencyKey');
  for (const p of Object.keys(PATH_PARAMS)) if (route.path.includes(`{${p}}`)) out.push(p);
  return out.sort();
}

describe('REST/MCP contract drift (clinical record)', () => {
  it('exposes exactly one tool per clinical REST operation and no others', () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.operationId).sort()).toStrictEqual(routes.map((r) => r.operationId).sort());
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) expect(t.name).toMatch(/^clinical_[a-z_]+$/);
  });

  it.each(tools.map((t) => [t.name, t] as const))('%s mirrors its REST input schema', (_n, tool) => {
    const route = routes.find((r) => r.operationId === tool.operationId);
    expect(route).toBeDefined();
    if (!route) return;
    expect(tool.readOnly).toBe(route.method === 'get');
    const schema = tool.inputSchema;
    expect(schema.additionalProperties).toBe(false);
    const transport = transportOf(route);
    const rest = restShape(route);
    const bodyProps = Object.keys(rest.properties).sort();
    const toolProps = Object.keys(schema.properties);
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
    for (const p of transport) {
      const name = p === 'idempotencyKey' ? 'IdempotencyKey' : (PATH_PARAMS[p] as string);
      expect(resolve(schema.properties[p], local)).toStrictEqual(resolve(DEFS[name], DEFS));
    }
    for (const [name, d] of Object.entries(local)) expect(d).toStrictEqual(DEFS[name]);
    expect(tool.onInvalid).not.toBe('domain');
  });
});
