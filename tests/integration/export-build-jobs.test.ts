import { randomUUID } from 'node:crypto';
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_SCOPE_CEILING, type ObjectStorePort, RefusalError } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  createAuthorize,
  createAutomationService,
  type ExportPracticePort,
  executeOnce,
  PRACTICE_EXPORT_DOCUMENTS,
  type PracticeExporters,
} from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBillingScopes } from './support/billing-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { actorFor } from './support/domain-harness';
import { seedEngagementScopes } from './support/engagement-fixtures';
import { EXPORT_WORKER, exportWorker, runExportBuilds } from './support/export-jobs';
import { T_ALPHA, USER_A1, USER_A4 } from './support/fixtures';
import { type ImagingStack, startImagingStack } from './support/imaging-fixtures';
import { seedMigrationScopes } from './support/migration-fixtures';
import { seedSchedulingScopes } from './support/scheduling-fixtures';

/**
 * Closeout C: the A15 export build is a worker job. `exports.create` records the request and answers
 * `building` at once; the worker (`exports.build`, service principal only) leases the request row,
 * builds as the requester's live membership and completes it fenced by the lease attempt; the caller
 * polls `exports.read`. An expired lease is taken over once and never builds twice. The completion
 * promotes the package bytes under the content lock, so the orphan-bytes sweep keeps them. Synthetic.
 */
let s: ImagingStack;
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
type Req = { exportRef: string; state: string; diagnostic: string | null; packageDigest: string | null };
const domainBody = (domain = 'scheduling') => ({
  formatVersion: 'cuspatlas-export/1',
  purpose: 'integration',
  scope: 'domain',
  domain,
});
const read = async (exportRef: string, who: Parameters<ImagingStack['inject']>[0] = 'owner') =>
  data<Req>(await s.inject(who, 'GET', `/v1/exports/request?exportRef=${exportRef}`));
const completions = async (exportRef: string) =>
  (
    await s.db.admin.query<{ resource_version: number; actor_id: string }>(
      `SELECT resource_version, actor_id FROM cuspatlas.audit_events
       WHERE resource_ref = $1 AND operation = 'exports.create' ORDER BY resource_version`,
      [exportRef],
    )
  ).rows;
async function setScopes(principal: string, add: string[], remove: string[] = []) {
  await s.db.admin.query(
    `UPDATE cuspatlas.memberships SET scopes = ARRAY(SELECT DISTINCT x FROM unnest(scopes || $2::text[]) x
       WHERE NOT x = ANY($3::text[])) WHERE principal_id = $1`,
    [principal, add, remove],
  );
}

beforeAll(async () => {
  s = await startImagingStack('export_build_jobs');
  await seedSchedulingScopes(s.db.admin);
  await seedClinicalScopes(s.db.admin);
  await seedEngagementScopes(s.db.admin);
  await seedBillingScopes(s.db.admin);
  await seedMigrationScopes(s.db.admin);
  await setScopes(USER_A1, ['exports.create', 'exports.read', 'admin.configure']);
  await exportWorker(s);
}, 240_000);
afterAll(async () => {
  await s?.close();
});

