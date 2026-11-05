import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBillingScopes } from './support/billing-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { seedEngagementScopes } from './support/engagement-fixtures';
import { exportWorker, runExportBuilds } from './support/export-jobs';
import { T_ALPHA, USER_A1 } from './support/fixtures';
import { type ImagingStack, startImagingStack } from './support/imaging-fixtures';
import { seedMigrationScopes } from './support/migration-fixtures';
import { seedSchedulingScopes } from './support/scheduling-fixtures';

/**
 * Closeout D2: the direct M1 practice export (`practice.export.create`) no longer builds inline. It
 * records an export request (origin `practice.export.create`, scope practice) and answers `building`;
 * the leased worker job (`exports.build`) builds it as the requester's live membership, re-checked for
 * `practice.export.create`; the caller polls `practice.export.read` and then grants and downloads the
 * M1 package as before. Synthetic data only.
 */
let s: ImagingStack;
type View = {
  requestRef: string;
  state: 'building' | 'ready' | 'failed';
  exportRef: string | null;
  format: string | null;
  documentCount: number | null;
  packageDigest: string | null;
  diagnostic: string | null;
};
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
const poll = (ref: string, who: Parameters<ImagingStack['inject']>[0] = 'owner') =>
  s.inject(who, 'GET', `/v1/practice/exports/state?requestRef=${ref}`);
const practiceRows = async () =>
  Number((await s.db.admin.query('SELECT count(*) AS n FROM cuspatlas.practice_exports')).rows[0]?.n);
async function setScopes(principal: string, add: string[], remove: string[] = []) {
  await s.db.admin.query(
    `UPDATE cuspatlas.memberships SET scopes = ARRAY(SELECT DISTINCT x FROM unnest(scopes || $2::text[]) x
       WHERE NOT x = ANY($3::text[])) WHERE principal_id = $1`,
    [principal, add, remove],
  );
}
/** Only the request under test is building (earlier ones are cleared so a pass builds just it). */
const only = (ref: string) =>
  s.db.admin.query(
    `UPDATE cuspatlas.export_requests SET state = 'failed', diagnostic = 'test_cleared'
     WHERE state = 'building' AND id <> $1`,
    [ref],
  );

beforeAll(async () => {
  s = await startImagingStack('practice_export_jobs');
  await seedSchedulingScopes(s.db.admin);
  await seedClinicalScopes(s.db.admin);
  await seedEngagementScopes(s.db.admin);
  await seedBillingScopes(s.db.admin);
  await seedMigrationScopes(s.db.admin);
  await setScopes(USER_A1, ['admin.configure']);
  await exportWorker(s);
}, 240_000);
afterAll(async () => {
  await s?.close();
});

