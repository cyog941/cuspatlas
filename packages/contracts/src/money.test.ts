import { describe, expect, it } from 'vitest';
import {
  addMoney,
  allocateRemainder,
  compareMoney,
  isMoney,
  MAX_MINOR,
  MoneyError,
  money,
  moneyFromMinorText,
  negateMoney,
  splitEvenly,
  subtractMoney,
  sumMoney,
} from './money';

/** Small seeded generator (mulberry32): property tests are reproducible without a new dependency. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.trunc(next() * (hi - lo + 1));
  return { next, int };
}

const usd = (minor: number) => money('USD', minor);
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof MoneyError) return err.code;
    throw err;
  }
  return 'none';
};

describe('Money representation (SHARED-CONTRACTS Money = { currency, minor })', () => {
  it('accepts only integer minor units within the safe bound and a three-letter currency', () => {
    expect(usd(1234)).toStrictEqual({ currency: 'USD', minor: 1234 });
    expect(isMoney({ currency: 'USD', minor: 0 })).toBe(true);
    for (const bad of [
      { currency: 'USD', minor: 1.5 },
      { currency: 'usd', minor: 1 },
      { currency: 'US', minor: 1 },
      { currency: 'USD', minor: Number.NaN },
      { currency: 'USD', minor: MAX_MINOR + 1 },
      { currency: 'USD', minor: '100' },
      { currency: 'USD' },
      null,
    ]) {
      expect(isMoney(bad)).toBe(false);
    }
    expect(codeOf(() => money('USD', 0.1 + 0.2))).toBe('invalid_money');
    expect(codeOf(() => money('XX1', 1))).toBe('invalid_money');
  });

  it('parses database integer text exactly and refuses anything that is not an integer', () => {
    expect(moneyFromMinorText('USD', '-12345')).toStrictEqual(usd(-12345));
    expect(moneyFromMinorText('USD', '0')).toStrictEqual(usd(0));
    for (const bad of ['1.0', '1e3', ' 1', '', '0x10', '99999999999999999999']) {
      expect([bad, codeOf(() => moneyFromMinorText('USD', bad))]).not.toStrictEqual([bad, 'none']);
    }
  });

  it('refuses mixed-currency arithmetic with a typed currency_mismatch, never a coercion', () => {
    const eur = money('EUR', 5);
    expect(codeOf(() => addMoney(usd(1), eur))).toBe('currency_mismatch');
    expect(codeOf(() => subtractMoney(usd(1), eur))).toBe('currency_mismatch');
    expect(codeOf(() => compareMoney(usd(1), eur))).toBe('currency_mismatch');
    expect(codeOf(() => sumMoney('USD', [usd(1), eur]))).toBe('currency_mismatch');
  });

  it('refuses a result outside the safe integer range instead of losing precision', () => {
    expect(codeOf(() => addMoney(usd(MAX_MINOR), usd(1)))).toBe('overflow');
    expect(codeOf(() => subtractMoney(usd(-MAX_MINOR), usd(1)))).toBe('overflow');
    expect(addMoney(usd(MAX_MINOR - 1), usd(1))).toStrictEqual(usd(MAX_MINOR));
  });

  it('property: addition is commutative, subtraction inverts it, negation is an involution (seeded)', () => {
    const r = rng(20261104);
    for (let i = 0; i < 2000; i += 1) {
      const a = usd(r.int(-1e12, 1e12));
      const b = usd(r.int(-1e12, 1e12));
      expect(addMoney(a, b)).toStrictEqual(addMoney(b, a));
      expect(subtractMoney(addMoney(a, b), b)).toStrictEqual(a);
      expect(negateMoney(negateMoney(a))).toStrictEqual(a);
      expect(addMoney(a, negateMoney(a)).minor).toBe(0);
      expect(compareMoney(a, b)).toBe(Math.sign(a.minor - b.minor));
    }
  });

  it('property: allocateRemainder preserves the total exactly with floor/ceil shares (seeded)', () => {
    const r = rng(8);
    for (let i = 0; i < 2000; i += 1) {
      const total = usd(r.int(-5e9, 5e9));
      const n = r.int(1, 12);
      const weights = Array.from({ length: n }, () => r.int(0, 10_000));
      if (!weights.some((w) => w > 0)) weights[0] = 1;
      const parts = allocateRemainder(total, weights);
      expect(parts).toHaveLength(n);
      expect(sumMoney('USD', parts)).toStrictEqual(total);
      const W = weights.reduce((s, w) => s + BigInt(w), 0n);
      parts.forEach((p, k) => {
        const exact = (BigInt(Math.abs(total.minor)) * BigInt(weights[k] ?? 0)) / W;
        const got = BigInt(Math.abs(p.minor));
        expect(got === exact || got === exact + 1n).toBe(true);
        if (weights[k] === 0) expect(p.minor).toBe(0);
        if (p.minor !== 0) expect(Math.sign(p.minor)).toBe(Math.sign(total.minor));
      });
      // Deterministic: the same input always gives the same split.
      expect(allocateRemainder(total, weights)).toStrictEqual(parts);
    }
  });

  it('distributes the residual minor units by largest remainder, ties to the lower index (ADR 0008)', () => {
    expect(allocateRemainder(usd(100), [1, 1, 1]).map((m) => m.minor)).toStrictEqual([34, 33, 33]);
    expect(allocateRemainder(usd(-100), [1, 1, 1]).map((m) => m.minor)).toStrictEqual([-34, -33, -33]);
    // 10 * 1/6 = 1.67, 10 * 2/6 = 3.33, 10 * 3/6 = 5: the largest fractional part takes the residue.
    expect(allocateRemainder(usd(10), [1, 2, 3]).map((m) => m.minor)).toStrictEqual([2, 3, 5]);
    expect(splitEvenly(usd(1000), 3).map((m) => m.minor)).toStrictEqual([334, 333, 333]);
    expect(codeOf(() => allocateRemainder(usd(10), []))).toBe('invalid_weights');
    expect(codeOf(() => allocateRemainder(usd(10), [0, 0]))).toBe('invalid_weights');
    expect(codeOf(() => allocateRemainder(usd(10), [1, -1]))).toBe('invalid_weights');
    expect(codeOf(() => allocateRemainder(usd(10), [1.5]))).toBe('invalid_weights');
  });
});
