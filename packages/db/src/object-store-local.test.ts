import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createLocalObjectStore } from './object-store-local';

/**
 * Closeout C review: ranged reads of stored bytes (export package chunks over MCP and REST) read only
 * the requested range. The whole object is verified against its digest first; a recent verification
 * of the same unchanged file (size, modification and change time, file identity) is reused for a
 * bounded time, and any change re-verifies, so tampering is still detected. Synthetic bytes only; the
 * store root lives under the worktree's ignored node_modules/.cache.
 */
const root = resolve('node_modules/.cache/cuspatlas', `object-store-range-${randomUUID()}`);
const TENANT = '10000000-0000-4000-8000-00000000000a';
afterAll(() => rmSync(root, { recursive: true, force: true }));

function storeWithMeter(verificationTtlMs?: number) {
  const reads = { verify: 0, range: 0, stream: 0 };
  const store = createLocalObjectStore({
    root,
    env: 'synthetic-test',
    ...(verificationTtlMs === undefined ? {} : { verificationTtlMs }),
    onRead: (kind, bytes) => {
      reads[kind] += bytes;
    },
  });
  return { store, reads };
}

async function stored(store: ReturnType<typeof createLocalObjectStore>, size: number) {
  const bytes = randomBytes(size);
  const staged = await store.stage(TENANT, bytes);
  const { storageKey } = await store.promote(TENANT, staged.stagingKey, staged.digestSha256);
  return { bytes, storageKey, digest: staged.digestSha256, path: join(root, ...storageKey.split('/')) };
}

describe('local object store ranged reads', () => {
  it('verifies once, then reads only the requested range per chunk', async () => {
    const { store, reads } = storeWithMeter();
    const size = 4 * 1024 * 1024;
    const o = await stored(store, size);
    const chunk = 64 * 1024;
    const first = await store.readRange?.(TENANT, o.storageKey, o.digest, (total) => ({
      start: 0,
      end: Math.min(chunk, total),
    }));
    expect(first?.totalLength).toBe(size);
    expect(first?.start).toBe(0);
    expect(Buffer.from(first?.bytes ?? []).equals(o.bytes.subarray(0, chunk))).toBe(true);
    expect(reads).toStrictEqual({ verify: size, range: chunk, stream: 0 });
    // Every further chunk reads only its own bytes: no whole-file read and no re-hash.
    for (let at = chunk; at < 10 * chunk; at += chunk) {
      const r = await store.readRange?.(TENANT, o.storageKey, o.digest, () => ({
        start: at,
        end: at + chunk,
      }));
      expect(Buffer.from(r?.bytes ?? []).equals(o.bytes.subarray(at, at + chunk))).toBe(true);
    }
    expect(reads).toStrictEqual({ verify: size, range: 10 * chunk, stream: 0 });
    // A selection of nothing (an offset past the end) still answers the verified total, no bytes.
    const none = await store.readRange?.(TENANT, o.storageKey, o.digest, () => null);
    expect([none?.bytes.byteLength, none?.totalLength]).toStrictEqual([0, size]);
  });

  it('detects tampering after a cached verification, even with size and modification time restored', async () => {
    const { store, reads } = storeWithMeter();
    const o = await stored(store, 256 * 1024);
    const sel = () => ({ start: 0, end: 1024 });
    await store.readRange?.(TENANT, o.storageKey, o.digest, sel);
    expect(reads.verify).toBe(256 * 1024);
    const original = readFileSync(o.path);
    const altered = Buffer.from(original);
    altered[1000] = (altered[1000] ?? 0) ^ 0x01;
    const before = new Date(Date.now() - 60_000);
    utimesSync(o.path, before, before);
    await store.readRange?.(TENANT, o.storageKey, o.digest, sel);
    // Same size, same modification time as cached, but the change time moved: re-verified, refused.
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(o.path, altered);
    utimesSync(o.path, before, before);
    await expect(store.readRange?.(TENANT, o.storageKey, o.digest, sel)).rejects.toMatchObject({
      code: 'digest_mismatch',
    });
    // Restored bytes verify again.
    writeFileSync(o.path, original);
    const ok = await store.readRange?.(TENANT, o.storageKey, o.digest, sel);
    expect(Buffer.from(ok?.bytes ?? []).equals(original.subarray(0, 1024))).toBe(true);
  });

  it('a cached verification expires; a wrong digest or a range outside the object is refused', async () => {
    const { store, reads } = storeWithMeter(0);
    const o = await stored(store, 8 * 1024);
    const sel = () => ({ start: 0, end: 10 });
    await store.readRange?.(TENANT, o.storageKey, o.digest, sel);
    await store.readRange?.(TENANT, o.storageKey, o.digest, sel);
    expect(reads.verify).toBe(2 * 8 * 1024);
    await expect(store.readRange?.(TENANT, o.storageKey, 'f'.repeat(64), sel)).rejects.toMatchObject({
      code: 'digest_mismatch',
    });
    await expect(
      store.readRange?.(TENANT, o.storageKey, o.digest, (t) => ({ start: 0, end: t + 1 })),
    ).rejects.toThrow();
  });
});

