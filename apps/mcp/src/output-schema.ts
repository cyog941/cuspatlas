import {
  actionProposalSchema,
  agentsSchema,
  automationSchema,
  billingSchema,
  type CatalogOperation,
  clinicalSchema,
  engagementSchema,
  imagingSchema,
  LIST_OPERATIONS,
  migrationSchema,
  patientSchema,
  schedulingSchema,
  syntheticTaskSchema,
} from '@cuspatlas/contracts';
import operations from '@cuspatlas/contracts/catalog/operations.json' with { type: 'json' };

/**
 * Closeout D6: the MCP `outputSchema` of a read-only list tool. It is the operation's published REST
 * success schema (rows under `data`, the OR-01 `envelope`, any vocabulary versions), bundled with every
 * definition it reaches so it is self-contained, without a `$schema` (validators use their default
 * draft). The SDK client validates a structured result against it, a refusal included (its structured
 * content is the typed refusal), so the schema is `anyOf` the success schema and the refusal envelope.
 * Truncation stays described by the `cuspatlas/truncation` `_meta` entry: a truncated answer is a
 * shorter `data` array, still conforming.
 */
type Json = Record<string, unknown>;
const FILES: Readonly<Record<string, { readonly $defs: Readonly<Record<string, unknown>> }>> = {
  proposal: actionProposalSchema,
  agents: agentsSchema,
  automation: automationSchema,
  billing: billingSchema,
  clinical: clinicalSchema,
  engagement: engagementSchema,
  imaging: imagingSchema,
  migration: migrationSchema,
  patient: patientSchema,
  scheduling: schedulingSchema,
  'synthetic-task': syntheticTaskSchema,
} as never;
const BY_OPERATION = new Map((operations as CatalogOperation[]).map((o) => [o.operation, o]));
const cache = new Map<string, Json | null>();

/** The refusal envelope every tool may answer (`isError: true`), described by its stable fields. */
export const REFUSAL_OUTPUT_SCHEMA = {
  type: 'object',
  description: 'A typed refusal (isError true): code, retryable, correlationId and an optional safe detail.',
  required: ['code', 'retryable', 'correlationId'],
  properties: {
    code: { type: 'string', pattern: '^[a-z_]{1,64}$' },
    retryable: { type: 'boolean' },
    correlationId: { type: 'string', maxLength: 128 },
    detail: { type: 'object' },
  },
} as const;

function bundle(defs: Readonly<Record<string, unknown>>, root: string): Json | null {
  const reached = new Map<string, unknown>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) for (const n of node) visit(n);
    else if (node && typeof node === 'object')
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/')) enter(v.slice(8));
        else visit(v);
      }
  };
  const enter = (name: string) => {
    if (reached.has(name)) return;
    reached.set(name, defs[name]);
    visit(defs[name]);
  };
  enter(root);
  let top = defs[root] as Json | undefined;
  while (top && typeof top.$ref === 'string' && top.$ref.startsWith('#/$defs/'))
    top = defs[top.$ref.slice(8)] as Json | undefined;
  if (top?.type !== 'object') return null;
  return { type: 'object', anyOf: [top, REFUSAL_OUTPUT_SCHEMA], $defs: Object.fromEntries(reached) };
}

/** The outputSchema of a read-only list operation's MCP tool, or null for any other operation. */
export function outputSchemaOf(operation: string): Json | null {
  if (cache.has(operation)) return cache.get(operation) ?? null;
  let out: Json | null = null;
  const ref = LIST_OPERATIONS[operation] ? BY_OPERATION.get(operation)?.rest?.successSchema : undefined;
  if (ref && !ref.startsWith('#')) {
    const [prefix, name] = (ref.includes(':') ? ref.split(':') : ['synthetic-task', ref]) as [string, string];
    const defs = FILES[prefix]?.$defs;
    if (defs?.[name]) out = bundle(defs, name);
  }
  cache.set(operation, out);
  return out;
}
