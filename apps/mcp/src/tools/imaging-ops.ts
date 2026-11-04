import { IMAGING_OPS, pathParamsOf } from '@cuspatlas/api';
import { imagingSchema } from '@cuspatlas/contracts';
import { type Args, inputSchema, type ToolDefinition, without } from './synthetic-tasks';

const DEFS = imagingSchema.$defs as Record<string, unknown>;
type Def = { properties: Record<string, object>; required?: string[] };

/** Transport-only properties of imaging tools and the contract definition each one uses. */
export const IMAGING_TRANSPORT: Record<string, string> = {
  idempotencyKey: 'IdempotencyKey',
  objectRef: 'ObjectRef',
  grantRef: 'GrantRef',
  ingressRef: 'IngressRef',
  decisionRef: 'DecisionRef',
  imageRef: 'ImageRef',
  mountRef: 'MountRef',
  annotationRef: 'AnnotationRef',
  legalHoldRef: 'LegalHoldRef',
  deletionRef: 'DeletionRef',
};

/** Input schema = the REST body (or GET query) properties plus path parameters and `idempotencyKey`. */
export function imagingSchemaFor(body: string | null, transport: readonly string[]) {
  const d = body === null ? { properties: {}, required: [] } : (DEFS[body] as Def);
  const props: Record<string, object | string> = { ...d.properties };
  for (const t of transport) props[t] = IMAGING_TRANSPORT[t] as string;
  return inputSchema(props, [...(d.required ?? []), ...transport], DEFS);
}

/**
 * MCP twins of every IMAGING_OPS route except the byte transports (REST only: MCP returns
 * references and metadata, never object bytes). Derived mechanically like the scheduling tools; the
 * handler calls the same domain function REST calls.
 */
export const IMAGING_TOOLS: readonly ToolDefinition[] = IMAGING_OPS.filter((op) => op.restOnly !== true).map(
  (op) => {
    const params = pathParamsOf(op.path);
    const keyed = op.method === 'post' && op.unkeyed !== true;
    const transport = [...params, ...(keyed ? ['idempotencyKey'] : [])];
    const body = op.requestBody?.replace('imaging:', '') ?? op.query ?? null;
    return {
      name: op.tool,
      operationId: op.operationId,
      description: op.description,
      inputSchema: imagingSchemaFor(body, transport),
      readOnly: op.method === 'get',
      onInvalid: { action: op.operationId },
      run: (deps, actor, args: Args) =>
        op.invoke(deps.imaging, actor, {
          params: Object.fromEntries(params.map((p) => [p, String(args[p] ?? '')])),
          body: without(args, ...transport),
          key: typeof args.idempotencyKey === 'string' ? args.idempotencyKey : '',
        }),
    };
  },
);
