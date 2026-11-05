import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  configuredIdempotencyDigestKey,
  configureIdempotencyDigestKey,
  idempotencyPayloadDigest,
  payloadDigest,
  resolveIdempotencyDigestKey,
  SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY,
} from './digest';

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

describe('keyed idempotency payload digest', () => {
  it('is HMAC-SHA-256 under the key, tenant-bound, and never the plain SHA-256 of the payload', () => {
    const key = new Uint8Array(32).fill(7);
    const payload = { allergen: 'synthetic pollen' };
    const d = idempotencyPayloadDigest(key, 'tenant-a', payload);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d).not.toBe(payloadDigest(payload));
    expect(d).toBe(idempotencyPayloadDigest(key, 'tenant-a', { allergen: 'synthetic pollen' }));
    expect(d).not.toBe(idempotencyPayloadDigest(key, 'tenant-b', payload));
    expect(d).not.toBe(idempotencyPayloadDigest(new Uint8Array(32).fill(8), 'tenant-a', payload));
    expect(idempotencyPayloadDigest(key, 't', { b: 1, a: 2 })).toBe(
      idempotencyPayloadDigest(key, 't', { a: 2, b: 1 }),
    );
  });

  it('uses the test-only key only under synthetic-test and requires a configured key elsewhere', () => {
    expect(resolveIdempotencyDigestKey('synthetic-test', undefined)).toBe(
      SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY,
    );
    expect(() => resolveIdempotencyDigestKey('production', undefined)).toThrow(/must be configured/);
    expect(() => resolveIdempotencyDigestKey('production', SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY)).toThrow(
      /only in synthetic-test/,
    );
    expect(() => resolveIdempotencyDigestKey('production', new Uint8Array(16))).toThrow(/at least 32 bytes/);
    const real = new Uint8Array(32).fill(9);
    expect(resolveIdempotencyDigestKey('production', real)).toBe(real);
  });

  it('executing without a configured key fails closed; one process never mixes two keys', () => {
    // The unit project has no setup file: nothing configured the process key yet.
    expect(() => configuredIdempotencyDigestKey()).toThrow(/not configured/);
    configureIdempotencyDigestKey(new Uint8Array(32).fill(1));
    expect(() => configureIdempotencyDigestKey(new Uint8Array(32).fill(1))).not.toThrow();
    expect(() => configureIdempotencyDigestKey(new Uint8Array(32).fill(2))).toThrow(/already configured/);
  });
});
