import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * A14 signing. The signature is HMAC-SHA-256 under the subscription secret over the exact transmitted
 * bytes prefixed by the attempt timestamp: `hex(HMAC(secret, "<t>." || body))`. The header is
 * `t=<unix seconds>,v1=<hex>[,v1=<hex>]` (two `v1` during a rotation overlap). Consumers verify the
 * bytes they received (never a re-serialization), refuse a timestamp outside the window, and
 * deduplicate on the `cuspatlas-event-id` header.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'cuspatlas-signature';
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function signDelivery(input: { bodyBytes: Uint8Array; timestamp: number; secret: string }): string {
  return createHmac('sha256', input.secret)
    .update(`${input.timestamp}.`)
    .update(input.bodyBytes)
    .digest('hex');
}

export function signatureHeader(input: {
  bodyBytes: Uint8Array;
  timestamp: number;
  secrets: readonly string[];
}): string {
  const sigs = input.secrets.map((secret) => `v1=${signDelivery({ ...input, secret })}`);
  return [`t=${input.timestamp}`, ...sigs].join(',');
}

export type WebhookVerification =
  | { readonly valid: true; readonly timestamp: number }
  | {
      readonly valid: false;
      readonly reason: 'malformed' | 'timestamp_out_of_window' | 'signature_mismatch';
    };

/** Reference consumer verifier (published in docs/api/webhooks.md). */
export function verifyWebhookSignature(input: {
  bodyBytes: Uint8Array;
  header: string;
  secrets: readonly string[];
  nowSeconds: number;
  toleranceSeconds?: number;
}): WebhookVerification {
  const parts = input.header.split(',').map((p) => p.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2) ?? '';
  const sigs = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!/^[0-9]{1,12}$/.test(t) || sigs.length === 0 || sigs.some((s) => !/^[0-9a-f]{64}$/.test(s)))
    return { valid: false, reason: 'malformed' };
  const timestamp = Number(t);
  if (Math.abs(input.nowSeconds - timestamp) > (input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS))
    return { valid: false, reason: 'timestamp_out_of_window' };
  for (const secret of input.secrets) {
    const want = Buffer.from(signDelivery({ bodyBytes: input.bodyBytes, timestamp, secret }), 'hex');
    if (sigs.some((s) => timingSafeEqual(Buffer.from(s, 'hex'), want))) return { valid: true, timestamp };
  }
  return { valid: false, reason: 'signature_mismatch' };
}

/** A fresh subscription secret: `whsec_` + 32 random bytes (base64url). */
export const newWebhookSecret = (): string => `whsec_${randomBytes(32).toString('base64url')}`;
export const secretFingerprint = (secret: string): string =>
  createHash('sha256').update(secret).digest('hex').slice(0, 16);

/** Test-only sealing key, permitted only in synthetic-test. */
export const SYNTHETIC_TEST_WEBHOOK_KEY: Uint8Array = new Uint8Array(
  createHash('sha256').update('cuspatlas synthetic-test webhook sealing key').digest(),
);

export function resolveWebhookSecretKey(env: string, configured: Uint8Array | undefined): Uint8Array | null {
  if (configured !== undefined) {
    if (configured.byteLength < 32)
      throw new Error('Refusing to start: the webhook sealing key is too short');
    if (env !== 'synthetic-test' && Buffer.from(configured).equals(Buffer.from(SYNTHETIC_TEST_WEBHOOK_KEY)))
      throw new Error(
        'Refusing to start: the test-only webhook sealing key is permitted only in synthetic-test',
      );
    return configured;
  }
  return env === 'synthetic-test' ? SYNTHETIC_TEST_WEBHOOK_KEY : null;
}

const aesKey = (key: Uint8Array) =>
  createHash('sha256').update('cuspatlas-webhook-secret/1').update(key).digest();

/** Key identifier carried in every sealed secret, so a later key rotation can tell keys apart. */
export const webhookKeyId = (key: Uint8Array): Buffer =>
  createHash('sha256').update('cuspatlas-webhook-key-id/1').update(key).digest().subarray(0, 8);

const SEAL_V2 = 0x02;

/**
 * AES-256-GCM, format 2: base64url(0x02 || keyId(8) || iv(12) || tag(16) || ciphertext), with the
 * subscription id as additional authenticated data, so a sealed secret copied onto another
 * subscription row does not open. The plaintext secret is never stored.
 */
export function sealSecret(key: Uint8Array, secret: string, subscriptionId: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', aesKey(key), iv);
  c.setAAD(Buffer.from(subscriptionId, 'utf8'));
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([SEAL_V2]), webhookKeyId(key), iv, c.getAuthTag(), ct]).toString(
    'base64url',
  );
}

export function openSecret(key: Uint8Array, sealed: string, subscriptionId: string): string {
  const raw = Buffer.from(sealed, 'base64url');
  if (raw[0] === SEAL_V2 && raw.subarray(1, 9).equals(webhookKeyId(key))) {
    const d = createDecipheriv('aes-256-gcm', aesKey(key), raw.subarray(9, 21));
    d.setAAD(Buffer.from(subscriptionId, 'utf8'));
    d.setAuthTag(raw.subarray(21, 37));
    return Buffer.concat([d.update(raw.subarray(37)), d.final()]).toString('utf8');
  }
  // Format 1 (pre-hardening synthetic rows): base64url(iv || tag || ciphertext), no AAD.
  const d = createDecipheriv('aes-256-gcm', aesKey(key), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
