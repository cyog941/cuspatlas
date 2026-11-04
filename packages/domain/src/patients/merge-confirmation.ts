import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RefusalError } from '@cuspatlas/contracts';

/**
 * Server-issued merge confirmation (S6, ADR 0003 Q5, pending approval). A token binds tenant,
 * reviewer, the exact (unordered) pair, both patient versions and an expiry with an HMAC under a
 * per-process key. Any change to either patient after review makes it stale; another reviewer,
 * another pair or a tampered token is invalid. Tokens do not survive a restart (a shared key is a
 * deployment decision, as for cursors).
 */
export interface MergeConfirmationCodec {
  issue(input: ConfirmationInput & { readonly versions: Readonly<Record<string, number>> }): {
    token: string;
    expiresAt: string;
  };
  /** Returns the bound version of each patient, or throws a typed denial. */
  verify(token: string, input: ConfirmationInput): Readonly<Record<string, number>>;
}

export interface ConfirmationInput {
  readonly tenantId: string;
  readonly actorId: string;
  readonly a: string;
  readonly b: string;
}

export interface MergeConfirmationOptions {
  readonly key?: Buffer;
  /** Default 900 s (15 minutes). */
  readonly ttlSeconds?: number;
  readonly now?: () => number;
}

const TOKEN = /^v1\.([0-9]{10})\.([0-9]{1,10})\.([0-9]{1,10})\.([A-Za-z0-9_-]{43})$/;

function denied(reason: 'confirmation_invalid' | 'confirmation_expired'): RefusalError {
  return new RefusalError({
    code: 'forbidden',
    reasonCode: 'merge_confirmation_invalid',
    detail: { reason },
  });
}

export function createMergeConfirmationCodec(options: MergeConfirmationOptions = {}): MergeConfirmationCodec {
  const key = options.key ?? randomBytes(32);
  const ttl = options.ttlSeconds ?? 900;
  const now = options.now ?? Date.now;
  const mac = (i: ConfirmationInput, low: string, high: string, vLow: number, vHigh: number, exp: string) =>
    createHmac('sha256', key)
      .update(`v1|${i.tenantId}|${i.actorId}|${low}|${high}|${vLow}|${vHigh}|${exp}`)
      .digest()
      .toString('base64url');
  const order = (i: ConfirmationInput) => (i.a < i.b ? [i.a, i.b] : [i.b, i.a]) as [string, string];

  return {
    issue(input) {
      const [low, high] = order(input);
      const vLow = input.versions[low];
      const vHigh = input.versions[high];
      if (vLow === undefined || vHigh === undefined) throw new Error('versions missing');
      const expSeconds = Math.floor(now() / 1000) + ttl;
      const exp = String(Math.max(0, expSeconds)).padStart(10, '0');
      return {
        token: `v1.${exp}.${vLow}.${vHigh}.${mac(input, low, high, vLow, vHigh, exp)}`,
        expiresAt: new Date(Number(exp) * 1000).toISOString(),
      };
    },
    verify(token, input) {
      const m = TOKEN.exec(token);
      if (!m) throw denied('confirmation_invalid');
      const [, exp, vl, vh, tag] = m as unknown as [string, string, string, string, string];
      const [low, high] = order(input);
      const expected = Buffer.from(mac(input, low, high, Number(vl), Number(vh), exp));
      const given = Buffer.from(tag);
      if (input.a === input.b || given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw denied('confirmation_invalid');
      }
      if (Number(exp) * 1000 <= now()) throw denied('confirmation_expired');
      return { [low]: Number(vl), [high]: Number(vh) };
    },
  };
}
