import { describe, expect, it } from 'vitest';
import type { DeprecationEntry } from '../../packages/contracts/src/catalog/catalog';
import type { Baseline } from '../../packages/contracts/src/catalog/change-control';
import {
  classifyChange,
  inputBreaks,
  summarizeInput,
} from '../../packages/contracts/src/catalog/change-control';
import {
  BASELINE_PATH,
  changeControlRefusals,
  DEPRECATIONS_PATH,
  gateViolations,
  loadBaseState,
  resolveBaseRef,
} from '../../scripts/catalog/baseline';

/** A-M1: the gate judges against the merge base, never against files edited in the same change. */
const before: Baseline = {
  version: 1,
  operations: [{ operation: 'x.op', transports: ['rest'], scope: 'x.read', principals: ['human'] }],
};
const removed: Baseline = { version: 1, operations: [] };
const entry = (announced: string, sunset: string): DeprecationEntry => ({
  operation: 'x.op',
  announced,
  sunset,
  replacedBy: null,
  note: 'synthetic',
});
const base = (deprecations: DeprecationEntry[], baseline: Baseline | null = before) => ({
  ref: 'base',
  baseline,
  deprecations,
});

describe('A-M1 change control against the merge base', () => {
  it('a deleted or corrupt working-tree baseline is fatal unless the first publication is explicit', () => {
    const missing = () => {
      throw new Error('ENOENT');
    };
    expect(() =>
      changeControlRefusals({
        current: removed,
        workingTreeBaseline: missing,
        base: base([]),
        today: '2027-09-01',
      }),
    ).toThrow('missing or corrupt');
    expect(() =>
      changeControlRefusals({
        current: removed,
        workingTreeBaseline: () => 'garbage' as unknown as Baseline,
        base: base([]),
        today: '2027-09-01',
      }),
    ).toThrow('missing or corrupt');
    expect(
      changeControlRefusals({
        current: before,
        workingTreeBaseline: missing,
        base: base([], null),
        today: '2027-09-01',
        firstPublication: true,
      }),
    ).toStrictEqual([]);
  });

  it('a deprecation written in the same change does not open the gate (only base entries count)', () => {
    // The base carries no deprecation; the working tree's entry is invisible to the gate.
    expect(
      changeControlRefusals({
        current: removed,
        workingTreeBaseline: () => before,
        base: base([]),
        today: '2027-09-01',
      }),
    ).toStrictEqual([
      'x.op $: operation removed or renamed (no deprecation entry with a sunset date at the merge base)',
    ]);
  });

  it('a backdated or too-short deprecation is refused even with a past sunset', () => {
    const changes = classifyChange(before, removed);
    expect(gateViolations(changes, [entry('2026-11-01', '2026-11-02')], '2027-01-01', 90)).toStrictEqual([
      'x.op $: operation removed or renamed (deprecation window 2026-11-01..2026-11-02 is shorter than 90 days)',
    ]);
    expect(gateViolations(changes, [entry('2026-12-01', '2026-11-01')], '2027-01-01', 90)).toStrictEqual([
      'x.op $: operation removed or renamed (deprecation announced 2026-12-01 is not before its sunset 2026-11-01)',
    ]);
    expect(gateViolations(changes, [entry('2026-11-01', '2027-05-01')], '2027-05-02', 90)).toStrictEqual([]);
    expect(gateViolations(changes, [entry('2026-11-01', '2027-05-01')], '2027-03-01', 90)).toHaveLength(1);
  });

  it('base state is read from git at the base ref; a corrupt base baseline is fatal', () => {
    const files: Record<string, string> = {
      [BASELINE_PATH]: JSON.stringify(before),
      [DEPRECATIONS_PATH]: JSON.stringify([entry('2026-11-01', '2027-05-01')]),
    };
    const state = loadBaseState('abc', (ref, path) => (ref === 'abc' ? (files[path] ?? null) : null));
    expect(state.baseline).toStrictEqual(before);
    expect(state.deprecations).toHaveLength(1);
    expect(loadBaseState('pre-catalog', () => null)).toStrictEqual({
      ref: 'pre-catalog',
      baseline: null,
      deprecations: [],
    });
    expect(() => loadBaseState('abc', () => '{not json')).toThrow('corrupt');
    expect(resolveBaseRef({ CUSPATLAS_CATALOG_BASE_REF: 'release/1' })).toBe('release/1');
  });
});

