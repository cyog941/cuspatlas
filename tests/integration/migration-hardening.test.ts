import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppointmentHarness, openAppointmentHarness } from './support/appointment-fixtures';
import { seedBillingScopes } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
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