/** Closeout E4: drains a streamed read, recording the largest chunk it was handed. */
async function drain(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
  const parts: Buffer[] = [];
  let peak = 0;
  for await (const c of chunks) {
    peak = Math.max(peak, c.byteLength);
    parts.push(Buffer.from(c));
  }
  return { bytes: Buffer.concat(parts), peak };
}

describe('Closeout E4: local object store streamed whole reads', () => {
  it('verifies with a streaming hash, then streams in bounded slices; never one whole buffer', async () => {
    const { store, reads } = storeWithMeter();
    const size = 4 * 1024 * 1024;
    const o = await stored(store, size);
    const r = await store.readStream?.(TENANT, o.storageKey, o.digest);
    expect(r?.totalLength).toBe(size);
    // Verified before any byte is handed out, with a 64 KiB hashing buffer.
    expect(reads).toStrictEqual({ verify: size, range: 0, stream: 0 });
    const out = await drain(r?.chunks ?? []);
    expect(out.bytes.equals(o.bytes)).toBe(true);
    expect(out.peak).toBeLessThanOrEqual(64 * 1024);
    expect(out.peak * 16).toBeLessThan(size);
    expect(reads).toStrictEqual({ verify: size, range: 0, stream: size });
  });

  it('an unchanged, recently verified file streams without a second verification pass', async () => {
    const { store, reads } = storeWithMeter();
    const size = 512 * 1024;
    const o = await stored(store, size);
    await drain((await store.readStream?.(TENANT, o.storageKey, o.digest))?.chunks ?? []);
    const again = await store.readStream?.(TENANT, o.storageKey, o.digest);
    const out = await drain(again?.chunks ?? []);
    expect(out.bytes.equals(o.bytes)).toBe(true);
    expect(reads).toStrictEqual({ verify: size, range: 0, stream: 2 * size });
    // A ranged read reuses the same verification.
    await store.readRange?.(TENANT, o.storageKey, o.digest, () => ({ start: 0, end: 10 }));
    expect(reads.verify).toBe(size);
  });

  it('refuses tampered bytes before handing out any chunk, and a wrong digest', async () => {
    const { store } = storeWithMeter();
    const o = await stored(store, 256 * 1024);
    const original = readFileSync(o.path);
    const altered = Buffer.from(original);
    altered[5000] = (altered[5000] ?? 0) ^ 0x01;
    writeFileSync(o.path, altered);
    try {
      await expect(store.readStream?.(TENANT, o.storageKey, o.digest)).rejects.toMatchObject({
        code: 'digest_mismatch',
      });
    } finally {
      writeFileSync(o.path, original);
    }
    await expect(store.readStream?.(TENANT, o.storageKey, 'f'.repeat(64))).rejects.toMatchObject({
      code: 'digest_mismatch',
    });
  });

  it('a file changed while it streams fails the stream; it never completes as valid', async () => {
    const { store } = storeWithMeter();
    const size = 1024 * 1024;
    const o = await stored(store, size);
    const r = await store.readStream?.(TENANT, o.storageKey, o.digest);
    const original = readFileSync(o.path);
    const altered = Buffer.from(original);
    altered[size - 10] = (altered[size - 10] ?? 0) ^ 0x01;
    let first = true;
    const consume = async () => {
      for await (const _c of r?.chunks ?? []) {
        if (first) {
          first = false;
          writeFileSync(o.path, altered);
        }
      }
    };
    try {
      await expect(consume()).rejects.toMatchObject({ code: 'digest_mismatch' });
    } finally {
      writeFileSync(o.path, original);
    }
  });
});

