import { pathParamsOf, SCHEDULING_OPS } from '@cuspatlas/api';
import { schemaFor } from './appointments';
import { type Args, type ToolDefinition, without } from './synthetic-tasks';

/**
 * MCP twins of every SCHEDULING_OPS route, derived mechanically: the input schema is the REST body
 * (or GET query) definition plus the path parameters and, for a mutating POST, `idempotencyKey`. The
 * handler calls the same domain function REST calls; invalid arguments are refused after the caller
 * is authorized for the same action (identical denial and attempt row).
 */
export const SCHEDULING_OP_TOOLS: readonly ToolDefinition[] = SCHEDULING_OPS.map((op) => {
  const params = pathParamsOf(op.path);
  const keyed = op.method === 'post' && op.postRead !== true;
  const transport = [...params, ...(keyed ? ['idempotencyKey'] : [])];
  const body = op.requestBody?.replace('scheduling:', '') ?? op.query ?? null;
  return {
    name: op.tool,
    operationId: op.operationId,
    description: op.description,
    inputSchema: schemaFor(body, transport),
    readOnly: !keyed,
    onInvalid: { action: op.operationId },
    run: (deps, actor, args: Args) =>
      op.invoke(deps.appointments, actor, {
        params: Object.fromEntries(params.map((p) => [p, String(args[p] ?? '')])),
        body: without(args, ...transport),
        key: typeof args.idempotencyKey === 'string' ? args.idempotencyKey : '',
      }),
  };
});
