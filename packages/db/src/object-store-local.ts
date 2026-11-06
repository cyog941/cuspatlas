import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
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
  /**
   * Closeout C review: how long a ranged read may reuse the digest verification of an unchanged
   * stored file (milliseconds, default 60 s; 0 verifies on every read).
   */
  readonly verificationTtlMs?: number;
  /**
   * Test instrumentation: bytes read from disk by ranged and streamed reads (whole-file verification,
   * a range, or a streamed slice).
   */
  readonly onRead?: (kind: 'verify' | 'range' | 'stream', bytes: number) => void;
  /** Test instrumentation: a file handle opened or closed by a ranged or streamed read. */
  readonly onHandle?: (event: 'open' | 'close') => void;
}

/** Verifications kept for reuse by ranged reads (the oldest is dropped when full). */
const MAX_CACHED_VERIFICATIONS = 256;
/** Ranged reads in flight at once (each holds at most its range plus one 64 KiB hashing buffer). */
const MAX_CONCURRENT_RANGE_READS = 8;
const HASH_SLICE_BYTES = 64 * 1024;

/** The identity of a stored file's current content: any write, replacement or touch changes it. */
const fingerprintOf = (s: import('node:fs').BigIntStats) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;

/** A small counting semaphore bounding concurrent ranged reads (and so their memory). */
function semaphore(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
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

/** Refreshes a file's modification time (best effort: a vanished file is the caller's next error). */
async function touch(abs: string): Promise<void> {
  const now = new Date();
  await utimes(abs, now, now).catch(() => undefined);
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

  // Closeout C review: verifications reused by ranged reads, keyed by tenant and key (the key names the
  // digest), valid while the file's fingerprint is unchanged and for at most the TTL.
  const verificationTtlMs = Math.max(0, options.verificationTtlMs ?? 60_000);
  const verified = new Map<string, { fingerprint: string; at: number }>();
  const limitRangeReads = semaphore(MAX_CONCURRENT_RANGE_READS);
  const observe = options.onRead ?? (() => undefined);
  const onHandle = options.onHandle ?? (() => undefined);

  /** Opens a stored file for reading; `closeOnce` closes it exactly once, however often it is called. */
  async function openRead(abs: string): Promise<{ fh: FileHandle; closeOnce: () => Promise<void> }> {
    const fh = await open(abs, 'r').catch(fsFailure);
    onHandle('open');
    let closing: Promise<void> | null = null;
    const closeOnce = () => {
      closing ??= fh.close().then(
        () => onHandle('close'),
        () => onHandle('close'),
      );
      return closing;
    };
    return { fh, closeOnce };
  }

  /** Hashes an open file in bounded slices (never the whole file in memory). */
  async function hashOpen(fh: FileHandle, size: number): Promise<string> {
    const h = createHash('sha256');
    const buf = Buffer.allocUnsafe(Math.min(HASH_SLICE_BYTES, Math.max(size, 1)));
    let at = 0;
    while (at < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.byteLength, size - at), at);
      if (bytesRead === 0) break;
      h.update(buf.subarray(0, bytesRead));
      at += bytesRead;
    }
    observe('verify', at);
    if (at !== size) throw new ObjectStoreError('digest_mismatch');
    return h.digest('hex');
  }

  /**
   * Verifies an open stored file against `expectedDigest` (streaming hash, bounded memory), or reuses a
   * recent verification of the same unchanged file; answers its fingerprint and size.
   */
  async function verifyOpen(
    fh: FileHandle,
    cacheKey: string,
    expectedDigest: string,
  ): Promise<{ fingerprint: string; size: number }> {
    const st = await fh.stat({ bigint: true }).catch(fsFailure);
    const fingerprint = fingerprintOf(st);
    const size = Number(st.size);
    const hit = verified.get(cacheKey);
    if (!hit || hit.fingerprint !== fingerprint || Date.now() - hit.at >= verificationTtlMs) {
      verified.delete(cacheKey);
      if ((await hashOpen(fh, size)) !== expectedDigest) throw new ObjectStoreError('digest_mismatch');
      if (verificationTtlMs > 0) {
        if (verified.size >= MAX_CACHED_VERIFICATIONS) {
          const oldest = verified.keys().next().value;
          if (oldest !== undefined) verified.delete(oldest);
        }
        verified.set(cacheKey, { fingerprint, at: Date.now() });
      }
    }
    return { fingerprint, size };
  }

  async function storeContent(tenantId: string, bytes: Uint8Array, digest: string) {
    const key = contentKey(tenantId, digest);
    const abs = pathOf(key);
    if (await exists(abs)) {
      // Identical content is already stored: verify it is intact before relying on it.
      const current = await readFile(abs).catch(fsFailure);
      if (sha256(current) === digest) {
        // A5: reusing stored bytes refreshes their modification time, so the orphan-bytes sweep's grace
        // period counts from the latest use and a re-check just before removal sees it.
        await touch(abs);
        return { storageKey: key, created: false };
      }
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
        const contentPath = pathOf(contentKey(tenantId, expectedDigest));
        const current = await readFile(contentPath).catch(fsFailure);
        if (sha256(current) !== expectedDigest) throw new ObjectStoreError('digest_mismatch');
        await touch(contentPath);
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
    async readRange(tenantId, storageKey, expectedDigest, select) {
      const digest = checkContent(tenantId, storageKey);
      if (expectedDigest !== digest) throw new ObjectStoreError('digest_mismatch');
      const cacheKey = `${tenantId}/${storageKey}`;
      return limitRangeReads(async () => {
        const { fh, closeOnce } = await openRead(pathOf(storageKey));
        try {
          const { fingerprint, size } = await verifyOpen(fh, cacheKey, expectedDigest);
          const sel = select(size);
          let bytes = new Uint8Array(0);
          if (sel) {
            const { start, end } = sel;
            if (
              !Number.isSafeInteger(start) ||
              !Number.isSafeInteger(end) ||
              start < 0 ||
              end < start ||
              end > size
            )
              throw new RangeError('range outside the stored object');
            const buf = Buffer.alloc(end - start);
            let at = 0;
            while (at < buf.byteLength) {
              const { bytesRead } = await fh.read(buf, at, buf.byteLength - at, start + at);
              if (bytesRead === 0) break;
              at += bytesRead;
            }
            observe('range', at);
            if (at !== buf.byteLength) throw new ObjectStoreError('digest_mismatch');
            bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          }
          // The file must not have changed while it was verified or read.
          const after = await fh.stat({ bigint: true }).catch(fsFailure);
          if (fingerprintOf(after) !== fingerprint) {
            verified.delete(cacheKey);
            throw new ObjectStoreError('digest_mismatch');
          }
          return { bytes, start: sel?.start ?? 0, totalLength: size };
        } finally {
          await closeOnce();
        }
      });
    },
    async readStream(tenantId, storageKey, expectedDigest) {
      const digest = checkContent(tenantId, storageKey);
      if (expectedDigest !== digest) throw new ObjectStoreError('digest_mismatch');
      const cacheKey = `${tenantId}/${storageKey}`;
      const { fh, closeOnce } = await openRead(pathOf(storageKey));
      let checked: { fingerprint: string; size: number };
      try {
        // The verification pass shares the ranged-read bound; the streaming pass holds one slice.
        checked = await limitRangeReads(() => verifyOpen(fh, cacheKey, expectedDigest));
      } catch (err) {
        await closeOnce();
        throw err;
      }
      // Closeout E review: the handle is closed by the stream's explicit `close` (a caller that
      // drops the stream unstarted, or a destroyed response body) or when the stream ends, whichever
      // comes first; once closed, the stream fails instead of reading a closed descriptor.
      let closed = false;
      const close = () => {
        closed = true;
        return closeOnce();
      };
      const { fingerprint, size } = checked;
      /** The streamed bytes hash to the digest and the file did not change meanwhile, or it throws. */
      const finish = async (hash: string, at: number) => {
        const after = await fh.stat({ bigint: true }).catch(fsFailure);
        if (at !== size || hash !== expectedDigest || fingerprintOf(after) !== fingerprint) {
          verified.delete(cacheKey);
          throw new ObjectStoreError('digest_mismatch');
        }
      };
      async function* chunks(): AsyncGenerator<Uint8Array> {
        const h = createHash('sha256');
        let at = 0;
        try {
          while (at < size) {
            if (closed) throw new ObjectStoreError('unavailable');
            const buf = Buffer.allocUnsafe(Math.min(HASH_SLICE_BYTES, size - at));
            const { bytesRead } = await fh.read(buf, 0, buf.byteLength, at).catch(fsFailure);
            if (closed) throw new ObjectStoreError('unavailable');
            if (bytesRead === 0) break;
            const part = buf.subarray(0, bytesRead);
            h.update(part);
            at += bytesRead;
            observe('stream', bytesRead);
            // The last slice is handed out only after the whole stream re-verified, so a file that
            // changed while it streamed never completes as a valid body.
            if (at >= size) await finish(h.digest('hex'), at);
            yield new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
          }
          if (closed) throw new ObjectStoreError('unavailable');
          if (at < size || size === 0) await finish(h.digest('hex'), at);
        } finally {
          await close();
        }
      }
      return { totalLength: size, chunks: chunks(), close };
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
  listContent(
    tenantId: string,
    limit: number,
  ): Promise<{ storageKey: string; digestSha256: string; modifiedAt: Date }[]>;
  removeContentIfOlderThan(tenantId: string, storageKey: string, olderThanMs: number): Promise<boolean>;
  contentModifiedAt(tenantId: string, storageKey: string): Promise<Date | null>;
} {
  const contentPath = (tenantId: string, storageKey: string) => {
    assertTenant(tenantId);
    const m = PATTERNS.content(tenantId).exec(storageKey);
    if (!m || m[2]?.slice(0, 2) !== m[1]) throw new ObjectStoreError('path_traversal');
    return join(root, ...storageKey.split('/'));
  };
  return {
    /**
     * A5: the content files of one tenant prefix (never another tenant's), sorted by key, at most
     * `limit`. In-flight `.partial` writes and anything not shaped like a content key are skipped.
     */
    async listContent(tenantId, limit) {
      assertTenant(tenantId);
      const out: { storageKey: string; digestSha256: string; modifiedAt: Date }[] = [];
      for (const key of await listLocalStoreKeys(root, tenantId, 'content')) {
        if (out.length >= limit) break;
        const m = PATTERNS.content(tenantId).exec(key);
        if (!m || m[2]?.slice(0, 2) !== m[1]) continue;
        const st = await stat(join(root, ...key.split('/'))).catch(() => null);
        if (st?.isFile()) out.push({ storageKey: key, digestSha256: m[2] as string, modifiedAt: st.mtime });
      }
      return out;
    },
    /**
     * A5: removes one content file only if it is still older than the window (a reuse in between
     * refreshed its modification time). Returns whether it was removed; a missing file is not.
     */
    async removeContentIfOlderThan(tenantId, storageKey, olderThanMs) {
      const abs = contentPath(tenantId, storageKey);
      const st = await stat(abs).catch((err: unknown) => {
        if ((err as { code?: unknown }).code === 'ENOENT') return null;
        throw new ObjectStoreError('unavailable');
      });
      if (!st?.isFile() || Date.now() - st.mtimeMs <= olderThanMs) return false;
      await rm(abs, { force: true }).catch(fsFailure);
      return true;
    },
    /** Closeout D3: one content file's write time, or null when it does not exist. */
    async contentModifiedAt(tenantId, storageKey) {
      const st = await stat(contentPath(tenantId, storageKey)).catch((err: unknown) => {
        if ((err as { code?: unknown }).code === 'ENOENT') return null;
        throw new ObjectStoreError('unavailable');
      });
      return st?.isFile() ? st.mtime : null;
    },
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
