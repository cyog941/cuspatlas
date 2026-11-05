import { randomUUID } from 'node:crypto';
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA, T_BETA, USER_A1 } from './support/fixtures';
import { type ImagingStack, pngBytes, putFixtureObject, startImagingStack } from './support/imaging-fixtures';

/**
 * Closeout D3: orphan-bytes removal is durable-first. A real sweep commits one removal intent per
 * candidate (with its sweep record) before any byte is touched; each intent is then finished in its
 * own transaction under the content lock (references re-checked, bytes removed, intent marked). A
 * failure between the steps leaves a committed intent that the next real run (or a same-key retry)
 * finishes, or reconciles when the bytes are already gone. Synthetic local store only.
 */
let s: ImagingStack;
let seed = 9700;
let fail: 'none' | 'beforeRemove' | 'afterRemove' = 'none';
let onRemove: ((key: string) => Promise<void>) | null = null;
const PATH = '/v1/imaging/storage/orphan-bytes/sweep';
const AGED = () => new Date(Date.now() - 48 * 3600 * 1000);
const blobPath = (tenant: string, digest: string) =>
  join(s.storeRoot, 't', tenant, 'sha256', digest.slice(0, 2), digest);
interface SweepData {
  sweepRef: string;
  orphans: string[];
  removed: string[];
  pending: number;
  resumed: number;
}
const data = (r: { json: Record<string, unknown> }) => r.json.data as SweepData;
const sweep = (key?: string) => s.command('owner', PATH, { dryRun: false }, key);
const intent = async (digest: string) =>
  (
    await s.db.admin.query<{
      state: string;
      kept_reason: string | null;
      sweep_id: string;
      completed_sweep_id: string | null;
      completed_by: string | null;
    }>(
      `SELECT state, kept_reason, sweep_id, completed_sweep_id, completed_by
       FROM cuspatlas.imaging_orphan_removals WHERE digest_sha256 = $1 ORDER BY created_at`,
      [digest],
    )
  ).rows;
const bytes = () => {
  seed += 1;
  return pngBytes(seed, 5, 5);
};
async function orphan(b = bytes()) {
  const { digestSha256 } = await s.store.putContent(T_ALPHA, b);
  utimesSync(blobPath(T_ALPHA, digestSha256), AGED(), AGED());
  return digestSha256;
}

beforeAll(async () => {
  s = await startImagingStack('imaging_orphan_removals', {
    wrapMaintenance: (m) => ({
      ...m,
      async removeContentIfOlderThan(tenantId, storageKey, olderThanMs) {
        if (onRemove) await onRemove(storageKey);
        if (fail === 'beforeRemove') throw new Error('simulated crash before the byte removal');
        const removed = await m.removeContentIfOlderThan(tenantId, storageKey, olderThanMs);
        if (fail === 'afterRemove') throw new Error('simulated crash after the byte removal');
        return removed;
      },
    }),
  });
});
afterAll(async () => {
  await s?.close();
});

