/**
 * The shared Money contract (docs/SHARED-CONTRACTS.md#money) and its arithmetic helpers (ADR 0008,
 * recommended-pending-billing-approval). Money is an explicit currency plus an integer count of minor
 * units. No helper accepts or produces a fractional value; every operation is exact (BigInt inside)
 * and refuses a result outside the safe integer range rather than losing precision. Mixed-currency
 * arithmetic is refused with `currency_mismatch`, never coerced.
 */
export interface Money {
  /** ISO 4217 alphabetic code, upper case (for example USD). */
  readonly currency: string;
  /** Signed integer minor units (cents for USD). */
  readonly minor: number;
}

export type MoneyErrorCode = 'invalid_money' | 'currency_mismatch' | 'overflow' | 'invalid_weights';

/** Typed money failure. The billing domain maps it to a 422 refusal with `detail.reason` = code. */
export class MoneyError extends Error {
  readonly code: MoneyErrorCode;
  constructor(code: MoneyErrorCode) {
    super(code);
    this.name = 'MoneyError';
    this.code = code;
  }
}

/** Largest magnitude any Money value may hold (2^53 - 1): every value round-trips through JSON. */
export const MAX_MINOR = Number.MAX_SAFE_INTEGER;
const MAX_BIG = BigInt(MAX_MINOR);
const CURRENCY = /^[A-Z]{3}$/;
const INTEGER_TEXT = /^-?(0|[1-9][0-9]{0,19})$/;

export const isCurrencyCode = (c: unknown): c is string => typeof c === 'string' && CURRENCY.test(c);

export function isMoney(value: unknown): value is Money {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isCurrencyCode(v.currency) && typeof v.minor === 'number' && Number.isSafeInteger(v.minor);
}

function fromBig(currency: string, minor: bigint): Money {
  if (minor > MAX_BIG || minor < -MAX_BIG) throw new MoneyError('overflow');
  // Normalise -0 so equal values are structurally equal.
  return { currency, minor: minor === 0n ? 0 : Number(minor) };
}

/** Builds a Money value; refuses a non-integer, an unsafe integer or a malformed currency. */
export function money(currency: string, minor: number | bigint): Money {
  if (!isCurrencyCode(currency)) throw new MoneyError('invalid_money');
  if (typeof minor === 'bigint') return fromBig(currency, minor);
  if (!Number.isSafeInteger(minor)) throw new MoneyError('invalid_money');
  return fromBig(currency, BigInt(minor));
}

/** Parses the exact integer text PostgreSQL returns for bigint and sum(bigint) columns. */
export function moneyFromMinorText(currency: string, text: string): Money {
  if (typeof text !== 'string' || !INTEGER_TEXT.test(text)) throw new MoneyError('invalid_money');
  return money(currency, BigInt(text));
}

function same(a: Money, b: Money): void {
  if (!isMoney(a) || !isMoney(b)) throw new MoneyError('invalid_money');
  if (a.currency !== b.currency) throw new MoneyError('currency_mismatch');
}

export function addMoney(a: Money, b: Money): Money {
  same(a, b);
  return fromBig(a.currency, BigInt(a.minor) + BigInt(b.minor));
}

export function subtractMoney(a: Money, b: Money): Money {
  same(a, b);
  return fromBig(a.currency, BigInt(a.minor) - BigInt(b.minor));
}

export function negateMoney(a: Money): Money {
  if (!isMoney(a)) throw new MoneyError('invalid_money');
  return fromBig(a.currency, -BigInt(a.minor));
}

/** -1, 0 or 1. Comparing two currencies is refused, never ordered. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  same(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

/** Sum in one currency; the empty sum is zero in that currency. */
export function sumMoney(currency: string, values: readonly Money[]): Money {
  let total = money(currency, 0);
  for (const v of values) total = addMoney(total, v);
  return total;
}

export const zeroMoney = (currency: string): Money => money(currency, 0);

/**
 * Splits `total` across non-negative integer weights so the parts add up to exactly `total`
 * (ADR 0008 rounding rule, B-D3 recommended-pending-billing-approval): each part first receives
 * floor(|total| * w / W); the residual minor units then go one each to the parts with the largest
 * fractional remainder, ties to the lower index. A negative total is split by magnitude and every
 * part carries the total's sign. A zero weight always receives zero. Deterministic for equal input.
 */
export function allocateRemainder(total: Money, weights: readonly number[]): Money[] {
  if (!isMoney(total)) throw new MoneyError('invalid_money');
  if (weights.length === 0 || weights.length > 1000) throw new MoneyError('invalid_weights');
  if (!weights.every((w) => Number.isSafeInteger(w) && w >= 0)) throw new MoneyError('invalid_weights');
  const big = weights.map((w) => BigInt(w));
  const sumW = big.reduce((s, w) => s + w, 0n);
  if (sumW === 0n) throw new MoneyError('invalid_weights');
  const sign = total.minor < 0 ? -1n : 1n;
  const magnitude = BigInt(total.minor) * sign;
  const shares = big.map((w) => (magnitude * w) / sumW);
  const remainders = big.map((w, i) => ({ i, r: (magnitude * w) % sumW, w }));
  let residue = magnitude - shares.reduce((s, x) => s + x, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i, w } of remainders) {
    if (residue === 0n) break;
    if (w === 0n) continue;
    shares[i] = (shares[i] ?? 0n) + 1n;
    residue -= 1n;
  }
  return shares.map((s) => fromBig(total.currency, s * sign));
}

/** `parts` equal shares of `total` under the same rule (residue to the earliest parts). */
export function splitEvenly(total: Money, parts: number): Money[] {
  if (!Number.isSafeInteger(parts) || parts < 1 || parts > 1000) throw new MoneyError('invalid_weights');
  return allocateRemainder(
    total,
    Array.from({ length: parts }, () => 1),
  );
}
