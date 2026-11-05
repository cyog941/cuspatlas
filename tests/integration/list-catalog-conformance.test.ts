import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import operations from '../../packages/contracts/src/catalog/operations.json';
import { LIST_ENVELOPE_SCHEMA_DEFS } from '../../packages/contracts/src/list-envelope';
import { LIST_OPERATIONS } from '../../packages/contracts/src/list-operations';

/**
 * A20 / OR-01 catalog-wide conformance. The classification rule (recorded in
 * docs/execution/api-progress.md, "A20/B11"): an operation is a **list** when its catalog kind is
 * `query` and either
 *   (a) its REST success schema's `data` is a JSON array (`type: 'array'` exactly, not a union), or
 *   (b) the final segment of its operation id is `list*`, `search`, `worklist`, `find`, `enrollments`
 *       or `daily`, or ends in `List`.
 * Every list must be registered in LIST_OPERATIONS (ordering with tie-break, limit, scope rule, rows
 * path) and its success schema must carry the canonical ListEnvelope at the registered placement.
 */
interface CatalogOp {
  operation: string;
  kind: string;
  rest?: { method: string; path: string; successSchema?: string };
  mcpTool?: string;
}
const OPS = operations as CatalogOp[];
const DIR = resolve(__dirname, '../../packages/contracts/src');
const FILES: Record<string, string> = { proposal: 'action-proposal' };
const cache = new Map<string, { $defs: Record<string, Schema> }>();
interface Schema {
  type?: unknown;
  $ref?: string;
  properties?: Record<string, Schema>;
  required?: string[];
}
function schemaOf(
  ref: string | undefined,
): { file: string; defs: Record<string, Schema>; def: Schema } | null {
  if (!ref || ref.startsWith('#')) return null;
  // Synthetic-task refs carry no prefix (synthetic-task.schema.json predates the prefixed form).
  const [prefix, name] = (ref.includes(':') ? ref.split(':') : ['synthetic-task', ref]) as [string, string];
  const file = `${FILES[prefix] ?? prefix}.schema.json`;
  if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(resolve(DIR, file), 'utf8')));
  const defs = cache.get(file)?.$defs ?? {};
  const def = defs[name];
  return def ? { file, defs, def } : null;
}
const deref = (defs: Record<string, Schema>, s: Schema | undefined): Schema | undefined =>
  s?.$ref?.startsWith('#/$defs/') ? deref(defs, defs[s.$ref.slice(8)]) : s;

const NAME_RULE = /^(list\w*|search|worklist|find|enrollments|daily|\w+List)$/;
export function isListOperation(op: CatalogOp): boolean {
  if (op.kind !== 'query') return false;
  const last = op.operation.split('.').at(-1) ?? '';
  if (NAME_RULE.test(last)) return true;
  const s = schemaOf(op.rest?.successSchema);
  return deref(s?.defs ?? {}, s?.def.properties?.data)?.type === 'array';
}

const LISTS = OPS.filter(isListOperation);

describe('A20 / OR-01 catalog-wide list envelope conformance', () => {
  it('classifies a stable, non-trivial set of list operations', () => {
    expect(LISTS.length).toBeGreaterThanOrEqual(50);
  });

  it('every list operation is registered, and every registration is a catalog list', () => {
    const registered = new Set(Object.keys(LIST_OPERATIONS));
    const missing = LISTS.map((o) => o.operation).filter((o) => !registered.has(o));
    expect(missing, 'list operations without a LIST_OPERATIONS entry').toEqual([]);
    const listed = new Set(LISTS.map((o) => o.operation));
    expect(
      [...registered].filter((o) => !listed.has(o)),
      'registered but not a list',
    ).toEqual([]);
  });

  it('every list declares ordering with a documented tie-break distinct from its key', () => {
    for (const [op, spec] of Object.entries(LIST_OPERATIONS)) {
      expect(spec.ordering.tieBreak, op).toMatch(/^[A-Za-z.]{1,64}$/);
      expect(spec.ordering.tieBreak, op).not.toBe(spec.ordering.key);
      expect(spec.rows, op).toMatch(/^data(\.[A-Za-z]+)?$/);
    }
  });

  it('every list success schema carries the canonical ListEnvelope where the response puts it', () => {
    const gaps: string[] = [];
    for (const op of LISTS) {
      const s = schemaOf(op.rest?.successSchema);
      if (!s) {
        gaps.push(`${op.operation}: success schema not resolvable (${op.rest?.successSchema})`);
        continue;
      }
      for (const name of Object.keys(LIST_ENVELOPE_SCHEMA_DEFS) as (keyof typeof LIST_ENVELOPE_SCHEMA_DEFS)[])
        if (JSON.stringify(s.defs[name]) !== JSON.stringify(LIST_ENVELOPE_SCHEMA_DEFS[name]))
          gaps.push(`${op.operation}: ${s.file} lacks the canonical ${name}`);
      const data = deref(s.defs, s.def.properties?.data);
      const top =
        s.def.properties?.envelope?.$ref === '#/$defs/ListEnvelope' && s.def.required?.includes('envelope');
      const nested =
        data?.properties?.envelope?.$ref === '#/$defs/ListEnvelope' && data.required?.includes('envelope');
      const flattened = LIST_ENVELOPE_SCHEMA_DEFS.ListEnvelope.required.every(
        (k) => data?.required?.includes(k) && data.properties?.[k],
      );
      if (!(top || nested || flattened))
        gaps.push(`${op.operation}: ${op.rest?.successSchema} has no envelope`);
    }
    expect(gaps).toEqual([]);
  });
});
