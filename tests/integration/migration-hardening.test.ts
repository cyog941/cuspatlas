import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  count,
  mergePatients,
  openAppointmentHarness,
} from './support/appointment-fixtures';
import { postCharge, seedBillingScopes } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { dbNow } from './support/db-clock';
import { SVC_A1, T_ALPHA, USER_A1, USER_A3 } from './support/fixtures';
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

const appliedPatient = async (pkg: string, source: string) =>
  (
    await db.admin.query(
      `SELECT a.patient_id FROM cuspatlas.migration_applied_records a JOIN cuspatlas.migration_staged_records s
       ON s.id = a.staged_record_id WHERE s.package_id = $1 AND s.source_id = $2`,
      [pkg, source],
    )
  ).rows[0]?.patient_id as string | undefined;

describe('H2 M-4 no orphan patient and no link to a merged patient', () => {
  it('a run that fails after creating patients leaves none behind; the retry creates each once', async () => {
    const pkg = await stage({
      patients: `${HEAD.patients}O001,Orphan,Sage,1977-07-07,5550700001,G1\n`,
    });
    const patients = await count(db, 'patients');
    await db.admin.query(`CREATE FUNCTION cuspatlas.h2_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated crash'; END $$`);
    await db.admin.query(
      'CREATE TRIGGER h2_fail BEFORE INSERT ON cuspatlas.migration_applied_records FOR EACH ROW EXECUTE FUNCTION cuspatlas.h2_fail()',
    );
    try {
      expect((await apply(pkg)).statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await db.admin.query('DROP TRIGGER h2_fail ON cuspatlas.migration_applied_records');
      await db.admin.query('DROP FUNCTION cuspatlas.h2_fail()');
    }
    expect(await count(db, 'patients')).toBe(patients);
    h.ok(await apply(pkg));
    expect(await count(db, 'patients')).toBe(patients + 1);
  });

  it('adopts a patient an earlier run created for the same staged record', async () => {
    const pkg = await stage({
      patients: `${HEAD.patients}O002,Orphan,Tatum,1978-08-08,5550700002,G1\n`,
    });
    const staged = [...(await sourceOf(pkg))][0]?.[0] as string;
    const left = h.ok<{ data: { patientRef: string } }>(
      await h.call('a1', 'POST', '/v1/patients', {
        legalName: { known: true, given: 'Tatum', family: 'Orphan' },
        birthDate: { known: true, value: '1978-08-08', precision: 'day' },
        identifiers: [{ type: 'external_record', issuer: 'cuspatlas-migration', value: staged }],
      }),
      201,
    ).data.patientRef;
    const patients = await count(db, 'patients');
    h.ok(await apply(pkg));
    expect([await count(db, 'patients'), await appliedPatient(pkg, 'O002')]).toStrictEqual([patients, left]);
  });

  it('a link decided before a merge follows the merged patient to its survivor', async () => {
    const make = async () =>
      h.ok<{ data: { patientRef: string } }>(
        await h.call('a1', 'POST', '/v1/patients', {
          legalName: { known: true, given: 'Quinn', family: 'Merge' },
          birthDate: { known: true, value: '1955-05-05', precision: 'day' },
        }),
        201,
      ).data.patientRef;
    const survivor = await make();
    const merged = await make();
    const pkg = await stage({
      patients: `${HEAD.patients}L001,Merge,Quinn,1955-05-05,5550700003,G1\n`,
    });
    const item = (await openItems(pkg)).find((i) => i.category === 'identity') as Item;
    h.ok(await resolve(pkg, item.itemRef, 'sameAsExisting', merged));
    await mergePatients(h, survivor, merged);
    h.ok(await apply(pkg));
    expect(await appliedPatient(pkg, 'L001')).toBe(survivor);
  });
});

describe('H2 M-5 a sign-off role comes from the reviewer list', () => {
  it('one person cannot claim a role an administrator did not assign them', async () => {
    const report = h.ok<{ data: { reportRef: string; reportDigest: string } }>(
      await h.call('a1', 'POST', '/v1/migration/reports', { packageRef: wedged }),
    ).data;
    const body = (role: string) => ({
      packageRef: wedged,
      reportRef: report.reportRef,
      reportDigest: report.reportDigest,
      role,
      decision: 'rejected',
    });
    const claimed = await h.call('a3', 'POST', '/v1/migration/signoffs', body('financialReviewer'));
    expect([claimed.statusCode, claimed.json().detail?.reason]).toStrictEqual([
      409,
      'reviewer_role_not_assigned',
    ]);
    const sign = (role: string): [string, unknown[]] => [
      `INSERT INTO cuspatlas.migration_signoffs (tenant_id, package_id, report_id, report_digest, role, decision, signed_by)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, 'rejected', cuspatlas.current_actor_id())`,
      [wedged, report.reportRef, report.reportDigest, role],
    ];
    expect(await asApp(USER_A3, [sign('financialReviewer')])).toBe('42501');
    expect(await asApp(USER_A3, [sign('operationsReviewer')])).toBe('accepted');
    // The runtime role cannot assign itself a role.
    expect(
      await asApp(USER_A3, [
        [
          `INSERT INTO cuspatlas.migration_reviewer_assignments (tenant_id, principal_id, role, assigned_by)
           VALUES (cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), 'financialReviewer', cuspatlas.current_actor_id())`,
          [],
        ],
      ]),
    ).toBe('42501');
  });
});

describe('H2 M-6 an opening item is posted once at the database', () => {
  /** An opening item with no entry yet (written with triggers off: the fixture, not the subject). */
  const freshItem = async (source: string, asOf: string) => {
    const harper = (await appliedPatient(wedged, 'H001')) as string;
    const c = await db.admin.connect();
    try {
      await c.query(`SET session_replication_role = replica`);
      const { rows } = await c.query(
        `INSERT INTO cuspatlas.migration_opening_items (tenant_id, package_id, staged_record_id, kind, patient_id,
           amount_minor, currency, as_of, as_of_precision, source_ref, created_by)
         SELECT $1, s.package_id, s.id, 'balance', $2, 100, 'USD', $4::date, 'day', s.source_id, $5
         FROM cuspatlas.migration_staged_records s WHERE s.package_id = $3 AND s.source_id = $6 RETURNING id`,
        [T_ALPHA, harper, wedged, asOf, USER_A1, source],
      );
      return { item: rows[0]?.id as string, patient: harper };
    } finally {
      await c.query(`SET session_replication_role = origin`);
      c.release();
    }
  };
  const post = async (
    c: import('pg').PoolClient,
    f: { item: string; patient: string },
    lines: [string, number][],
  ) => {
    const e = await c.query(
      `INSERT INTO cuspatlas.billing_journal_entries (tenant_id, kind, currency, line_count, posted_by, correlation_id)
       VALUES ($1, 'openingBalance', 'USD', $2, $3, gen_random_uuid()) RETURNING id`,
      [T_ALPHA, lines.length, USER_A1],
    );
    let n = 0;
    for (const [account, amount] of lines)
      await c.query(
        `INSERT INTO cuspatlas.billing_journal_lines (tenant_id, entry_id, line_no, account, amount_minor, currency,
           patient_id, opening_item_id) VALUES ($1, $2, $3, $4, $5, 'USD', $6, $7)`,
        [T_ALPHA, e.rows[0].id, ++n, account, amount, f.patient, f.item],
      );
  };
  const code = (err: unknown) => (err as { code?: string }).code ?? 'error';

  it('two concurrent forged postings of one item: exactly one commits', async () => {
    const f = await freshItem('W2', '2026-01-01');
    const pair: [string, number][] = [
      ['opening_receivable', 100],
      ['opening_equity', -100],
    ];
    const c1 = await db.admin.connect();
    const c2 = await db.admin.connect();
    try {
      await c1.query('BEGIN');
      await post(c1, f, pair);
      await c2.query('BEGIN');
      const second = post(c2, f, pair)
        .then(() => c2.query('COMMIT'))
        .then(
          () => 'committed',
          (err) => code(err),
        );
      await c1.query('COMMIT');
      expect(await second).toBe('23505');
    } finally {
      await c2.query('ROLLBACK').catch(() => undefined);
      c1.release();
      c2.release();
    }
    const { rows } = await db.admin.query(
      `SELECT count(DISTINCT entry_id)::int AS n FROM cuspatlas.billing_journal_lines WHERE opening_item_id = $1`,
      [f.item],
    );
    expect(rows[0].n).toBe(1);
  });

  it('an entry of two equity lines cannot stand in for the posting', async () => {
    const f = await freshItem('W4', '2026-01-02');
    const c = await db.admin.connect();
    try {
      await c.query('BEGIN');
      await post(c, f, [
        ['opening_equity', 100],
        ['opening_equity', -100],
      ]);
      await c.query('COMMIT');
      expect('committed').toBe('refused');
    } catch (err) {
      await c.query('ROLLBACK');
      expect(code(err)).toBe('23514');
    } finally {
      c.release();
    }
  });
});

describe('H2 M-7 excluded money blocks cutover until acknowledged', () => {
  it('each excluded balance must be acknowledged by the financial reviewer on the report digest', async () => {
    const pkg = await stage({
      patients: `${HEAD.patients}X001,Excluded,Uma,1983-03-03,5550800001,G8\n`,
      ledger_balances: `${HEAD.ledger_balances}X1,G8,X001,100,USD,2026-10-31\nX2,G8,X001,999999999999999,USD,2026-09-30\n`,
    });
    h.ok(await apply(pkg));
    const x2 = [...(await sourceOf(pkg))].find(([, s]) => s === 'X2')?.[0] as string;
    const report = h.ok<{ data: { reportRef: string; reportDigest: string; blockingExceptions: number } }>(
      await h.call('a1', 'POST', '/v1/migration/reports', { packageRef: pkg }),
    ).data;
    const read = h.ok<{ data: { report: { blockingExceptions: { code: string; subjectRef: string }[] } } }>(
      await h.call('a1', 'GET', `/v1/migration/reports/latest?packageRef=${pkg}`),
    ).data.report.blockingExceptions;
    expect(read).toStrictEqual([
      { code: 'excluded_balance', subjectRef: `staged:${x2}`, requiredAction: 'acknowledge_exclusion' },
    ]);
    const sign = (who: string, role: string, acknowledgedExclusions?: string[]) =>
      h.call(who, 'POST', '/v1/migration/signoffs', {
        packageRef: pkg,
        reportRef: report.reportRef,
        reportDigest: report.reportDigest,
        role,
        decision: 'approved',
        ...(acknowledgedExclusions ? { acknowledgedExclusions } : {}),
      });
    const advance = () =>
      h.call('a1', 'POST', '/v1/migration/cutover/advance', { packageRef: pkg, reportRef: report.reportRef });
    const silent = await sign('a1', 'financialReviewer');
    expect([silent.statusCode, silent.json().detail?.reason]).toStrictEqual([
      409,
      'unacknowledged_exclusion',
    ]);
    h.ok(await sign('a3', 'operationsReviewer'), 201);
    const early = await advance();
    expect([early.statusCode, early.json().detail?.reason]).toStrictEqual([409, 'unacknowledged_exclusion']);
    h.ok(await sign('a1', 'financialReviewer', [x2]), 201);
    const { rows } = await db.admin.query(
      `SELECT acknowledged_exclusions::text[] AS a, report_digest FROM cuspatlas.migration_signoffs
       WHERE report_id = $1 AND role = 'financialReviewer'`,
      [report.reportRef],
    );
    expect(rows).toStrictEqual([{ a: [x2], report_digest: report.reportDigest }]);
    expect(h.ok<{ data: { cutoverState: string } }>(await advance()).data.cutoverState).toBe(
      'readyForCutover',
    );
  });
});

describe('H2 M-8 intake hygiene', () => {
  it('refuses a NUL character with a typed 422 and stores a formula-leading value raw', async () => {
    const nul = await h.call(
      'a1',
      'POST',
      '/v1/migration/packages',
      intakeBody(
        profileRef,
        legacyPackage({ patients: `${HEAD.patients}N001,Nul\u0000,Ivy,1984-04-04,5550900001,G1\n` }),
      ),
    );
    expect([nul.statusCode, nul.json().detail?.reason]).toStrictEqual([422, 'nul_character']);
    const pkg = await stage({
      patients: `${HEAD.patients}F001,=HYPERLINK("syn"),Ivy,1984-04-04,5550900002,G1\n`,
    });
    const { rows } = await db.admin.query(
      `SELECT payload->>'last_name' AS v FROM cuspatlas.migration_staged_records WHERE package_id = $1`,
      [pkg],
    );
    expect(rows[0]?.v).toBe('=HYPERLINK("syn")');
  });

  it('returns an already-staged package only to the same profile and authorisation', async () => {
    const tables = { patients: `${HEAD.patients}R001,Replay,Jo,1985-05-05,5550900003,G1\n` };
    const first = await stage(tables);
    const same = h.ok<{ data: { packageRef: string; alreadyStaged: boolean } }>(
      await h.call('a1', 'POST', '/v1/migration/packages', intakeBody(profileRef, legacyPackage(tables))),
      201,
    ).data;
    expect(same).toMatchObject({ packageRef: first, alreadyStaged: true });
    const other = await h.call('a1', 'POST', '/v1/migration/packages', {
      ...intakeBody(profileRef, legacyPackage(tables)),
      authorisation: { reference: 'syn-auth-other-2026', practiceRef: PRACTICE },
    });
    expect([other.statusCode, other.json().detail?.reason]).toStrictEqual([
      409,
      'staged_under_other_authorisation',
    ]);
  });
});

describe('H2 M-10 opening facts on the B seam', () => {
  it('balances and statements include opening receivable and credit; opening credit allocates to a charge', async () => {
    const pkg = await stage({
      patients: `${HEAD.patients}Y001,Seam,Yara,1986-06-06,5551100001,G1\n`,
      ledger_balances: `${HEAD.ledger_balances}YB1,G1,Y001,3000,USD,2026-10-31\n`,
      unapplied_credits: `${HEAD.unapplied_credits}YC1,G1,Y001,1000,USD,2026-09-01\n`,
    });
    h.ok(await apply(pkg));
    const patient = (await appliedPatient(pkg, 'Y001')) as string;
    const credit = (
      await db.admin.query(
        `SELECT id FROM cuspatlas.migration_opening_items WHERE package_id = $1 AND kind = 'unappliedCredit'`,
        [pkg],
      )
    ).rows[0]?.id as string;
    type Balance = {
      patientResponsibility: { minor: number };
      unappliedCredit: { minor: number };
      balance: { minor: number };
    };
    const balance = async () =>
      h.ok<{ data: Balance }>(await h.call('a1', 'GET', `/v1/billing/patients/${patient}/balance`)).data;
    expect(await balance()).toMatchObject({
      patientResponsibility: { minor: 3000 },
      unappliedCredit: { minor: 1000 },
      balance: { minor: 2000 },
    });
    const statement = h.ok<{ data: { statementRef: string } }>(
      await h.call('a1', 'POST', '/v1/billing/statements', {
        guarantorRef: patient,
        cutoffAt: await dbNow(db.admin),
        basis: 'posted_through_cutoff',
      }),
      201,
    ).data.statementRef;
    const read = h.ok<{ data: { total: { minor: number } } }>(
      await h.call('a1', 'GET', `/v1/billing/statements/${statement}`),
    ).data;
    expect(read.total.minor).toBe(2000);
    // Opening credit allocated through the B2 allocation command, with B2's invariants.
    const { chargeRef } = await postCharge(h, patient, 700);
    const allocate = (minor: number, key?: string) =>
      h.call(
        'a1',
        'POST',
        `/v1/billing/payments/${credit}/allocations`,
        {
          allocations: [{ chargeRef, amount: { currency: 'USD', minor } }],
        },
        key,
      );
    const over = await allocate(800);
    expect([over.statusCode, over.json().detail?.reason]).toStrictEqual([409, 'charge_overallocated']);
    h.ok(await allocate(600), 201);
    const more = await allocate(500);
    expect([more.statusCode, more.json().detail?.reason]).toStrictEqual([409, 'insufficient_funds']);
    expect(await balance()).toMatchObject({
      patientResponsibility: { minor: 3100 },
      unappliedCredit: { minor: 400 },
      balance: { minor: 2700 },
    });
    // The opening reconciliation still states the credit as imported (allocations are later facts).
    const o = h.ok<{ data: { totals: { importedCredit: { minor: number } } } }>(
      await h.call('a1', 'GET', `/v1/migration/opening-items?packageRef=${pkg}`),
    ).data;
    expect(o.totals.importedCredit.minor).toBe(1000);
  });
});
