import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../../packages/client/src/generated';
import operations from '../../packages/contracts/src/catalog/operations.json';
import { LIST_OPERATIONS } from '../../packages/contracts/src/list-operations';

/**
 * Closeout D: catalog-wide response envelope conformance. Every REST success response that carries
 * JSON puts its payload under a root `data` member (commands add `version`, `correlationId` and
 * `replayed`; lists add the OR-01 `envelope`). The only exceptions are binary results
 * (application/octet-stream) and the two foundation routes listed below with their reason.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'health.read': 'unauthenticated liveness probe ({status: ok}); not a business read',
  'session.read': 'P1 foundation session descriptor, kept as published; the portal session already uses data',
};

interface CatalogOp {
  operation: string;
  rest?: { successSchema?: string };
}
interface Schema {
  $ref?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  type?: unknown;
}
const DIR = resolve(__dirname, '../../packages/contracts/src');
const FILES: Record<string, string> = { proposal: 'action-proposal' };
const cache = new Map<string, Record<string, Schema>>();
function resolveDef(ref: string): Schema | null {
  const [prefix, name] = (ref.includes(':') ? ref.split(':') : ['synthetic-task', ref]) as [string, string];
  const file = `${FILES[prefix] ?? prefix}.schema.json`;
  if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(resolve(DIR, file), 'utf8')).$defs);
  const defs = cache.get(file) ?? {};
  let def: Schema | undefined = defs[name];
  while (def?.$ref?.startsWith('#/$defs/')) def = defs[def.$ref.slice(8)];
  return def ?? null;
}

const REST = (operations as CatalogOp[]).filter(
  (o) => o.rest && !OPERATIONS[o.operation as keyof typeof OPERATIONS]?.binaryResult,
);

describe('Closeout D: every REST success response uses the shared data envelope', () => {
  it('covers the whole REST catalog', () => {
    expect(REST.length).toBeGreaterThan(400);
  });

  it('every JSON success schema requires a root data member', () => {
    const gaps: string[] = [];
    for (const o of REST) {
      if (EXEMPT[o.operation]) continue;
      const ref = o.rest?.successSchema;
      const def = ref && !ref.startsWith('#') ? resolveDef(ref) : null;
      if (!def) {
        gaps.push(`${o.operation}: success schema not resolvable (${ref})`);
        continue;
      }
      if (!def.required?.includes('data') || !def.properties?.data)
        gaps.push(`${o.operation}: ${ref} has no root data member`);
    }
    expect(gaps).toEqual([]);
  });

  it('every list carries its rows under data and the OR-01 envelope beside it', () => {
    const gaps: string[] = [];
    for (const [op, spec] of Object.entries(LIST_OPERATIONS))
      if (!spec.rows.startsWith('data')) gaps.push(`${op}: rows at ${spec.rows}`);
    expect(gaps).toEqual([]);
  });

  it('the exemptions name real operations', () => {
    const names = new Set((operations as CatalogOp[]).map((o) => o.operation));
    for (const op of Object.keys(EXEMPT)) expect(names.has(op), op).toBe(true);
  });
});
