import { ENGAGEMENT_OPS, pathParamsOf } from '@cuspatlas/api';
import { engagementSchema } from '@cuspatlas/contracts';
import { type Args, inputSchema, type ToolDefinition, without } from './synthetic-tasks';

const DEFS = engagementSchema.$defs as Record<string, unknown>;
type Def = { properties: Record<string, object>; required?: string[] };

/** Transport-only properties of E tools and the engagement definition each one uses. */
export const ENGAGEMENT_TRANSPORT: Record<string, string> = {
  idempotencyKey: 'IdempotencyKey',
  principalRef: 'PrincipalRef',
  patientRef: 'PatientRef',
  templateRef: 'TemplateRef',
  decisionRef: 'EntityRef',
  messageRef: 'EntityRef',
  formRef: 'FormRef',
  submissionRef: 'EntityRef',
  reviewRef: 'EntityRef',
  threadRef: 'EntityRef',
  callRef: 'EntityRef',
};

function schemaFor(body: string | null, transport: readonly string[]) {
  const d = body === null ? { properties: {}, required: [] } : (DEFS[body] as Def);
  const props: Record<string, object | string> = { ...d.properties };
  for (const t of transport) props[t] = ENGAGEMENT_TRANSPORT[t] as string;
  return inputSchema(props, [...(d.required ?? []), ...transport], DEFS as never);
}

/**
 * MCP twins of every ENGAGEMENT_OPS (staff) route, derived mechanically like the scheduling ones:
 * the REST body (or GET query) definition plus path parameters and, for a POST, `idempotencyKey`.
 * Portal-audience routes are deliberately absent: MCP is a staff and agent surface.
 */
export const ENGAGEMENT_OP_TOOLS: readonly ToolDefinition[] = ENGAGEMENT_OPS.map((op) => {
  const params = pathParamsOf(op.path);
  const keyed = op.method === 'post';
  const transport = [...params, ...(keyed ? ['idempotencyKey'] : [])];
  const body = op.requestBody?.replace('engagement:', '') ?? op.query ?? null;
  return {
    name: op.tool,
    operationId: op.operationId,
    description: op.description,
    inputSchema: schemaFor(body, transport),
    readOnly: !keyed,
    onInvalid: { action: op.operationId },
    run: (deps, actor, args: Args) => {
      if (!deps.engagement) throw new Error('engagement service not configured');
      return op.invoke(deps.engagement, actor, {
        params: Object.fromEntries(params.map((p) => [p, String(args[p] ?? '')])),
        body: without(args, ...transport),
        key: typeof args.idempotencyKey === 'string' ? args.idempotencyKey : '',
      });
    },
  };
});
