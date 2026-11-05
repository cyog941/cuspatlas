import { mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBackup, type RestoreConnection, verifyBackup } from '@cuspatlas/db';
import { runBackupVerificationJob } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImagingStack, startImagingStack } from './support/imaging-fixtures';
import { seedPracticeScopes } from './support/practice-fixtures';

/**
 * M9 operator ownership, backup verification, support and escalation (synthetic; the named
 * operator, hosting model and objectives stay open decisions under M-S3; nothing is deployed). The
 * readiness check lists every unmet operator obligation and is empty only when a complete operator
 * profile, a fresh isolated-restore verification and a 24x7 security escalation all exist.
 */
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const MIGRATIONS = join(REPO_ROOT, 'supabase', 'migrations');
const scratch: string[] = [];
const tmp = (label: string) => {
  const d = mkdtempSync(join(tmpdir(), `cuspatlas-ops-verify-${label}-`));
  scratch.push(d);
  return d;
};
const conn = (): RestoreConnection => ({
  host: '127.0.0.1',
  port: Number(process.env.CUSPATLAS_TEST_PG_PORT),
  user: 'postgres',
  password: process.env.CUSPATLAS_TEST_PG_ADMIN_PASSWORD ?? '',
  database: 'postgres',
});
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
let s: ImagingStack;

const responsibilities = ['backup', 'restore_drill', 'security_incident', 'support', 'escalation'].map(
  (r) => ({
    responsibility: r,
    roleName: `placeholder:${r.replace('_', '-')}-owner`,
    contactRef: 'placeholder:operator-desk',
  }),
);
const escalation = [
  {
    incidentClass: 'security_incident',
    responderClass: 'operator',
    coverage: 'always',
    expectedFirstResponseMinutes: 60,
  },
  {
    incidentClass: 'outage',
    responderClass: 'operator',
    coverage: 'always',
    expectedFirstResponseMinutes: 30,
  },
  {
    incidentClass: 'support',
    responderClass: 'operator',
    coverage: 'business_hours',
    expectedFirstResponseMinutes: 480,
  },
];
const profile = (over: Record<string, unknown> = {}) => ({
  operatorRef: 'placeholder:contracted-operator',
  hostingModel: 'contracted',
  responsibilities,
  escalation,
  supportClaim: { rtoSeconds: 14400 },
  ...over,
});
const readiness = async () =>
  data<{ ready: boolean; unmetObligations: string[] }>(
    await s.inject('owner', 'GET', '/v1/operations/readiness'),
  );

async function backupOf(stack: ImagingStack) {
  const dir = tmp('backup');
  const client = await stack.db.admin.connect();
  try {
    await createBackup(client, { outDir: dir, repoRoot: REPO_ROOT });
  } finally {
    client.release();
  }
  return dir;
}

const job = (backupDir: string) =>
  runBackupVerificationJob({
    verify: () =>
      verifyBackup({
        backupDir,
        conn: conn(),
        migrationsDir: MIGRATIONS,
        sampleTarget: `cuspatlas_synthetic_ops_verify_${Date.now().toString(36)}`,
      }),
    record: async (input) => {
      const r = await s.command('service', '/v1/operations/backup-verifications', input);
      if (r.status !== 201) throw new Error(`record failed ${r.status}`);
      return data<{ verificationRef: string; result: string }>(r);
    },
  });

beforeAll(async () => {
  s = await startImagingStack('ops_operator');
  await seedPracticeScopes(s);
}, 180_000);

