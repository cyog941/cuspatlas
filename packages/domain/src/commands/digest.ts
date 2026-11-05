import { createHash, createHmac } from 'node:crypto';

/**
 * Canonical JSON (frozen rule): object keys sorted recursively by code unit, no whitespace, arrays in
 * order. Only JSON values are accepted; anything else (undefined, functions, non-finite numbers,
 * bigint, class instances) is refused rather than silently dropped, so two different payloads can
 * never share a digest through lossy serialization.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number in command payload');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error('Non-plain object in command payload');
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new Error('Non-JSON value in command payload');
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * SHA-256 (hex) over the canonical UTF-8 JSON of the payload. Used where the payload itself is stored
 * beside its digest (action proposals); the idempotency table uses the keyed digest below.
 */
export const payloadDigest = (payload: unknown): string => sha256Hex(canonicalJson(payload));

/** The caller's key is persisted only as this digest, so caller text never lands in a row. */
export const idempotencyKeyDigest = (key: string): string => sha256Hex(key);

/**
 * Test-only idempotency digest key (synthetic-test only; refused elsewhere). Never for real data.
 */
export const SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY: Uint8Array = new Uint8Array(
  createHash('sha256')
    .update('cuspatlas synthetic-test idempotency digest key (never for real data)')
    .digest(),
);

/** Payload digest scheme stored in `command_idempotency.payload_digest_scheme`. */
export const IDEMPOTENCY_DIGEST_SCHEME = 2;

/**
 * Keyed payload digest of the idempotency table (scheme 2): HMAC-SHA-256 (hex) under a server secret
 * over a purpose label, the tenant and the canonical UTF-8 JSON of the payload. A command payload can
 * carry low-entropy patient data (an allergen, a contact value); an unkeyed hash of it at rest could
 * be confirmed by guessing, a keyed one cannot without the secret. Equal payloads in one tenant under
 * one key still have equal digests, so replay comparison is unchanged.
 */
export function idempotencyPayloadDigest(key: Uint8Array, tenantId: string, payload: unknown): string {
  return createHmac('sha256', key)
    .update(`cuspatlas/idempotency-payload/v1\u0000${tenantId}\u0000`, 'utf8')
    .update(canonicalJson(payload), 'utf8')
    .digest('hex');
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);

/**
 * The idempotency digest key for an environment (CUSPATLAS_IDEMPOTENCY_DIGEST_KEY, base64, at least 32
 * bytes). The test-only key is used when none is configured under synthetic-test and is refused
 * everywhere else; outside synthetic-test a key must be configured.
 */
export function resolveIdempotencyDigestKey(env: string, configured: Uint8Array | undefined): Uint8Array {
  if (configured !== undefined) {
    if (configured.byteLength < 32) {
      throw new Error('Refusing to start: CUSPATLAS_IDEMPOTENCY_DIGEST_KEY must be at least 32 bytes');
    }
    if (env !== 'synthetic-test' && sameBytes(configured, SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY)) {
      throw new Error(
        'Refusing to start: the test-only idempotency digest key is permitted only in synthetic-test',
      );
    }
    return configured;
  }
  if (env === 'synthetic-test') return SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY;
  throw new Error(
    'Refusing to start: CUSPATLAS_IDEMPOTENCY_DIGEST_KEY must be configured outside synthetic-test',
  );
}

let processKey: Uint8Array | null = null;

/**
 * Sets the key the default `executeOnce` uses in this process (called by the API and MCP builders with
 * the resolved key). A second, different key in the same process is refused: two keys would make
 * replays of one command disagree.
 */
export function configureIdempotencyDigestKey(key: Uint8Array): void {
  if (processKey !== null && !sameBytes(processKey, key)) {
    throw new Error('A different idempotency digest key is already configured in this process');
  }
  processKey = new Uint8Array(key);
}

/** The configured process key; executing a command without one is refused (fail closed). */
export function configuredIdempotencyDigestKey(): Uint8Array {
  if (processKey === null) throw new Error('The idempotency digest key is not configured');
  return processKey;
}
