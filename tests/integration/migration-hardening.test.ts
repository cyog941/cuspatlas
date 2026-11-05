import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppointmentHarness, openAppointmentHarness } from './support/appointment-fixtures';
import { seedBillingScopes } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { SVC_A1, T_ALPHA, USER_A1 } from './support/fixtures';
import {
  intakeBody,
  legacyPackage,
  PRACTICE,
  SOURCE_SYSTEM,
  seedMigrationScopes,
} from './support/migration-fixtures';
import { patientBody } from './support/patient-fixtures';

/**
 * Hardening H2 of workstream M: the apply never wedges on a row the database would refuse, the
 * runtime role cannot forge opening items, cutover readiness or sign-offs, and a crash between two
 * transactions never leaves a stale sign-off, an orphan patient or a link to a merged patient.
 * Synthetic only; recommended-pending-approval.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let profileRef: string;
let existing: string;
/** The M-1 package, fully applied. */
let wedged: string;

type Item = { itemRef: string; category: string; stagedRefs: string[] };
const HEAD = {
  patients: 'patient_id,last_name,first_name,birth_date,phone,guarantor_id\n',
  ledger_balances: 'balance_id,account_id,patient_id,balance_minor,currency,as_of\n',
  unapplied_credits: 'payment_id,account_id,patient_id,amount_minor,currency,received_on\n',
};
const stage = async (tables: Record<string, string>) =>
  h.ok<{ data: { packageRef: string } }>(
    await h.call('a1', 'POST', '/v1/migration/packages', intakeBody(profileRef, legacyPackage(tables))),
    201,
  ).data.packageRef;
const openItems = async (pkg: string) =>
  h.ok<{ data: Item[] }>(await h.call('a1', 'GET', `/v1/migration/review-items?packageRef=${pkg}&state=open`))
    .data;
const resolve = (pkg: string, itemRef: string, decision: string, patientRef?: string) =>
  h.call('a1', 'POST', '/v1/migration/review-items/resolve', {
    packageRef: pkg,
    itemRef,
    decision,
    reasonCode: 'reviewed',
    ...(patientRef ? { patientRef } : {}),
  });
const plan = async (pkg: string) =>
  h.ok<{ data: { planDigest: string; exceptions: { code: string; entity: string; stagedRef: string }[] } }>(
    await h.call('a1', 'GET', `/v1/migration/imports/plan?packageRef=${pkg}`),
  ).data;
const apply = async (pkg: string, batchSize = 200) =>
  h.call('a1', 'POST', '/v1/migration/imports/apply', {
    packageRef: pkg,
    expectedPlanDigest: (await plan(pkg)).planDigest,
    batchSize,
  });
const sourceOf = async (pkg: string) =>
  new Map(
    (
      await db.admin.query(
        'SELECT id, source_id FROM cuspatlas.migration_staged_records WHERE package_id = $1',
        [pkg],
      )
    ).rows.map((r) => [r.id as string, r.source_id as string]),
  );

