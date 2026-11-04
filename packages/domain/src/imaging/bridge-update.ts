import { createHash, type KeyObject } from 'node:crypto';
import { peekHeader, signCompact, UPDATE_MANIFEST_TYP, verifyCompact } from './bridge-crypto';

/**
 * I6 update-integrity placeholder: the signed-manifest verification contract a future bridge updater
 * must apply before installing anything (I-D7 recommends signed installers and signed updates with a
 * revocation path; no bridge, installer or update channel exists). A manifest is a compact JWS
 * (EdDSA, typ cuspatlas-bridge-update+jws) by a release key from a pinned trust set, naming a semantic
 * version, an expiry and the SHA-256 and length of every artifact. Refused: unsigned or `none`,
 * an untrusted key id, a bad signature, a malformed or expired manifest, a version not newer than the
 * installed one (no downgrade or replay of an older release), an artifact whose bytes do not match.
 */
export type UpdateRefusal =
  | 'unsigned'
  | 'untrusted_key'
  | 'signature_invalid'
  | 'malformed'
  | 'expired'
  | 'downgrade'
  | 'artifact_digest_mismatch';

export interface UpdateManifest {
  readonly v: 1;
  readonly channel: string;
  readonly version: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly artifacts: readonly {
    readonly name: string;
    readonly sha256: string;
    readonly byteLength: number;
  }[];
}

const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const semver = (v: string) =>
  (SEMVER.exec(v)?.slice(1).map(Number) ?? null) as [number, number, number] | null;
const newer = (a: [number, number, number], b: [number, number, number]) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

function parseManifest(p: Record<string, unknown>): UpdateManifest | null {
  if (Object.keys(p).sort().join(',') !== 'artifacts,channel,expiresAt,issuedAt,v,version') return null;
  if (p.v !== 1 || typeof p.channel !== 'string' || !/^[a-z0-9-]{1,32}$/.test(p.channel)) return null;
  if (typeof p.version !== 'string' || !semver(p.version)) return null;
  if (typeof p.issuedAt !== 'string' || Number.isNaN(Date.parse(p.issuedAt))) return null;
  if (typeof p.expiresAt !== 'string' || Number.isNaN(Date.parse(p.expiresAt))) return null;
  if (!Array.isArray(p.artifacts) || p.artifacts.length < 1 || p.artifacts.length > 16) return null;
  for (const a of p.artifacts as Record<string, unknown>[]) {
    if (typeof a !== 'object' || a === null || Object.keys(a).sort().join(',') !== 'byteLength,name,sha256')
      return null;
    if (typeof a.name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(a.name)) return null;
    if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) return null;
    if (!Number.isInteger(a.byteLength) || (a.byteLength as number) < 1) return null;
  }
  return p as unknown as UpdateManifest;
}

export function verifyUpdateManifest(
  token: unknown,
  trustedKeys: Readonly<Record<string, KeyObject>>,
  ctx: {
    readonly currentVersion: string;
    readonly artifact?: { readonly name: string; readonly bytes: Uint8Array };
  },
  now: Date = new Date(),
): { ok: true; manifest: UpdateManifest } | { ok: false; reason: UpdateRefusal } {
  if (typeof token !== 'string' || token.split('.').length !== 3) return { ok: false, reason: 'malformed' };
  const [h, , s] = token.split('.') as [string, string, string];
  if (s === '') return { ok: false, reason: 'unsigned' };
  const header = peekHeader(token);
  if (!header) {
    try {
      const raw = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: unknown };
      if (raw.alg === 'none') return { ok: false, reason: 'unsigned' };
    } catch {}
    return { ok: false, reason: 'malformed' };
  }
  if (header.typ !== UPDATE_MANIFEST_TYP) return { ok: false, reason: 'malformed' };
  const key = Object.hasOwn(trustedKeys, header.kid) ? trustedKeys[header.kid] : undefined;
  if (!key) return { ok: false, reason: 'untrusted_key' };
  const payload = verifyCompact(token, key, UPDATE_MANIFEST_TYP);
  if (!payload) return { ok: false, reason: 'untrusted_key' };
  const manifest = parseManifest(payload);
  if (!manifest) return { ok: false, reason: 'malformed' };
  if (Date.parse(manifest.expiresAt) <= now.getTime()) return { ok: false, reason: 'expired' };
  const current = semver(ctx.currentVersion);
  const offered = semver(manifest.version);
  if (!current || !offered || !newer(offered, current)) return { ok: false, reason: 'downgrade' };
  if (ctx.artifact) {
    const entry = manifest.artifacts.find((a) => a.name === ctx.artifact?.name);
    const digest = createHash('sha256').update(ctx.artifact.bytes).digest('hex');
    if (!entry || entry.sha256 !== digest || entry.byteLength !== ctx.artifact.bytes.byteLength)
      return { ok: false, reason: 'artifact_digest_mismatch' };
  }
  return { ok: true, manifest };
}

/** Test-only helper: signs a synthetic manifest (no release key or channel exists). */
export function signUpdateManifestForTest(manifest: object, key: KeyObject, kid: string): string {
  return signCompact({ alg: 'EdDSA', typ: UPDATE_MANIFEST_TYP, kid }, manifest, key);
}
