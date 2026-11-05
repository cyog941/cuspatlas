import { BILLING_OPS, pathParamsOf } from '@cuspatlas/api';
import { billingSchema } from '@cuspatlas/contracts';
import { BILLING_TRANSPORT } from './billing';
import { type Args, inputSchema, type ToolDefinition, without } from './synthetic-tasks';

const DEFS = billingSchema.$defs as Record<string, unknown>;
type Def = { properties: Record<string, object>; required?: string[] };

/** Transport-only properties (path parameters and the Idempotency-Key): the billing table. */
const TRANSPORT = BILLING_TRANSPORT;

/**
 * MCP twins of every BILLING_OPS route, derived mechanically: the input schema is the REST body (or
 * GET query) definition plus the path parameters and, for a keyed POST, `idempotencyKey`. The
 * handler calls the same domain function REST calls; invalid arguments are refused after the caller
 * is authorized for the same action (identical denial and attempt row).
 */
export const BILLING_OP_TOOLS: readonly ToolDefinition[] = BILLING_OPS.map((op) => {
  const params = pathParamsOf(op.path);
  const keyed = op.method === 'post' && op.unkeyed !== true;
  const transport = [...params, ...(keyed ? ['idempotencyKey'] : [])];
  const body = op.requestBody?.replace('billing:', '') ?? op.query ?? null;
  const d = body === null ? { properties: {}, required: [] } : (DEFS[body] as Def);
  const props: Record<string, object | string> = { ...d.properties };
  for (const t of transport) props[t] = TRANSPORT[t] as string;
  return {
    name: op.tool,
    operationId: op.operationId,
    description: op.description,
    inputSchema: inputSchema(props, [...(d.required ?? []), ...transport], DEFS),
    readOnly: !keyed && op.method === 'get',
    onInvalid: { action: op.operationId },
    run: (deps, actor, args: Args) =>
      op.invoke(deps.billing, actor, {
        params: Object.fromEntries(params.map((p) => [p, String(args[p] ?? '')])),
        body: op.method === 'post' && op.unkeyed === true ? {} : without(args, ...transport),
        key: typeof args.idempotencyKey === 'string' ? args.idempotencyKey : '',
      }),
  };
});