describe('Closeout C: export build as a worker job', () => {
  it('create answers building; the job builds as the requester; the caller polls ready', async () => {
    const c = await s.command('owner', '/v1/exports', domainBody());
    expect([c.status, data<Req>(c).state, c.json.version]).toStrictEqual([201, 'building', 1]);
    expect((await read(data<Req>(c).exportRef)).state).toBe('building');
    const ref = data<Req>(c).exportRef;
    const outcomes = await runExportBuilds(s);
    expect(outcomes).toContainEqual({ exportRef: ref, outcome: 'ready' });
    const done = await read(ref);
    expect(done.state).toBe('ready');
    expect(done.packageDigest).toMatch(/^[0-9a-f]{64}$/);
    // Requested and completed transitions; the completion is the requester's, never the worker's.
    expect((await completions(ref)).map((r) => [r.resource_version, r.actor_id])).toStrictEqual([
      [1, USER_A1],
      [2, USER_A1],
    ]);
    // Delivered like before: grant and download of the stored package.
    const g = await s.command('owner', '/v1/exports/grants', { exportRef: ref });
    const d = await s.command('owner', '/v1/exports/package', {
      exportRef: ref,
      token: data<{ token: string }>(g).token,
    });
    expect(d.status).toBe(200);
    // Nothing is left to build.
    expect((await runExportBuilds(s)).filter((o) => o.exportRef === ref)).toStrictEqual([]);
  });

  it('an expired lease is re-run once and never builds twice; a live lease is left alone', async () => {
    const expired = data<Req>(await s.command('owner', '/v1/exports', domainBody('imaging'))).exportRef;
    const live = data<Req>(await s.command('owner', '/v1/exports', domainBody('clinical'))).exportRef;
    // A worker took each lease earlier: one crashed (lease expired), one is still building.
    await s.db.admin.query(
      `UPDATE cuspatlas.export_requests SET build_attempt = 1, build_leased_until = now() - interval '1 second'
       WHERE id = $1`,
      [expired],
    );
    await s.db.admin.query(
      `UPDATE cuspatlas.export_requests SET build_attempt = 1, build_leased_until = now() + interval '10 minutes'
       WHERE id = $1`,
      [live],
    );
    // Two workers at once: exactly one takes the expired lease over.
    const [a, b] = await Promise.all([runExportBuilds(s), runExportBuilds(s)]);
    const all = [...a, ...b].filter((o) => o.exportRef === expired);
    expect(all.filter((o) => o.outcome === 'ready')).toHaveLength(1);
    expect(all.every((o) => o.outcome === 'ready' || o.outcome === 'skipped')).toBe(true);
    expect([...a, ...b].some((o) => o.exportRef === live)).toBe(false);
    const { rows } = await s.db.admin.query(
      'SELECT id, state, build_attempt, version FROM cuspatlas.export_requests WHERE id = ANY($1::uuid[])',
      [[expired, live]],
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, [r.state, r.build_attempt, r.version]]));
    expect(by[expired]).toStrictEqual(['ready', 2, 2]);
    expect(by[live]).toStrictEqual(['building', 1, 1]);
    expect((await completions(expired)).map((r) => r.resource_version)).toStrictEqual([1, 2]);
    // A later pass does not build it again.
    expect((await runExportBuilds(s)).some((o) => o.exportRef === expired)).toBe(false);
    expect((await completions(expired)).length).toBe(2);
  });

  it('a requester whose access narrowed or whose membership was revoked fails the build', async () => {
    await setScopes(USER_A4, ['exports.create', 'exports.read', 'admin.configure']);
    try {
      const narrowed = data<Req>(
        await s.command('imagingReadOnly', '/v1/exports', domainBody('billing')),
      ).exportRef;
      const revoked = data<Req>(
        await s.command('imagingReadOnly', '/v1/exports', domainBody('engagement')),
      ).exportRef;
      await setScopes(USER_A4, [], ['admin.configure']);
      await s.db.admin.query(
        `UPDATE cuspatlas.export_requests SET build_leased_until = now() + interval '10 minutes' WHERE id = $1`,
        [revoked],
      );
      const first = await runExportBuilds(s);
      expect(first).toContainEqual({ exportRef: narrowed, outcome: 'failed' });
      const n = await s.db.admin.query(
        'SELECT state, diagnostic FROM cuspatlas.export_requests WHERE id = $1',
        [narrowed],
      );
      expect(n.rows[0]).toStrictEqual({ state: 'failed', diagnostic: 'forbidden' });
      await s.db.admin.query(
        'UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1 AND tenant_id = $2',
        [USER_A4, T_ALPHA],
      );
      await s.db.admin.query(`UPDATE cuspatlas.export_requests SET build_leased_until = NULL WHERE id = $1`, [
        revoked,
      ]);
      expect(await runExportBuilds(s)).toContainEqual({ exportRef: revoked, outcome: 'failed' });
      const r = await s.db.admin.query(
        'SELECT state, diagnostic, package_digest FROM cuspatlas.export_requests WHERE id = $1',
        [revoked],
      );
      expect(r.rows[0]).toStrictEqual({
        state: 'failed',
        diagnostic: 'requester_inactive',
        package_digest: null,
      });
      // The failure of an inactive requester is recorded by the worker, never as the requester.
      expect((await completions(revoked)).map((x) => x.actor_id)).toStrictEqual([USER_A4, EXPORT_WORKER]);
    } finally {
      await s.db.admin.query(
        'UPDATE cuspatlas.memberships SET revoked_at = NULL WHERE principal_id = $1 AND tenant_id = $2',
        [USER_A4, T_ALPHA],
      );
      await setScopes(USER_A4, [], ['exports.create', 'exports.read', 'admin.configure']);
    }
  });

  it('only a service principal holding exports.build runs the build job (outbox.deliver is not enough)', async () => {
    expect(AGENT_SCOPE_CEILING.has('exports.build')).toBe(false);
    const outboxOnly = '30000000-0000-4000-8000-0000000000da';
    await s.db.admin.query(
      `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'svc-outbox-only')
       ON CONFLICT DO NOTHING`,
      [outboxOnly],
    );
    await s.db.admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [T_ALPHA, outboxOnly, ['outbox.deliver']],
    );
    const svc = createAutomationService({
      env: 'synthetic-test',
      authorize: createAuthorize(createMembershipSource(s.db.app)),
      withTenantTransaction: createTenantTransactionRunner(s.db.app),
      recording: { sink: createSecurityAttemptSink(s.db.sink), alert: () => undefined },
      execute: executeOnce,
      exports: {
        exporters: {} as PracticeExporters,
        objectStore: s.store,
        tokenSecret: new Uint8Array(32).fill(7),
        memberships: createMembershipSource(s.db.app),
      },
    });
    const env = { operation: 'exports.build', idempotencyKey: randomUUID(), payload: {} };
    const human = await actorFor(s.db, USER_A1, T_ALPHA);
    await expect(svc.runExportBuilds(human, env)).rejects.toMatchObject({ code: 'forbidden' });
    const outbox = await actorFor(s.db, outboxOnly, T_ALPHA);
    await expect(svc.runExportBuilds(outbox, { ...env, idempotencyKey: randomUUID() })).rejects.toMatchObject(
      {
        code: 'forbidden',
      },
    );
  });

  it('a request queued while no worker runs is never failed; it builds once a worker returns', async () => {
    const ref = data<Req>(await s.command('owner', '/v1/exports', domainBody('scheduling'))).exportRef;
    // The worker was down for two hours: the request was never leased (build_attempt = 0).
    await s.db.admin.query(
      `UPDATE cuspatlas.export_requests SET created_at = now() - interval '2 hours' WHERE id = $1`,
      [ref],
    );
    expect((await read(ref)).state).toBe('building');
    expect(await runExportBuilds(s)).toContainEqual({ exportRef: ref, outcome: 'ready' });
    expect((await read(ref)).state).toBe('ready');
    // The worker recorded the attempt as itself, with the attempt number as the record's version.
    const attempts = await s.db.admin.query(
      `SELECT resource_type, resource_version, actor_id, principal FROM cuspatlas.audit_events
       WHERE resource_ref = $1 AND operation = 'exports.build' ORDER BY resource_version`,
      [ref],
    );
    expect(attempts.rows).toStrictEqual([
      {
        resource_type: 'exportBuildAttempt',
        resource_version: 1,
        actor_id: EXPORT_WORKER,
        principal: 'service',
      },
    ]);
  });

  it('a leased build whose lease expired past the deadline is failed as build_interrupted', async () => {
    const ref = data<Req>(await s.command('owner', '/v1/exports', domainBody('imaging'))).exportRef;
    await s.db.admin.query(
      `UPDATE cuspatlas.export_requests SET build_attempt = 1, build_leased_until = now() - interval '2 hours'
       WHERE id = $1`,
      [ref],
    );
    expect(await read(ref)).toMatchObject({ state: 'failed', diagnostic: 'build_interrupted' });
    // The fencing token never moves backwards, whoever writes it.
    await expect(
      s.db.admin.query('UPDATE cuspatlas.export_requests SET build_attempt = 0 WHERE id = $1', [ref]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a long build keeps its lease: no takeover, no interruption, it completes', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const doc = async () => ({
      format: PRACTICE_EXPORT_DOCUMENTS[0]?.format as string,
      exportedAt: new Date().toISOString(),
      tables: Object.fromEntries((PRACTICE_EXPORT_DOCUMENTS[0]?.tables ?? []).map((t) => [t, []])),
    });
    const slow: PracticeExporters['scheduling'] = async () => {
      await sleep(3500);
      return doc();
    };
    const memberships = createMembershipSource(s.db.app);
    const svc = createAutomationService({
      env: 'synthetic-test',
      authorize: createAuthorize(memberships),
      withTenantTransaction: createTenantTransactionRunner(s.db.app),
      recording: { sink: createSecurityAttemptSink(s.db.sink), alert: () => undefined },
      execute: executeOnce,
      exports: {
        exporters: { scheduling: slow, imaging: doc, clinical: doc, engagement: doc, billing: doc },
        objectStore: s.store,
        tokenSecret: new Uint8Array(32).fill(7),
        memberships,
        buildLeaseSeconds: 1,
        buildDeadlineSeconds: 2,
      },
    });
    const owner = await actorFor(s.db, USER_A1, T_ALPHA);
    const worker = await actorFor(s.db, EXPORT_WORKER, T_ALPHA);
    const env = () => ({ operation: 'exports.build', idempotencyKey: randomUUID(), payload: {} });
    const created = await svc.createExport(owner, {
      operation: 'exports.create',
      idempotencyKey: randomUUID(),
      payload: domainBody('scheduling'),
    });
    const ref = created.data.exportRef;
    // Clear every other building request so the passes below see only this one.
    await s.db.admin.query(
      `UPDATE cuspatlas.export_requests SET state = 'failed', diagnostic = 'test_cleared'
       WHERE state = 'building' AND id <> $1`,
      [ref],
    );
    const first = svc.runExportBuilds(worker, env());
    // Well past the 1 s lease (and the 2 s deadline) while the build is still running.
    await sleep(2600);
    const second = await svc.runExportBuilds(worker, env());
    expect(second.data.outcomes.filter((o) => o.exportRef === ref && o.outcome !== 'skipped')).toStrictEqual(
      [],
    );
    expect((await svc.readExport(owner, { exportRef: ref })).data.state).toBe('building');
    expect((await first).data.outcomes).toContainEqual({ exportRef: ref, outcome: 'ready' });
    const { rows } = await s.db.admin.query(
      'SELECT state, build_attempt FROM cuspatlas.export_requests WHERE id = $1',
      [ref],
    );
    expect(rows[0]).toStrictEqual({ state: 'ready', build_attempt: 1 });
  });

  it('practice scope: a second attempt racing an in-flight first attempt is deferred, never failed', async () => {
    const real = await s.command('owner', '/v1/practice/exports', { purpose: 'practiceExit' });
    expect(real.status).toBe(201);
    const result = real.json.data as {
      exportRef: string;
      format: string;
      manifestDigest: string;
      packageDigest: string;
      byteLength: number;
      documentCount: number;
    };
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const practice: ExportPracticePort = {
      async create() {
        calls += 1;
        if (calls === 1) {
          await gate;
          return { data: result, version: 1, replayed: false } as never;
        }
        // The first attempt's idempotency reservation is still pending: retryable in-flight conflict.
        if (calls === 2) throw new RefusalError({ code: 'conflict', retryable: true });
        return { data: result, version: 1, replayed: true } as never;
      },
      grant: async () => ({ data: { token: 'unused' } }),
      download: async () => ({ data: null }),
    };
    const memberships = createMembershipSource(s.db.app);
    const svc = createAutomationService({
      env: 'synthetic-test',
      authorize: createAuthorize(memberships),
      withTenantTransaction: createTenantTransactionRunner(s.db.app),
      recording: { sink: createSecurityAttemptSink(s.db.sink), alert: () => undefined },
      execute: executeOnce,
      exports: {
        exporters: {} as PracticeExporters,
        practice,
        objectStore: s.store,
        tokenSecret: new Uint8Array(32).fill(7),
        memberships,
        buildLeaseSeconds: 60,
      },
    });
    const owner = await actorFor(s.db, USER_A1, T_ALPHA);
    const worker = await actorFor(s.db, EXPORT_WORKER, T_ALPHA);
    const env = () => ({ operation: 'exports.build', idempotencyKey: randomUUID(), payload: {} });
    const created = await svc.createExport(owner, {
      operation: 'exports.create',
      idempotencyKey: randomUUID(),
      payload: { formatVersion: 'cuspatlas-export/1', purpose: 'verification', scope: 'practice' },
    });
    const ref = created.data.exportRef;
    await s.db.admin.query(
      `UPDATE cuspatlas.export_requests SET state = 'failed', diagnostic = 'test_cleared'
       WHERE state = 'building' AND id <> $1`,
      [ref],
    );
    const first = svc.runExportBuilds(worker, env());
    for (let i = 0; i < 200 && calls < 1; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(calls).toBe(1);
    // The first attempt stalls past its lease; a second worker takes the request over.
    await s.db.admin.query(
      `UPDATE cuspatlas.export_requests SET build_leased_until = now() - interval '1 second' WHERE id = $1`,
      [ref],
    );
    const second = await svc.runExportBuilds(worker, env());
    expect(second.data.outcomes).toContainEqual({ exportRef: ref, outcome: 'deferred' });
    const mid = await s.db.admin.query(
      'SELECT state, diagnostic, build_attempt, build_leased_until FROM cuspatlas.export_requests WHERE id = $1',
      [ref],
    );
    expect(mid.rows[0]).toStrictEqual({
      state: 'building',
      diagnostic: null,
      build_attempt: 2,
      build_leased_until: null,
    });
    release();
    // The first attempt finishes but no longer holds the fence: it records nothing.
    expect((await first).data.outcomes).toContainEqual({ exportRef: ref, outcome: 'lease_lost' });
    // A later pass replays the committed practice export: ready, never a false failure.
    const third = await svc.runExportBuilds(worker, env());
    expect(third.data.outcomes).toContainEqual({ exportRef: ref, outcome: 'ready' });
    const done = await s.db.admin.query(
      'SELECT state, diagnostic, practice_export_id FROM cuspatlas.export_requests WHERE id = $1',
      [ref],
    );
    expect(done.rows[0]).toStrictEqual({
      state: 'ready',
      diagnostic: null,
      practice_export_id: result.exportRef,
    });
  });

  it('the completion promotes under the content lock: the orphan-bytes sweep keeps the package bytes', async () => {
    const empty: PracticeExporters['scheduling'] = async () => ({
      format: PRACTICE_EXPORT_DOCUMENTS[0]?.format as string,
      exportedAt: new Date().toISOString(),
      tables: Object.fromEntries((PRACTICE_EXPORT_DOCUMENTS[0]?.tables ?? []).map((t) => [t, []])),
    });
    const blobPath = (digest: string) =>
      join(s.storeRoot, 't', T_ALPHA, 'sha256', digest.slice(0, 2), digest);
    const seen: { lockedElsewhere?: boolean; sweep?: Record<string, unknown>; digest?: string } = {};
    const store = new Proxy(s.store, {
      get(target, prop, recv) {
        if (prop !== 'promote') return Reflect.get(target, prop, recv);
        const promote: ObjectStorePort['promote'] = async (tenant, stagingKey, digest) => {
          const out = await target.promote(tenant, stagingKey, digest);
          seen.digest = digest;
          // Pretend these bytes are old and unreferenced: only the content lock protects them now.
          const old = new Date(Date.now() - 48 * 3600 * 1000);
          utimesSync(blobPath(digest), old, old);
          const probe = await s.db.admin.query<{ ok: boolean }>(
            'SELECT cuspatlas.imaging_try_lock_content($1, $2) AS ok',
            [tenant, digest],
          );
          seen.lockedElsewhere = probe.rows[0]?.ok === false;
          const r = await s.command('owner', '/v1/imaging/storage/orphan-bytes/sweep', {
            dryRun: false,
            graceHours: 1,
          });
          seen.sweep = r.json.data as Record<string, unknown>;
          return out;
        };
        return promote;
      },
    });
    const memberships = createMembershipSource(s.db.app);
    const svc = createAutomationService({
      env: 'synthetic-test',
      authorize: createAuthorize(memberships),
      withTenantTransaction: createTenantTransactionRunner(s.db.app),
      recording: { sink: createSecurityAttemptSink(s.db.sink), alert: () => undefined },
      execute: executeOnce,
      exports: {
        exporters: { scheduling: empty, imaging: empty, clinical: empty, engagement: empty, billing: empty },
        objectStore: store,
        tokenSecret: new Uint8Array(32).fill(7),
        memberships,
      },
    });
    const owner = await actorFor(s.db, USER_A1, T_ALPHA);
    const created = await svc.createExport(owner, {
      operation: 'exports.create',
      idempotencyKey: randomUUID(),
      payload: domainBody(),
    });
    expect(created.data.state).toBe('building');
    const worker = await actorFor(s.db, EXPORT_WORKER, T_ALPHA);
    const r = await svc.runExportBuilds(worker, {
      operation: 'exports.build',
      idempotencyKey: randomUUID(),
      payload: {},
    });
    expect(r.data.outcomes).toContainEqual({ exportRef: created.data.exportRef, outcome: 'ready' });
    expect(seen.lockedElsewhere).toBe(true);
    const sweep = seen.sweep as { removed: string[]; kept: { contentLocked: number } };
    expect(sweep.removed).not.toContain(seen.digest);
    expect(sweep.kept.contentLocked).toBeGreaterThanOrEqual(1);
    expect(existsSync(blobPath(seen.digest as string))).toBe(true);
    // After the completion commits, the bytes are referenced by the request.
    const again = await s.command('owner', '/v1/imaging/storage/orphan-bytes/sweep', {
      dryRun: false,
      graceHours: 1,
    });
    expect((again.json.data as { removed: string[] }).removed).not.toContain(seen.digest);
    expect(existsSync(blobPath(seen.digest as string))).toBe(true);
  });
});