describe('Closeout E review: a streamed read never leaks its file handle', () => {
  function storeWithHandles() {
    const handles = { open: 0, opened: 0 };
    const store = createLocalObjectStore({
      root,
      env: 'synthetic-test',
      onHandle: (event) => {
        if (event === 'open') {
          handles.open += 1;
          handles.opened += 1;
        } else handles.open -= 1;
      },
    });
    return { store, handles };
  }
  const streamOf = async (
    store: ReturnType<typeof createLocalObjectStore>,
    o: { storageKey: string; digest: string },
  ) => {
    const r = await store.readStream?.(TENANT, o.storageKey, o.digest);
    if (!r) throw new Error('readStream missing');
    return r;
  };

  it('normal completion closes the handle', async () => {
    const { store, handles } = storeWithHandles();
    const o = await stored(store, 200 * 1024);
    const r = await streamOf(store, o);
    expect(handles).toStrictEqual({ open: 1, opened: 1 });
    expect((await drain(r.chunks)).bytes.equals(o.bytes)).toBe(true);
    expect(handles).toStrictEqual({ open: 0, opened: 1 });
    // The explicit close after completion is a no-op.
    await r.close();
    expect(handles.open).toBe(0);
  });

  it('a stream that is never started is closed by its explicit, idempotent close', async () => {
    const { store, handles } = storeWithHandles();
    const o = await stored(store, 100 * 1024);
    const r = await streamOf(store, o);
    expect(handles.open).toBe(1);
    await Promise.all([r.close(), r.close()]);
    await r.close();
    expect(handles).toStrictEqual({ open: 0, opened: 1 });
    // Iterating a closed stream fails instead of reading a closed descriptor or hanging.
    await expect(drain(r.chunks)).rejects.toThrow();
    expect(handles.open).toBe(0);
  });

  it('an early break and a close while streaming both close the handle once', async () => {
    const { store, handles } = storeWithHandles();
    const o = await stored(store, 300 * 1024);
    const r = await streamOf(store, o);
    for await (const _c of r.chunks) break;
    expect(handles.open).toBe(0);
    const again = await streamOf(store, o);
    const it = again.chunks[Symbol.asyncIterator]();
    await it.next();
    await again.close();
    await expect(it.next()).rejects.toThrow();
    expect(handles).toStrictEqual({ open: 0, opened: 2 });
  });

  it('a mid-stream integrity error closes the handle', async () => {
    const { store, handles } = storeWithHandles();
    const size = 512 * 1024;
    const o = await stored(store, size);
    const r = await streamOf(store, o);
    const original = readFileSync(o.path);
    const altered = Buffer.from(original);
    altered[size - 10] = (altered[size - 10] ?? 0) ^ 0x01;
    writeFileSync(o.path, altered);
    try {
      await expect(drain(r.chunks)).rejects.toMatchObject({ code: 'digest_mismatch' });
    } finally {
      writeFileSync(o.path, original);
    }
    expect(handles.open).toBe(0);
    await r.close();
    expect(handles).toStrictEqual({ open: 0, opened: 1 });
  });

  it('a refused (tampered) file closes the handle before answering', async () => {
    const { store, handles } = storeWithHandles();
    const o = await stored(store, 64 * 1024 + 7);
    const original = readFileSync(o.path);
    const altered = Buffer.from(original);
    altered[3] = (altered[3] ?? 0) ^ 0x01;
    writeFileSync(o.path, altered);
    try {
      await expect(store.readStream?.(TENANT, o.storageKey, o.digest)).rejects.toMatchObject({
        code: 'digest_mismatch',
      });
    } finally {
      writeFileSync(o.path, original);
    }
    expect(handles).toStrictEqual({ open: 0, opened: 1 });
  });
});
