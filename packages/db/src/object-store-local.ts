import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ObjectStoreError, type ObjectStorePort } from '@cuspatlas/contracts';

/**
 * Synthetic local-filesystem object store (I1). Private by construction: there is no URL, no listing
 * on the port and no caller-supplied path. Every key is built here from the server-derived tenant and
 * a server value (a random staging id or the SHA-256 of the bytes) and checked against a fixed
 * per-tenant pattern before any filesystem call, so a traversal or another tenant's prefix is refused
 * as `path_traversal`. Content is addressed by SHA-256 inside the tenant prefix; tenants never share
 * bytes. Refused under `production`: it is a development and test adapter only (I-D1 picks the managed
 * backend).
 */
export interface LocalObjectStoreOptions {
  /** Absolute directory owned by this store (tests use a per-run directory under os.tmpdir()). */
  readonly root: string;
  /** Runtime environment; `production` is refused. */
  readonly env: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);
const DIGEST_RE = /^[0-9a-f]{64}$/;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function assertTenant(tenantId: string): void {
  if (!UUID_RE.test(tenantId)) throw new ObjectStoreError('path_traversal');
}

/** Key patterns per area, bound to one tenant. Anything else is refused before touching the disk. */
const PATTERNS = {
  staging: (t: string) => new RegExp(`^staging/${t}/${UUID}$`),
  content: (t: string) => new RegExp(`^t/${t}/sha256/([0-9a-f]{2})/([0-9a-f]{64})$`),
};

function contentKey(tenantId: string, digest: string): string {
  return `t/${tenantId}/sha256/${digest.slice(0, 2)}/${digest}`;
}

function checkStaging(tenantId: string, key: string): void {
  assertTenant(tenantId);
  if (typeof key !== 'string' || !PATTERNS.staging(tenantId).test(key))
    throw new ObjectStoreError('path_traversal');
}

function checkContent(tenantId: string, key: string): string {
  assertTenant(tenantId);
  const m = typeof key === 'string' ? PATTERNS.content(tenantId).exec(key) : null;
  if (!m || m[2]?.slice(0, 2) !== m[1]) throw new ObjectStoreError('path_traversal');
  return m[2] as string;
}

function fsFailure(err: unknown): never {
  if (err instanceof ObjectStoreError) throw err;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') throw new ObjectStoreError('missing');
  throw new ObjectStoreError('unavailable');
}

