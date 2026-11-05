import { pathParamsOf, READ_OPS, READ_PARAM_DEFS } from '@cuspatlas/api';
import { syntheticTaskSchema } from '@cuspatlas/contracts';
import { type Args, inputSchema, type ToolDefinition, without } from './synthetic-tasks';

type Def = { properties?: Record<string, object>; required?: string[] };
const DEFS = syntheticTaskSchema.$defs as unknown as Record<string, Def>;

/**
 * MCP twins of every READ_OPS operation that names a tool (derived mechanically: the GET query or POST
 * body definition plus the path parameters and, for a POST, `idempotencyKey`). The handler calls the
 * same read-surface function REST calls.
 */
export const READ_OP_TOOLS: readonly ToolDefinition[] = READ_OPS.flatMap((op) => {
  if (op.tool === undefined) return [];
  const params = pathParamsOf(op.path);
  const keyed = op.method === 'post';
  const transport = [...params, ...(keyed ? ['idempotencyKey'] : [])];
  const def = op.query ? DEFS[op.query] : op.requestBody ? DEFS[op.requestBody] : undefined;
  const props: Record<string, string | object> = { ...(def?.properties ?? {}) };
  for (const p of params) props[p] = READ_PARAM_DEFS[p] ?? 'Uuid';
  if (keyed) props.idempotencyKey = 'IdempotencyKey';
  const tool: ToolDefinition = {
    name: op.tool,
    operationId: op.operationId,
    description: op.description,
    inputSchema: inputSchema(props, [...(def?.required ?? []), ...transport]),
    readOnly: !keyed,
    onInvalid: { action: op.operationId },
    run: (deps, actor, args: Args) =>
      op.invoke(deps.reads, actor, {
        params: Object.fromEntries(params.map((p) => [p, String(args[p] ?? '')])),
        body: without(args, ...transport),
        key: typeof args.idempotencyKey === 'string' ? args.idempotencyKey : '',
      }),
  };
  return [tool];
});
