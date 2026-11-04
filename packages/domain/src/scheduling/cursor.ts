import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RefusalError } from '@cuspatlas/contracts';

const MAC_BYTES = 16;
const POSITION = /^[A-Za-z0-9:._+-]{1,200}$/;

/**
 * Opaque scheduling cursors, the same construction as the foundation cursor (base64url JSON plus a
 * truncated HMAC-SHA256 over tenant and body) but with a string position and a `scope` that binds a
 * cursor to the listing or query that produced it. A cursor from another tenant, another listing or
 * another query, or altered in any way, is refused with `invalid_request`.
 */
export interface SchedulingCursorCodec {
  encode(tenantId: string, scope: string, after: string): string;
  decode(tenantId: string, scope: string, cursor: string): string;
}

export function createSchedulingCursorCodec(key: Buffer = randomBytes(32)): SchedulingCursorCodec {
  const mac = (tenantId: string, body: string) =>
    createHmac('sha256', key).update(`${tenantId}.${body}`).digest().subarray(0, MAC_BYTES);
  const invalid = () => new RefusalError({ code: 'invalid_request' });
  return {
    encode(tenantId, scope, after) {
      const body = Buffer.from(JSON.stringify({ v: 1, s: scope, a: after })).toString('base64url');
      return `${body}.${mac(tenantId, body).toString('base64url')}`;
    },
    decode(tenantId, scope, cursor) {
      const parts = cursor.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid();
      const [body, tag] = parts as [string, string];
      const given = Buffer.from(tag, 'base64url');
      const expected = mac(tenantId, body);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
      let parsed: { v?: unknown; s?: unknown; a?: unknown };
      try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        throw invalid();
      }
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Object.keys(parsed).length !== 3 ||
        parsed.v !== 1 ||
        parsed.s !== scope ||
        typeof parsed.a !== 'string' ||
        !POSITION.test(parsed.a)
      ) {
        throw invalid();
      }
      return parsed.a;
    },
  };
}
