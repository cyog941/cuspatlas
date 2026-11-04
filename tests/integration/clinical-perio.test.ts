import { randomUUID } from 'node:crypto';
import {
  validatePerioComparison,
  validatePerioDerivationCommandResult,
  validatePerioExamCommandResult,
  validatePerioExamList,
  validatePerioExamRead,
} from '@cuspatlas/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  leakTables,
  mergePatients,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
  T_BETA,
} from './support/appointment-fixtures';
import { seedClinicalScopes, seedDispositions, seedPerioConfiguration } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';

/**
 * C7: periodontal exams as raw measurements (synthetic engineering implementation; C-D3
 * recommended-pending-clinical-approval; site scheme, bounds and grade scales C-S1-Q5 provisional).
 * Derived values come only from the configured formula registry, whose every entry is pending
 * approval; no derived value is presented as approved. No diagnosis, no decision support.
 */
let db: TestDatabase;
let h: AppointmentHarness;
const EXAMS = '/v1/clinical/perio/exams';
const LOC = 'loc-perio';
const SITES = ['db', 'b', 'mb', 'dl', 'l', 'ml'] as const;

beforeAll(async () => {
  db = await openTestDatabase('clinical_perio');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedClinicalScopes(db.admin);
  await seedDispositions(db.admin, T_ALPHA, ['completed_as_planned']);
  await seedPerioConfiguration(db.admin, T_ALPHA);
  await seedPerioConfiguration(db.admin, T_BETA);
  await seedLocation(h, LOC);
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

type Measurement = {
  measurementRef: string;
  tooth: { canonicalRef: string; universal: string | null };
  site: string | null;
  measure: string;
  status: string;
  mm: number | null;
  present: boolean | null;
  grade: string | null;
  current: boolean;
  supersedesRef: string | null;
  supersededByRef: string | null;
  reasonCode: string | null;
};
type Derivation = {
  derivationRef: string;
  formula: {
    formulaRef: string;
    version: number;
    approvalStatus: string;
    withdrawn: boolean;
    historical: boolean;
  };
  label: string;
  values: {
    tooth: { canonicalRef: string };
    site: string;
    status: string;
    value: number | null;
    missingInputs: string[];
  }[];
};
type Exam = {
  examRef: string;
  patientRef: string;
  sourcePatientRef: string;
  sequence: number;
  measurements: Measurement[];
  derivations: Derivation[];
};

const NM = 'not_measured' as const;
/** Compact per-tooth series in the scheme's site order (db, b, mb, dl, l, ml); the platform body limit is 16 KiB. */
function toothBody(
  code: string,
  pd = 3,
  opts: { site?: string; siteValue?: number | typeof NM; mobility?: unknown } = {},
) {
  return {
    tooth: { system: 'universal', code },
    mobility: opts.mobility ?? { grade: 'syn_0' },
    furcation: NM as unknown,
    probingDepth: SITES.map((s) => (opts.site === s && opts.siteValue !== undefined ? opts.siteValue : pd)),
    recession: SITES.map(() => 1 as number | typeof NM),
    bleeding: SITES.map(() => false as boolean | typeof NM),
  };
}
const fullArch = (pd = 3) => Array.from({ length: 32 }, (_, i) => toothBody(String(i + 1), pd));
const post = (body: Record<string, unknown>, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', EXAMS, body, key);
async function record(patientRef: string, teeth: unknown[], extra: Record<string, unknown> = {}) {
  const res = await post({ patientRef, siteScheme: 'six_site_provisional', teeth, ...extra });
  const json = h.ok<{ data: Exam; version: number; replayed: boolean }>(res, 201);
  expect(validatePerioExamCommandResult(json)).toBe(true);
  return json;
}
async function readExam(examRef: string) {
  const json = h.ok<{ data: Exam }>(await h.call('a1', 'GET', `${EXAMS}/${examRef}`));
  expect(validatePerioExamRead(json)).toBe(true);
  return json.data;
}
const derive = (examRef: string, formulaRef: string, formulaVersion: number) =>
  h.call('a1', 'POST', `${EXAMS}/${examRef}/derivations`, { formulaRef, formulaVersion });
const correct = (examRef: string, body: Record<string, unknown>, key = randomUUID()) =>
  h.call('a1', 'POST', `${EXAMS}/${examRef}/corrections`, body, key);
const find = (e: Exam, universal: string, site: string | null, measure: string, current = true) =>
  e.measurements.find(
    (m) =>
      m.tooth.universal === universal && m.site === site && m.measure === measure && m.current === current,
  ) as Measurement;
const measurementRows = async () =>
  (await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.clinical_perio_measurements')).rows[0]
    .n as number;

describe('C7 acceptance cases', () => {
  it('1. a full-arch six-site exam reads back every value; an unmeasured site stays not_measured and outside arithmetic', async () => {
    const p = await createPatient(h, 'Synthetic Perio One');
    const teeth = fullArch();
    teeth[2] = toothBody('3', 3, { site: 'mb', siteValue: NM });
    const r = await record(p, teeth, { examDate: '2026-10-01' });
    const e = r.data;
    // 32 teeth x (6 sites x 3 measures + mobility + furcation).
    expect(e.measurements).toHaveLength(32 * 20);
    expect(e.measurements.every((m) => m.current)).toBe(true);
    const unmeasured = find(e, '3', 'mb', 'probing_depth');
    expect([unmeasured.status, unmeasured.mm]).toStrictEqual(['not_measured', null]);
    expect(find(e, '3', 'db', 'probing_depth').mm).toBe(3);
    expect(find(e, '3', null, 'furcation').status).toBe('not_measured');
    const d = h.ok<{ data: Derivation }>(await derive(e.examRef, 'SYN-PERIO-SUM', 1), 201);
    expect(validatePerioDerivationCommandResult(d)).toBe(true);
    expect([d.data.label, d.data.formula.approvalStatus]).toStrictEqual([
      'derived_pending_clinical_approval',
      'pending',
    ]);
    const site = d.data.values.find((v) => v.tooth.canonicalRef === 'perm-ur-6' && v.site === 'mb');
    expect([site?.status, site?.value, site?.missingInputs]).toStrictEqual([
      'not_computable',
      null,
      ['probing_depth'],
    ]);
    const other = d.data.values.find((v) => v.tooth.canonicalRef === 'perm-ur-6' && v.site === 'db');
    expect([other?.status, other?.value]).toStrictEqual(['derived', 4]);
    expect(d.data.values).toHaveLength(32 * 6);
  });

  it('2. a correction supersedes one measurement; the read shows current and prior values with the reason', async () => {
    const p = await createPatient(h, 'Synthetic Perio Correct');
    const e = (await record(p, [toothBody('14'), toothBody('15')])).data;
    const target = find(e, '14', 'b', 'probing_depth');
    const fixed = h.ok<{ data: Exam }>(
      await correct(e.examRef, {
        reasonCode: 'transcription_error',
        corrections: [{ measurementRef: target.measurementRef, value: { status: 'measured', mm: 5 } }],
      }),
      201,
    ).data;
    const now = find(fixed, '14', 'b', 'probing_depth');
    const prior = find(fixed, '14', 'b', 'probing_depth', false);
    expect([now.mm, now.supersedesRef, now.reasonCode]).toStrictEqual([
      5,
      target.measurementRef,
      'transcription_error',
    ]);
    expect([prior.mm, prior.measurementRef, prior.supersededByRef]).toStrictEqual([
      3,
      target.measurementRef,
      now.measurementRef,
    ]);
    // The original row is byte-identical after the correction.
    const { rows } = await db.admin.query(
      'SELECT value_mm, status FROM cuspatlas.clinical_perio_measurements WHERE id = $1',
      [target.measurementRef],
    );
    expect(rows).toStrictEqual([{ value_mm: 3, status: 'measured' }]);
    const bad = await correct(e.examRef, {
      reasonCode: 'transcription_error',
      corrections: [
        {
          measurementRef: find(fixed, '14', 'b', 'bleeding').measurementRef,
          value: { status: 'measured', mm: 2 },
        },
      ],
    });
    expect([bad.statusCode, bad.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/corrections/0/value', rule: 'valueNotForMeasure' }] },
    ]);
  });

  it('3. two exams compare per site, listing unmeasured sites rather than counting them as improvement', async () => {
    const p = await createPatient(h, 'Synthetic Perio Compare');
    const base = (await record(p, [toothBody('3', 4), toothBody('4', 4)])).data;
    const target = (await record(p, [toothBody('3', 3, { site: 'b', siteValue: NM }), toothBody('5', 2)]))
      .data;
    const res = await h.call(
      'a1',
      'GET',
      `/v1/clinical/perio/comparisons?baseExamRef=${base.examRef}&targetExamRef=${target.examRef}`,
    );
    const c = h.ok<{
      data: {
        sites: {
          tooth: { universal: string };
          site: string;
          measure: string;
          base: number | null;
          target: number | null;
          delta: number | null;
          status: string;
        }[];
        formulaVersions: unknown[];
      };
    }>(res);
    expect(validatePerioComparison(c)).toBe(true);
    const at = (u: string, site: string) =>
      c.data.sites.find((s) => s.tooth.universal === u && s.site === site && s.measure === 'probing_depth');
    expect(at('3', 'db')).toMatchObject({ base: 4, target: 3, delta: -1, status: 'compared' });
    expect(at('3', 'b')).toMatchObject({
      base: 4,
      target: null,
      delta: null,
      status: 'not_measured_in_target',
    });
    expect(at('4', 'db')).toMatchObject({ base: 4, target: null, delta: null, status: 'absent_in_target' });
    expect(at('5', 'db')).toMatchObject({ base: null, target: 2, delta: null, status: 'absent_in_base' });
    expect(c.data.formulaVersions).toStrictEqual([]);
    // With a formula: derived deltas name the formula version of each exam.
    for (const e of [base, target]) h.ok(await derive(e.examRef, 'SYN-PERIO-SUM', 1), 201);
    const withF = h.ok<{
      data: {
        derived: { sites: { status: string; delta: number | null }[]; approvalStatus: string } | null;
        formulaVersions: { examRef: string; formulaRef: string; version: number }[];
      };
    }>(
      await h.call(
        'a1',
        'GET',
        `/v1/clinical/perio/comparisons?baseExamRef=${base.examRef}&targetExamRef=${target.examRef}&formulaRef=SYN-PERIO-SUM&formulaVersion=1`,
      ),
    );
    expect(withF.data.formulaVersions).toStrictEqual([
      { examRef: base.examRef, formulaRef: 'SYN-PERIO-SUM', version: 1 },
      { examRef: target.examRef, formulaRef: 'SYN-PERIO-SUM', version: 1 },
    ]);
    expect(withF.data.derived?.approvalStatus).toBe('pending');
    expect(
      withF.data.derived?.sites.some((s) => s.status === 'not_computable_in_target' && s.delta === null),
    ).toBe(true);
    const other = await createPatient(h, 'Synthetic Perio Compare Other');
    const foreignExam = (await record(other, [toothBody('3')])).data;
    const mismatch = await h.call(
      'a1',
      'GET',
      `/v1/clinical/perio/comparisons?baseExamRef=${base.examRef}&targetExamRef=${foreignExam.examRef}`,
    );
    expect([mismatch.statusCode, mismatch.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/targetExamRef', rule: 'examPatientMismatch' }] },
    ]);
  });

  it('4. a mobility or furcation grade outside the configured vocabulary is refused and nothing is stored', async () => {
    const p = await createPatient(h, 'Synthetic Perio Grade');
    const before = await measurementRows();
    const res = await post({
      patientRef: p,
      siteScheme: 'six_site_provisional',
      teeth: [toothBody('8', 3, { mobility: { grade: 'syn_9' } })],
    });
    expect([res.statusCode, res.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/teeth/0/mobility/grade', rule: 'notConfigured' }] },
    ]);
    const outOfBounds = await post({
      patientRef: p,
      siteScheme: 'six_site_provisional',
      teeth: [toothBody('8', 21)],
    });
    expect(outOfBounds.statusCode).toBe(400);
    expect(await measurementRows()).toBe(before);
  });

  it('5. another tenant’s patient is hidden; a tooth charted missing is refused unless charted otherwise first', async () => {
    const p = await createPatient(h, 'Synthetic Perio Five');
    const foreign = await post(
      { patientRef: p, siteScheme: 'six_site_provisional', teeth: [toothBody('3')] },
      'b1',
    );
    expect([foreign.statusCode, foreign.json().code]).toStrictEqual([404, 'not_found']);
    const missing = h.ok<{ data: { entry: { entryRef: string } } }>(
      await h.call('a1', 'POST', '/v1/clinical/chart/entries', {
        patientRef: p,
        provenance: 'recorded',
        tooth: { system: 'universal', code: '30' },
        kind: 'missing',
        findingRef: 'SYN-MISS-001',
      }),
      201,
    ).data.entry.entryRef;
    const refused = await post({
      patientRef: p,
      siteScheme: 'six_site_provisional',
      teeth: [toothBody('29'), toothBody('30')],
    });
    expect([refused.statusCode, refused.json().detail]).toStrictEqual([
      409,
      { reason: 'tooth_absent_on_chart', blockingRefs: [{ kind: 'chartEntry', ref: missing }] },
    ]);
    const sn = await post({
      patientRef: p,
      siteScheme: 'six_site_provisional',
      teeth: [{ ...toothBody('3'), tooth: { system: 'canonical', code: 'sn-ur-1' } }],
    });
    expect([sn.statusCode, sn.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/teeth/0/tooth', rule: 'siteSchemeNotForTooth' }] },
    ]);
    // The explicit chart workflow: an implant charted at the position makes the tooth measurable again.
    h.ok(
      await h.call('a1', 'POST', '/v1/clinical/chart/entries', {
        patientRef: p,
        provenance: 'recorded',
        tooth: { system: 'universal', code: '30' },
        kind: 'implant',
        findingRef: 'SYN-IMPL-001',
      }),
      201,
    );
    await record(p, [toothBody('30')]);
  });

  it('6. recomputing under a new formula version adds derived values and leaves the old ones with their version', async () => {
    const p = await createPatient(h, 'Synthetic Perio Formula');
    const e = (await record(p, [toothBody('19', 4)])).data;
    const v1 = h.ok<{ data: Derivation }>(await derive(e.examRef, 'SYN-PERIO-SUM', 1), 201).data;
    const v2 = h.ok<{ data: Derivation }>(await derive(e.examRef, 'SYN-PERIO-SUM', 2), 201).data;
    expect([v1.values[0]?.value, v2.values[0]?.value]).toStrictEqual([5, 4]);
    const read = await readExam(e.examRef);
    expect(
      read.derivations.map((d) => [d.derivationRef, d.formula.version, d.values[0]?.value]),
    ).toStrictEqual([
      [v1.derivationRef, 1, 5],
      [v2.derivationRef, 2, 4],
    ]);
    expect(read.derivations.every((d) => d.formula.approvalStatus === 'pending')).toBe(true);
    const unknown = await derive(e.examRef, 'SYN-PERIO-SUM', 7);
    expect([unknown.statusCode, unknown.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/formulaVersion', rule: 'notConfigured' }] },
    ]);
  });
});

describe('C7 failure and recovery cases', () => {
  it('1. a partially written exam is refused as a whole', async () => {
    const p = await createPatient(h, 'Synthetic Perio Partial');
    const before = await measurementRows();
    const partial = toothBody('12');
    partial.probingDepth = partial.probingDepth.slice(0, 5);
    const res = await post({
      patientRef: p,
      siteScheme: 'six_site_provisional',
      teeth: [toothBody('11'), partial],
    });
    expect([res.statusCode, res.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/teeth/1/probingDepth', rule: 'siteMissing' }] },
    ]);
    const dup = await post({
      patientRef: p,
      siteScheme: 'six_site_provisional',
      teeth: [toothBody('11'), toothBody('11')],
    });
    expect([dup.statusCode, dup.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/teeth/1/tooth', rule: 'duplicateTooth' }] },
    ]);
    expect(await measurementRows()).toBe(before);
    const exams = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.clinical_perio_exams x JOIN cuspatlas.clinical_perio_streams s
         ON s.id = x.stream_id WHERE s.subject_patient_id = $1`,
      [p],
    );
    expect(exams.rows[0].n).toBe(0);
  });

  it('2. two concurrent corrections of one measurement keep one successor and one typed conflict', async () => {
    const p = await createPatient(h, 'Synthetic Perio Race');
    const e = (await record(p, [toothBody('2')])).data;
    const m = find(e, '2', 'l', 'recession');
    const results = await Promise.all(
      [2, 3].map((n) =>
        correct(e.examRef, {
          reasonCode: 'transcription_error',
          corrections: [{ measurementRef: m.measurementRef, value: { status: 'measured', mm: n } }],
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toStrictEqual([201, 409]);
    const winner = find(
      ((results.find((r) => r.statusCode === 201) as (typeof results)[number]).json() as { data: Exam }).data,
      '2',
      'l',
      'recession',
    );
    expect(results.find((r) => r.statusCode === 409)?.json().detail).toStrictEqual({
      reason: 'measurement_superseded',
      blockingRefs: [{ kind: 'perioMeasurement', ref: winner.measurementRef }],
    });
  });

  it('3. a merged patient’s exams stay distinct with their source patient', async () => {
    const survivor = await createPatient(h, 'Synthetic Merge Perio');
    const merged = await createPatient(h, 'Synthetic Merge Perio');
    const a = (await record(survivor, [toothBody('3')])).data;
    const b = (await record(merged, [toothBody('3')])).data;
    const rows = async () =>
      (
        await db.admin.query(
          'SELECT json_agg(m ORDER BY m.id) AS m FROM cuspatlas.clinical_perio_measurements m',
        )
      ).rows[0];
    const before = await rows();
    const mergeRef = await mergePatients(h, survivor, merged);
    expect(await rows()).toStrictEqual(before);
    const list = h.ok<{
      data: { examRef: string; sourcePatientRef: string; patientRef: string; sequence: number }[];
    }>(await h.call('a1', 'GET', `/v1/clinical/patients/${survivor}/perio-exams`));
    expect(validatePerioExamList(list)).toBe(true);
    expect(
      list.data.map((x) => [x.examRef, x.sourcePatientRef, x.patientRef, x.sequence]).sort(),
    ).toStrictEqual(
      [
        [a.examRef, survivor, survivor, 1],
        [b.examRef, merged, survivor, 1],
      ].sort(),
    );
    const moves = await db.admin.query(
      `SELECT content_digest_before = content_digest_after AS same FROM cuspatlas.patient_merge_moves
       WHERE merge_id = $1 AND record_class = 'clinicalPerioStream'`,
      [mergeRef],
    );
    expect(moves.rows).toStrictEqual([{ same: true }]);
    const redirected = await h.call('a1', 'GET', `/v1/clinical/patients/${merged}/perio-exams`);
    expect([redirected.statusCode, redirected.json().detail?.reason]).toStrictEqual([409, 'patient_merged']);
    // S-D2: a perio exam on the survivor after the merge makes unmerge need the review.
    await record(survivor, [toothBody('4')]);
    const unmerge = await h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, {
      reasonCode: 'merged_in_error',
    });
    expect([unmerge.statusCode, unmerge.json().detail]).toStrictEqual([
      422,
      { reason: 'reconciliation_review_required' },
    ]);
  });

  it('4. a formula withdrawn after use leaves past derived values readable and flagged historical', async () => {
    const p = await createPatient(h, 'Synthetic Perio Withdrawn');
    const e = (await record(p, [toothBody('20', 2)])).data;
    const d = h.ok<{ data: Derivation }>(await derive(e.examRef, 'SYN-PERIO-OLD', 1), 201).data;
    await db.admin.query(
      `UPDATE cuspatlas.clinical_perio_formulas SET withdrawn_at = now() WHERE tenant_id = $1 AND formula_ref = 'SYN-PERIO-OLD'`,
      [T_ALPHA],
    );
    const read = await readExam(e.examRef);
    const old = read.derivations.find((x) => x.derivationRef === d.derivationRef);
    expect([old?.formula.withdrawn, old?.formula.historical, old?.values[0]?.value]).toStrictEqual([
      true,
      true,
      3,
    ]);
    const again = await derive(e.examRef, 'SYN-PERIO-OLD', 1);
    expect([again.statusCode, again.json().detail?.reason]).toStrictEqual([409, 'formula_withdrawn']);
  });
});

describe('C7 storage, encounter seam, authorship, privacy and parity', () => {
  it('the runtime role cannot rewrite measurements, derived values or the formula registry', async () => {
    const p = await createPatient(h, 'Synthetic Perio Append');
    const e = (await record(p, [toothBody('6')])).data;
    h.ok(await derive(e.examRef, 'SYN-PERIO-SUM', 1), 201);
    for (const sql of [
      'UPDATE cuspatlas.clinical_perio_measurements SET value_mm = 0',
      'DELETE FROM cuspatlas.clinical_perio_measurements',
      `UPDATE cuspatlas.clinical_perio_exams SET site_scheme = 'six_site_provisional'`,
      'UPDATE cuspatlas.clinical_perio_derived_values SET value = 0',
      'DELETE FROM cuspatlas.clinical_perio_derivations',
      `UPDATE cuspatlas.clinical_perio_formulas SET approval_status = 'approved'`,
      `INSERT INTO cuspatlas.clinical_perio_formulas (tenant_id, formula_ref, version, operation, inputs)
       VALUES ('${T_ALPHA}', 'SYN-SELF', 1, 'sum', ARRAY['probing_depth'])`,
      `INSERT INTO cuspatlas.clinical_perio_grade_vocabulary (tenant_id, measure, grade_code) VALUES ('${T_ALPHA}', 'mobility', 'syn_9')`,
    ]) {
      const client = await db.app.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
        const code = await client.query(sql).then(
          () => 'ok',
          (err) => err.code,
        );
        expect([sql, code]).toStrictEqual([sql, '42501']);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.clinical_perio_formulas WHERE approval_status <> 'pending'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('a closed encounter refuses an exam; a member without write scope or a service principal cannot record', async () => {
    const p = await createPatient(h, 'Synthetic Perio Closed');
    const e = h.ok<{ data: { encounter: { encounterRef: string; version: number } } }>(
      await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef: p, locationRef: LOC }),
      201,
    ).data.encounter;
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/encounters/${e.encounterRef}/close`, {
        expectedVersion: e.version,
        dispositionCode: 'completed_as_planned',
      }),
    );
    const body = { patientRef: p, siteScheme: 'six_site_provisional', teeth: [toothBody('3')] };
    const closed = await post({ ...body, encounterRef: e.encounterRef });
    expect([
      closed.statusCode,
      closed.json().detail?.reason,
      closed.json().detail?.alternative,
    ]).toStrictEqual([409, 'encounter_closed', 'clinical.encounters.open']);
    expect((await post(body, 'a4')).statusCode).toBe(403);
    expect((await post(body, 'svcA1')).statusCode).toBe(403);
  });

  it('the marker in a reason or tooth input never leaks; reads are sensitive reads', async () => {
    const p = await createPatient(h, 'Synthetic Perio Marker');
    const e = (await record(p, [toothBody('9')])).data;
    await correct(e.examRef, {
      reasonCode: 'transcription_error',
      corrections: [
        {
          measurementRef: find(e, '9', 'b', 'probing_depth').measurementRef,
          value: { status: 'measured', mm: 4 },
        },
      ],
    });
    await post({
      patientRef: p,
      siteScheme: 'six_site_provisional',
      teeth: [{ ...toothBody('9'), tooth: { system: 'universal', code: MARKER } }],
    });
    await readExam(e.examRef);
    const reads = (
      await db.admin.query(
        `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.sensitive_read_events t`,
      )
    ).rows[0].j as string;
    expect(`${await leakTables(db)}${reads}${h.logLines.join('\n')}`).not.toContain(MARKER);
    const logged = await db.admin.query(
      `SELECT DISTINCT operation FROM cuspatlas.sensitive_read_events WHERE operation LIKE 'clinical.perio.%' ORDER BY 1`,
    );
    expect(logged.rows.map((r) => r.operation)).toEqual(expect.arrayContaining(['clinical.perio.readExam']));
  });

  it('MCP records replay a REST key; reads and refusals match across surfaces', async () => {
    const p = await createPatient(h, 'Synthetic Perio Parity');
    const key = randomUUID();
    const body = { patientRef: p, siteScheme: 'six_site_provisional', teeth: [toothBody('7')] };
    const rest = h.ok<{ data: Exam }>(await post(body, 'a1', key), 201);
    const viaMcp = await h.mcp('a1', 'clinical_perio_record_exam', { ...body, idempotencyKey: key }, 201);
    expect([viaMcp.code, (viaMcp.body as { replayed: boolean }).replayed]).toStrictEqual([null, true]);
    expect((viaMcp.body as { data: Exam }).data.examRef).toBe(rest.data.examRef);
    const mcpRead = await h.mcp('a1', 'clinical_perio_get_exam', { perioExamRef: rest.data.examRef });
    expect((mcpRead.body as { data: Exam }).data).toStrictEqual(await readExam(rest.data.examRef));
    const foreign = await h.mcp('b1', 'clinical_perio_get_exam', { perioExamRef: rest.data.examRef });
    expect([foreign.status, foreign.code]).toStrictEqual([404, 'not_found']);
  });
});