describe('A-S7 input summary and breaks', () => {
  const doc = { $defs: {} };
  const shape = (n: unknown) => summarizeInput(n, doc);
  const breaks = (a: unknown, b: unknown) =>
    inputBreaks(shape(a), shape(b)).map((c) => `${c.path} ${c.reason}`);

  it('tracks format, minItems, uniqueItems, multipleOf, exclusive bounds, not and if/then', () => {
    expect(breaks({ type: 'string' }, { type: 'string', format: 'uuid' })).toStrictEqual([
      '$ format changed',
    ]);
    expect(breaks({ type: 'array' }, { type: 'array', minItems: 1 })).toStrictEqual(['$ minItems tightened']);
    expect(breaks({ type: 'array' }, { type: 'array', uniqueItems: true })).toStrictEqual([
      '$ uniqueItems added',
    ]);
    expect(breaks({ type: 'integer' }, { type: 'integer', multipleOf: 5 })).toStrictEqual([
      '$ multipleOf changed',
    ]);
    expect(
      breaks({ type: 'number', exclusiveMaximum: 10 }, { type: 'number', exclusiveMaximum: 5 }),
    ).toStrictEqual(['$ exclusiveMaximum tightened']);
    expect(breaks({ type: 'number' }, { type: 'number', exclusiveMinimum: 0 })).toStrictEqual([
      '$ exclusiveMinimum tightened',
    ]);
    expect(breaks({ type: 'string' }, { type: 'string', not: { const: 'x' } })).toStrictEqual([
      '$ not changed',
    ]);
    expect(
      breaks(
        { type: 'object', properties: { a: { type: 'string' } } },
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          if: { required: ['a'] },
          // biome-ignore lint/suspicious/noThenProperty: the JSON Schema if/then keyword, not a thenable.
          then: { required: ['b'] },
        },
      ),
    ).toStrictEqual(['$ conditional changed']);
  });

  it('tracks map values, per-alternative anyOf and merges allOf correctly', () => {
    expect(
      breaks(
        { type: 'object', additionalProperties: { type: 'string' } },
        { type: 'object', additionalProperties: { type: 'string', maxLength: 3 } },
      ),
    ).toStrictEqual(['${} maxLength tightened']);
    // Same number of alternatives, but one was narrowed.
    expect(
      breaks(
        { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        { anyOf: [{ type: 'string' }, { type: 'boolean' }] },
      ),
    ).toStrictEqual(['$ alternative 1 no longer accepted']);
    const merged = shape({
      allOf: [
        { type: 'object', properties: { a: { type: 'string', maxLength: 10 } } },
        { properties: { a: { maxLength: 5 } }, required: ['a'], additionalProperties: false },
      ],
    });
    expect(merged.properties?.a).toStrictEqual({ type: ['string'], maxLength: 5 });
    expect(merged.closed).toBe(true);
    expect(merged.required).toStrictEqual(['a']);
  });

  it('idempotency, new refusals and newly admitted non-human principals are breaking', () => {
    const op = (extra: Record<string, unknown>) => ({
      version: 2,
      operations: [
        { operation: 'x.op', transports: ['rest'], scope: 'x.write', principals: ['human'], ...extra },
      ],
    });
    const r = (a: unknown, b: unknown) =>
      classifyChange(a as Baseline, b as Baseline).map((c) => `${c.class} ${c.reason}`);
    expect(r(op({ idempotency: 'none' }), op({ idempotency: 'required' }))).toStrictEqual([
      'breaking idempotency none -> required',
    ]);
    expect(r(op({ refusals: ['403'] }), op({ refusals: ['403', '409'] }))).toStrictEqual([
      'breaking new refusal 409',
    ]);
    expect(r(op({}), op({ principals: ['human', 'service'] }))).toStrictEqual([
      'breaking principal service newly admitted',
    ]);
  });
});
