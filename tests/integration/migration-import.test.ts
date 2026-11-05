import { randomUUID } from 'node:crypto';
import type { ActorContext, CommandEnvelope } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  createAuthorize,
  createMigrationService,
  createPatientService,
  executeOnce,
  type PatientService,
  SYNTHETIC_TEST_MATCH_KEY_PEPPER,
} from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppointmentHarness, count, openAppointmentHarness } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { actorFor, envelope } from './support/domain-harness';
import { T_ALPHA, USER_A1 } from './support/fixtures';
import {
  intakeBody,
  legacyPackage,
  legacyTables,
  PRACTICE,
  SOURCE_SYSTEM,
  seedMigrationScopes,
} from './support/migration-fixtures';

/**
 * M3: dry run, plan-digest pinning and idempotent, resumable staged application against the
 * FABRICATED synthetic legacy format. Patients are created only through S4 `createPatient`;
 * appointments and procedures become archive references (never bookings, attendance or clinical
 * facts). Synthetic only; rules recommended-pending-approval.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let profileRef: string;

interface Plan {
  packageRef: string;
  planDigest: string;
  counts: {
    entity: string;
    staged: number;
    planned: number;
    applied: number;
    excluded: number;
    blocked: number;
  }[];
  exceptions: { code: string; entity: string; stagedRef: string; requiredAction: string }[];
}
interface ApplyResult {
  appliedThisBatch: number;
  alreadyApplied: number;
  remaining: number;
  blocked: number;
  state: 'partial' | 'complete';
}

const plan = async (packageRef: string, who = 'a1') =>
  h.ok<{ data: Plan }>(await h.call(who, 'GET', `/v1/migration/imports/plan?packageRef=${packageRef}`)).data;
const apply = (packageRef: string, expectedPlanDigest: string, batchSize = 50, who = 'a1') =>
  h.call(who, 'POST', '/v1/migration/imports/apply', { packageRef, expectedPlanDigest, batchSize });
const applied = async (packageRef: string, digest: string, batchSize = 50) =>
  h.ok<{ data: ApplyResult }>(await apply(packageRef, digest, batchSize)).data;
const counts = (p: Plan, entity: string) => p.counts.find((c) => c.entity === entity);
const stageNew = async (tables: Record<string, string>, sourceProfile = profileRef) =>
  h.ok<{ data: { packageRef: string } }>(
    await h.call('a1', 'POST', '/v1/migration/packages', intakeBody(sourceProfile, legacyPackage(tables))),
    201,
  ).data.packageRef;
const items = async (packageRef: string) =>
  h.ok<{ data: { itemRef: string; category: string; subjectKey: string }[] }>(
    await h.call('a1', 'GET', `/v1/migration/review-items?packageRef=${packageRef}&state=open`),
  ).data;
const resolve = async (packageRef: string, itemRef: string, decision: string) =>
  h.ok(
    await h.call('a1', 'POST', '/v1/migration/review-items/resolve', {
      packageRef,
      itemRef,
      decision,
      reasonCode: 'reviewed',
    }),
  );

/** Row counts of every application table (superuser read), to prove a dry run writes nothing. */
async function tableCounts(): Promise<Record<string, number>> {
  const { rows } = await db.admin.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'cuspatlas' AND c.relkind = 'r' ORDER BY 1`,
  );
  const out: Record<string, number> = {};
  for (const r of rows)
    out[r.relname] = (
      await db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${r.relname}`)
    ).rows[0].n;
  return out;
}

