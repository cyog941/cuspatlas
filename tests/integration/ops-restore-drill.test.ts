import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type RestoreConnection, type RestoreDrillReport, runRestoreDrill } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachTestDatabase } from './support/db';
import { T_ALPHA } from './support/fixtures';
import { type ImagingStack, startImagingStack } from './support/imaging-fixtures';
import { seedSyntheticPractice } from './support/practice-fixtures';

/**
 * M8 timed restore exercise on the embedded synthetic cluster (never a real deployment): back up the
 * whole synthetic tenant (logical database backup and object store), restore into a fresh isolated
 * target, reconcile every tenant table (count and content digest), re-run the journal check on every
 * entry, serve a verified practice export (M1) from the restored stack, deny cross-tenant access,
 * and measure elapsed time against the recorded recommended-pending-approval objectives. The report
 * is machine-readable (artifacts/restore-drill-report.json) and bound into the evidence manifest
 * (AS-06). A deliberately incomplete backup is detected and reported as a failed drill.
 */
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const MIGRATIONS = join(REPO_ROOT, 'supabase', 'migrations');
const OBJECTIVES = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs/deployment/recovery-objectives.json'), 'utf8'),
);
// Backups are dumps: the backup tool refuses a directory inside the repository (like the F8 and I9
// drills, the scratch lives in the OS temporary directory and is removed afterwards).
const scratch: string[] = [];
const tmp = (label: string) => {
  const d = mkdtempSync(join(tmpdir(), `cuspatlas-ops-drill-${label}-`));
  scratch.push(d);
  return d;
};
const adminConn = (): RestoreConnection => ({
  host: '127.0.0.1',
  port: Number(process.env.CUSPATLAS_TEST_PG_PORT),
  user: 'postgres',
  password: process.env.CUSPATLAS_TEST_PG_ADMIN_PASSWORD ?? '',
  database: 'postgres',
});
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
let src: ImagingStack;
let restored: ImagingStack | undefined;
let exportRef: string;

beforeAll(async () => {
  src = await startImagingStack('ops_drill_src');
  await seedSyntheticPractice(src, 'Drill');
  const r = await src.command('owner', '/v1/practice/exports', { purpose: 'verification' });
  expect(r.status).toBe(201);
  exportRef = data<{ exportRef: string }>(r).exportRef;
}, 240_000);

afterAll(async () => {
  await restored?.close();
  await src?.close();
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

const objectives = {
  rpoSeconds: OBJECTIVES.rpoSeconds,
  rtoSeconds: OBJECTIVES.rtoSeconds,
  status: OBJECTIVES.status,
};

describe('M8 timed restore exercise', () => {
  it('restores database and store into an isolated target, reconciles, and records a timed report', {
    timeout: 300_000,
  }, async () => {
    const target = `cuspatlas_synthetic_ops_drill_${Date.now().toString(36)}`;
    const storeRoot = tmp('restored-store');
    const report: RestoreDrillReport = await runRestoreDrill({
      sourceAdmin: src.db.admin,
      sourceStoreRoot: src.storeRoot,
      conn: adminConn(),
      target,
      targetStoreRoot: storeRoot,
      backupDir: tmp('db'),
      objectsDir: tmp('objects'),
      repoRoot: REPO_ROOT,
      migrationsDir: MIGRATIONS,
      tenantId: T_ALPHA,
      objectives,
    });
    expect(report).toMatchObject({
      kind: 'cuspatlas-restore-drill-report',
      synthetic: true,
      result: 'passed',
      failure: null,
      gap: null,
      withinObjectives: { rto: true, rpo: true },
      objectives: { status: 'recommended-pending-approval' },
    });
    expect(report.reconciliation.mismatches).toStrictEqual([]);
    expect(report.reconciliation.tables).toBeGreaterThan(50);
    expect(report.reconciliation.journalEntriesChecked).toBeGreaterThan(0);
    expect(report.reconciliation.objectFiles).toBeGreaterThan(0);
    expect(report.measured.rtoSeconds).toBeGreaterThan(0);

    // The restored stack serves: the practice export taken before the backup verifies against the
    // restored live tenant (counts and digests), and another tenant is denied as if it did not exist.
    restored = await startImagingStack('unused', {
      database: attachTestDatabase(target),
      storeRoot,
      seed: false,
    });
    const v = await restored.inject(
      'owner',
      'GET',
      `/v1/practice/exports/verification?exportRef=${exportRef}`,
    );
    expect(data<{ state: string; mismatches: unknown[] }>(v)).toMatchObject({
      state: 'verified',
      mismatches: [],
    });
    const x = await restored.inject(
      'crossTenant',
      'GET',
      `/v1/practice/exports/verification?exportRef=${exportRef}`,
    );
    expect(x.status).toBe(404);

    mkdirSync(join(REPO_ROOT, 'artifacts'), { recursive: true });
    writeFileSync(
      join(REPO_ROOT, 'artifacts', 'restore-drill-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  });

  it('a deliberately incomplete backup is detected and reported as a failed drill; the source is untouched', {
    timeout: 300_000,
  }, async () => {
    const backupDir = tmp('db-incomplete');
    const before = (await src.db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.patients')).rows[0].n;
    const report = await runRestoreDrill({
      sourceAdmin: src.db.admin,
      sourceStoreRoot: src.storeRoot,
      conn: adminConn(),
      target: `cuspatlas_synthetic_ops_drill_bad_${Date.now().toString(36)}`,
      targetStoreRoot: tmp('restored-bad'),
      backupDir,
      objectsDir: tmp('objects-bad'),
      repoRoot: REPO_ROOT,
      migrationsDir: MIGRATIONS,
      tenantId: T_ALPHA,
      objectives,
      afterBackup: async () => {
        const victim = readdirSync(join(backupDir, 'tables')).find((f) => f === 'patients.ndjson');
        if (!victim) throw new Error('no patients data file in the backup');
        unlinkSync(join(backupDir, 'tables', victim));
      },
    });
    expect(report).toMatchObject({
      result: 'failed',
      failure: 'incomplete_backup',
      restoreCompletedAt: null,
    });
    expect(report.gap).toMatch(/restore did not complete/);
    expect((await src.db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.patients')).rows[0].n).toBe(
      before,
    );
  });
  it('the restore-load flag does not relax the opening item guard for the runtime role', async () => {
    const { rows } = await src.db.admin.query(
      'SELECT to_jsonb(o) AS j FROM cuspatlas.migration_opening_items o LIMIT 1',
    );
    expect(rows).toHaveLength(1);
    const c = await src.db.admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE cuspatlas_app');
      await c.query("SET LOCAL cuspatlas.restore_load = 'on'");
      await expect(
        c.query(
          'INSERT INTO cuspatlas.migration_opening_items SELECT * FROM jsonb_populate_record(NULL::cuspatlas.migration_opening_items, $1)',
          [rows[0].j],
        ),
      ).rejects.toThrow(/apply run in progress|row-level security|permission denied/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
