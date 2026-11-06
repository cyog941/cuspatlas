import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { composeWorker } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA, USER_A1 } from './support/fixtures';
import { type ImagingStack, pngBytes, startImagingStack } from './support/imaging-fixtures';

/**
 * Closeout E: the scheduled dry-run orphan-bytes report shows the removal intents left open by earlier
 * real sweeps (count and oldest age, on the database clock) and still never finishes them or removes
 * bytes. Synthetic local store only.
 */
const W = '30000000-0000-4000-8000-0000000000e1';
let s: ImagingStack;
let seed = 12_100;
const AGED = () => new Date(Date.now() - 48 * 3600 * 1000);
const blobPath = (tenant: string, digest: string) =>
  join(s.storeRoot, 't', tenant, 'sha256', digest.slice(0, 2), digest);
const env = (tenant: string) => ({
  CUSPATLAS_ENV: 'synthetic-test',
  CUSPATLAS_WORKER_PRINCIPAL_ID: W,
  CUSPATLAS_WORKER_TENANT_IDS: tenant,
  CUSPATLAS_OBJECT_STORE_DIR: s.storeRoot,
  CUSPATLAS_ORPHAN_SWEEP_INTERVAL_SECONDS: '3600',
});
const pools = () => ({ app: s.db.app, attempts: s.db.sink });
async function orphan(tenant: string) {
  seed += 1;
  const { digestSha256 } = await s.store.putContent(tenant, pngBytes(seed, 5, 5));
  utimesSync(blobPath(tenant, digestSha256), AGED(), AGED());
  return digestSha256;
}
/** An intent a real sweep committed and never finished (a crash between its commit and completion). */
async function openIntent(tenant: string, digest: string, ageSeconds: number) {
  const sweep = await s.db.admin.query<{ id: string }>(
    `INSERT INTO cuspatlas.imaging_orphan_sweeps (tenant_id, actor_id, dry_run, grace_hours, scanned_count,
       orphan_count, kept_within_grace, kept_live_object, kept_tombstone_retained, kept_legal_hold,
       kept_export_package, kept_content_locked, orphan_digests, created_at)
     VALUES ($1, $2, false, 24, 1, 1, 0, 0, 0, 0, 0, 0, ARRAY[$3::text], now() - make_interval(secs => $4::int))
     RETURNING id`,
    [tenant, USER_A1, digest, ageSeconds],
  );
  await s.db.admin.query(
    `INSERT INTO cuspatlas.imaging_orphan_removals (tenant_id, sweep_id, digest_sha256, storage_key, intended_by,
       created_at)
     VALUES ($1::uuid, $2, $3::text, 't/' || $1::text || '/sha256/' || substr($3::text, 1, 2) || '/' || $3::text, $4,
       now() - make_interval(secs => $5::int))`,
    [tenant, sweep.rows[0]?.id, digest, USER_A1, ageSeconds],
  );
}

beforeAll(async () => {
  s = await startImagingStack('worker_orphan_sweep_e');
  await s.db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'svc-worker-orphans-e') ON CONFLICT DO NOTHING`,
    [W],
  );
  await s.db.admin.query(
    'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) SELECT t, $1, $2 FROM unnest($3::uuid[]) t',
    [
      W,
      ['admin.configure', 'outbox.deliver', 'communications.deliver'],
      [T_ALPHA, '10000000-0000-4000-8000-00000000000b'],
    ],
  );
});
afterAll(async () => {
  await s?.close();
});

describe('Closeout E1: the scheduled dry run reports open removal intents', () => {
  it('reports the count and oldest age of open intents, finishes none of them and removes no bytes', async () => {
    const older = await orphan(T_ALPHA);
    const newer = await orphan(T_ALPHA);
    await openIntent(T_ALPHA, older, 7200);
    await openIntent(T_ALPHA, newer, 600);
    const w = await composeWorker(env(T_ALPHA), { pools: pools() });
    const r = await w.tick();
    expect(r.errors.filter((e) => e.stage === 'orphan_sweep')).toStrictEqual([]);
    expect(r.orphanSweeps).toHaveLength(1);
    const report = r.orphanSweeps?.[0];
    expect(report?.openIntents).toBe(2);
    expect(report?.oldestOpenIntentAgeSeconds).toBeGreaterThanOrEqual(7200);
    expect(report?.oldestOpenIntentAgeSeconds).toBeLessThan(7200 + 300);
    // The append-only record carries the same figures for an operator reading the report later.
    const rec = await s.db.admin.query<{ open_intent_count: number; oldest_open_intent_age_seconds: number }>(
      `SELECT open_intent_count, oldest_open_intent_age_seconds FROM cuspatlas.imaging_orphan_sweeps
       WHERE id = $1`,
      [report?.sweepRef],
    );
    expect(rec.rows[0]?.open_intent_count).toBe(2);
    expect(rec.rows[0]?.oldest_open_intent_age_seconds).toBe(report?.oldestOpenIntentAgeSeconds);
    // Nothing finished, nothing removed.
    const states = await s.db.admin.query<{ state: string }>(
      'SELECT state FROM cuspatlas.imaging_orphan_removals WHERE tenant_id = $1',
      [T_ALPHA],
    );
    expect(states.rows.map((x) => x.state)).toStrictEqual(['intended', 'intended']);
    expect(existsSync(blobPath(T_ALPHA, older))).toBe(true);
    expect(existsSync(blobPath(T_ALPHA, newer))).toBe(true);
  });
});