beforeAll(async () => {
  db = await openTestDatabase('migration_import');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedMigrationScopes(db.admin);
  profileRef = h.ok<{ data: { profileRef: string } }>(
    await h.call('a1', 'POST', '/v1/migration/source-profiles', {
      sourceSystem: SOURCE_SYSTEM,
      format: 'cuspatlas-synthetic-legacy/1',
      practiceRef: PRACTICE,
    }),
    201,
  ).data.profileRef;
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('M3 dry run and staged application', () => {
  let packageRef: string;
  let first: Plan;

  it('a dry run returns the full plan with counts and exceptions and writes nothing', async () => {
    packageRef = await stageNew(legacyTables({ futureAppointment: true }));
    const before = await tableCounts();
    first = await plan(packageRef);
    const viaMcp = await h.mcp('a4', 'migration_imports_plan', { packageRef });
    expect(await tableCounts()).toStrictEqual(before);
    expect((viaMcp.body as { data: Plan }).data).toStrictEqual(first);
    expect(first.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(counts(first, 'patients')).toMatchObject({ staged: 3, planned: 3, applied: 0, blocked: 0 });
    expect(counts(first, 'appointments')).toMatchObject({ staged: 3, planned: 2, blocked: 1 });
    // Legacy codes are unreviewed terminology: blocked, never mapped to a clinical code.
    expect(counts(first, 'procedures')).toMatchObject({ staged: 3, planned: 0, blocked: 3 });
    expect(first.exceptions.filter((e) => e.code === 'review_open').length).toBeGreaterThanOrEqual(4);
    expect(await plan(packageRef)).toStrictEqual(first);
  });

  it('refuses a stale plan digest, a cross-tenant package and a member without the scope', async () => {
    const before = await count(db, 'patients');
    const stale = await apply(packageRef, 'f'.repeat(64));
    expect([stale.statusCode, stale.json().detail?.reason]).toStrictEqual([409, 'plan_digest_changed']);
    expect((await apply(packageRef, first.planDigest, 50, 'b1')).statusCode).toBe(404);
    expect((await apply(packageRef, first.planDigest, 50, 'a4')).statusCode).toBe(403);
    expect(
      (await h.call('a5', 'GET', `/v1/migration/imports/plan?packageRef=${packageRef}`)).statusCode,
    ).toBe(403);
    expect(await count(db, 'patients')).toBe(before);
  });

  it('applies in bounded batches, resumably, and a re-run applies nothing twice', async () => {
    const patientsBefore = await count(db, 'patients');
    const b1 = await applied(packageRef, first.planDigest, 2);
    expect(b1).toMatchObject({ appliedThisBatch: 2, state: 'partial' });
    expect(await count(db, 'patients')).toBe(patientsBefore + 2);
    const b2 = await applied(packageRef, first.planDigest, 50);
    expect(b2).toMatchObject({ appliedThisBatch: 8, alreadyApplied: 2, remaining: 0, state: 'partial' });
    expect(b2.blocked).toBeGreaterThan(0);
    const again = await applied(packageRef, first.planDigest, 50);
    expect(again).toMatchObject({ appliedThisBatch: 0, alreadyApplied: 10, remaining: 0 });
    expect(await count(db, 'patients')).toBe(patientsBefore + 3);
    // No booking, attendance or clinical fact was fabricated from legacy history.
    for (const t of [
      'appointments',
      'appointment_attendance_transitions',
      'clinical_rendered_procedures',
      'clinical_encounters',
    ])
      expect([t, await count(db, t)]).toStrictEqual([t, 0]);
  });

  it('every applied record carries its source id, time precision and provenance', async () => {
    const { rows } = await db.admin.query(
      `SELECT a.action, a.source_id, a.time_precision, a.provenance, a.patient_id, a.staged_record_id, s.entity
       FROM cuspatlas.migration_applied_records a JOIN cuspatlas.migration_staged_records s ON s.id = a.staged_record_id
       WHERE a.package_id = $1 AND s.entity IN ('patients', 'appointments') ORDER BY s.entity, a.source_id`,
      [packageRef],
    );
    expect(rows.map((r) => [r.entity, r.source_id, r.action, r.time_precision])).toStrictEqual([
      ['appointments', 'A001', 'historicalReference', 'minute'],
      ['appointments', 'A002', 'historicalReference', 'minute'],
      ['patients', 'P001', 'createPatient', 'none'],
      ['patients', 'P002', 'createPatient', 'none'],
      ['patients', 'P003', 'createPatient', 'none'],
    ]);
    for (const r of rows)
      expect(r.provenance).toMatchObject({
        sourceSystem: SOURCE_SYSTEM,
        adapter: 'cuspatlas-synthetic-legacy/1@1',
      });
    // The S4 record carries the prior-system identifier and migration provenance; month precision kept.
    const p3 = rows.find((r) => r.source_id === 'P003');
    const patient = h.ok<{ data: Record<string, unknown> }>(
      await h.call('a1', 'GET', `/v1/patients/${p3.patient_id}`),
    ).data;
    expect(patient.identifiers).toStrictEqual([
      { type: 'prior_system', issuer: SOURCE_SYSTEM, value: 'P003' },
      { type: 'external_record', issuer: 'cuspatlas-migration', value: p3.staged_record_id },
    ]);
    expect(patient.birthDate).toStrictEqual({ known: true, value: '1975-11', precision: 'month' });
    expect((patient.provenance as Record<string, string>).legalName).toBe('migration_import');
    const appt = rows.find((r) => r.source_id === 'A001');
    expect(appt.patient_id).toBe(rows.find((r) => r.source_id === 'P001').patient_id);
  });

  it('a review decision changes the plan digest; the new plan applies the reviewed rows', async () => {
    for (const i of await items(packageRef)) {
      if (i.category === 'terminology') await resolve(packageRef, i.itemRef, 'archiveOnly');
      if (i.category === 'future_appointment') await resolve(packageRef, i.itemRef, 'exclude');
    }
    const stale = await apply(packageRef, first.planDigest);
    expect([stale.statusCode, stale.json().detail?.reason]).toStrictEqual([409, 'plan_digest_changed']);
    const next = await plan(packageRef);
    expect(next.planDigest).not.toBe(first.planDigest);
    expect(counts(next, 'procedures')).toMatchObject({ planned: 3, blocked: 0 });
    expect(counts(next, 'appointments')).toMatchObject({ planned: 2, excluded: 1, blocked: 0 });
    const r = await applied(packageRef, next.planDigest);
    expect(r.appliedThisBatch).toBe(3);
    const { rows } = await db.admin.query(
      `SELECT a.time_precision, a.detail FROM cuspatlas.migration_applied_records a
       JOIN cuspatlas.migration_staged_records s ON s.id = a.staged_record_id
       WHERE a.package_id = $1 AND s.entity = 'procedures' ORDER BY s.row_no`,
      [packageRef],
    );
    expect(rows.map((x) => [x.time_precision, x.detail.legacyCode])).toStrictEqual([
      ['day', 'L-PROPHY'],
      ['day', 'L-EXAM'],
      ['day', 'L-PROPHY'],
    ]);
    // Applied rows are permanent provenance facts.
    await expect(db.app.query('DELETE FROM cuspatlas.migration_applied_records')).rejects.toThrow();
  });
});

describe('M3 crash recovery', () => {
  it('a crash after S4 created a patient resumes without creating it twice', async () => {
    const packageRef = await stageNew({
      patients: `patient_id,last_name,first_name,birth_date,phone,guarantor_id
Q001,Resumed,Harper,1961-01-05,5550200001,G9
Q002,Resumed,Indigo,1962-02-06,5550200002,G9
Q003,Resumed,Jordan,1963-03-07,5550200003,G9
`,
    });
    const membership = createMembershipSource(db.app);
    const authorize = createAuthorize(membership);
    const withTenantTransaction = createTenantTransactionRunner(db.app);
    const recording = { sink: createSecurityAttemptSink(db.sink), alert: () => undefined };
    const real = createPatientService({
      authorize,
      withTenantTransaction,
      recording,
      execute: executeOnce,
      matchKeyPepper: SYNTHETIC_TEST_MATCH_KEY_PEPPER,
    });
    let crashes = 1;
    const crashing = {
      ...real,
      async createPatient(ctx: ActorContext, env: CommandEnvelope<unknown>) {
        const r = await real.createPatient(ctx, env);
        if (crashes > 0) {
          crashes -= 1;
          throw new Error('simulated worker crash after the S4 commit');
        }
        return r;
      },
    } as PatientService;
    const deps = {
      authorize,
      withTenantTransaction,
      recording,
      matchKeyPepper: SYNTHETIC_TEST_MATCH_KEY_PEPPER,
    };
    const ctx = await actorFor(db, USER_A1, T_ALPHA);
    const p = await createMigrationService({ ...deps, patients: crashing }).planImport(ctx, { packageRef });
    const before = await count(db, 'patients');
    await expect(
      createMigrationService({ ...deps, patients: crashing }).applyImport(
        ctx,
        envelope('migration.imports.apply', { packageRef, expectedPlanDigest: p.planDigest, batchSize: 10 }),
      ),
    ).rejects.toThrow('simulated worker crash');
    expect(await count(db, 'patients')).toBe(before + 1);
    // Idempotency rows expire; resumption must not rely on them: clear them to prove it.
    await db.admin.query(`DELETE FROM cuspatlas.command_idempotency WHERE operation = 'patients.create'`);
    const r = await createMigrationService({ ...deps, patients: real }).applyImport(
      ctx,
      envelope(
        'migration.imports.apply',
        { packageRef, expectedPlanDigest: p.planDigest, batchSize: 10 },
        randomUUID(),
      ),
    );
    expect(r.data).toMatchObject({ appliedThisBatch: 3, remaining: 0 });
    expect(await count(db, 'patients')).toBe(before + 3);
  });
});
