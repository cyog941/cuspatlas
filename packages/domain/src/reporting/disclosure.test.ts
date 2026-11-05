import { RefusalError } from '@cuspatlas/contracts';
import { describe, expect, it } from 'vitest';
import { assertAlignedWindow, discloseMeasure, MEASURES } from './measures';

/** A batch 3 hardening (MUST 1): small-cell suppression, coarse rounding, aligned windows. Synthetic. */
const def = (key: string) => MEASURES.find((m) => m.key === key) as (typeof MEASURES)[number];
const noShow = def('scheduling.no_show_rate');
const ratio = (numerator: number, denominator: number) => ({
  kind: 'ratio' as const,
  numerator,
  denominator,
  population: denominator,
  counts: true,
});

describe('measure disclosure control', () => {
  it('suppresses a small numerator even when the population is large (40 bookings, 2 no-shows)', () => {
    const r = discloseMeasure(noShow, ratio(2, 40), 11);
    expect(r).toEqual({ state: 'suppressed', suppressed: ['numerator'] });
  });

  it('suppresses a small complement (38 of 40)', () => {
    expect(discloseMeasure(noShow, ratio(38, 40), 11)).toEqual({
      state: 'suppressed',
      suppressed: ['complement'],
    });
  });

  it('reports only counts rounded to 5 and a rate to 0.1 percent derived from them', () => {
    const a = discloseMeasure(noShow, ratio(12, 41), 11);
    const b = discloseMeasure(noShow, ratio(12, 42), 11);
    expect(a).toEqual({
      state: 'value',
      value: 0.25,
      numerator: 10,
      denominator: 40,
      rounding: { counts: 5, rate: 0.001 },
    });
    // Two adjacent aligned windows differing by one patient report the same rounded values.
    expect(b).toEqual(a);
  });

  it('suppresses a single-claim receivable by its contributing claim count', () => {
    const m = def('financial.open_insurer_receivable');
    const money = { currency: 'USD', minor: 12500 };
    expect(discloseMeasure(m, { kind: 'money', value: money, contributors: 1 }, 11)).toEqual({
      state: 'suppressed',
      suppressed: ['contributors'],
    });
    expect(
      discloseMeasure(m, { kind: 'money', value: { currency: 'USD', minor: 0 }, contributors: 0 }, 11).state,
    ).toBe('value');
  });

  it('rounds a shown count to 5 and suppresses a small one', () => {
    const m = def('financial.needs_action');
    expect(discloseMeasure(m, { kind: 'count', value: 3 }, 11)).toEqual({
      state: 'suppressed',
      suppressed: ['count'],
    });
    expect(discloseMeasure(m, { kind: 'count', value: 23 }, 11)).toEqual({
      state: 'value',
      value: 25,
      rounding: { counts: 5 },
    });
  });

  it('accepts whole calendar weeks or months and refuses sliding windows naming the granularity', () => {
    expect(assertAlignedWindow('2030-03-04', '2030-03-10')).toBe('week');
    expect(assertAlignedWindow('2030-03-04', '2030-03-17')).toBe('week');
    expect(assertAlignedWindow('2030-03-01', '2030-03-31')).toBe('month');
    expect(assertAlignedWindow('2030-02-01', '2030-04-30')).toBe('month');
    for (const [f, t] of [
      ['2030-03-05', '2030-03-05'],
      ['2030-03-05', '2030-03-11'],
      ['2030-03-02', '2030-03-31'],
    ] as const) {
      try {
        assertAlignedWindow(f, t);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(RefusalError);
        expect(JSON.stringify((e as RefusalError).detail)).toContain('calendarWeekOrMonth');
      }
    }
  });
});
