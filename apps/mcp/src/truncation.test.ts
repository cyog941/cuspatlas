import { describe, expect, it } from 'vitest';
import { TOOLS } from './server';
import {
  advertisedTool,
  RESUME_CURSOR_PROPERTY,
  TRUNCATION_META_KEY,
  TRUNCATION_RESULT_SCHEMA,
} from './truncation';

/**
 * Closeout C: A9 truncation is discoverable. Every tool the server may truncate for an agent (every
 * read-only tool: the server settles each read-only agent call through `settleQuery`) advertises the
 * optional `resumeCursor` input and, in its tool `_meta`, the JSON Schema of the `_meta.truncated`
 * object a truncated answer carries. Commands are never truncated and advertise neither.
 */
describe('resumeCursor advertisement', () => {
  it('every truncatable (read-only) tool declares the resume cursor input and the truncation output', () => {
    const readOnly = TOOLS.filter((t) => t.readOnly);
    expect(readOnly.length).toBeGreaterThan(100);
    for (const t of readOnly) {
      const a = advertisedTool(t, t.description, { agent: true });
      const props = a.inputSchema.properties as Record<string, unknown>;
      expect([t.name, props.resumeCursor]).toStrictEqual([t.name, RESUME_CURSOR_PROPERTY]);
      expect([t.name, a.inputSchema.required?.includes('resumeCursor')]).toStrictEqual([t.name, false]);
      expect([t.name, a._meta?.[TRUNCATION_META_KEY]]).toStrictEqual([t.name, TRUNCATION_RESULT_SCHEMA]);
      expect(a.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('commands advertise neither, and the registered (validated) schema is unchanged', () => {
    for (const t of TOOLS) {
      const a = advertisedTool(t, t.description, { agent: true });
      if (!t.readOnly) {
        expect([t.name, Object.keys(a.inputSchema.properties ?? {})]).not.toContainEqual(
          expect.arrayContaining(['resumeCursor']),
        );
        expect(a._meta).toBeUndefined();
      }
      expect(Object.keys(t.inputSchema.properties ?? {})).not.toContain('resumeCursor');
      expect(a.annotations).toStrictEqual({ readOnlyHint: t.readOnly, openWorldHint: false });
    }
  });

  it('a non-agent caller (never truncated) is advertised neither the cursor nor the truncation output', () => {
    for (const t of TOOLS) {
      const a = advertisedTool(t, t.description, { agent: false });
      expect([t.name, Object.keys(a.inputSchema.properties ?? {})]).not.toContainEqual(
        expect.arrayContaining(['resumeCursor']),
      );
      expect([t.name, a._meta]).toStrictEqual([t.name, undefined]);
      expect(a.inputSchema).toStrictEqual(t.inputSchema);
    }
  });

  it('the truncation schema describes exactly what the server sends', () => {
    expect(TRUNCATION_RESULT_SCHEMA.required).toStrictEqual(['returned', 'omitted', 'limit', 'resumeCursor']);
    expect(Object.keys(TRUNCATION_RESULT_SCHEMA.properties)).toStrictEqual([
      'returned',
      'omitted',
      'limit',
      'resumeCursor',
    ]);
  });
});