beforeAll(async () => {
  db = await openTestDatabase('migration_hardening');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedBillingScopes(db.admin);
  await seedMigrationScopes(db.admin);
  profileRef = h.ok<{ data: { profileRef: string } }>(
    await h.call('a1', 'POST', '/v1/migration/source-profiles', {
      sourceSystem: SOURCE_SYSTEM,
      format: 'cuspatlas-synthetic-legacy/1',
      practiceRef: PRACTICE,
    }),
    201,
  ).data.profileRef;
  existing = h.ok<{ data: { patientRef: string } }>(
    await h.call('a1', 'POST', '/v1/patients', {
      ...patientBody('Morgan', { birthDate: { known: true, value: '1970-01-01', precision: 'day' } }),
      legalName: { known: true, given: 'Morgan', family: 'Existing' },
    }),
    201,
  ).data.patientRef;
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('H2 M-1 the apply never wedges', () => {
  it('excludes over-cap amounts, impossible dates and index-key duplicates after link decisions', async () => {
    const pkg = await stage({
      patients: `${HEAD.patients}H001,Wedge,Harper,1981-03-03,5550500001,G1\nH002,Wedge,Indigo,1980-02-30,5550500002,G1\nM001,Existing,Morgan,1970-01-01,5550500003,G2\nM002,Existing,Morgan,1970-01-01,5550500004,G2\n`,
      ledger_balances: `${HEAD.ledger_balances}W1,G1,H001,999999999999999,USD,2026-10-31\nW2,G1,H001,100,USD,2026-02-30\nW3,G1,H001,100,USD,\nW4,G1,H001,100,USD,1900-01-01\nW5,G2,M001,100,USD,2026-10-31\nW6,G2,M002,100,USD,2026-10-31\n`,
      unapplied_credits: `${HEAD.unapplied_credits}W7,G1,H001,100,USD,2026-02-30\n`,
    });
    const identity = (await openItems(pkg)).filter((i) => i.category === 'identity');
    expect(identity.map((i) => i.stagedRefs.length)).toStrictEqual([2]);
    h.ok(await resolve(pkg, identity[0]?.itemRef as string, 'sameAsExisting', existing));
    const ids = await sourceOf(pkg);
    const p = await plan(pkg);
    expect(p.exceptions.map((e) => `${ids.get(e.stagedRef)}:${e.code}`).sort()).toStrictEqual([
      'H002:validation_failed',
      'W1:validation_failed',
      'W2:validation_failed',
      'W4:duplicate_opening',
      'W6:duplicate_opening',
      'W7:validation_failed',
    ]);
    wedged = pkg;
    const r = await apply(pkg);
    expect(h.ok<{ data: { state: string } }>(r).data.state).toBe('complete');
    const { rows } = await db.admin.query(
      'SELECT source_ref FROM cuspatlas.migration_opening_items WHERE package_id = $1 ORDER BY 1',
      [pkg],
    );
    expect(rows.map((x) => x.source_ref)).toStrictEqual(['W3', 'W5']);
    // A second package linking to the same patient for the same day is excluded, not a wedge.
    const again = await stage({
      patients: `${HEAD.patients}M009,Existing,Morgan,1970-01-01,5550500009,G9\n`,
      ledger_balances: `${HEAD.ledger_balances}W9,G9,M009,100,USD,2026-10-31\n`,
    });
    const item = (await openItems(again)).find((i) => i.category === 'identity');
    h.ok(await resolve(again, item?.itemRef as string, 'sameAsExisting', existing));
    expect((await plan(again)).exceptions.map((e) => e.code)).toStrictEqual(['duplicate_opening']);
    expect(h.ok<{ data: { state: string } }>(await apply(again)).data.state).toBe('complete');
  });
});

/** One statement batch under the runtime role in tenant alpha; the SQLSTATE of a refusal. */
const asApp = async (actor: string, steps: [string, unknown[]][]): Promise<string> => {
  const c = await db.app.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
    await c.query(`SELECT set_config('cuspatlas.actor_id', $1, true)`, [actor]);
    for (const [sql, params] of steps) await c.query(sql, params);
    await c.query('ROLLBACK');
    return 'accepted';
  } catch (err) {
    await c.query('ROLLBACK');
    return (err as { code?: string }).code ?? 'error';
  } finally {
    c.release();
  }
};

describe('H2 M-2 database guards under the runtime role', () => {
  const run: [string, unknown[]] = [
    `INSERT INTO cuspatlas.migration_apply_runs (tenant_id, package_id, plan_digest, started_by)
     VALUES (cuspatlas.current_tenant_id(), $1, repeat('a', 64), cuspatlas.current_actor_id())`,
    [],
  ];
  const item = (stagedRef: string, patient: string, amount: string): [string, unknown[]] => [
    `INSERT INTO cuspatlas.migration_opening_items (tenant_id, package_id, staged_record_id, kind, patient_id,
       amount_minor, currency, as_of_precision, source_ref, created_by)
     SELECT cuspatlas.current_tenant_id(), s.package_id, s.id, 'balance', $2, $3::bigint, 'USD', 'approximate',
       s.source_id, cuspatlas.current_actor_id()
     FROM cuspatlas.migration_staged_records s WHERE s.id = $1`,
    [stagedRef, patient, amount],
  ];

  it('refuses a forged opening item: outside an apply run, a changed amount, another patient', async () => {
    const ids = [...(await sourceOf(wedged))].find(([, src]) => src === 'W2')?.[0] as string;
    const { rows } = await db.admin.query(
      `SELECT a.patient_id FROM cuspatlas.migration_applied_records a JOIN cuspatlas.migration_staged_records s
       ON s.id = a.staged_record_id WHERE s.package_id = $1 AND s.source_id = 'H001'`,
      [wedged],
    );
    const harper = rows[0]?.patient_id as string;
    const withRun = (step: [string, unknown[]]): [string, unknown[]][] => [[run[0], [wedged]], step];
    expect(await asApp(USER_A1, [item(ids, harper, '100')])).toBe('42501');
    expect(await asApp(USER_A1, withRun(item(ids, harper, '5000')))).toBe('42501');
    expect(await asApp(USER_A1, withRun(item(ids, existing, '100')))).toBe('42501');
  });

  it('refuses a forged cutover, a skipped change sequence and a forged sign-off', async () => {
    const report = h.ok<{ data: { reportRef: string; reportDigest: string } }>(
      await h.call('a1', 'POST', '/v1/migration/reports', { packageRef: wedged }),
    ).data;
    const pkgSql = (set: string): [string, unknown[]] => [
      `UPDATE cuspatlas.migration_packages SET ${set} WHERE id = $1`,
      [wedged],
    ];
    expect(await asApp(USER_A1, [pkgSql(`cutover_state = 'readyForCutover'`)])).toBe('42501');
    expect(await asApp(USER_A1, [pkgSql('change_seq = change_seq + 2')])).toBe('42501');
    const sign = (digest: string): [string, unknown[]] => [
      `INSERT INTO cuspatlas.migration_signoffs (tenant_id, package_id, report_id, report_digest, role, decision, signed_by)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, 'financialReviewer', 'approved', cuspatlas.current_actor_id())`,
      [wedged, report.reportRef, digest],
    ];
    expect(await asApp(USER_A1, [sign('f'.repeat(64))])).toBe('42501');
    expect(await asApp(SVC_A1, [sign(report.reportDigest)])).toBe('42501');
    expect(await asApp(USER_A1, [sign(report.reportDigest)])).toBe('accepted');
  });
});

/** A package whose two source rows are one person decided `mergeAfterImport`, applied. */
const appliedDuplicatePair = async (tag: string) => {
  const pkg = await stage({
    patients: `${HEAD.patients}${tag}1,Twin,Rory${tag},1966-06-06,5550600001,G1\n${tag}2,Twin,Rory${tag},1966-06-06,5550600002,G1\n`,
  });
  const group = (await openItems(pkg)).find((i) => i.category === 'identity') as Item;
  h.ok(await resolve(pkg, group.itemRef, 'mergeAfterImport'));
  h.ok(await apply(pkg));
  const { rows } = await db.admin.query(
    `SELECT a.patient_id FROM cuspatlas.migration_applied_records a
     WHERE a.staged_record_id = ANY ($1::uuid[]) ORDER BY a.source_id`,
    [group.stagedRefs],
  );
  const [survivor, merged] = rows.map((r) => r.patient_id as string) as [string, string];
  const token = h
    .ok<{ data: { candidateRef: string; confirmationToken: string }[] }>(
      await h.call('a1', 'GET', `/v1/patients/${survivor}/duplicate-candidates`),
    )
    .data.find((c) => c.candidateRef === merged)?.confirmationToken as string;
  return {
    pkg,
    survivor,
    merged,
    body: {
      packageRef: pkg,
      itemRef: group.itemRef,
      survivorRef: survivor,
      mergedRef: merged,
      confirmationToken: token,
      reasonCode: 'duplicate_registration',
    },
  };
};
const changeSeq = async (pkg: string) =>
  (await db.admin.query('SELECT change_seq FROM cuspatlas.migration_packages WHERE id = $1', [pkg])).rows[0]
    ?.change_seq as number;
const mergedInto = async (patient: string) =>
  (await db.admin.query('SELECT merged_into FROM cuspatlas.patients WHERE id = $1', [patient])).rows[0]
    ?.merged_into as string | null;

describe('H2 M-3 a merge and its change-sequence bump commit together', () => {
  it('a crash before the bump leaves no merge; the retry merges and bumps once', async () => {
    const m = await appliedDuplicatePair('MC');
    const before = await changeSeq(m.pkg);
    // Simulated crash: the package bump fails after S6 has done its work.
    await db.admin.query(`CREATE FUNCTION cuspatlas.h2_crash() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.change_seq <> OLD.change_seq THEN RAISE EXCEPTION 'simulated crash'; END IF; RETURN NEW; END $$`);
    await db.admin.query(
      'CREATE TRIGGER h2_crash BEFORE UPDATE ON cuspatlas.migration_packages FOR EACH ROW EXECUTE FUNCTION cuspatlas.h2_crash()',
    );
    const key = '7d1e9b2a-3c4f-4a5b-8c6d-7e8f9a0b1c2d';
    try {
      const crashed = await h.call('a1', 'POST', '/v1/migration/identity/merges', m.body, key);
      expect(crashed.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await db.admin.query('DROP TRIGGER h2_crash ON cuspatlas.migration_packages');
      await db.admin.query('DROP FUNCTION cuspatlas.h2_crash()');
    }
    expect([await mergedInto(m.merged), await changeSeq(m.pkg)]).toStrictEqual([null, before]);
    h.ok(await h.call('a1', 'POST', '/v1/migration/identity/merges', m.body, key), 201);
    expect([await mergedInto(m.merged), await changeSeq(m.pkg)]).toStrictEqual([m.survivor, before + 1]);
    // A replay changes nothing further.
    h.ok(await h.call('a1', 'POST', '/v1/migration/identity/merges', m.body, key), 201);
    expect(await changeSeq(m.pkg)).toBe(before + 1);
  });
});
