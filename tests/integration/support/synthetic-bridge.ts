import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { posix } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Test-only synthetic bridge client (I6/I7). It stands in for the future reviewed native bridge,
 * which is NOT built: it holds an Ed25519 key pair in test memory only (never written anywhere),
 * pairs with a one-time code, signs short-lived single-use assertions bound to the request, verifies
 * the server's signed job envelopes and signs job results. Its JWS code is written independently of
 * the server's so the two check each other.
 */
export const BRIDGE_AUDIENCE = 'urn:cuspatlas:bridge:v1';
const b64 = (x: Uint8Array | string) =>
  Buffer.from(typeof x === 'string' ? Buffer.from(x, 'utf8') : x).toString('base64url');
const rawOf = (k: KeyObject) => (k.export({ format: 'jwk' }) as { x: string }).x;

/** The exact bytes `raw` puts on the wire for a body. */
export const bodyBytes = (body: unknown): Uint8Array =>
  body === undefined
    ? new Uint8Array()
    : body instanceof Uint8Array
      ? body
      : Buffer.from(JSON.stringify(body));

export interface KeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly raw: string;
}
export const newKeyPair = (): KeyPair => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, raw: rawOf(publicKey) };
};

export function jws(header: Record<string, unknown>, payload: object, key: KeyObject): string {
  const h = b64(JSON.stringify(header));
  const p = b64(JSON.stringify(payload));
  return `${h}.${p}.${b64(sign(null, Buffer.from(`${h}.${p}`), key))}`;
}

