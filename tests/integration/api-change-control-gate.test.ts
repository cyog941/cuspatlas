import { describe, expect, it } from 'vitest';
import type { DeprecationEntry } from '../../packages/contracts/src/catalog/catalog';
import type { Baseline } from '../../packages/contracts/src/catalog/change-control';
import { classifyChange } from '../../packages/contracts/src/catalog/change-control';
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
