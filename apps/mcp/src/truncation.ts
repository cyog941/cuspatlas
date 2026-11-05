import { outputSchemaOf } from './output-schema';
import type { ToolDefinition } from './tools/synthetic-tasks';

/**
 * Closeout C: the A9 truncation contract as advertised in `tools/list`. The server settles every
 * read-only tool call of an agent through `settleQuery`; a list answer over a per-call record or PHI
 * budget comes back shortened, with `_meta.truncated` (schema below). Passing its `resumeCursor` with
 * the same arguments reruns the query and skips the records already returned. The cursor is a
 * transport argument of agent calls, stripped before validation, so the registered (validated) tool
 * schema never contains it; only the copy advertised to an agent does.
 */
export const TRUNCATION_META_KEY = 'cuspatlas/truncation';

export const RESUME_CURSOR_PROPERTY = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  description:
    'Agent callers only: the _meta.truncated.resumeCursor of an earlier truncated answer of this tool with the same arguments. Resumes after the records already returned; a malformed or foreign cursor is invalid_request (resume_cursor_invalid). Records can shift if the list changed in between.',
} as const;

/** JSON Schema of the `_meta.truncated` object of a truncated answer. */
export const TRUNCATION_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description:
    'Present in the result _meta only when the answer was shortened to fit the per-call record or PHI budget of an agent. Only the returned records are charged.',
  required: ['returned', 'omitted', 'limit', 'resumeCursor'],
  properties: {
    returned: { type: 'integer', minimum: 1 },
    omitted: { type: 'integer', minimum: 1 },
    limit: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'value'],
      properties: {
        name: { enum: ['recordsPerCall', 'phiFieldsPerCall'] },
        value: { type: 'integer', minimum: 0 },
      },
    },
    resumeCursor: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

/** True for every tool whose agent answers the server may truncate (every read-only tool). */
export const isTruncatable = (tool: Pick<ToolDefinition, 'readOnly'>): boolean => tool.readOnly;

/**
 * The `tools/list` entry of a tool. For an agent caller (the only caller the server ever truncates)
 * truncatable tools also advertise the cursor input and output; any other caller is listed the
 * registered schema only, so a cursor it sends is refused like any unknown argument.
 */
export function advertisedTool(
  tool: ToolDefinition,
  description: string,
  caller: { readonly agent: boolean },
) {
  // Closeout D6: a read-only list tool also declares its outputSchema (every caller).
  const output = tool.readOnly ? outputSchemaOf(tool.operationId) : null;
  const base = {
    name: tool.name,
    description,
    annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
    ...(output ? { outputSchema: output } : {}),
  };
  if (!caller.agent || !isTruncatable(tool))
    return { ...base, inputSchema: tool.inputSchema } as typeof base & {
      inputSchema: ToolDefinition['inputSchema'];
      outputSchema?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    };
  return {
    ...base,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...(tool.inputSchema.properties ?? {}), resumeCursor: RESUME_CURSOR_PROPERTY },
    },
    _meta: { [TRUNCATION_META_KEY]: TRUNCATION_RESULT_SCHEMA },
  };
}
