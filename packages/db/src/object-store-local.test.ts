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
  const reads = { verify: 0, range: 0 };
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
    expect(reads).toStrictEqual({ verify: size, range: chunk });
    // Every further chunk reads only its own bytes: no whole-file read and no re-hash.
    for (let at = chunk; at < 10 * chunk; at += chunk) {
      const r = await store.readRange?.(TENANT, o.storageKey, o.digest, () => ({
        start: at,
        end: at + chunk,
      }));
      expect(Buffer.from(r?.bytes ?? []).equals(o.bytes.subarray(at, at + chunk))).toBe(true);
    }
    expect(reads).toStrictEqual({ verify: size, range: 10 * chunk });
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
