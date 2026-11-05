import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppointmentHarness, openAppointmentHarness } from './support/appointment-fixtures';
import { seedBillingScopes } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import {
  intakeBody,
  legacyPackage,
  legacyTables,
  PRACTICE,
  SOURCE_SYSTEM,
  seedMigrationScopes,
} from './support/migration-fixtures';

/**
 * M6: reconciliation report versions and the staff sign-off gate. Cutover readiness needs an approval
 * of the current report version by two distinct human reviewers and no blocking exception; any later
 * import change (here a delegated S6 merge) reopens the gate. Synthetic only.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let packageRef: string;

interface Summary {
  reportRef: string;
  reportVersion: number;
  reportDigest: string;
  blockingExceptions: number;
}
interface Report {
  reportRef: string;
  reportVersion: number;
  stale: boolean;
  cutoverState: string;
  report: {
    counts: {
      entity: string;
      declared: number;
      staged: number;
      applied: number;
      excluded: number;
      blocked: number;
    }[];
    balanceComparison: {
      accountRef: string;
      sourceValue: { minor: number };
      targetValue: { minor: number };
      difference: { minor: number };
    }[];
    blockingExceptions: { code: string }[];
    exceptionsByCategory: { code: string; count: number }[];
    notImported: number;
  };
  signOffs: { role: string; valid: boolean }[];
}
const build = async (who = 'a1') =>
  h.ok<{ data: Summary }>(await h.call(who, 'POST', '/v1/migration/reports', { packageRef })).data;
const read = async () =>
  h.ok<{ data: Report }>(await h.call('a4', 'GET', `/v1/migration/reports/latest?packageRef=${packageRef}`))
    .data;
const sign = (who: string, s: Summary, role: string, decision = 'approved') =>
  h.call(who, 'POST', '/v1/migration/signoffs', {
    packageRef,
    reportRef: s.reportRef,
    reportDigest: s.reportDigest,
    role,
    decision,
  });
const advance = (who: string, s: Summary) =>
  h.call(who, 'POST', '/v1/migration/cutover/advance', { packageRef, reportRef: s.reportRef });
const reason = (r: { json(): { detail?: { reason?: string } } }) => r.json().detail?.reason;
const items = async () =>
  h.ok<{ data: { itemRef: string; category: string; stagedRefs: string[] }[] }>(
    await h.call('a1', 'GET', `/v1/migration/review-items?packageRef=${packageRef}&state=open`),
  ).data;
const resolve = async (itemRef: string, decision: string) =>
  h.ok(
    await h.call('a1', 'POST', '/v1/migration/review-items/resolve', {
      packageRef,
      itemRef,
      decision,
      reasonCode: 'reviewed',
    }),
  );

beforeAll(async () => {
  db = await openTestDatabase('migration_reconciliation');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedBillingScopes(db.admin);
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
      intakeBody(profileRef, legacyPackage(legacyTables({ futureAppointment: true, sourceDuplicate: true }))),
    ),
    201,
  ).data.packageRef;
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('M6 reconciliation report and sign-off gate', () => {
  let v1: Summary;
  let v2: Summary;

  it('reports per-entity counts and per-guarantor balances, and blocks while exceptions are open', async () => {
    v1 = await build();
    expect(v1.reportVersion).toBe(1);
    expect(v1.blockingExceptions).toBeGreaterThan(0);
    expect((await build()).reportRef).toBe(v1.reportRef); // nothing changed: same version
    const r = await read();
    expect(r.report.counts.find((c) => c.entity === 'patients')).toMatchObject({
      declared: 4,
      staged: 4,
      applied: 0,
    });
    // Nothing imported yet: the full source balance is an unexplained difference, not a zero.
    expect(r.report.balanceComparison.find((b) => b.accountRef === 'guarantor:G1')).toMatchObject({
      sourceValue: { minor: 16500 },
      targetValue: { minor: 0 },
      difference: { minor: 16500 },
    });
    expect(r.report.blockingExceptions.map((e) => e.code)).toContain('unexplained_difference');
    const early = await sign('a1', v1, 'financialReviewer');
    expect([early.statusCode, reason(early)]).toStrictEqual([409, 'unresolved_exception']);
    const adv = await advance('a1', v1);
    expect([adv.statusCode, reason(adv)]).toStrictEqual([409, 'unresolved_exception']);
  });

  it('after review and import a new version supersedes the prior one, and a stale version cannot be signed', async () => {
    for (const i of await items()) {
      if (i.category === 'terminology') await resolve(i.itemRef, 'archiveOnly');
      if (i.category === 'future_appointment') await resolve(i.itemRef, 'exclude');
      if (i.category === 'identity') await resolve(i.itemRef, 'mergeAfterImport');
    }
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
    v2 = await build();
    expect(v2).toMatchObject({ reportVersion: 2, blockingExceptions: 0 });
    const r = await read();
    expect(r.report.balanceComparison.every((b) => b.difference.minor === 0)).toBe(true);
    expect(r.report.notImported).toBe(1);
    expect(r.report.exceptionsByCategory).toStrictEqual([{ code: 'excluded_by_review', count: 1 }]);
    // The prior version still exists (superseded, never deleted) and cannot be signed.
    expect(
      (await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.migration_reports')).rows[0].n,
    ).toBe(2);
    const stale = await sign('a1', v1, 'financialReviewer');
    expect([stale.statusCode, reason(stale)]).toStrictEqual([409, 'stale_report_version']);
  });

  it('cutover needs two distinct human reviewers with the sign-off scope on the current version', async () => {
    expect((await sign('a4', v2, 'financialReviewer')).statusCode).toBe(403);
    expect((await sign('svcA1', v2, 'financialReviewer')).statusCode).toBe(403);
    expect((await sign('b1', v2, 'financialReviewer')).statusCode).toBe(404);
    h.ok(await sign('a1', v2, 'financialReviewer'), 201);
    const same = await sign('a1', v2, 'operationsReviewer');
    expect([same.statusCode, reason(same)]).toStrictEqual([409, 'separate_reviewer_required']);
    const half = await advance('a1', v2);
    expect([half.statusCode, reason(half)]).toStrictEqual([409, 'sign_off_incomplete']);
    h.ok(await sign('a3', v2, 'operationsReviewer'), 201);
    expect((await advance('a4', v2)).statusCode).toBe(403);
    const ok = h.ok<{ data: { cutoverState: string } }>(await advance('a1', v2));
    expect(ok.data.cutoverState).toBe('readyForCutover');
    expect((await read()).signOffs.every((s) => s.valid)).toBe(true);
    await expect(db.app.query('DELETE FROM cuspatlas.migration_signoffs')).rejects.toThrow();
  });

  it('a later import change reopens the gate and invalidates every sign-off', async () => {
    const group = (
      await h.ok<{ data: { itemRef: string; category: string; stagedRefs: string[] }[] }>(
        await h.call('a1', 'GET', `/v1/migration/review-items?packageRef=${packageRef}`),
      )
    ).data.find((i) => i.category === 'identity') as { itemRef: string; stagedRefs: string[] };
    const { rows } = await db.admin.query(
      'SELECT patient_id FROM cuspatlas.migration_applied_records WHERE staged_record_id = ANY ($1::uuid[]) ORDER BY source_id',
      [group.stagedRefs],
    );
    const [survivor, merged] = rows.map((r) => r.patient_id as string) as [string, string];
    const review = h.ok<{ data: { candidateRef: string; confirmationToken: string }[] }>(
      await h.call('a1', 'GET', `/v1/patients/${survivor}/duplicate-candidates`),
    );
    const token = review.data.find((c) => c.candidateRef === merged)?.confirmationToken;
    h.ok(
      await h.call('a1', 'POST', '/v1/migration/identity/merges', {
        packageRef,
        itemRef: group.itemRef,
        survivorRef: survivor,
        mergedRef: merged,
        confirmationToken: token,
        reasonCode: 'duplicate_registration',
      }),
      201,
    );
    const r = await read();
    expect([r.cutoverState, r.stale, r.signOffs.some((s) => s.valid)]).toStrictEqual([
      'reconciling',
      true,
      false,
    ]);
    const again = await advance('a1', v2);
    expect([again.statusCode, reason(again)]).toStrictEqual([409, 'stale_report_version']);
    const v3 = await build();
    expect(v3.reportVersion).toBe(3);
  });
});