afterAll(async () => {
  await s?.close();
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe('M9 operator readiness', () => {
  it('an under-provisioned synthetic deployment lists every unmet obligation', async () => {
    expect(await readiness()).toStrictEqual({
      ready: false,
      unmetObligations: ['missing_operator', 'absent_verification'],
      evaluatedAt: expect.any(String),
      objectivesStatus: 'recommended-pending-approval',
    });
  });

  it('refuses an operator profile missing a responsibility, a weak security escalation, or real contact data', async () => {
    const missing = await s.command(
      'owner',
      '/v1/operations/operator-profiles',
      profile({ responsibilities: responsibilities.slice(1) }),
    );
    expect([missing.status, (missing.json.detail as { reason?: string })?.reason]).toStrictEqual([
      422,
      'responsibility_missing',
    ]);
    const weak = await s.command(
      'owner',
      '/v1/operations/operator-profiles',
      profile({ escalation: [{ ...escalation[0], coverage: 'business_hours' }, ...escalation.slice(1)] }),
    );
    expect([weak.status, (weak.json.detail as { reason?: string })?.reason]).toStrictEqual([
      422,
      'weak_escalation',
    ]);
    const real = await s.command(
      'owner',
      '/v1/operations/operator-profiles',
      profile({ operatorRef: 'ops@example.com' }),
    );
    expect(real.status).toBe(400);
    const svc = await s.command('service', '/v1/operations/operator-profiles', profile());
    expect(svc.status).toBe(403);
  });

  it('a change of operator is a new profile version; the prior one is retained', async () => {
    const a = await s.command('owner', '/v1/operations/operator-profiles', profile());
    const b = await s.command(
      'owner',
      '/v1/operations/operator-profiles',
      profile({ operatorRef: 'placeholder:second-operator' }),
    );
    expect([a.status, b.status]).toStrictEqual([201, 201]);
    expect(data<{ profileVersion: number }>(b).profileVersion).toBe(
      data<{ profileVersion: number }>(a).profileVersion + 1,
    );
    const { rows } = await s.db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.ops_operator_profiles');
    expect(rows[0].n).toBe(2);
    expect((await readiness()).unmetObligations).toStrictEqual(['absent_verification']);
  });

  it('a checksum-only verification does not satisfy the isolated-restore requirement', async () => {
    const r = await s.command('service', '/v1/operations/backup-verifications', {
      backupDigest: 'a'.repeat(64),
      manifestVerified: true,
      isolatedRestore: 'not_run',
    });
    expect(data<{ result: string }>(r).result).toBe('checksum_only');
    expect((await readiness()).unmetObligations).toStrictEqual(['checksum_only_verification']);
  });

  it('the worker job verifies the latest backup (digests and an isolated sample restore) and readiness passes', {
    timeout: 300_000,
  }, async () => {
    const out = await job(await backupOf(s));
    expect(out).toMatchObject({ recorded: true, result: 'verified' });
    expect(await readiness()).toMatchObject({ ready: true, unmetObligations: [] });
    const alerts = data<{ count: number }>(await s.inject('owner', 'GET', '/v1/operations/alerts'));
    expect(alerts.count).toBe(0);
  });

  it('an SLA claim the drill has not demonstrated is refused by readiness', async () => {
    await s.command(
      'owner',
      '/v1/operations/operator-profiles',
      profile({ supportClaim: { rtoSeconds: 1 } }),
    );
    expect((await readiness()).unmetObligations).toStrictEqual(['sla_not_demonstrated']);
    await s.command('owner', '/v1/operations/operator-profiles', profile());
  });

  it('a damaged backup is recorded as a failed verification and raised as an alert work item', {
    timeout: 300_000,
  }, async () => {
    const dir = await backupOf(s);
    const victim = readdirSync(join(dir, 'tables')).find((f) => f === 'patients.ndjson') as string;
    unlinkSync(join(dir, 'tables', victim));
    const out = await job(dir);
    expect(out).toMatchObject({ recorded: true, result: 'failed' });
    expect((await readiness()).unmetObligations).toStrictEqual(['failed_verification']);
    const alerts = data<{ count: number; items: { reasonCode: string; owner: { queue: string } }[] }>(
      await s.inject('owner', 'GET', '/v1/operations/alerts'),
    );
    expect(alerts.items.map((i) => i.reasonCode)).toStrictEqual(['failed_verification']);
  });

  it('a verification older than the configured interval reports stale, and a job that cannot run blocks readiness', async () => {
    await s.db.admin.query(
      `BEGIN; SET LOCAL session_replication_role = replica;
       UPDATE cuspatlas.ops_backup_verifications SET checked_at = checked_at - interval '3 days';
       COMMIT;`,
    );
    expect((await readiness()).unmetObligations).toStrictEqual(['stale_verification']);
    const broken = await runBackupVerificationJob({
      verify: async () => {
        throw new Error('backup location unreachable');
      },
      record: async (input) => data(await s.command('service', '/v1/operations/backup-verifications', input)),
    });
    expect(broken).toMatchObject({ recorded: true, result: 'failed' });
    expect((await readiness()).ready).toBe(false);
  });
});
