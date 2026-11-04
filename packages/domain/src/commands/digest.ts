import { createHash } from 'node:crypto';

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

/** SHA-256 (hex) over the canonical UTF-8 JSON of the payload. */
export const payloadDigest = (payload: unknown): string => sha256Hex(canonicalJson(payload));

/** The caller's key is persisted only as this digest, so caller text never lands in a row. */
export const idempotencyKeyDigest = (key: string): string => sha256Hex(key);
