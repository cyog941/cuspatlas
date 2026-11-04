import { createHmac } from 'node:crypto';
import { createMatchKeyer, MATCH_KEY } from '../patients/model';

/**
 * E keyed digests (review hardening). A contact value or a caller number is never stored or compared
 * as a plain hash: a short numeric space (phone numbers) and a guessable one (email addresses) make a
 * plain SHA-256 a lookup table. Every E digest is an HMAC-SHA-256 under the S4 match-key pepper
 * (CUSPATLAS_MATCH_KEY_PEPPER), bound to the tenant and to a purpose label, so a digest from one
 * tenant, purpose or channel never matches another and the pepper is needed to test a guess.
 *
 * Phone numbers are normalized once, here: digits only, a bare 10-digit national number gets the `1`
 * country prefix (so `+1-202-555-0100`, `1 202 555 0100` and `2025550100` are one number). Email is
 * trimmed and lower-cased. Digest scheme 2 is the keyed scheme; scheme 1 rows (plain SHA-256, written
 * before this hardening, synthetic only) never match and need to be re-verified or re-recorded.
 */
export const DIGEST_SCHEME = 2;

export type DigestChannel = 'email' | 'phone';

/** Digits only; a bare 10-digit number is prefixed with the `1` country code. */
export function canonicalPhone(value: string): string {
  const d = value.replace(/\D/g, '');
  return d.length === 10 ? `1${d}` : d;
}

export function normalizeContactValue(channel: DigestChannel, value: string): string {
  return channel === 'phone' ? canonicalPhone(value) : value.trim().toLowerCase();
}

export interface ContactDigester {
  /** Contact verification digest (64 hex). */
  contact(channel: DigestChannel, value: string): string;
  /** Caller digest of a call event (64 hex), separate from the verification purpose. */
  caller(number: string): string;
  /**
   * The S4 phone match keys a patient's stored number could carry for this number: the canonical
   * form and the bare national form (S4 keys the digits as entered). Used with `patients.match_keys`.
   */
  phoneMatchKeys(number: string): string[];
}

export function createContactDigester(pepper: Uint8Array, tenantId: string): ContactDigester {
  if (pepper.byteLength < 32) throw new Error('match-key pepper must be at least 32 bytes');
  const mac = (purpose: string, value: string) =>
    createHmac('sha256', pepper).update(`${tenantId}\u0000e:${purpose}\u0000${value}`).digest('hex');
  const keyer = createMatchKeyer(pepper, tenantId);
  return {
    contact: (channel, value) => mac(`contact:${channel}`, normalizeContactValue(channel, value)),
    caller: (number) => mac('caller', canonicalPhone(number)),
    phoneMatchKeys: (number) => {
      const c = canonicalPhone(number);
      const forms = c.length === 11 && c.startsWith('1') ? [c, c.slice(1)] : [c];
      return forms.map((f) => keyer.key(MATCH_KEY.phone, f));
    },
  };
}
