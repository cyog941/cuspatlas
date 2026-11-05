import { AGENT_OPS } from '@cuspatlas/api';
import { agentsSchema } from '@cuspatlas/contracts';
import { type Args, inputSchema, type ToolDefinition, without } from './synthetic-tasks';

const DEFS = agentsSchema.$defs as Record<string, unknown>;
type Def = { properties: Record<string, object>; required?: string[] };

/**
 * MCP twins of every AGENT_OPS route (workstream A batch 2), derived mechanically like the migration
 * tools: the input schema is the REST body (or GET query) definition plus `idempotencyKey` for a POST.
 * The handler calls the same domain function REST calls; invalid arguments are refused after the
 * caller is authorized for the same action.
 */
export const AGENT_TOOLS: readonly ToolDefinition[] = AGENT_OPS.map((op) => {
  const keyed = op.method === 'post';
  const body = op.requestBody?.replace('agents:', '') ?? op.query ?? null;
  const d = body === null ? { properties: {}, required: [] } : (DEFS[body] as Def);
  const props: Record<string, object | string> = { ...d.properties };
  if (keyed) props.idempotencyKey = 'IdempotencyKey';
  return {
    name: op.tool,
    operationId: op.operationId,
    description: op.description,
    inputSchema: inputSchema(props, [...(d.required ?? []), ...(keyed ? ['idempotencyKey'] : [])], DEFS),
    readOnly: !keyed,
    onInvalid: { action: op.operationId },
    run: (deps, actor, args: Args) =>
      op.invoke(deps.agents, actor, {
        params: {},
        body: without(args, 'idempotencyKey'),
        key: typeof args.idempotencyKey === 'string' ? args.idempotencyKey : '',
      }),
  };
});
