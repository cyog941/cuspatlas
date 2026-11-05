import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppointmentHarness, openAppointmentHarness } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { SVC_A1, USER_A1, USER_A2, USER_A3, USER_A4, USER_B1 } from './support/fixtures';
import {
  intakeBody,
  legacyPackage,
  PRACTICE,
  SOURCE_SYSTEM,
  seedMigrationScopes,
} from './support/migration-fixtures';

/**
 * Closeout A6 (H2 M-5 open item): the administrator-facing reviewer assignment commands. An assignment
 * is made and ended by a tenant-wide human administrator (admin.configure) for a live human member of the
 * same tenant, never for the administrator themself; ending it keeps the row (revoked, by whom, why), and
 * the sign-off it gates is refused once it ends. Synthetic only.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let packageRef: string;

type Assignment = {
  assignmentRef: string;
  principalRef: string;
  role: string;
  state: string;
  assignedByRef: string;
  revokedByRef: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  version: number;
};
const assign = (who: string, principalRef: string, role = 'financialReviewer', key?: string) =>
  h.call(who, 'POST', '/v1/migration/reviewers', { principalRef, role }, key);
const unassign = (who: string, assignmentRef: string, expectedVersion: number, key?: string) =>
  h.call(
    who,
    'POST',
    '/v1/migration/reviewers/unassign',
    { assignmentRef, expectedVersion, reasonCode: 'role_change' },
    key,
  );
const list = async (who: string, query = '') =>
  h.ok<{ data: Assignment[]; envelope: { appliedFilters: unknown } }>(
    await h.call(who, 'GET', `/v1/migration/reviewers${query}`),
  ).data;
const reason = (r: { statusCode: number; json(): { code?: string; detail?: { reason?: string } } }) => [
  r.statusCode,
  r.json().detail?.reason ?? r.json().code,
];
const count = async () =>
  Number(
    (await db.admin.query('SELECT count(*) FROM cuspatlas.migration_reviewer_assignments')).rows[0].count,
  );

beforeAll(async () => {
  db = await openTestDatabase('migration_reviewers');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedMigrationScopes(db.admin);
  const profileRef = h.ok<{ data: { profileRef: string } }>(
    await h.call('a1', 'POST', '/v1/migration/source-profiles', {
      sourceSystem: SOURCE_SYSTEM,
      format: 'cuspatlas-synthetic-legacy/1',
      practiceRef: PRACTICE,
    }),
    201,
  ).data.profileRef;
  packageRef = h.ok<{ data: { packageRef: string } }>(
    await h.call(
      'a1',
      'POST',
      '/v1/migration/packages',
      intakeBody(
        profileRef,
        legacyPackage({
          patients:
            'patient_id,last_name,first_name,birth_date,phone,guarantor_id\nR001,Review,Rowan,1984-04-04,5552200001,G1\n',
        }),
      ),
    ),
    201,
  ).data.packageRef;
  const plan = h.ok<{ data: { planDigest: string } }>(
    await h.call('a1', 'GET', `/v1/migration/imports/plan?packageRef=${packageRef}`),
  ).data;
  h.ok(
    await h.call('a1', 'POST', '/v1/migration/imports/apply', {
      packageRef,
      expectedPlanDigest: plan.planDigest,
      batchSize: 200,
    }),
  );
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('A6 reviewer assignment commands', () => {
  let first: string;

  it('assigns a live human member, idempotently, and lists it', async () => {
    const key = randomUUID();
    const r = h.ok<{ data: Assignment; version: number; replayed: boolean }>(
      await assign('a1', USER_A4, 'financialReviewer', key),
      201,
    );
    expect(r.data).toMatchObject({ principalRef: USER_A4, role: 'financialReviewer', state: 'active' });
    expect([r.version, r.replayed]).toStrictEqual([1, false]);
    first = r.data.assignmentRef;
    const again = h.ok<{ data: Assignment; replayed: boolean }>(
      await assign('a1', USER_A4, 'financialReviewer', key),
      201,
    );
    expect([again.data.assignmentRef, again.replayed]).toStrictEqual([first, true]);
    // A second live assignment of the same role is refused, not duplicated.
    expect(reason(await assign('a1', USER_A4))).toStrictEqual([409, 'already_assigned']);
    // migration.read is enough to list (a4 holds only migration.read).
    const rows = await list('a4', `?principalRef=${USER_A4}`);
    expect(rows.map((x) => [x.assignmentRef, x.state, x.assignedByRef, x.version])).toStrictEqual([
      [first, 'active', USER_A1, 1],
    ]);
    // The fixture-seeded assignments are listed too.
    expect(
      (await list('a1', '?role=operationsReviewer&state=active')).map((x) => x.principalRef).sort(),
    ).toStrictEqual([USER_A1, USER_A3].sort());
  });

  it('unassigns at the expected version, keeps the history and allows a reassignment', async () => {
    expect(reason(await unassign('a1', first, 7))).toStrictEqual([409, 'stale_version']);
    const r = h.ok<{ data: Assignment; version: number }>(await unassign('a1', first, 1));
    expect([r.data.state, r.version]).toStrictEqual(['revoked', 2]);
    expect(reason(await unassign('a1', first, 2))).toStrictEqual([409, 'assignment_not_active']);
    const again = h.ok<{ data: Assignment }>(await assign('a1', USER_A4), 201).data.assignmentRef;
    expect(again).not.toBe(first);
    const rows = await list('a1', `?principalRef=${USER_A4}`);
    expect(rows.map((x) => [x.assignmentRef, x.state, x.revokedByRef, x.revocationReason])).toStrictEqual([
      [first, 'revoked', USER_A1, 'role_change'],
      [again, 'active', null, null],
    ]);
    expect(
      (await list('a1', `?principalRef=${USER_A4}&state=revoked`)).map((x) => x.assignmentRef),
    ).toStrictEqual([first]);
    // Never deleted: the row of the first assignment is still there.
    const { rows: kept } = await db.admin.query(
      'SELECT revoked_at IS NOT NULL AS revoked, revoked_by FROM cuspatlas.migration_reviewer_assignments WHERE id = $1',
      [first],
    );
    expect(kept).toStrictEqual([{ revoked: true, revoked_by: USER_A1 }]);
  });

  it('refuses a service principal, a revoked member, another tenant member, an unknown principal and self', async () => {
    const before = await count();
    for (const principal of [SVC_A1, USER_A2, USER_B1, randomUUID()])
      expect([principal, ...reason(await assign('a1', principal, 'operationsReviewer'))]).toStrictEqual([
        principal,
        422,
        'reviewer_not_eligible',
      ]);
    expect(reason(await assign('a1', USER_A1, 'financialReviewer'))).toStrictEqual([
      409,
      'self_assignment_refused',
    ]);
    expect(await count()).toBe(before);
  });

  it('refuses a non-admin, a location-restricted admin, a service principal, a revoked member and another tenant', async () => {
    const before = await count();
    const target = (await list('a1', `?principalRef=${USER_A4}&state=active`))[0] as Assignment;
    for (const who of ['a4', 'a5', 'a3', 'svcA1', 'a2']) {
      expect([who, (await assign(who, USER_A4, 'operationsReviewer')).statusCode]).toStrictEqual([who, 403]);
      expect([who, (await unassign(who, target.assignmentRef, target.version)).statusCode]).toStrictEqual([
        who,
        403,
      ]);
    }
    // Tenant beta's administrator cannot assign an alpha member nor end an alpha assignment.
    expect(reason(await assign('b1', USER_A4, 'operationsReviewer'))).toStrictEqual([
      422,
      'reviewer_not_eligible',
    ]);
    expect((await unassign('b1', target.assignmentRef, target.version)).statusCode).toBe(404);
    expect((await list('b1')).map((x) => x.principalRef)).not.toContain(USER_A4);
    // Reads: a principal without migration.read is refused; a revoked member too.
    expect((await h.call('a5', 'GET', '/v1/migration/reviewers')).statusCode).toBe(403);
    expect((await h.call('a2', 'GET', '/v1/migration/reviewers')).statusCode).toBe(403);
    // MCP is refused the same way for a non-admin.
    const m = await h.mcp('a4', 'migration_reviewers_assign', {
      principalRef: USER_A3,
      role: 'financialReviewer',
      idempotencyKey: randomUUID(),
    });
    expect(m.status).toBe(403);
    expect(await count()).toBe(before);
  });

  it('records an audit event for each assignment change', async () => {
    const { rows } = await db.admin.query(
      `SELECT operation, resource_version, actor_id FROM cuspatlas.audit_events
       WHERE resource_type = 'migrationReviewerAssignment' AND resource_ref = $1 ORDER BY resource_version`,
      [first],
    );
    expect(rows).toStrictEqual([
      { operation: 'migration.reviewers.assign', resource_version: 1, actor_id: USER_A1 },
      { operation: 'migration.reviewers.unassign', resource_version: 2, actor_id: USER_A1 },
    ]);
  });

  it('an unassigned reviewer can no longer sign off; a reassigned one can', async () => {
    const report = h.ok<{ data: { reportRef: string; reportDigest: string } }>(
      await h.call('a1', 'POST', '/v1/migration/reports', { packageRef }),
    ).data;
    const signOff = () =>
      h.call('a3', 'POST', '/v1/migration/signoffs', {
        packageRef,
        reportRef: report.reportRef,
        reportDigest: report.reportDigest,
        role: 'operationsReviewer',
        decision: 'rejected',
      });
    // a3 holds the fixture-seeded operationsReviewer assignment (version 1); end it through the API.
    const seeded = (
      await list('a1', `?principalRef=${USER_A3}&role=operationsReviewer&state=active`)
    )[0] as Assignment;
    h.ok(await unassign('a1', seeded.assignmentRef, seeded.version));
    expect(reason(await signOff())).toStrictEqual([409, 'reviewer_role_not_assigned']);
    // MCP list parity: the ended assignment is listed as revoked.
    const m = await h.mcp('a1', 'migration_reviewers_list', { principalRef: USER_A3 });
    expect((m.body.data as Assignment[]).map((x) => [x.assignmentRef, x.state])).toContainEqual([
      seeded.assignmentRef,
      'revoked',
    ]);
    h.ok(await assign('a1', USER_A3, 'operationsReviewer'), 201);
    h.ok(await signOff(), 201);
  });
});
