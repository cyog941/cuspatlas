import { ROUTES } from '@cuspatlas/api';
import { actionProposalSchema, patientSchema, syntheticTaskSchema } from '@cuspatlas/contracts';
import { describe, expect, it } from 'vitest';
import { TOOLS } from './server';

type Schema = Record<string, unknown>;
const TASK_DEFS = syntheticTaskSchema.$defs as Record<string, Schema>;
const PROPOSAL_DEFS = actionProposalSchema.$defs as Record<string, Schema>;

/** Resolves a $ref against the published contract so tool and REST schemas compare structurally. */
function resolve(schema: unknown, local: Record<string, Schema>): unknown {
  if (Array.isArray(schema)) return schema.map((s) => resolve(s, local));
  if (schema !== null && typeof schema === 'object') {
    const o = schema as Schema;
    if (typeof o.$ref === 'string') return resolve(local[o.$ref.replace('#/$defs/', '')], local);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolve(v, local)]));
  }
  return schema;
}

const TRANSPORT_ONLY = new Set(['idempotencyKey', 'taskRef', 'proposalRef']);
const synthetic = ROUTES.filter((r) => r.operationId.startsWith('syntheticTasks.'));
// Scheduling tools (S7/S9) have their own drift test: scheduling-tool-drift.test.ts.
const SYNTHETIC_TOOLS = TOOLS.filter((t) => t.operationId.startsWith('syntheticTasks.'));

/** The REST request shape of a route: its body definition, or the list query, or nothing. */
function restShape(operationId: string, requestBody: string | undefined) {
  if (requestBody?.startsWith('proposal:')) {
    return { defs: PROPOSAL_DEFS, shape: PROPOSAL_DEFS[requestBody.slice('proposal:'.length)] };
  }
  if (requestBody !== undefined) return { defs: TASK_DEFS, shape: TASK_DEFS[requestBody] };
  if (operationId === 'syntheticTasks.list')
    return { defs: TASK_DEFS, shape: TASK_DEFS.SyntheticTaskListQuery };
  const defs = operationId.startsWith('syntheticTasks.proposals.') ? PROPOSAL_DEFS : TASK_DEFS;
  return { defs, shape: { properties: {}, required: [] } };
}

describe('REST/MCP contract drift (synthetic tasks and proposals)', () => {
  it('exposes exactly one tool per REST operation and no others', () => {
    expect(SYNTHETIC_TOOLS.map((t) => t.operationId).sort()).toStrictEqual(
      synthetic.map((r) => r.operationId).sort(),
    );
    expect(SYNTHETIC_TOOLS.map((t) => t.name).sort()).toStrictEqual([
      'synthetic_tasks_approve',
      'synthetic_tasks_commit',
      'synthetic_tasks_create',
      'synthetic_tasks_get',
      'synthetic_tasks_get_proposal',
      'synthetic_tasks_list',
      'synthetic_tasks_propose',
      'synthetic_tasks_relabel',
    ]);
  });

  it.each(SYNTHETIC_TOOLS.map((t) => [t.name, t] as const))(
    '%s mirrors its REST input schema',
    (_n, tool) => {
      const route = synthetic.find((r) => r.operationId === tool.operationId);
      expect(route).toBeDefined();
      if (!route) return;
      const toolSchema = tool.inputSchema;
      const toolProps = Object.keys(toolSchema.properties);
      const transport = toolProps.filter((p) => TRANSPORT_ONLY.has(p));
      // Only the Idempotency-Key header and path parameters are transport additions.
      const headerKey = route.method === 'post' && !route.path.includes('{proposalRef}');
      expect(toolSchema.additionalProperties).toBe(false);
      expect(transport.sort()).toStrictEqual(
        [
          ...(headerKey ? ['idempotencyKey'] : []),
          ...(route.path.includes('{taskRef}') ? ['taskRef'] : []),
          ...(route.path.includes('{proposalRef}') ? ['proposalRef'] : []),
        ].sort(),
      );

      const { defs, shape } = restShape(tool.operationId, route.requestBody);
      const rest = shape as { properties: Schema; required?: string[] };
      const bodyProps = Object.keys(rest.properties).sort();
      expect(toolProps.filter((p) => !TRANSPORT_ONLY.has(p)).sort()).toStrictEqual(bodyProps);
      expect(toolSchema.required.filter((p) => !TRANSPORT_ONLY.has(p)).sort()).toStrictEqual(
        [...(rest.required ?? [])].sort(),
      );

      const local = toolSchema.$defs as Record<string, Schema>;
      for (const p of bodyProps) {
        expect(resolve(toolSchema.properties[p], local)).toStrictEqual(resolve(rest.properties[p], defs));
      }
      if (headerKey) {
        expect(resolve(toolSchema.properties.idempotencyKey, local)).toStrictEqual(
          resolve(TASK_DEFS.IdempotencyKey, TASK_DEFS),
        );
      }
      if (route.path.includes('{taskRef}')) {
        expect(resolve(toolSchema.properties.taskRef, local)).toStrictEqual(
          resolve(TASK_DEFS.TaskRef, TASK_DEFS),
        );
      }
      if (route.path.includes('{proposalRef}')) {
        expect(resolve(toolSchema.properties.proposalRef, local)).toStrictEqual(
          resolve(PROPOSAL_DEFS.ProposalRef, PROPOSAL_DEFS),
        );
      }
      // Contract definitions copied into the tool must be byte-identical to the published ones.
      for (const [name, def] of Object.entries(local)) expect(def).toStrictEqual(defs[name]);
    },
  );
});

