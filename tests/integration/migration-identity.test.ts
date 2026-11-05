import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppointmentHarness, count, openAppointmentHarness } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import {
  intakeBody,
  legacyPackage,
  legacyTables,
  PRACTICE,
  SOURCE_SYSTEM,
  seedMigrationScopes,
} from './support/migration-fixtures';
import { patientBody } from './support/patient-fixtures';

/**
 * M4: identity candidates (S6 scoring, within the source and against existing patients), staff
 * decisions, provenance links, and merges only through S6 `mergePatients`. Synthetic only.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let profileRef: string;
let existing: string;
let packageRef: string;

interface Item {
  itemRef: string;
  category: string;
  stagedRefs: string[];
  proposal: {
    basis: string;
    candidates: { patientRef: string; reasons: string[] }[];
    automaticMerge: boolean;
  };
}
const profile = async (sourceSystem: string) =>
  h.ok<{ data: { profileRef: string } }>(
    await h.call('a1', 'POST', '/v1/migration/source-profiles', {
      sourceSystem,
      format: 'cuspatlas-synthetic-legacy/1',
      practiceRef: PRACTICE,
    }),
    201,
  ).data.profileRef;
const stage = async (ref: string, tables: Record<string, string>, sourceSystem = SOURCE_SYSTEM) =>
  h.ok<{ data: { packageRef: string } }>(
    await h.call(
      'a1',
      'POST',
      '/v1/migration/packages',
      intakeBody(ref, legacyPackage(tables, { sourceSystem })),
    ),
    201,
  ).data.packageRef;
const identityItems = async (pkg: string) =>
  h
    .ok<{ data: Item[] }>(await h.call('a1', 'GET', `/v1/migration/review-items?packageRef=${pkg}`))
    .data.filter((i) => i.category === 'identity');
const staged = async (pkg: string) =>
  new Map(
    (
      await db.admin.query(
        'SELECT id, source_id FROM cuspatlas.migration_staged_records WHERE package_id = $1',
        [pkg],
      )
    ).rows.map((r) => [r.id as string, r.source_id as string]),
  );
const resolve = (pkg: string, itemRef: string, decision: string, patientRef?: string, who = 'a1') =>
  h.call(who, 'POST', '/v1/migration/review-items/resolve', {
    packageRef: pkg,
    itemRef,
    decision,
    reasonCode: 'identity_reviewed',
    ...(patientRef ? { patientRef } : {}),
  });
const applyAll = async (pkg: string) => {
  const plan = h.ok<{ data: { planDigest: string } }>(
    await h.call('a1', 'GET', `/v1/migration/imports/plan?packageRef=${pkg}`),
  ).data;
  return h.ok<{ data: { appliedThisBatch: number } }>(
    await h.call('a1', 'POST', '/v1/migration/imports/apply', {
      packageRef: pkg,
      expectedPlanDigest: plan.planDigest,
      batchSize: 200,
    }),
  ).data;
};
const provenance = async (patientRef: string) =>
  h.ok<{ data: { sourceSystem: string; sourceId: string; entity: string; action: string }[] }>(
    await h.call('a4', 'GET', `/v1/migration/provenance?patientRef=${patientRef}`),
  ).data;

beforeAll(async () => {
  db = await openTestDatabase('migration_identity');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedMigrationScopes(db.admin);
  profileRef = await profile(SOURCE_SYSTEM);
  // An existing tenant patient who is the same synthetic person as source row P001.
  existing = h.ok<{ data: { patientRef: string } }>(
    await h.call('a1', 'POST', '/v1/patients', {
      ...patientBody('Avery', { birthDate: { known: true, value: '1980-04-02', precision: 'day' } }),
      legalName: { known: true, given: 'Avery', family: 'Legacy' },
    }),
    201,
  ).data.patientRef;
  packageRef = await stage(profileRef, legacyTables({ sourceDuplicate: true }));
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('M4 identity candidates', () => {
  it('proposes groups with a stated basis and never on a shared household phone alone', async () => {
    const items = await identityItems(packageRef);
    const ids = await staged(packageRef);
    const groups = items.map((i) => i.stagedRefs.map((r) => ids.get(r)).sort());
    expect(groups.sort()).toStrictEqual([['P001'], ['P003', 'P003B']]);
    const p1 = items.find((i) => ids.get(i.stagedRefs[0] as string) === 'P001') as Item;
    expect(p1.proposal.basis).toBe('existingPatient');
    expect(p1.proposal.candidates.map((c) => c.patientRef)).toStrictEqual([existing]);
    expect(p1.proposal.automaticMerge).toBe(false);
    // P001 and P002 share a phone and a guarantor: no group contains both.
    expect(groups.some((g) => g.includes('P001') && g.includes('P002'))).toBe(false);
    const plan = h.ok<{ data: { counts: { entity: string; planned: number; blocked: number }[] } }>(
      await h.call('a1', 'GET', `/v1/migration/imports/plan?packageRef=${packageRef}`),
    ).data;
    expect(plan.counts.find((c) => c.entity === 'patients')).toMatchObject({ planned: 1, blocked: 3 });
  });

  it('records staff decisions; a link names only a proposed live candidate; nothing merges automatically', async () => {
    const items = await identityItems(packageRef);
    const ids = await staged(packageRef);
    const p1 = items.find((i) => i.stagedRefs.length === 1) as Item;
    const dup = items.find((i) => i.stagedRefs.length === 2) as Item;
    const other = h.ok<{ data: { patientRef: string } }>(
      await h.call('a1', 'POST', '/v1/patients', patientBody('Unrelated')),
      201,
    ).data.patientRef;
    const wrong = await resolve(packageRef, p1.itemRef, 'sameAsExisting', other);
    expect([wrong.statusCode, wrong.json().detail?.reason]).toStrictEqual([422, 'patient_not_candidate']);
    expect((await resolve(packageRef, p1.itemRef, 'sameAsExisting', existing, 'a4')).statusCode).toBe(403);
    h.ok(await resolve(packageRef, p1.itemRef, 'sameAsExisting', existing));
    h.ok(await resolve(packageRef, dup.itemRef, 'mergeAfterImport'));
    for (const i of h
      .ok<{ data: { itemRef: string; category: string }[] }>(
        await h.call('a1', 'GET', `/v1/migration/review-items?packageRef=${packageRef}&state=open`),
      )
      .data.filter((x) => x.category === 'terminology'))
      h.ok(await resolve(packageRef, i.itemRef, 'archiveOnly'));
    const patients = await count(db, 'patients');
    const merges = await count(db, 'patient_merges');
    await applyAll(packageRef);
    // P001 linked to the existing patient (not created); P002, P003 and P003B created.
    expect(await count(db, 'patients')).toBe(patients + 3);
    expect(await count(db, 'patient_merges')).toBe(merges);
    const link = (await provenance(existing)).find((p) => p.entity === 'patients');
    expect(link).toMatchObject({ sourceSystem: SOURCE_SYSTEM, sourceId: 'P001', action: 'linkPatient' });
    expect([...ids.values()]).toContain('P003B');
  });

  it('merges a decided group only through S6, keeping both source identifiers', async () => {
    const dup = (await identityItems(packageRef)).find((i) => i.stagedRefs.length === 2) as Item;
    const { rows } = await db.admin.query(
      `SELECT a.patient_id, a.source_id FROM cuspatlas.migration_applied_records a
       WHERE a.staged_record_id = ANY ($1::uuid[]) ORDER BY a.source_id`,
      [dup.stagedRefs],
    );
    const [survivor, merged] = rows.map((r) => r.patient_id as string) as [string, string];
    const review = h.ok<{ data: { candidateRef: string; confirmationToken: string }[] }>(
      await h.call('a1', 'GET', `/v1/patients/${survivor}/duplicate-candidates`),
    );
    const token = review.data.find((c) => c.candidateRef === merged)?.confirmationToken as string;
    const body = {
      packageRef,
      itemRef: dup.itemRef,
      survivorRef: survivor,
      mergedRef: merged,
      confirmationToken: token,
      reasonCode: 'duplicate_registration',
    };
    expect((await h.call('a4', 'POST', '/v1/migration/identity/merges', body)).statusCode).toBe(403);
    expect((await h.call('b1', 'POST', '/v1/migration/identity/merges', body)).statusCode).toBe(404);
    const p1Item = (await identityItems(packageRef)).find((i) => i.stagedRefs.length === 1) as Item;
    const notDecided = await h.call('a1', 'POST', '/v1/migration/identity/merges', {
      ...body,
      itemRef: p1Item.itemRef,
    });
    expect([notDecided.statusCode, notDecided.json().detail?.reason]).toStrictEqual([
      409,
      'merge_not_decided',
    ]);
    h.ok(await h.call('a1', 'POST', '/v1/migration/identity/merges', body), 201);
    const after = await db.admin.query('SELECT merged_into FROM cuspatlas.patients WHERE id = $1', [merged]);
    expect(after.rows[0].merged_into).toBe(survivor);
    expect(
      (await provenance(survivor))
        .filter((p) => p.entity === 'patients')
        .map((p) => p.sourceId)
        .sort(),
    ).toStrictEqual(['P003', 'P003B']);
  });

  it('the same source id in two source systems stays two patients with distinct provenance', async () => {
    const second = await profile('syn-second-pms');
    const tables = {
      patients:
        'patient_id,last_name,first_name,birth_date,phone,guarantor_id\nP001,Othersource,Quinn,1999-09-09,5550300001,G1\n',
    };
    const pkg2 = await stage(second, tables, 'syn-second-pms');
    expect(await identityItems(pkg2)).toStrictEqual([]);
    const before = await count(db, 'patients');
    await applyAll(pkg2);
    expect(await count(db, 'patients')).toBe(before + 1);
    const { rows } = await db.admin.query(
      `SELECT DISTINCT patient_id, source_system FROM cuspatlas.migration_applied_records WHERE source_id = 'P001' ORDER BY source_system`,
    );
    expect(rows.map((r) => r.source_system)).toStrictEqual(['syn-legacy-pms', 'syn-second-pms']);
    expect(new Set(rows.map((r) => r.patient_id)).size).toBe(2);
  });
});