export function createLocalObjectStore(options: LocalObjectStoreOptions): ObjectStorePort {
  if (options.env === 'production') {
    throw new Error('Refusing to start: the local object store is a synthetic development adapter only');
  }
  if (!isAbsolute(options.root)) throw new Error('object store root must be an absolute path');
  const root = resolve(options.root);

  /** Absolute path of a checked key; refuses anything that would resolve outside the root. */
  const pathOf = (key: string) => {
    const abs = resolve(root, ...key.split('/'));
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..'))
      throw new ObjectStoreError('path_traversal');
    return abs;
  };

  async function atomicWrite(abs: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
    const tmp = `${abs}.${randomUUID()}.partial`;
    await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
    await rename(tmp, abs);
  }

  async function exists(abs: string): Promise<boolean> {
    try {
      await stat(abs);
      return true;
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return false;
      throw new ObjectStoreError('unavailable');
    }
  }

  async function storeContent(tenantId: string, bytes: Uint8Array, digest: string) {
    const key = contentKey(tenantId, digest);
    const abs = pathOf(key);
    if (await exists(abs)) {
      // Identical content is already stored: verify it is intact before relying on it.
      const current = await readFile(abs).catch(fsFailure);
      if (sha256(current) === digest) return { storageKey: key, created: false };
      // Review hardening: the stored file was altered. The caller's bytes are verified against the
      // digest, so they repair the content key; the altered file is kept in quarantine for review
      // (objects already quarantined because of it stay quarantined).
      await atomicWrite(pathOf(`quarantine/${tenantId}/repaired-${randomUUID()}`), current).catch(fsFailure);
      await atomicWrite(abs, bytes).catch(fsFailure);
      return { storageKey: key, created: true };
    }
    await atomicWrite(abs, bytes).catch(fsFailure);
    return { storageKey: key, created: true };
  }

  return {
    async stage(tenantId, bytes) {
      assertTenant(tenantId);
      if (bytes.byteLength === 0) throw new ObjectStoreError('missing');
      const stagingKey = `staging/${tenantId}/${randomUUID()}`;
      await atomicWrite(pathOf(stagingKey), bytes).catch(fsFailure);
      return { stagingKey, digestSha256: sha256(bytes), byteLength: bytes.byteLength };
    },
    async readStaged(tenantId, stagingKey) {
      checkStaging(tenantId, stagingKey);
      return new Uint8Array(await readFile(pathOf(stagingKey)).catch(fsFailure));
    },
    async promote(tenantId, stagingKey, expectedDigest) {
      checkStaging(tenantId, stagingKey);
      if (!DIGEST_RE.test(expectedDigest)) throw new ObjectStoreError('digest_mismatch');
      const staged = pathOf(stagingKey);
      if (!(await exists(staged))) {
        // Retry after a promotion whose database transaction rolled back: the bytes already moved to
        // their content key; verify them there instead of failing.
        const current = await readFile(pathOf(contentKey(tenantId, expectedDigest))).catch(fsFailure);
        if (sha256(current) !== expectedDigest) throw new ObjectStoreError('digest_mismatch');
        return { storageKey: contentKey(tenantId, expectedDigest), created: false };
      }
      const bytes = await readFile(staged).catch(fsFailure);
      if (sha256(bytes) !== expectedDigest) throw new ObjectStoreError('digest_mismatch');
      const out = await storeContent(tenantId, bytes, expectedDigest);
      await rm(staged, { force: true }).catch(fsFailure);
      return out;
    },
    async quarantineStaged(tenantId, stagingKey) {
      checkStaging(tenantId, stagingKey);
      const quarantineKey = `quarantine/${tenantId}/${stagingKey.slice(-36)}`;
      const target = pathOf(quarantineKey);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 }).catch(fsFailure);
      await rename(pathOf(stagingKey), target).catch(fsFailure);
      return { quarantineKey };
    },
    async quarantineStored(tenantId, storageKey, objectRef) {
      checkContent(tenantId, storageKey);
      if (!UUID_RE.test(objectRef)) throw new ObjectStoreError('path_traversal');
      const quarantineKey = `quarantine/${tenantId}/${objectRef}`;
      const target = pathOf(quarantineKey);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 }).catch(fsFailure);
      await copyFile(pathOf(storageKey), target).catch(fsFailure);
      return { quarantineKey };
    },
    async discardStaged(tenantId, stagingKey) {
      checkStaging(tenantId, stagingKey);
      await rm(pathOf(stagingKey), { force: true }).catch(fsFailure);
    },
    async read(tenantId, storageKey, expectedDigest) {
      const digest = checkContent(tenantId, storageKey);
      const bytes = await readFile(pathOf(storageKey)).catch(fsFailure);
      // Verified on every read: the key names the digest, and the registered digest must agree too.
      if (expectedDigest !== digest || sha256(bytes) !== expectedDigest)
        throw new ObjectStoreError('digest_mismatch');
      return new Uint8Array(bytes);
    },
    async head(tenantId, storageKey) {
      checkContent(tenantId, storageKey);
      try {
        const s = await stat(pathOf(storageKey));
        return { byteLength: s.size };
      } catch (err) {
        if ((err as { code?: unknown }).code === 'ENOENT') return null;
        throw new ObjectStoreError('unavailable');
      }
    },
    async putContent(tenantId, bytes) {
      assertTenant(tenantId);
      if (bytes.byteLength === 0) throw new ObjectStoreError('missing');
      const digest = sha256(bytes);
      const { storageKey } = await storeContent(tenantId, bytes, digest);
      return { storageKey, digestSha256: digest };
    },
    async remove(tenantId, storageKey) {
      checkContent(tenantId, storageKey);
      await rm(pathOf(storageKey), { force: true }).catch(fsFailure);
    },
    async writeTombstone(tenantId, objectRef, digestSha256) {
      assertTenant(tenantId);
      if (!UUID_RE.test(objectRef) || !DIGEST_RE.test(digestSha256))
        throw new ObjectStoreError('path_traversal');
      const abs = pathOf(`tombstones/${tenantId}/${objectRef}`);
      if (await exists(abs)) return;
      const body = JSON.stringify({ objectRef, digestSha256, deletedAt: new Date().toISOString() });
      await atomicWrite(abs, new TextEncoder().encode(body)).catch(fsFailure);
    },
    async hasTombstone(tenantId, objectRef) {
      assertTenant(tenantId);
      if (!UUID_RE.test(objectRef)) throw new ObjectStoreError('path_traversal');
      return exists(pathOf(`tombstones/${tenantId}/${objectRef}`));
    },
  };
}

/**
 * Maintenance listing (orphan sweep, I1 failure and recovery). Never handed to a request path: the
 * application's port has no listing at all.
 */
export async function listLocalStoreKeys(
  root: string,
  tenantId: string,
  area: 'staging' | 'content',
): Promise<string[]> {
  assertTenant(tenantId);
  const base = area === 'staging' ? join(root, 'staging', tenantId) : join(root, 't', tenantId, 'sha256');
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return;
      throw new ObjectStoreError('unavailable');
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (!e.name.endsWith('.partial')) out.push(relative(root, p).split(sep).join('/'));
    }
  }
  await walk(base);
  return out.sort();
}

/**
 * Maintenance listing for the orphan-staging sweep: staged files older than a window. Separate from the
 * object store port (which has no listing), handed only to the reconcile sweep.
 */
export function createLocalStagingMaintenance(root: string): {
  listStagedOlderThan(tenantId: string, olderThanMs: number): Promise<string[]>;
} {
  return {
    async listStagedOlderThan(tenantId, olderThanMs) {
      assertTenant(tenantId);
      const dir = join(root, 'staging', tenantId);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        if ((err as { code?: unknown }).code === 'ENOENT') return [];
        throw new ObjectStoreError('unavailable');
      }
      const out: string[] = [];
      for (const n of names) {
        if (!UUID_RE.test(n)) continue;
        const st = await stat(join(dir, n)).catch(() => null);
        if (st?.isFile() && Date.now() - st.mtimeMs > olderThanMs) out.push(`staging/${tenantId}/${n}`);
      }
      return out.sort();
    },
  };
}