/**
 * Hardening (review of 6540a56): tools with `onInvalid: 'domain'` run their handler before the MCP
 * schema verdict is applied, so a tool schema stricter than the domain validator could let the domain
 * execute a call that MCP then reports as `invalid_request`. Their input schema must therefore be
 * exactly the domain's sub-schema plus transport-only properties validated by the same definitions.
 */
const DOMAIN_VALIDATED: Record<string, { body: string; transport: Record<string, Schema> }> = {
  'syntheticTasks.proposals.prepare': {
    body: 'ProposalPrepare',
    transport: { idempotencyKey: TASK_DEFS.IdempotencyKey as Schema },
  },
  'syntheticTasks.proposals.approve': {
    body: 'ProposalApprove',
    transport: { proposalRef: PROPOSAL_DEFS.ProposalRef as Schema },
  },
  'syntheticTasks.proposals.commit': {
    body: 'ProposalCommit',
    transport: { proposalRef: PROPOSAL_DEFS.ProposalRef as Schema },
  },
};

describe('domain-validated MCP tools are never stricter than the domain validator', () => {
  const domainTools = TOOLS.filter((t) => t.onInvalid === 'domain');

  it('exactly the three mutating proposal tools validate in the domain', () => {
    expect(domainTools.map((t) => t.operationId).sort()).toStrictEqual(Object.keys(DOMAIN_VALIDATED).sort());
  });

  it.each(domainTools.map((t) => [t.name, t] as const))('%s equals the domain sub-schema', (_n, tool) => {
    const spec = DOMAIN_VALIDATED[tool.operationId];
    expect(spec).toBeDefined();
    if (!spec) return;
    const body = PROPOSAL_DEFS[spec.body] as {
      properties: Schema;
      required: string[];
      additionalProperties: unknown;
    };
    const local = tool.inputSchema.$defs as Record<string, Schema>;
    const expected = resolve(
      {
        type: 'object',
        additionalProperties: body.additionalProperties,
        required: [...body.required, ...Object.keys(spec.transport)].sort(),
        properties: { ...body.properties, ...spec.transport },
      },
      { ...PROPOSAL_DEFS, ...TASK_DEFS },
    );
    const actual = resolve(
      {
        type: tool.inputSchema.type,
        additionalProperties: tool.inputSchema.additionalProperties,
        required: [...tool.inputSchema.required].sort(),
        properties: tool.inputSchema.properties,
      },
      local,
    );
    expect(actual).toStrictEqual(expected);
  });
});

/**
 * Patient tools (S4-S6): one tool per patient REST operation, each input schema exactly the REST body
 * (or query) plus the transport-only path references and, for mutations, the Idempotency-Key.
 */