describe('Closeout D2: the M1 practice export builds in the worker', () => {
  it('create answers building and stores nothing; the worker builds it; the caller polls ready', async () => {
    const before = await practiceRows();
    const key = randomUUID();
    const c = await s.command('owner', '/v1/practice/exports', { purpose: 'practiceExit' }, key);
    expect([c.status, c.json.version]).toStrictEqual([201, 1]);
    const v = data<View>(c);
    expect([v.state, v.exportRef, v.packageDigest]).toStrictEqual(['building', null, null]);
    expect(await practiceRows()).toBe(before);
    expect(data<View>(await poll(v.requestRef)).state).toBe('building');
    await only(v.requestRef);
    expect(await runExportBuilds(s)).toContainEqual({ exportRef: v.requestRef, outcome: 'ready' });
    const done = data<View>(await poll(v.requestRef));
    expect(done.state).toBe('ready');
    expect(done.format).toBe('cuspatlas-practice-export/1');
    expect(done.documentCount).toBe(5);
    expect(done.exportRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(await practiceRows()).toBe(before + 1);
    // Delivered through the M1 grant and download, unchanged.
    const g = await s.command('owner', '/v1/practice/exports/grants', { exportRef: done.exportRef });
    const d = await s.command('owner', '/v1/practice/exports/package', {
      exportRef: done.exportRef,
      token: data<{ token: string }>(g).token,
    });
    expect(d.status).toBe(200);
    // A same-key retry answers the current state, never the stored building view, and builds nothing.
    const again = await s.command('owner', '/v1/practice/exports', { purpose: 'practiceExit' }, key);
    expect([again.json.replayed, data<View>(again).state, data<View>(again).exportRef]).toStrictEqual([
      true,
      'ready',
      done.exportRef,
    ]);
    expect(await practiceRows()).toBe(before + 1);
    // Recorded as the requester; the M1 artifact is recorded too.
    const { rows } = await s.db.admin.query<{ resource_type: string; actor_id: string }>(
      `SELECT resource_type, actor_id FROM cuspatlas.audit_events
       WHERE operation = 'practice.export.create' AND resource_ref = ANY($1::uuid[]) ORDER BY resource_type`,
      [[v.requestRef, done.exportRef]],
    );
    expect(rows).toStrictEqual([
      { resource_type: 'exportRequest', actor_id: USER_A1 },
      { resource_type: 'practiceExport', actor_id: USER_A1 },
    ]);
  });

  it('MCP answers the same building view and polls it with practice_export_read', async () => {
    const c = await s.mcp('owner', 'practice_export_create', {
      purpose: 'verification',
      idempotencyKey: randomUUID(),
    });
    expect(c.isError, JSON.stringify(c.body)).toBe(false);
    const v = (c.body as { data: View }).data;
    expect(v.state).toBe('building');
    const r = await s.mcp('owner', 'practice_export_read', { requestRef: v.requestRef });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect((r.body as { data: View }).data).toStrictEqual(data<View>(await poll(v.requestRef)));
  });

  it('the build re-checks the requester: narrowed access fails as forbidden, revoked as requester_inactive', async () => {
    const narrowed = data<View>(await s.command('owner', '/v1/practice/exports', { purpose: 'archiveCopy' }));
    await only(narrowed.requestRef);
    await setScopes(USER_A1, [], ['admin.configure']);
    try {
      expect(await runExportBuilds(s)).toContainEqual({ exportRef: narrowed.requestRef, outcome: 'failed' });
    } finally {
      await setScopes(USER_A1, ['admin.configure']);
    }
    expect(data<View>(await poll(narrowed.requestRef))).toMatchObject({
      state: 'failed',
      diagnostic: 'forbidden',
    });
    const revoked = data<View>(await s.command('owner', '/v1/practice/exports', { purpose: 'archiveCopy' }));
    await only(revoked.requestRef);
    await s.db.admin.query(
      'UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1 AND tenant_id = $2',
      [USER_A1, T_ALPHA],
    );
    try {
      expect(await runExportBuilds(s)).toContainEqual({ exportRef: revoked.requestRef, outcome: 'failed' });
    } finally {
      await s.db.admin.query(
        'UPDATE cuspatlas.memberships SET revoked_at = NULL WHERE principal_id = $1 AND tenant_id = $2',
        [USER_A1, T_ALPHA],
      );
    }
    expect(data<View>(await poll(revoked.requestRef))).toMatchObject({
      state: 'failed',
      diagnostic: 'requester_inactive',
      exportRef: null,
    });
  });

  it('refuses another tenant, a role without admin.configure, a revoked member and a service', async () => {
    const v = data<View>(await s.command('owner', '/v1/practice/exports', { purpose: 'verification' }));
    expect((await poll(v.requestRef, 'crossTenant')).status).toBe(404);
    expect((await poll(v.requestRef, 'writer')).status).toBe(403);
    expect([401, 403]).toContain((await poll(v.requestRef, 'revoked')).status);
    expect((await poll(v.requestRef, 'service')).status).toBe(403);
    expect((await s.command('writer', '/v1/practice/exports', { purpose: 'verification' })).status).toBe(403);
    expect((await s.command('service', '/v1/practice/exports', { purpose: 'verification' })).status).toBe(
      403,
    );
    expect([401, 403]).toContain(
      (await s.command('revoked', '/v1/practice/exports', { purpose: 'verification' })).status,
    );
    // An A15 export request is never readable through the M1 read.
    await setScopes(USER_A1, ['exports.create', 'exports.read']);
    const a15 = await s.command('owner', '/v1/exports', {
      formatVersion: 'cuspatlas-export/1',
      purpose: 'verification',
      scope: 'practice',
    });
    expect(a15.status).toBe(201);
    expect((await poll(data<{ exportRef: string }>(a15).exportRef)).status).toBe(404);
  });
});
