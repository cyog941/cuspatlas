import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { composeWorker } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA, T_BETA } from './support/fixtures';
import { type ImagingStack, pngBytes, startImagingStack } from './support/imaging-fixtures';

/**
 * Closeout D4: the orphan-bytes sweep as an optional scheduled worker job. Disabled unless
 * `CUSPATLAS_ORPHAN_SWEEP_INTERVAL_SECONDS` is set (and an object store is configured). When due for a
 * served tenant (its last scheduled sweep is older than the interval, so a restart does not re-run
 * early), the worker runs the sweep in dry-run mode only, as its service principal through the
 * worker-only `imaging.storage.scheduledOrphanSweep`, and the report is the append-only sweep record.
 * Removing bytes stays a human operation. Synthetic local store only.
 */
const W = '30000000-0000-4000-8000-0000000000d6';
let s: ImagingStack;
let seed = 9900;
const AGED = () => new Date(Date.now() - 48 * 3600 * 1000);
const blobPath = (tenant: string, digest: string) =>
  join(s.storeRoot, 't', tenant, 'sha256', digest.slice(0, 2), digest);
const env = (extra: Record<string, string> = {}) => ({
  CUSPATLAS_ENV: 'synthetic-test',
  CUSPATLAS_WORKER_PRINCIPAL_ID: W,
  CUSPATLAS_WORKER_TENANT_IDS: T_ALPHA,
  CUSPATLAS_OBJECT_STORE_DIR: s.storeRoot,
  ...extra,
});
const pools = () => ({ app: s.db.app, attempts: s.db.sink });
async function orphan(tenant = T_ALPHA) {
  seed += 1;
  const { digestSha256 } = await s.store.putContent(tenant, pngBytes(seed, 5, 5));
  utimesSync(blobPath(tenant, digestSha256), AGED(), AGED());
  return digestSha256;
}
const scheduledSweeps = async () =>
  (
    await s.db.admin.query<{ tenant_id: string; dry_run: boolean; orphan_digests: string[] }>(
      `SELECT tenant_id, dry_run, orphan_digests FROM cuspatlas.imaging_orphan_sweeps WHERE actor_id = $1
       ORDER BY created_at`,
      [W],
    )
  ).rows;
const setScopes = (scopes: string[]) =>
  s.db.admin.query('UPDATE cuspatlas.memberships SET scopes = $2 WHERE principal_id = $1', [W, scopes]);

