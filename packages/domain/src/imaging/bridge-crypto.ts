import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';

/**
 * I6 bridge cryptography (server side). Ed25519 only, compact JWS (RFC 7515) with a fixed header
 * shape, implemented on node:crypto (no new dependency). The server signs job envelopes with its own
 * bridge signing key; a device signs its assertions and job results with its own per-device key. A
 * private device key never reaches the server; only raw 32-byte public keys (base64url) are stored.
 */
const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_JWS = 8192;

export const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === 'string' ? Buffer.from(b, 'utf8') : b).toString('base64url');

/** Raw Ed25519 public key (43 base64url characters) as a KeyObject, or null when malformed. */
export function publicKeyFromRaw(raw: string): KeyObject | null {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
  } catch {
    return null;
  }
}

/** The raw base64url form of an Ed25519 public KeyObject. */
export function rawFromPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { crv?: string; x?: string };
  if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('not an Ed25519 key');
  return jwk.x;
}

/** Short key identifier: first 16 hex characters of SHA-256 over the raw public key. */
export const keyId = (raw: string) => createHash('sha256').update(raw).digest('hex').slice(0, 16);

export interface JwsHeader {
  readonly alg: 'EdDSA';
  readonly typ: string;
  readonly kid: string;
}

export function signCompact(header: JwsHeader, payload: object, key: KeyObject): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const s = sign(null, Buffer.from(`${h}.${p}`), key);
  return `${h}.${p}.${b64url(s)}`;
}

/** Header of a compact JWS without verifying it (to select the verification key), or null. */
export function peekHeader(token: unknown): JwsHeader | null {
  if (typeof token !== 'string' || token.length > MAX_JWS) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((x) => x.length > 0 && B64URL.test(x))) return null;
  try {
    const h = JSON.parse(Buffer.from(parts[0] as string, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const keys = Object.keys(h).sort().join(',');
    if (keys !== 'alg,kid,typ' || h.alg !== 'EdDSA' || typeof h.typ !== 'string' || typeof h.kid !== 'string')
      return null;
    return h as unknown as JwsHeader;
  } catch {
    return null;
  }
}

/**
 * Verifies a compact JWS with `key` and the expected `typ`; returns the payload object or null. The
 * header must be exactly {alg: EdDSA, typ, kid} (no `none`, no embedded keys, no critical headers).
 */
export function verifyCompact(token: unknown, key: KeyObject, typ: string): Record<string, unknown> | null {
  const header = peekHeader(token);
  if (!header || header.typ !== typ) return null;
  const [h, p, s] = (token as string).split('.') as [string, string, string];
  try {
    if (!verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as unknown;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Verifies a detached proof-of-possession signature over a fixed, server-defined message. */
export function verifyProof(message: string, proof: unknown, key: KeyObject): boolean {
  if (typeof proof !== 'string' || !B64URL.test(proof) || proof.length > 128) return false;
  try {
    return verify(null, Buffer.from(message), key, Buffer.from(proof, 'base64url'));
  } catch {
    return false;
  }
}

export const pairingProofMessage = (pairingRef: string, publicKey: string) =>
  `cuspatlas-bridge-pair:v1:${pairingRef}:${publicKey}`;
export const rotationProofMessage = (deviceRef: string, keyVersion: number, publicKey: string) =>
  `cuspatlas-bridge-rotate:v1:${deviceRef}:${keyVersion}:${publicKey}`;

export const BRIDGE_AUDIENCE = 'urn:cuspatlas:bridge:v1';
export const JOB_ENVELOPE_TYP = 'cuspatlas-bridge-job+jws';
export const JOB_RESULT_TYP = 'cuspatlas-bridge-result+jws';
export const DEVICE_ASSERTION_TYP = 'cuspatlas-device-assertion+jws';
export const UPDATE_MANIFEST_TYP = 'cuspatlas-bridge-update+jws';

/** Server job-signing key: a configured PKCS8 PEM; under synthetic-test an ephemeral key otherwise. */
export function resolveBridgeSigningKey(
  env: 'synthetic-test' | 'development' | 'production',
  pem: string | undefined,
): KeyObject | null {
  if (pem) {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('The bridge signing key must be Ed25519');
    return key;
  }
  if (env === 'synthetic-test') return generateKeyPairSync('ed25519').privateKey;
  return null;
}
