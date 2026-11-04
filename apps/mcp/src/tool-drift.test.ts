import { ROUTES } from '@cuspatlas/api';
import { syntheticTaskSchema } from '@cuspatlas/contracts';
import { describe, expect, it } from 'vitest';
import { SYNTHETIC_TASK_TOOLS } from './tools/synthetic-tasks';

type Schema = Record<string, unknown>;
const DEFS = syntheticTaskSchema.$defs as Record<string, Schema>;

/** Resolves a $ref against the published contract so tool and REST schemas compare structurally. */
function resolve(schema: unknown, local: Record<string, Schema> = DEFS): unknown {
  if (Array.isArray(schema)) return schema.map((s) => resolve(s, local));
  if (schema !== null && typeof schema === 'object') {
    const o = schema as Schema;
    if (typeof o.$ref === 'string') return resolve(local[o.$ref.replace('#/$defs/', '')], local);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolve(v, local)]));
  }
  return schema;
}

const TRANSPORT_ONLY = new Set(['idempotencyKey', 'taskRef']);
const synthetic = ROUTES.filter((r) => r.operationId.startsWith('syntheticTasks.'));

describe('REST/MCP contract drift (synthetic tasks)', () => {
  it('exposes exactly one tool per REST operation and no others', () => {
    expect(SYNTHETIC_TASK_TOOLS.map((t) => t.operationId).sort()).toStrictEqual(
      synthetic.map((r) => r.operationId).sort(),
    );
    expect(SYNTHETIC_TASK_TOOLS.map((t) => t.name).sort()).toStrictEqual([
      'synthetic_tasks_create',
      'synthetic_tasks_get',
      'synthetic_tasks_list',
      'synthetic_tasks_relabel',
    ]);
  });

  it.each(SYNTHETIC_TASK_TOOLS.map((t) => [t.name, t] as const))(
    '%s mirrors its REST input schema',
    (_n, tool) => {
      const route = synthetic.find((r) => r.operationId === tool.operationId);
      expect(route).toBeDefined();
      const toolSchema = tool.inputSchema;
      const toolProps = Object.keys(toolSchema.properties);
      const transport = toolProps.filter((p) => TRANSPORT_ONLY.has(p));
      // Only the header and path parameters are transport additions; everything else is the REST schema.
      expect(toolSchema.additionalProperties).toBe(false);
      expect(transport.sort()).toStrictEqual(
        [
          ...(route?.method === 'post' ? ['idempotencyKey'] : []),
          ...(route?.path.includes('{taskRef}') ? ['taskRef'] : []),
        ].sort(),
      );

      const restShape =
        route?.requestBody !== undefined
          ? (DEFS[route.requestBody] as { properties: Schema; required?: string[] })
          : tool.operationId === 'syntheticTasks.list'
            ? (DEFS.SyntheticTaskListQuery as { properties: Schema; required?: string[] })
            : { properties: {}, required: [] };
      const bodyProps = Object.keys(restShape.properties).sort();
      expect(toolProps.filter((p) => !TRANSPORT_ONLY.has(p)).sort()).toStrictEqual(bodyProps);
      expect(toolSchema.required.filter((p) => !TRANSPORT_ONLY.has(p)).sort()).toStrictEqual(
        [...(restShape.required ?? [])].sort(),
      );

      const local = toolSchema.$defs as Record<string, Schema>;
      for (const p of bodyProps) {
        expect(resolve(toolSchema.properties[p], local)).toStrictEqual(resolve(restShape.properties[p]));
      }
      if (tool.operationId !== 'syntheticTasks.list' && route?.method === 'post') {
        expect(resolve(toolSchema.properties.idempotencyKey, local)).toStrictEqual(
          resolve(DEFS.IdempotencyKey),
        );
      }
      if (route?.path.includes('{taskRef}')) {
        expect(resolve(toolSchema.properties.taskRef, local)).toStrictEqual(resolve(DEFS.TaskRef));
      }
      // Contract definitions copied into the tool must be byte-identical to the published ones.
      for (const [name, def] of Object.entries(local)) expect(def).toStrictEqual(DEFS[name]);
    },
  );
});
