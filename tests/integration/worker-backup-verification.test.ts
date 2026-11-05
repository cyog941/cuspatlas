import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBackup } from '@cuspatlas/db';
import { composeWorker, type WorkerMainLogLine } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA, T_BETA } from './support/fixtures';
import { type ImagingStack, startImagingStack } from './support/imaging-fixtures';

/**
 * M9 backup verification wired into the worker tick (synthetic data only). With a backup location and
 * a restore target configured, a tick verifies the latest backup (digests and an isolated sample
 * restore) and records the result per served tenant through `operations.backupVerifications.record`
 * as the worker's service principal; due-ness comes from the last recorded verification, so a second
 * tick inside the interval (or a restart) records nothing. A verification that throws is recorded as
 * failed, never passed. Without a location the job is disabled with one structured reason line.
 */
const W = '30000000-0000-4000-8000-0000000000d7';
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const scratch: string[] = [];
let s: ImagingStack;
let backupDir: string;

const restoreUrl = (port: number) =>
  `postgres://postgres:${encodeURIComponent(process.env.CUSPATLAS_TEST_PG_ADMIN_PASSWORD ?? '')}@127.0.0.1:${port}/postgres`;
const baseEnv = () => ({
  CUSPATLAS_ENV: 'synthetic-test',
  CUSPATLAS_WORKER_PRINCIPAL_ID: W,
  CUSPATLAS_WORKER_TENANT_IDS: `${T_ALPHA},${T_BETA}`,
});
const configuredEnv = (port = Number(process.env.CUSPATLAS_TEST_PG_PORT)) => ({
  ...baseEnv(),
  CUSPATLAS_BACKUP_LOCATION: backupDir,
  CUSPATLAS_RESTORE_ADMIN_DATABASE_URL: restoreUrl(port),
  CUSPATLAS_BACKUP_VERIFY_INTERVAL_SECONDS: '3600',
});
const pools = () => ({ app: s.db.app, attempts: s.db.sink });

async function verifications() {
  const { rows } = await s.db.admin.query<{
    tenant_id: string;
    result: string;
    failure_code: string | null;
    recorded_by: string;
  }>(
    'SELECT tenant_id, result, failure_code, recorded_by FROM cuspatlas.ops_backup_verifications ORDER BY checked_at, tenant_id',
  );
  return rows;
}

beforeAll(async () => {
  s = await startImagingStack('worker_backup_verify');
  await s.db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'svc-worker-backup') ON CONFLICT DO NOTHING`,
    [W],
  );
  for (const t of [T_ALPHA, T_BETA]) {
    await s.db.admin.query(
      'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [t, W, ['outbox.deliver', 'migration.write']],
    );
  }
  backupDir = mkdtempSync(join(tmpdir(), 'cuspatlas-worker-backup-'));
  scratch.push(backupDir);
  const client = await s.db.admin.connect();
  try {
    await createBackup(client, { outDir: backupDir, repoRoot: REPO_ROOT });
  } finally {
    client.release();
  }
}, 300_000);

afterAll(async () => {
  await s?.close();
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe('worker backup verification (M9)', () => {
  it('without a backup location the job is disabled with one structured reason and records nothing', async () => {
    const lines: WorkerMainLogLine[] = [];
    const w = await composeWorker(baseEnv(), { pools: pools(), log: (l) => lines.push(l) });
    const r = await w.tick();
    expect(r.backupVerification).toBeNull();
    expect(lines.filter((l) => l.msg === 'backup_verification_disabled')).toStrictEqual([
      { msg: 'backup_verification_disabled', reason: 'backup_location_not_configured' },
    ]);
    await w.tick();
    expect(lines.filter((l) => l.msg === 'backup_verification_disabled')).toHaveLength(1);

    const partial: WorkerMainLogLine[] = [];
    const w2 = await composeWorker(
      { ...baseEnv(), CUSPATLAS_BACKUP_LOCATION: backupDir },
      { pools: pools(), log: (l) => partial.push(l) },
    );
    await w2.tick();
    expect(partial.filter((l) => l.msg === 'backup_verification_disabled')).toStrictEqual([
      { msg: 'backup_verification_disabled', reason: 'restore_target_not_configured' },
    ]);
    // No path or connection detail is ever logged.
    expect(JSON.stringify([...lines, ...partial])).not.toContain(backupDir);
    expect(await verifications()).toStrictEqual([]);
  });

  it('refuses an interval longer than the readiness freshness window', async () => {
    await expect(
      composeWorker(
        { ...configuredEnv(), CUSPATLAS_BACKUP_VERIFY_INTERVAL_SECONDS: '90000' },
        { pools: pools() },
      ),
    ).rejects.toThrow(/CUSPATLAS_BACKUP_VERIFY_INTERVAL_SECONDS/);
  });

  it('a configured tick verifies and records per served tenant; a second tick and a restart inside the interval record nothing', {
    timeout: 300_000,
  }, async () => {
    const lines: WorkerMainLogLine[] = [];
    const w = await composeWorker(configuredEnv(), { pools: pools(), log: (l) => lines.push(l) });
    const first = await w.tick();
    expect(first.errors).toStrictEqual([]);
    expect(first.backupVerification).toStrictEqual([
      { tenantId: T_ALPHA, recorded: true, result: 'verified' },
      { tenantId: T_BETA, recorded: true, result: 'verified' },
    ]);
    const rows = await verifications();
    expect(rows.map((r) => [r.tenant_id, r.result, r.recorded_by]).sort()).toStrictEqual(
      [
        [T_ALPHA, 'verified', W],
        [T_BETA, 'verified', W],
      ].sort(),
    );
    const second = await w.tick();
    expect(second.backupVerification).toStrictEqual([]);
    const restarted = await composeWorker(configuredEnv(), { pools: pools() });
    expect((await restarted.tick()).backupVerification).toStrictEqual([]);
    expect(await verifications()).toHaveLength(2);
    expect(lines.some((l) => l.msg === 'backup_verification_disabled')).toBe(false);
    // The record goes through the business operation: audited with the worker principal as actor.
    const { rows: audit } = await s.db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.audit_events
       WHERE operation = 'operations.backupVerifications.record' AND actor_id = $1`,
      [W],
    );
    expect(audit[0]?.n).toBe(2);
  });

  it('a verification that throws (restore target unreachable) is recorded as failed, never passed', {
    timeout: 300_000,
  }, async () => {
    await s.db.admin.query(
      `BEGIN; SET LOCAL session_replication_role = replica;
       UPDATE cuspatlas.ops_backup_verifications SET checked_at = checked_at - interval '2 hours';
       COMMIT;`,
    );
    const w = await composeWorker(configuredEnv(1), { pools: pools() });
    const r = await w.tick();
    expect(r.backupVerification).toStrictEqual([
      { tenantId: T_ALPHA, recorded: true, result: 'failed' },
      { tenantId: T_BETA, recorded: true, result: 'failed' },
    ]);
    const failed = (await verifications()).filter((v) => v.result === 'failed');
    expect(failed.map((v) => v.failure_code)).toStrictEqual([
      'verification_unavailable',
      'verification_unavailable',
    ]);
  });
});