beforeAll(async () => {
  s = await startImagingStack('worker_orphan_sweep');
  await s.db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'svc-worker-orphans') ON CONFLICT DO NOTHING`,
    [W],
  );
  for (const t of [T_ALPHA, T_BETA])
    await s.db.admin.query(
      'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [t, W, ['admin.configure', 'outbox.deliver', 'communications.deliver']],
    );
});
afterAll(async () => {
  await s?.close();
});

describe('Closeout D4: scheduled dry-run orphan-bytes sweep', () => {
  it('is disabled unless the interval is set, and records nothing', async () => {
    const w = await composeWorker(env(), { pools: pools() });
    expect(w.disabled).toContainEqual({
      consumer: 'orphanSweep',
      reason: 'no orphan sweep interval is configured (CUSPATLAS_ORPHAN_SWEEP_INTERVAL_SECONDS)',
    });
    const r = await w.tick();
    expect(r.orphanSweeps).toBeNull();
    expect(await scheduledSweeps()).toStrictEqual([]);
  });

  it('refuses a malformed interval', async () => {
    for (const v of ['abc', '10', '9999999999'])
      await expect(
        composeWorker(env({ CUSPATLAS_ORPHAN_SWEEP_INTERVAL_SECONDS: v }), { pools: pools() }),
      ).rejects.toThrow(/CUSPATLAS_ORPHAN_SWEEP_INTERVAL_SECONDS/);
  });

  it('when due, runs a dry run only and records the report; nothing is removed; not again inside the interval', async () => {
    const d = await orphan();
    const beta = await orphan(T_BETA);
    const w = await composeWorker(env({ CUSPATLAS_ORPHAN_SWEEP_INTERVAL_SECONDS: '3600' }), {
      pools: pools(),
    });
    expect(w.disabled.some((x) => x.consumer === 'orphanSweep')).toBe(false);
    const r = await w.tick();
    expect(r.errors.filter((e) => e.stage === 'orphan_sweep')).toStrictEqual([]);
    expect(r.orphanSweeps).toHaveLength(1);
    expect(r.orphanSweeps?.[0]).toMatchObject({ tenantId: T_ALPHA, dryRun: true });
    expect(r.orphanSweeps?.[0]?.orphans).toBeGreaterThanOrEqual(1);
    const rows = await scheduledSweeps();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: T_ALPHA, dry_run: true });
    expect(rows[0]?.orphan_digests).toContain(d);
    // Only the served tenant's prefix is listed; nothing is removed and no removal intent is recorded.
    expect(rows[0]?.orphan_digests).not.toContain(beta);
    expect(existsSync(blobPath(T_ALPHA, d))).toBe(true);
    const intents = await s.db.admin.query('SELECT 1 FROM cuspatlas.imaging_orphan_removals');
    expect(intents.rows).toStrictEqual([]);
    const audit = await s.db.admin.query(
      `SELECT actor_id FROM cuspatlas.audit_events WHERE operation = 'imaging.storage.scheduledOrphanSweep'`,
    );
    expect(audit.rows).toStrictEqual([{ actor_id: W }]);
    // Due-ness comes from the record: a second tick (or a restarted worker) inside the interval runs nothing.
    expect((await w.tick()).orphanSweeps).toStrictEqual([]);
    const restarted = await composeWorker(env({ CUSPATLAS_ORPHAN_SWEEP_INTERVAL_SECONDS: '3600' }), {
      pools: pools(),
    });
    expect((await restarted.tick()).orphanSweeps).toStrictEqual([]);
    expect(await scheduledSweeps()).toHaveLength(1);
  });

  it('a worker without admin.configure or with a revoked membership records nothing', async () => {
    const served = { CUSPATLAS_WORKER_TENANT_IDS: T_BETA, CUSPATLAS_ORPHAN_SWEEP_INTERVAL_SECONDS: '3600' };
    await setScopes(['outbox.deliver', 'communications.deliver']);
    try {
      const r = await (await composeWorker(env(served), { pools: pools() })).tick();
      expect(r.errors.some((e) => e.stage === 'orphan_sweep')).toBe(true);
      expect((await scheduledSweeps()).filter((x) => x.tenant_id === T_BETA)).toStrictEqual([]);
    } finally {
      await setScopes(['admin.configure', 'outbox.deliver', 'communications.deliver']);
    }
    await s.db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1', [
      W,
    ]);
    try {
      const r = await (await composeWorker(env(served), { pools: pools() })).tick();
      expect(r.errors.some((e) => e.stage === 'orphan_sweep')).toBe(true);
      expect((await scheduledSweeps()).filter((x) => x.tenant_id === T_BETA)).toStrictEqual([]);
    } finally {
      await s.db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = NULL WHERE principal_id = $1', [
        W,
      ]);
    }
  });

  it('the scheduled operation is worker-only: service principals only, no REST or MCP surface', async () => {
    const tools = await s.mcpToolNames('owner');
    expect(tools.some((t) => t.includes('scheduled'))).toBe(false);
    const catalog = (await import('../../packages/contracts/src/catalog/operations.json')).default as {
      operation: string;
      transports: string[];
      principals: string[];
    }[];
    expect(catalog.find((o) => o.operation === 'imaging.storage.scheduledOrphanSweep')).toMatchObject({
      transports: ['worker'],
      principals: ['service'],
    });
  });
});
