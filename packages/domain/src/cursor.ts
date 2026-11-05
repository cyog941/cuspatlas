import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RefusalError } from '@cuspatlas/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC_BYTES = 16;
/** Offset positions (agents, automation lists) alongside keyset UUIDs. */
const OFFSET = /^\d{1,9}$/;

/**
 * The list-cursor key ring shared by every instance (CUSPATLAS_CURSOR_KEY). `previous`
 * (CUSPATLAS_CURSOR_KEY_PREVIOUS) is accepted for decoding only, so a rotation keeps cursors that
 * were already handed out valid for a grace period; new cursors are always minted with `current`.
 */
export interface CursorKeyRing {
  readonly current: Uint8Array;
  readonly previous?: Uint8Array;
}

/** Test-only cursor key, accepted solely when the runtime environment is synthetic-test. */
export const SYNTHETIC_TEST_CURSOR_KEY: Uint8Array = new Uint8Array(
  createHash('sha256').update('cuspatlas synthetic-test list-cursor key (never for real data)').digest(),
);

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);

/**
 * The key ring a transport must use: the configured secret (at least 32 bytes), or the test-only key
 * under synthetic-test. Refuses a missing key, a short key, and the test-only key in any other
 * environment; the previous key obeys the same rules and must differ from the current key.
 */
export function resolveCursorKeyRing(
  env: string,
  configured: Uint8Array | undefined,
  previous?: Uint8Array,
): CursorKeyRing {
  const check = (k: Uint8Array, name: string) => {
    if (k.byteLength < 32) throw new Error(`Refusing to start: ${name} must be at least 32 bytes`);
    if (env !== 'synthetic-test' && sameBytes(k, SYNTHETIC_TEST_CURSOR_KEY)) {
      throw new Error('Refusing to start: the test-only cursor key is permitted only in synthetic-test');
    }
  };
  let current: Uint8Array;
  if (configured !== undefined) {
    check(configured, 'CUSPATLAS_CURSOR_KEY');
    current = configured;
  } else if (env === 'synthetic-test') {
    current = SYNTHETIC_TEST_CURSOR_KEY;
  } else {
    throw new Error('Refusing to start: CUSPATLAS_CURSOR_KEY must be configured outside synthetic-test');
  }
  if (previous === undefined) return { current };
  check(previous, 'CUSPATLAS_CURSOR_KEY_PREVIOUS');
  if (sameBytes(previous, current)) {
    throw new Error('Refusing to start: CUSPATLAS_CURSOR_KEY_PREVIOUS must differ from the current key');
  }
  return { current, previous };
}

/** Shared MAC helper: mints with the current key, verifies against current then previous. */
export function cursorMac(key: Buffer | CursorKeyRing): {
  sign(tenantId: string, body: string): Buffer;
  verify(tenantId: string, body: string, tag: string): boolean;
} {
  const ring: CursorKeyRing = Buffer.isBuffer(key) ? { current: key } : key;
  const keys = ring.previous ? [ring.current, ring.previous] : [ring.current];
  const macWith = (k: Uint8Array, tenantId: string, body: string) =>
    createHmac('sha256', k).update(`${tenantId}.${body}`).digest().subarray(0, MAC_BYTES);
  return {
    sign: (tenantId, body) => macWith(ring.current, tenantId, body),
    verify(tenantId, body, tag) {
      const given = Buffer.from(tag, 'base64url');
      return keys.some((k) => {
        const expected = macWith(k, tenantId, body);
        return given.length === expected.length && timingSafeEqual(given, expected);
      });
    },
  };
}

export interface CursorCodec {
  encode(tenantId: string, after: string): string;
  /** Returns the keyset position, or throws invalid_request for anything tampered or foreign. */
  decode(tenantId: string, cursor: string): string;
}

/**
 * Opaque pagination cursors: base64url(JSON {v:1, after}) + "." + truncated HMAC-SHA256 over the
 * tenant and the body. A cursor minted for another tenant, or altered in any way, is refused.
 * Transports pass the configured key ring (resolveCursorKeyRing), so cursors survive restarts and are
 * valid on every instance; the bare default (a per-process random key) is for isolated domain tests.
 */
export function createCursorCodec(key: Buffer | CursorKeyRing = randomBytes(32)): CursorCodec {
  const m = cursorMac(key);
  const invalid = () => new RefusalError({ code: 'invalid_request' });

  return {
    encode(tenantId, after) {
      const body = Buffer.from(JSON.stringify({ v: 1, after })).toString('base64url');
      return `${body}.${m.sign(tenantId, body).toString('base64url')}`;
    },
    decode(tenantId, cursor) {
      const parts = cursor.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid();
      const [body, tag] = parts as [string, string];
      if (!m.verify(tenantId, body, tag)) throw invalid();
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        throw invalid();
      }
      const p = parsed as { v?: unknown; after?: unknown };
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Object.keys(parsed).length !== 2 ||
        p.v !== 1 ||
        typeof p.after !== 'string' ||
        !(UUID.test(p.after) || OFFSET.test(p.after))
      ) {
        throw invalid();
      }
      return p.after;
    },
  };
}