const PATIENT_DEFS = patientSchema.$defs as Record<string, Schema>;
const patientRoutes = ROUTES.filter((r) => r.operationId.startsWith('patients.'));
const PATIENT_TOOLS = TOOLS.filter((t) => t.operationId.startsWith('patients.'));
/** Path parameters that are transport-only for patient tools. */
const PATIENT_PATH_REFS = ['patientRef', 'relationshipRef', 'mergeRef'];
/** REST GET routes take their arguments from the query; this maps them to the contract shape. */
const PATIENT_QUERIES: Record<string, string> = {
  'patients.read': 'PatientReadQuery',
  'patients.relationships.list': 'RelationshipListQuery',
  'patients.access.resolve': 'PatientAccessQuery',
  'patients.duplicates.find': 'DuplicateQuery',
  'patients.merges.list': 'MergeHistoryQuery',
};
const PATIENT_TOOL_NAMES = [
  'patients_add_relationship',
  'patients_create',
  'patients_find_duplicates',
  'patients_get',
  'patients_list_merge_history',
  'patients_list_relationships',
  'patients_merge',
  'patients_resolve_access',
  'patients_revoke_relationship',
  'patients_search',
  'patients_set_status',
  'patients_unmerge',
  'patients_update_demographics',
];

describe('REST/MCP contract drift (patients)', () => {
  it('exposes exactly one tool per patient REST operation and no others', () => {
    expect(PATIENT_TOOLS.map((t) => t.operationId).sort()).toStrictEqual(
      patientRoutes.map((r) => r.operationId).sort(),
    );
    expect(PATIENT_TOOLS.map((t) => t.name).sort()).toStrictEqual(PATIENT_TOOL_NAMES);
    expect(PATIENT_TOOLS.every((t) => t.onInvalid !== 'domain')).toBe(true);
  });

  it.each(PATIENT_TOOLS.map((t) => [t.name, t] as const))('%s mirrors its REST input schema', (_n, tool) => {
    const route = patientRoutes.find((r) => r.operationId === tool.operationId);
    expect(route).toBeDefined();
    if (!route) return;
    const shapeName = route.requestBody?.slice('patient:'.length) ?? PATIENT_QUERIES[route.operationId];
    const rest = (shapeName ? PATIENT_DEFS[shapeName] : { properties: {}, required: [] }) as {
      properties: Schema;
      required?: string[];
    };
    const pathRefs = PATIENT_PATH_REFS.filter((p) => route.path.includes(`{${p}}`));
    const keyed = !tool.readOnly;
    const transport = [...pathRefs, ...(keyed ? ['idempotencyKey'] : [])].sort();
    const toolSchema = tool.inputSchema;
    expect(toolSchema.additionalProperties).toBe(false);
    const toolProps = Object.keys(toolSchema.properties);
    expect(toolProps.filter((p) => transport.includes(p)).sort()).toStrictEqual(transport);
    expect(toolProps.filter((p) => !transport.includes(p)).sort()).toStrictEqual(
      Object.keys(rest.properties).sort(),
    );
    expect(toolSchema.required.filter((p) => !transport.includes(p)).sort()).toStrictEqual(
      [...(rest.required ?? [])].sort(),
    );
    expect([...toolSchema.required].filter((p) => transport.includes(p)).sort()).toStrictEqual(transport);
    const local = toolSchema.$defs as Record<string, Schema>;
    for (const p of Object.keys(rest.properties)) {
      expect(resolve(toolSchema.properties[p], local)).toStrictEqual(
        resolve(rest.properties[p], PATIENT_DEFS),
      );
    }
    for (const p of pathRefs) {
      const defName = p.charAt(0).toUpperCase() + p.slice(1);
      expect(resolve(toolSchema.properties[p], local)).toStrictEqual(
        resolve(PATIENT_DEFS[defName], PATIENT_DEFS),
      );
    }
    if (keyed) {
      expect(resolve(toolSchema.properties.idempotencyKey, local)).toStrictEqual(
        resolve(TASK_DEFS.IdempotencyKey, TASK_DEFS),
      );
    }
    for (const [name, def] of Object.entries(local)) expect(def).toStrictEqual(PATIENT_DEFS[name]);
  });
});
