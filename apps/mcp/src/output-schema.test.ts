import { LIST_OPERATIONS } from '@cuspatlas/contracts';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { outputSchemaOf, REFUSAL_OUTPUT_SCHEMA } from './output-schema';
import { TOOLS } from './server';
import { advertisedTool } from './truncation';

/**
 * Closeout D6: every read-only list tool declares an MCP `outputSchema` derived from the operation's
 * published JSON Schema (the same success schema as REST: rows under `data`, the OR-01 `envelope`), so
 * the `cuspatlas/truncation` `_meta` extension is no longer the only machine description of a list
 * answer. The schema is self-contained (every `$ref` resolves inside it) and compiles.
 */
const listTools = TOOLS.filter((t) => t.readOnly && LIST_OPERATIONS[t.operationId]);

const refsOf = (node: unknown, out: string[] = []): string[] => {
  if (Array.isArray(node)) for (const n of node) refsOf(n, out);
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else refsOf(v, out);
    }
  return out;
};

describe('Closeout D6: MCP outputSchema for read-only list tools', () => {
  it('covers every read-only list tool', () => {
    expect(listTools.length).toBeGreaterThan(50);
    for (const t of listTools)
      expect([t.name, outputSchemaOf(t.operationId) !== null]).toStrictEqual([t.name, true]);
  });

  it('is an object schema: the success schema with data, or the refusal envelope; self-contained; compiles', () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    for (const t of listTools) {
      const s = outputSchemaOf(t.operationId) as {
        type: string;
        anyOf: [{ required: string[] }, unknown];
        $defs?: Record<string, unknown>;
      };
      expect([t.name, s.type]).toStrictEqual([t.name, 'object']);
      expect([t.name, s.anyOf[0].required.includes('data')]).toStrictEqual([t.name, true]);
      expect([t.name, s.anyOf[1]]).toStrictEqual([t.name, REFUSAL_OUTPUT_SCHEMA]);
      for (const ref of refsOf(s)) {
        expect(ref.startsWith('#/$defs/'), `${t.name} ${ref}`).toBe(true);
        expect(s.$defs?.[ref.slice(8)], `${t.name} ${ref}`).toBeDefined();
      }
      expect(() => ajv.compile(s), t.name).not.toThrow();
    }
  });

  it('is advertised in tools/list for human and agent callers; commands and other reads declare none', () => {
    for (const agent of [false, true])
      for (const t of TOOLS) {
        const a = advertisedTool(t, t.description, { agent }) as { outputSchema?: unknown };
        const want = t.readOnly && LIST_OPERATIONS[t.operationId] ? outputSchemaOf(t.operationId) : undefined;
        expect([t.name, a.outputSchema]).toStrictEqual([t.name, want]);
      }
  });
});
