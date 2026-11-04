import { ROUTES } from '@cuspatlas/api';
import { actionProposalSchema, syntheticTaskSchema } from '@cuspatlas/contracts';
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
    expect(TOOLS.map((t) => t.operationId).sort()).toStrictEqual(synthetic.map((r) => r.operationId).sort());
    expect(TOOLS.map((t) => t.name).sort()).toStrictEqual([
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

  it.each(TOOLS.map((t) => [t.name, t] as const))('%s mirrors its REST input schema', (_n, tool) => {
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
  });
});
