import { randomUUID } from 'node:crypto';
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { ObjectStorePort } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  createAuthorize,
  createAutomationService,
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

  it('only a service principal holding outbox.deliver runs the build job', async () => {
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
