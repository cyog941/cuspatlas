import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, payloadDigest } from './digest';

describe('canonical payload digest', () => {
  it('sorts keys recursively, keeps array order and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(payloadDigest({ b: 1, a: 2 })).toBe(payloadDigest({ a: 2, b: 1 }));
    expect(payloadDigest({ a: [1, 2] })).not.toBe(payloadDigest({ a: [2, 1] }));
    expect(payloadDigest({ label: 'é' })).toBe(
      createHash('sha256').update('{"label":"é"}', 'utf8').digest('hex'),
    );
  });

  it('refuses values JSON would drop or distort', () => {
    for (const bad of [{ a: undefined }, { a: Number.NaN }, { a: () => 1 }, new Date(0), { a: 1n }]) {
      expect(() => canonicalJson(bad)).toThrow();
    }
  });
});
