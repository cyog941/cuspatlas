import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Read-grant tokens (I1). A token is `v1.<grantRef>.<expiresEpochSeconds>.<mac>` where `mac` is the
 * base64url HMAC-SHA-256 over the tenant, principal, object, grant and expiry under a server secret.
 * It is useless without the bound principal's own bearer token, expires within 300 s and is also
 * checked against its live grant row (revocation). Tokens are never stored or logged.
 */
const TOKEN =
  /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9]{10})\.([A-Za-z0-9_-]{43})$/;

export interface GrantBinding {
  readonly tenantId: string;
  readonly principalId: string;
  readonly objectRef: string;
}

function mac(secret: Uint8Array, b: GrantBinding, grantRef: string, expires: number): Buffer {
  return createHmac('sha256', secret)
    .update(['v1', b.tenantId, b.principalId, b.objectRef, grantRef, String(expires)].join('\u0000'))
    .digest();
}

export function signGrantToken(
  secret: Uint8Array,
  b: GrantBinding,
  grantRef: string,
  expiresEpochSeconds: number,
): string {
  const exp = String(expiresEpochSeconds).padStart(10, '0');
  return `v1.${grantRef}.${exp}.${mac(secret, b, grantRef, expiresEpochSeconds).toString('base64url')}`;
}

/** Parses and verifies a token for one binding; null when malformed, foreign or forged. */
export function verifyGrantToken(
  secret: Uint8Array,
  b: GrantBinding,
  token: unknown,
): { grantRef: string; expiresEpochSeconds: number } | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const m = TOKEN.exec(token);
  if (!m) return null;
  const grantRef = m[1] as string;
  const expires = Number(m[2]);
  const given = Buffer.from(m[3] as string, 'base64url');
  // Canonical encoding only: base64url decoding ignores the unused low bits of the last character, so
  // a token whose last character was altered could otherwise still decode to the same MAC.
  if (given.toString('base64url') !== m[3]) return null;
  const want = mac(secret, b, grantRef, expires);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return { grantRef, expiresEpochSeconds: expires };
}

/** Test-only secret, accepted solely under synthetic-test (same rule as the test token issuer). */
export const SYNTHETIC_TEST_IMAGING_TOKEN_SECRET: Uint8Array = new Uint8Array(
  createHash('sha256')
    .update('cuspatlas synthetic-test imaging read-grant secret (never for real data)')
    .digest(),
);

const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);

/**
 * The read-grant secret a transport must use: the configured secret (CUSPATLAS_IMAGING_TOKEN_SECRET,
 * at least 32 bytes), or the test-only secret under synthetic-test. Refuses (at startup) a short secret
 * and the test-only secret in any other environment. A missing secret outside synthetic-test returns
 * null: imaging then starts with read grants disabled (every grant and content read is a typed 503 with
 * an alert line), so the rest of the service keeps its own startup rules and nothing fails open.
 */
export function resolveImagingTokenSecret(
  env: string,
  configured: Uint8Array | undefined,
): Uint8Array | null {
  if (configured !== undefined) {
    if (configured.byteLength < 32)
      throw new Error('Refusing to start: the imaging token secret is too short');
    if (env !== 'synthetic-test' && same(configured, SYNTHETIC_TEST_IMAGING_TOKEN_SECRET)) {
      throw new Error(
        'Refusing to start: the test-only imaging token secret is permitted only in synthetic-test',
      );
    }
    return configured;
  }
  return env === 'synthetic-test' ? SYNTHETIC_TEST_IMAGING_TOKEN_SECRET : null;
}