export function verifyJws(token: string, key: KeyObject, typ: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (header.alg !== 'EdDSA' || header.typ !== typ) return null;
    if (!verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) return null;
    return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface Reply {
  status: number;
  json: Record<string, unknown>;
  body: string;
}

export interface JobEnvelope {
  jobRef: string;
  deviceRef: string;
  tenantRef: string;
  kind: string;
  scopePath: string | null;
  nonce: string;
  attempt: number;
  expiresAt: string;
  leaseExpiresAt: string;
}

export class SyntheticBridge {
  keys: KeyPair = newKeyPair();
  deviceRef = '';
  tenantRef = '';
  keyVersion = 0;
  serverKey: KeyObject | null = null;
  /** Assertions issued, so a test can replay one. */
  readonly issued: string[] = [];

  constructor(private readonly app: FastifyInstance) {}

  async pair(code: string, opts: { proofKey?: KeyPair } = {}): Promise<Reply> {
    const pairingRef = code.split('.')[3] ?? '';
    const proof = b64(
      sign(
        null,
        Buffer.from(`cuspatlas-bridge-pair:v1:${pairingRef}:${this.keys.raw}`),
        (opts.proofKey ?? this.keys).privateKey,
      ),
    );
    const r = await this.raw(
      'POST',
      '/v1/bridge/pair',
      { pairingCode: code, publicKey: this.keys.raw, proof },
      null,
    );
    if (r.status === 201) {
      const d = r.json.data as { deviceRef: string; keyVersion: number; jobSigningKey: string };
      this.deviceRef = d.deviceRef;
      this.keyVersion = d.keyVersion;
      this.tenantRef = code.split('.')[1] ?? '';
      this.serverKey = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: d.jobSigningKey },
        format: 'jwk',
      });
    }
    return r;
  }

  /** A short-lived, single-use assertion bound to one request (method and path). */
  assertion(
    method: string,
    path: string,
    o: {
      key?: KeyPair;
      keyVersion?: number;
      audience?: string;
      ttlSeconds?: number;
      iatOffsetSeconds?: number;
      htu?: string;
      tenantRef?: string;
      deviceRef?: string;
      /** The body the request will carry (digest committed in `bdy`); default `{}` for non-GET. */
      body?: unknown;
      /** Negative fixture: sign without a body digest. */
      omitBody?: boolean;
    } = {},
  ): string {
    const now = Math.floor(Date.now() / 1000) + (o.iatOffsetSeconds ?? 0);
    const device = o.deviceRef ?? this.deviceRef;
    const token = jws(
      {
        alg: 'EdDSA',
        typ: 'cuspatlas-device-assertion+jws',
        kid: `${device}.${o.keyVersion ?? this.keyVersion}`,
      },
      {
        iss: device,
        sub: device,
        aud: o.audience ?? BRIDGE_AUDIENCE,
        tid: o.tenantRef ?? this.tenantRef,
        iat: now,
        exp: now + (o.ttlSeconds ?? 60),
        jti: randomUUID(),
        htm: method,
        htu: o.htu ?? path,
        ...(method === 'GET' || o.omitBody === true
          ? {}
          : {
              bdy: createHash('sha256')
                .update(bodyBytes(o.body === undefined ? {} : o.body))
                .digest('base64url'),
            }),
      },
      (o.key ?? this.keys).privateKey,
    );
    this.issued.push(token);
    return token;
  }

  async raw(method: 'GET' | 'POST', url: string, body: unknown, bearer: string | null): Promise<Reply> {
    const binary = body instanceof Uint8Array;
    const res = await this.app.inject({
      method,
      url,
      headers: {
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        ...(method === 'POST'
          ? { 'content-type': binary ? 'application/octet-stream' : 'application/json' }
          : {}),
      },
      ...(body === undefined ? {} : { payload: binary ? Buffer.from(body) : JSON.stringify(body) }),
    });
    let json: Record<string, unknown> = {};
    try {
      json = res.json();
    } catch {}
    return { status: res.statusCode, json, body: res.body };
  }

  call(
    path: string,
    body: unknown = {},
    o: Parameters<SyntheticBridge['assertion']>[2] = {},
  ): Promise<Reply> {
    return this.raw('POST', path, body, this.assertion('POST', path, { body, ...o }));
  }

  /** Verifies a signed job envelope with the server key learned at pairing; null when forged. */
  verifyEnvelope(token: unknown): JobEnvelope | null {
    if (typeof token !== 'string' || !this.serverKey) return null;
    const p = verifyJws(token, this.serverKey, 'cuspatlas-bridge-job+jws');
    if (!p || p.aud !== BRIDGE_AUDIENCE || p.deviceRef !== this.deviceRef || p.tenantRef !== this.tenantRef)
      return null;
    return p as unknown as JobEnvelope;
  }

  async claim(): Promise<{ reply: Reply; job: JobEnvelope | null }> {
    const reply = await this.call('/v1/bridge/jobs/claim', {});
    const env = (reply.json.data as { envelope?: string | null } | undefined)?.envelope ?? null;
    return { reply, job: env === null ? null : this.verifyEnvelope(env) };
  }

  upload(
    jobRef: string,
    bytes: Uint8Array,
    o: Parameters<SyntheticBridge['assertion']>[2] = {},
  ): Promise<Reply> {
    return this.call(`/v1/bridge/jobs/${jobRef}/content`, bytes, o);
  }

  resultToken(
    job: Pick<JobEnvelope, 'jobRef' | 'nonce' | 'attempt'>,
    outcome:
      | { outcome: 'completed'; bytes?: Uint8Array; contentType?: string }
      | { outcome: 'failed'; failureReason: string; retryable?: boolean },
    o: { key?: KeyPair; reportedAt?: string; deviceRef?: string } = {},
  ): string {
    const artifact =
      outcome.outcome === 'completed' && outcome.bytes
        ? {
            contentType: outcome.contentType ?? 'image/png',
            byteLength: outcome.bytes.byteLength,
            digestSha256: createHash('sha256').update(outcome.bytes).digest('hex'),
          }
        : undefined;
    return jws(
      { alg: 'EdDSA', typ: 'cuspatlas-bridge-result+jws', kid: `${this.deviceRef}.${this.keyVersion}` },
      {
        v: 1,
        aud: BRIDGE_AUDIENCE,
        jobRef: job.jobRef,
        deviceRef: o.deviceRef ?? this.deviceRef,
        nonce: job.nonce,
        attempt: job.attempt,
        outcome: outcome.outcome,
        ...(outcome.outcome === 'failed'
          ? { failureReason: outcome.failureReason, retryable: outcome.retryable === true }
          : {}),
        reportedAt: o.reportedAt ?? new Date().toISOString(),
        captureSoftware: 'synthetic-bridge',
        ...(artifact ? { artifact } : {}),
      },
      (o.key ?? this.keys).privateKey,
    );
  }

  report(jobRef: string, token: string, o: Parameters<SyntheticBridge['assertion']>[2] = {}): Promise<Reply> {
    return this.call(`/v1/bridge/jobs/${jobRef}/result`, { result: token }, o);
  }

  heartbeat(): Promise<Reply> {
    return this.call('/v1/bridge/heartbeat', {});
  }

  /** Rotates the device key: the request is asserted with the current key, the new key proves itself. */
  async rotate(): Promise<{ reply: Reply; old: KeyPair }> {
    const next = newKeyPair();
    const version = this.keyVersion + 1;
    const proof = b64(
      sign(
        null,
        Buffer.from(`cuspatlas-bridge-rotate:v1:${this.deviceRef}:${version}:${next.raw}`),
        next.privateKey,
      ),
    );
    const reply = await this.call('/v1/bridge/keys/rotate', { publicKey: next.raw, proof });
    const old = this.keys;
    if (reply.status === 200) {
      this.keys = next;
      this.keyVersion = version;
    }
    return { reply, old };
  }

  /**
   * Bridge-side path resolution (what the native bridge must do with a signed scopePath): resolve it
   * inside its configured root and refuse anything that escapes. The server already refuses such paths.
   */
  static resolveInsideRoot(root: string, scopePath: string): string | null {
    const target = posix.normalize(posix.join(root, scopePath));
    return target === root || target.startsWith(`${root}/`) ? target : null;
  }
}