describe('Closeout D3: durable-first orphan-bytes removal', () => {
  it('commits the removal intent before touching bytes, then removes and marks it complete', async () => {
    const d = await orphan();
    let seenBeforeRemoval: string[] = [];
    onRemove = async () => {
      // Another connection sees the intent: it was committed before the removal started.
      seenBeforeRemoval = (await intent(d)).map((r) => r.state);
    };
    try {
      const r = await sweep();
      expect(r.status).toBe(200);
      const out = data(r);
      expect(seenBeforeRemoval).toStrictEqual(['intended']);
      expect(out.removed).toContain(d);
      expect(out.pending).toBe(0);
      expect(existsSync(blobPath(T_ALPHA, d))).toBe(false);
      expect(await intent(d)).toStrictEqual([
        {
          state: 'removed',
          kept_reason: null,
          sweep_id: out.sweepRef,
          completed_sweep_id: out.sweepRef,
          completed_by: USER_A1,
        },
      ]);
    } finally {
      onRemove = null;
    }
  });

  it('a failure before the byte removal leaves the intent; the next run finishes it', async () => {
    const d = await orphan();
    fail = 'beforeRemove';
    const first = data(await sweep());
    fail = 'none';
    expect(first.removed).not.toContain(d);
    expect(first.orphans).toContain(d);
    expect(first.pending).toBeGreaterThanOrEqual(1);
    expect(existsSync(blobPath(T_ALPHA, d))).toBe(true);
    expect((await intent(d)).map((r) => r.state)).toStrictEqual(['intended']);
    const next = data(await sweep());
    expect(next.resumed).toBeGreaterThanOrEqual(1);
    expect(existsSync(blobPath(T_ALPHA, d))).toBe(false);
    expect(await intent(d)).toMatchObject([
      { state: 'removed', sweep_id: first.sweepRef, completed_sweep_id: next.sweepRef },
    ]);
  });

  it('a removal whose completion rolled back leaves a record the next run reconciles', async () => {
    const d = await orphan();
    fail = 'afterRemove';
    const first = data(await sweep());
    fail = 'none';
    // The bytes are gone, the transaction that would mark the intent rolled back: the intent remains.
    expect(existsSync(blobPath(T_ALPHA, d))).toBe(false);
    expect(first.removed).not.toContain(d);
    expect((await intent(d)).map((r) => r.state)).toStrictEqual(['intended']);
    const next = data(await sweep());
    expect(next.resumed).toBeGreaterThanOrEqual(1);
    expect(await intent(d)).toMatchObject([
      { state: 'absent', sweep_id: first.sweepRef, completed_sweep_id: next.sweepRef },
    ]);
  });

  it('a same-key retry finishes its own pending intent and replays the sweep', async () => {
    const d = await orphan();
    const key = randomUUID();
    fail = 'beforeRemove';
    const first = data(await sweep(key));
    fail = 'none';
    expect(first.pending).toBeGreaterThanOrEqual(1);
    const again = await sweep(key);
    expect(again.json.replayed).toBe(true);
    expect(data(again).sweepRef).toBe(first.sweepRef);
    expect(data(again).removed).toContain(d);
    expect(data(again).pending).toBe(0);
    expect(existsSync(blobPath(T_ALPHA, d))).toBe(false);
  });

  it('an intent whose bytes were registered again meanwhile is kept, never removed', async () => {
    const b = bytes();
    const d = await orphan(b);
    fail = 'beforeRemove';
    await sweep();
    fail = 'none';
    await putFixtureObject(s.db.admin, s.store, { tenantId: T_ALPHA, createdBy: USER_A1, bytes: b });
    utimesSync(blobPath(T_ALPHA, d), AGED(), AGED());
    await sweep();
    expect(existsSync(blobPath(T_ALPHA, d))).toBe(true);
    expect(await intent(d)).toMatchObject([{ state: 'kept', kept_reason: 'liveObject' }]);
  });

  it('intents are append-only, tenant-bound and invisible to another tenant', async () => {
    const d = await orphan();
    fail = 'beforeRemove';
    await sweep();
    fail = 'none';
    await expect(
      s.db.admin.query(
        `UPDATE cuspatlas.imaging_orphan_removals SET digest_sha256 = $2 WHERE digest_sha256 = $1`,
        [d, 'f'.repeat(64)],
      ),
    ).rejects.toThrow();
    await expect(
      s.db.admin.query('DELETE FROM cuspatlas.imaging_orphan_removals WHERE digest_sha256 = $1', [d]),
    ).rejects.toThrow();
    const c = await s.db.app.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('cuspatlas.tenant_id', $1, true)", [T_BETA]);
      const seen = await c.query('SELECT 1 FROM cuspatlas.imaging_orphan_removals WHERE digest_sha256 = $1', [
        d,
      ]);
      expect(seen.rows).toStrictEqual([]);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    // Finish it so later suites see no pending intent.
    await sweep();
  });
});
