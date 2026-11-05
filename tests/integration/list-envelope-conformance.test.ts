import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIST_ENVELOPE_SCHEMA_DEFS } from '../../packages/contracts/src/list-envelope';

/**
 * OR-01: one list envelope. The TypeScript type lives in contracts `list-envelope.ts`; every schema
 * file that returns a list carries the same four `$defs` verbatim, and no file defines its own.
 */
const DIR = resolve(__dirname, '../../packages/contracts/src');
const schema = (file: string) =>
  JSON.parse(readFileSync(resolve(DIR, file), 'utf8')) as { $defs: Record<string, unknown> };
const NAMES = Object.keys(LIST_ENVELOPE_SCHEMA_DEFS) as (keyof typeof LIST_ENVELOPE_SCHEMA_DEFS)[];

/** Every `$defs` entry whose properties include an `envelope`. */
const envelopeHolders = (defs: Record<string, unknown>) =>
  Object.entries(defs).flatMap(([name, def]) => {
    const found: [string, unknown][] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      const props = (node as { properties?: Record<string, unknown> }).properties;
      if (props?.envelope) found.push([path, props.envelope]);
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    };
    walk(def, name);
    return found;
  });

describe('OR-01 shared list envelope', () => {
  it('engagement (E10) and scheduling (S18-S22) carry the canonical definitions verbatim', () => {
    for (const file of ['engagement.schema.json', 'scheduling.schema.json']) {
      const defs = schema(file).$defs;
      for (const name of NAMES)
        expect(defs[name], `${file} ${name}`).toStrictEqual(LIST_ENVELOPE_SCHEMA_DEFS[name]);
    }
  });

  it('no other contract schema defines a list envelope of its own', () => {
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.schema.json'))) {
      const defs = schema(file).$defs ?? {};
      for (const name of NAMES) {
        if (name in defs)
          expect(defs[name], `${file} ${name}`).toStrictEqual(LIST_ENVELOPE_SCHEMA_DEFS[name]);
      }
    }
  });

  it('every S list refers to ListEnvelope, and the E10 thread list flattens exactly its properties', () => {
    const s = envelopeHolders(schema('scheduling.schema.json').$defs);
    expect(s.length).toBeGreaterThanOrEqual(4);
    for (const [path, env] of s) expect(env, path).toStrictEqual({ $ref: '#/$defs/ListEnvelope' });

    const data = (
      schema('engagement.schema.json').$defs.ThreadList as {
        properties: { data: { required: string[]; properties: Record<string, unknown> } };
      }
    ).properties.data;
    const canonical = LIST_ENVELOPE_SCHEMA_DEFS.ListEnvelope;
    for (const key of canonical.required) {
      expect(data.required).toContain(key);
      expect(data.properties[key], key).toStrictEqual(canonical.properties[key]);
    }
  });
});
