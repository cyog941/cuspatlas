import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RefusalError } from '@cuspatlas/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC_BYTES = 16;

export interface CursorCodec {
  encode(tenantId: string, after: string): string;
  /** Returns the keyset position, or throws invalid_request for anything tampered or foreign. */
  decode(tenantId: string, cursor: string): string;
}

/**
 * Opaque pagination cursors: base64url(JSON {v:1, after}) + "." + truncated HMAC-SHA256 over the
 * tenant and the body. A cursor minted for another tenant, or altered in any way, is refused.
 * The key defaults to a per-process random value, so cursors do not survive a restart.
 */
export function createCursorCodec(key: Buffer = randomBytes(32)): CursorCodec {
  const mac = (tenantId: string, body: string) =>
    createHmac('sha256', key).update(`${tenantId}.${body}`).digest().subarray(0, MAC_BYTES);
  const invalid = () => new RefusalError({ code: 'invalid_request' });

  return {
    encode(tenantId, after) {
      const body = Buffer.from(JSON.stringify({ v: 1, after })).toString('base64url');
      return `${body}.${mac(tenantId, body).toString('base64url')}`;
    },
    decode(tenantId, cursor) {
      const parts = cursor.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid();
      const [body, tag] = parts as [string, string];
      const given = Buffer.from(tag, 'base64url');
      const expected = mac(tenantId, body);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
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
        !UUID.test(p.after)
      ) {
        throw invalid();
      }
      return p.after;
    },
  };
}
