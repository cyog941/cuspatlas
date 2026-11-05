import { randomUUID } from 'node:crypto';
import { validateChartEntryCommandResult, validateChartRead } from '@cuspatlas/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  leakTables,
  mergePatients,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
} from './support/appointment-fixtures';
import { seedClinicalScopes, seedDispositions } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { dbNow } from './support/db-clock';
import { MARKER } from './support/marker';

/**
 * C6: structured chart entries per canonical tooth identity (synthetic engineering implementation;
 * C-D1/C-D2 recommended-pending-clinical-approval; surface values C-S1-Q2 provisional). Every
 * denial runs under the runtime role. No diagnosis, no decision support.
 */
let db: TestDatabase;
let h: AppointmentHarness;
const ENTRIES = '/v1/clinical/chart/entries';
const LOC = 'loc-chart';

beforeAll(async () => {
  db = await openTestDatabase('clinical_chart');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedClinicalScopes(db.admin);
  await seedDispositions(db.admin, T_ALPHA, ['completed_as_planned']);
  await seedLocation(h, LOC);
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

type Tooth = {
  canonicalRef: string;
  dentition: string;
  displaySystem: string;
  display: string | null;
  universal: string | null;
  fdi: string | null;
};
type Entry = {
  entryRef: string;
  chartRef: string;
  patientRef: string;
  sourcePatientRef: string;
  tooth: Tooth | null;
  surfaces: string[] | null;
  kind: string;
  findingRef: string;
  state: string;
  recordedState: string;
  detailText: string | null;
  provenance: string;
  sourceRef: string | null;
  encounterRef: string | null;
  recordedBy: { actorRef: string; role: string };
  clinicalAuthor: { actorRef: string; role: string } | null;
  recordedAt: string;
  supersedesEntryRef: string | null;
  supersededByEntryRef: string | null;
  correctionReasonCode: string | null;
  toothVocabulary: string | null;
};
type Chart = {
  patientRef: string;
  asOf: string;
  displaySystem: string;
  recorded: boolean;
  charts: { chartRef: string; sourcePatientRef: string; version: number }[];
  entries: Entry[];
  teeth: { tooth: Tooth; status: string; activeEntryRefs: string[] }[];
};

const tooth = (code: string, system = 'universal') => ({ system, code });
const post = (body: Record<string, unknown>, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', ENTRIES, body, key);
async function record(body: Record<string, unknown>) {
  const res = await post({ provenance: 'recorded', ...body });
  const json = h.ok<{ data: { outcome: string; entry: Entry }; version: number; replayed: boolean }>(
    res,
    201,
  );
  expect(validateChartEntryCommandResult(json)).toBe(true);
  return json;
}
const correct = (entryRef: string, body: Record<string, unknown>, key = randomUUID()) =>
  h.call('a1', 'POST', `${ENTRIES}/${entryRef}/corrections`, body, key);
async function chart(patientRef: string, query = '', who = 'a1') {
  const res = await h.call(who, 'GET', `/v1/clinical/patients/${patientRef}/chart${query}`);
  const json = h.ok<{ data: Chart }>(res);
  expect(validateChartRead(json)).toBe(true);
  return json.data;
}
async function encounter(patientRef: string): Promise<{ encounterRef: string; version: number }> {
  const r = h.ok<{ data: { encounter: { encounterRef: string; version: number } } }>(
    await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef, locationRef: LOC }),
    201,
  );
  return r.data.encounter;
}
const pause = () => new Promise((r) => setTimeout(r, 5));

describe('C6 acceptance cases', () => {
  it('1. a surface finding reads back with its surfaces; a correction keeps the first as superseded', async () => {
    const p = await createPatient(h, 'Synthetic Chart One');
    const e = await encounter(p);
    const first = await record({
      patientRef: p,
      encounterRef: e.encounterRef,
      tooth: tooth('3'),
      surfaces: ['O', 'M'],
      kind: 'condition',
      findingRef: 'SYN-COND-001',
    });
    expect(first.data.outcome).toBe('recorded');
    const a = first.data.entry;
    expect([a.surfaces, a.tooth?.canonicalRef, a.tooth?.universal, a.tooth?.fdi]).toStrictEqual([
      ['M', 'O'],
      'perm-ur-6',
      '3',
      '16',
    ]);
    expect([a.state, a.recordedBy.role, a.clinicalAuthor?.role, a.toothVocabulary]).toStrictEqual([
      'active',
      'dentist',
      'dentist',
      'cuspatlas-tooth.v1',
    ]);
    const t1 = a.recordedAt;
    await pause();
    const fixed = h.ok<{ data: Entry }>(
      await correct(a.entryRef, { reasonCode: 'wrong_surface', surfaces: ['O', 'D'], state: 'active' }),
      201,
    ).data;
    expect([
      fixed.supersedesEntryRef,
      fixed.surfaces,
      fixed.findingRef,
      fixed.correctionReasonCode,
    ]).toStrictEqual([a.entryRef, ['D', 'O'], 'SYN-COND-001', 'wrong_surface']);
    const now = await chart(p);
    const prior = now.entries.find((x) => x.entryRef === a.entryRef);
    expect([prior?.state, prior?.supersededByEntryRef, prior?.surfaces]).toStrictEqual([
      'superseded',
      fixed.entryRef,
      ['M', 'O'],
    ]);
    expect(now.teeth).toStrictEqual([
      { tooth: fixed.tooth, status: 'present', activeEntryRefs: [fixed.entryRef] },
    ]);
    // As-of the first instant: only the first entry, still active.
    const then = await chart(p, `?asOf=${encodeURIComponent(t1)}`);
    expect(then.entries.map((x) => [x.entryRef, x.state])).toStrictEqual([[a.entryRef, 'active']]);
    // FDI display preference projects the same canonical identity.
    const fdi = await chart(p, '?displaySystem=fdi');
    expect(fdi.entries.map((x) => [x.tooth?.display, x.tooth?.canonicalRef])).toStrictEqual([
      ['16', 'perm-ur-6'],
      ['16', 'perm-ur-6'],
    ]);
  });

  it('2. a primary and a permanent tooth in one position are distinct identities in a mixed dentition', async () => {
    const p = await createPatient(h, 'Synthetic Chart Mixed');
    const primary = await record({
      patientRef: p,
      tooth: tooth('K'),
      kind: 'condition',
      findingRef: 'SYN-COND-002',
    });
    const permanent = await record({
      patientRef: p,
      tooth: tooth('35', 'fdi'),
      kind: 'condition',
      findingRef: 'SYN-COND-002',
    });
    expect(primary.data.outcome).toBe('recorded');
    expect(permanent.data.outcome).toBe('recorded');
    expect([primary.data.entry.tooth?.canonicalRef, permanent.data.entry.tooth?.canonicalRef]).toStrictEqual([
      'prim-ll-5',
      'perm-ll-5',
    ]);
    expect([permanent.data.entry.tooth?.universal, primary.data.entry.tooth?.fdi]).toStrictEqual([
      '20',
      '75',
    ]);
    const all = await chart(p);
    expect(all.teeth.map((t) => t.tooth.canonicalRef).sort()).toStrictEqual(['perm-ll-5', 'prim-ll-5']);
    const onlyPrimary = await chart(p, '?dentition=primary');
    expect(onlyPrimary.entries.map((x) => x.tooth?.canonicalRef)).toStrictEqual(['prim-ll-5']);
  });

  it('3. conversion round-trips for supported anatomy and refuses an unsupported case explicitly', async () => {
    const p = await createPatient(h, 'Synthetic Chart Convert');
    const sn = await record({
      patientRef: p,
      tooth: tooth('sn-ur-1', 'canonical'),
      kind: 'supernumerary',
      findingRef: 'SYN-SUPER-001',
    });
    // No numbering counterpart: the projection is null and says why, never a neighbouring tooth.
    expect(sn.data.entry.tooth).toStrictEqual({
      canonicalRef: 'sn-ur-1',
      dentition: 'supernumerary',
      displaySystem: 'universal',
      display: null,
      universal: null,
      fdi: null,
    });
    const unknown = await post({
      patientRef: p,
      provenance: 'recorded',
      tooth: tooth('33'),
      kind: 'condition',
      findingRef: 'SYN-C',
    });
    expect([unknown.statusCode, unknown.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/tooth/code', rule: 'unknownToothCode' }] },
    ]);
    const notSuper = await post({
      patientRef: p,
      provenance: 'recorded',
      tooth: tooth('4'),
      kind: 'supernumerary',
      findingRef: 'SYN-SUPER-001',
    });
    expect([notSuper.statusCode, notSuper.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/tooth', rule: 'supernumeraryNeedsSupernumeraryTooth' }] },
    ]);
  });

  it('4. a finding naming another patient’s encounter or another tenant’s patient is refused', async () => {
    const p = await createPatient(h, 'Synthetic Chart Four');
    const other = await createPatient(h, 'Synthetic Chart Four Other');
    const e = await encounter(other);
    const mismatch = await post({
      patientRef: p,
      provenance: 'recorded',
      encounterRef: e.encounterRef,
      tooth: tooth('14'),
      kind: 'condition',
      findingRef: 'SYN-COND-004',
    });
    expect([mismatch.statusCode, mismatch.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/encounterRef', rule: 'encounterPatientMismatch' }] },
    ]);
    const before = await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.clinical_chart_entries');
    const foreign = await post(
      {
        patientRef: p,
        provenance: 'recorded',
        tooth: tooth('14'),
        kind: 'condition',
        findingRef: 'SYN-COND-004',
      },
      'b1',
    );
    expect([foreign.statusCode, foreign.json().code]).toStrictEqual([404, 'not_found']);
    const read = await h.call('b1', 'GET', `/v1/clinical/patients/${p}/chart`);
    expect(read.statusCode).toBe(404);
    const ok = await record({
      patientRef: p,
      tooth: tooth('14'),
      kind: 'condition',
      findingRef: 'SYN-COND-004',
    });
    const foreignCorrect = await h.call('b1', 'POST', `${ENTRIES}/${ok.data.entry.entryRef}/corrections`, {
      reasonCode: 'wrong_tooth',
      state: 'active',
    });
    expect([foreignCorrect.statusCode, foreignCorrect.json().code]).toStrictEqual([404, 'not_found']);
    const after = await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.clinical_chart_entries');
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('5. an imported finding shows imported provenance, no clinical author, and is excluded by a provenance filter', async () => {
    const p = await createPatient(h, 'Synthetic Chart Imported');
    const needsSource = await post({
      patientRef: p,
      provenance: 'imported',
      tooth: tooth('30'),
      kind: 'existing_restoration',
      surfaces: ['O'],
      findingRef: 'SYN-REST-001',
    });
    expect([needsSource.statusCode, needsSource.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/sourceRef', rule: 'required' }] },
    ]);
    const imported = await record({
      patientRef: p,
      provenance: 'imported',
      sourceRef: 'synthetic-import-batch-1',
      tooth: tooth('30'),
      kind: 'existing_restoration',
      surfaces: ['O'],
      findingRef: 'SYN-REST-001',
    });
    expect([
      imported.data.entry.provenance,
      imported.data.entry.clinicalAuthor,
      imported.data.entry.sourceRef,
    ]).toStrictEqual(['imported', null, 'synthetic-import-batch-1']);
    expect(imported.data.entry.recordedBy.role).toBe('dentist');
    const fresh = await record({
      patientRef: p,
      tooth: tooth('19'),
      kind: 'condition',
      findingRef: 'SYN-COND-005',
    });
    const recordedOnly = await chart(p, '?provenance=recorded');
    expect(recordedOnly.entries.map((x) => x.entryRef)).toStrictEqual([fresh.data.entry.entryRef]);
    const importedOnly = await chart(p, '?provenance=imported');
    expect(importedOnly.entries.map((x) => x.entryRef)).toStrictEqual([imported.data.entry.entryRef]);
  });

  it('6. a surface finding on a tooth type without such surfaces is refused with the reason', async () => {
    const p = await createPatient(h, 'Synthetic Chart Six');
    const cases: [Record<string, unknown>, string, string][] = [
      [{ tooth: tooth('8'), surfaces: ['O'] }, '/surfaces', 'surfaceNotForToothType'],
      [{ tooth: tooth('sn-ll-2', 'canonical'), surfaces: ['M'] }, '/surfaces', 'surfacesNotForToothType'],
      [{ surfaces: ['M'] }, '/surfaces', 'surfacesNeedTooth'],
      [{ tooth: tooth('3'), surfaces: ['O'], kind: 'missing' }, '/surfaces', 'surfacesNotForKind'],
      [{ kind: 'missing' }, '/tooth', 'required'],
    ];
    for (const [extra, pointer, rule] of cases) {
      const res = await post({
        patientRef: p,
        provenance: 'recorded',
        kind: 'condition',
        findingRef: 'SYN-COND-006',
        ...extra,
      });
      expect([extra, res.statusCode, res.json().detail]).toStrictEqual([
        extra,
        422,
        { violations: [{ pointer, rule }] },
      ]);
    }
  });
});

describe('C6 as-of at the database clock (clock audit)', () => {
  // The future check of asOf used the application clock: with the host clock behind the database, an
  // instant the database had already stamped (an entry's recordedAt, the database "now") was refused
  // as in the future. The reported asOf of a current read came from the same clock.
  for (const skewMs of [-5_000, 5_000]) {
    it(`a chart as of the database's current instant is readable (app clock ${skewMs > 0 ? 'ahead' : 'behind'} 5 s)`, async () => {
      const p = await createPatient(h, 'Synthetic Chart Skew');
      const entry = (
        await record({ patientRef: p, tooth: tooth('8'), kind: 'condition', findingRef: 'SYN-COND-SKEW' })
      ).data.entry;
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skewMs });
      try {
        const asOf = await dbNow(db.admin);
        const then = await chart(p, `?asOf=${encodeURIComponent(asOf)}`);
        expect(then.entries.map((x) => x.entryRef)).toStrictEqual([entry.entryRef]);
        const current = await chart(p);
        expect(Date.parse(current.asOf)).toBeGreaterThanOrEqual(Date.parse(entry.recordedAt));
        expect(Date.parse(current.asOf)).toBeGreaterThanOrEqual(Date.parse(asOf));
      } finally {
        vi.useRealTimers();
      }
    });
  }
});

describe('C6 failure and recovery cases', () => {
  it('1. a duplicate entry is idempotent; duplicated corrections of one base keep one successor', async () => {
    const p = await createPatient(h, 'Synthetic Chart Dup');
    const body = {
      patientRef: p,
      tooth: tooth('9'),
      surfaces: ['M', 'I'],
      kind: 'condition',
      findingRef: 'SYN-COND-007',
    };
    const first = await record(body);
    const second = await record({ ...body, surfaces: ['I', 'M'] });
    expect([second.data.outcome, second.data.entry.entryRef]).toStrictEqual([
      'existing',
      first.data.entry.entryRef,
    ]);
    const key = randomUUID();
    const replay = h.ok<{ replayed: boolean; data: { entry: Entry } }>(
      await post({ provenance: 'recorded', ...body }, 'a1', key),
      201,
    );
    const again = h.ok<{ replayed: boolean; data: { entry: Entry } }>(
      await post({ provenance: 'recorded', ...body }, 'a1', key),
      201,
    );
    expect([replay.replayed, again.replayed, again.data.entry.entryRef]).toStrictEqual([
      false,
      true,
      first.data.entry.entryRef,
    ]);
    const n = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.audit_events WHERE operation = 'clinical.chart.recordEntry' AND resource_ref = $1`,
      [first.data.entry.entryRef],
    );
    expect(n.rows[0].n).toBe(1);
    const results = await Promise.all(
      [1, 2].map(() =>
        correct(first.data.entry.entryRef, { reasonCode: 'wrong_surface', surfaces: ['M'], state: 'active' }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toStrictEqual([201, 409]);
    const loser = results.find((r) => r.statusCode === 409);
    const winner = results.find((r) => r.statusCode === 201)?.json().data as Entry;
    expect(loser?.json().detail).toStrictEqual({
      reason: 'entry_superseded',
      blockingRefs: [{ kind: 'chartEntry', ref: winner.entryRef }],
    });
  });

  it('2. a correction of a superseded entry names the current successor', async () => {
    const p = await createPatient(h, 'Synthetic Chart Chain');
    const a = (
      await record({ patientRef: p, tooth: tooth('28'), kind: 'condition', findingRef: 'SYN-COND-008' })
    ).data.entry;
    const b = h.ok<{ data: Entry }>(
      await correct(a.entryRef, { reasonCode: 'wrong_tooth', tooth: tooth('29'), state: 'active' }),
      201,
    ).data;
    const c = h.ok<{ data: Entry }>(
      await correct(b.entryRef, { reasonCode: 'resolved_finding', state: 'resolved' }),
      201,
    ).data;
    expect([c.tooth?.universal, c.recordedState, c.state]).toStrictEqual(['29', 'resolved', 'resolved']);
    const stale = await correct(a.entryRef, { reasonCode: 'wrong_tooth', state: 'active' });
    expect([stale.statusCode, stale.json().detail]).toStrictEqual([
      409,
      { reason: 'entry_superseded', blockingRefs: [{ kind: 'chartEntry', ref: c.entryRef }] },
    ]);
    const void_ = h.ok<{ data: Entry }>(
      await correct(c.entryRef, { reasonCode: 'recorded_in_error', state: 'entered_in_error' }),
      201,
    ).data;
    const after = await correct(void_.entryRef, { reasonCode: 'wrong_tooth', state: 'active' });
    expect([after.statusCode, after.json().detail?.reason]).toStrictEqual([409, 'entry_entered_in_error']);
    const read = await chart(p);
    expect(read.teeth).toStrictEqual([]);
    expect(read.entries.map((x) => x.state)).toStrictEqual([
      'superseded',
      'superseded',
      'superseded',
      'entered_in_error',
    ]);
  });

  it('3. a chart read for a patient with no chart is an explicit empty state', async () => {
    const p = await createPatient(h, 'Synthetic Chart Empty');
    const read = await chart(p);
    expect([read.recorded, read.charts, read.entries, read.teeth]).toStrictEqual([false, [], [], []]);
  });

  it('4. entries carry the tooth vocabulary version and no runtime path rewrites them', async () => {
    const p = await createPatient(h, 'Synthetic Chart Vocab');
    await record({ patientRef: p, tooth: tooth('5'), kind: 'condition', findingRef: 'SYN-COND-009' });
    for (const sql of [
      `UPDATE cuspatlas.clinical_chart_entries SET tooth_canonical_ref = 'perm-ur-1'`,
      `UPDATE cuspatlas.clinical_chart_entries SET tooth_vocabulary = 'cuspatlas-tooth.v2'`,
      'DELETE FROM cuspatlas.clinical_chart_entries',
      'DELETE FROM cuspatlas.clinical_charts',
      `UPDATE cuspatlas.clinical_charts SET origin_patient_id = subject_patient_id, version = version + 1`,
      `UPDATE cuspatlas.clinical_charts SET head_sequence = head_sequence + 3, version = version + 1`,
      `INSERT INTO cuspatlas.clinical_chart_entries (tenant_id, chart_id, sequence, tooth_canonical_ref, tooth_vocabulary,
         kind, finding_ref, recorded_state, provenance, recorded_by, recorded_by_role)
       SELECT tenant_id, id, 99, 'perm-ur-1', 'cuspatlas-tooth.v9', 'condition', 'SYN-X', 'active', 'recorded',
         created_by, 'dentist' FROM cuspatlas.clinical_charts LIMIT 1`,
    ]) {
      const client = await db.app.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
        const code = await client.query(sql).then(
          () => 'ok',
          (e) => e.code,
        );
        expect([sql, ['42501', '23514'].includes(code)]).toStrictEqual([sql, true]);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
  });
});

describe('C6 encounter seam, merge, authorship, privacy and parity', () => {
  it('a closed encounter refuses a new entry and names the alternative', async () => {
    const p = await createPatient(h, 'Synthetic Chart Closed');
    const e = await encounter(p);
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/encounters/${e.encounterRef}/close`, {
        expectedVersion: e.version,
        dispositionCode: 'completed_as_planned',
      }),
    );
    const res = await post({
      patientRef: p,
      provenance: 'recorded',
      encounterRef: e.encounterRef,
      tooth: tooth('2'),
      kind: 'condition',
      findingRef: 'SYN-COND-010',
    });
    expect([res.statusCode, res.json().detail]).toStrictEqual([
      409,
      {
        reason: 'encounter_closed',
        blockingRefs: [{ kind: 'clinicalEncounter', ref: e.encounterRef }],
        alternative: 'clinical.encounters.open',
      },
    ]);
  });

  it('a merge keeps both charts with their source patient and rewrites no entry; the merged identity is redirected', async () => {
    const survivor = await createPatient(h, 'Synthetic Merge Chart');
    const merged = await createPatient(h, 'Synthetic Merge Chart');
    await record({ patientRef: survivor, tooth: tooth('18'), kind: 'condition', findingRef: 'SYN-COND-011' });
    const moved = await record({
      patientRef: merged,
      tooth: tooth('31'),
      kind: 'missing',
      findingRef: 'SYN-MISS-001',
    });
    const rows = async () =>
      (await db.admin.query('SELECT json_agg(e ORDER BY e.id) AS e FROM cuspatlas.clinical_chart_entries e'))
        .rows[0];
    const before = await rows();
    const mergeRef = await mergePatients(h, survivor, merged);
    expect(await rows()).toStrictEqual(before);
    const read = await chart(survivor);
    expect(read.charts.map((c) => c.sourcePatientRef).sort()).toStrictEqual([merged, survivor].sort());
    const m = read.entries.find((x) => x.entryRef === moved.data.entry.entryRef);
    expect([m?.patientRef, m?.sourcePatientRef]).toStrictEqual([survivor, merged]);
    expect(read.teeth.find((t) => t.tooth.universal === '31')?.status).toBe('missing');
    const moves = await db.admin.query(
      `SELECT record_class, content_digest_before = content_digest_after AS same FROM cuspatlas.patient_merge_moves
       WHERE merge_id = $1 AND record_class = 'clinicalChart'`,
      [mergeRef],
    );
    expect(moves.rows).toStrictEqual([{ record_class: 'clinicalChart', same: true }]);
    const redirected = await h.call('a1', 'GET', `/v1/clinical/patients/${merged}/chart`);
    expect([redirected.statusCode, redirected.json().detail]).toStrictEqual([
      409,
      { reason: 'patient_merged', blockingRefs: [{ kind: 'patient', ref: survivor }] },
    ]);
    // S-D2: a chart entry on the survivor after the merge makes unmerge need the review.
    await record({ patientRef: survivor, tooth: tooth('15'), kind: 'condition', findingRef: 'SYN-COND-012' });
    const unmerge = await h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, {
      reasonCode: 'merged_in_error',
    });
    expect([unmerge.statusCode, unmerge.json().detail]).toStrictEqual([
      422,
      { reason: 'reconciliation_review_required' },
    ]);
  });

  it('a read-only member, a member without a profile and a service principal cannot write; the read-only member reads', async () => {
    const p = await createPatient(h, 'Synthetic Chart Authors');
    const body = {
      patientRef: p,
      provenance: 'recorded',
      tooth: tooth('7'),
      kind: 'condition',
      findingRef: 'SYN-COND-013',
    };
    const a7 = await h.issuer.issue({ sub: '20000000-0000-4000-8000-0000000000a7', tid: T_ALPHA });
    const readOnly = await post(body, 'a4');
    expect([readOnly.statusCode, readOnly.json().code]).toStrictEqual([403, 'forbidden']);
    const noProfile = await post(body, a7);
    expect([noProfile.statusCode, noProfile.json().detail]).toStrictEqual([
      403,
      { reason: 'clinical_author_missing' },
    ]);
    expect((await post(body, 'svcA1')).statusCode).toBe(403);
    expect((await h.call('a4', 'GET', `/v1/clinical/patients/${p}/chart`)).statusCode).toBe(200);
  });

  it('the marker in detail text never reaches logs, audit, outbox, attempts, idempotency or sensitive reads', async () => {
    const p = await createPatient(h, 'Synthetic Chart Marker');
    const r = await record({
      patientRef: p,
      tooth: tooth('21'),
      kind: 'condition',
      findingRef: 'SYN-COND-014',
      detailText: `Synthetic ${MARKER}`,
    });
    expect(r.data.entry.detailText).toBe(`Synthetic ${MARKER}`);
    await correct(r.data.entry.entryRef, {
      reasonCode: 'wrong_tooth',
      state: 'active',
      detailText: `Again ${MARKER}`,
    });
    await chart(p);
    await post(
      { patientRef: p, provenance: 'recorded', kind: 'condition', findingRef: 'SYN-C', detailText: MARKER },
      'b1',
    );
    const reads = (
      await db.admin.query(
        `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.sensitive_read_events t`,
      )
    ).rows[0].j as string;
    expect(`${await leakTables(db)}${reads}${h.logLines.join('\n')}`).not.toContain(MARKER);
    const logged = await db.admin.query(
      `SELECT DISTINCT operation FROM cuspatlas.sensitive_read_events WHERE operation = 'clinical.chart.read'`,
    );
    expect(logged.rows).toHaveLength(1);
  });

  it('MCP records replay a REST key; reads and refusals match across surfaces', async () => {
    const p = await createPatient(h, 'Synthetic Chart Parity');
    const key = randomUUID();
    const body = {
      patientRef: p,
      provenance: 'recorded',
      tooth: tooth('10'),
      kind: 'condition',
      findingRef: 'SYN-COND-015',
    };
    const rest = h.ok<{ data: { entry: Entry } }>(await post(body, 'a1', key), 201);
    const viaMcp = await h.mcp('a1', 'clinical_chart_record_entry', { ...body, idempotencyKey: key }, 201);
    expect(viaMcp.code).toBeNull();
    expect((viaMcp.body as { replayed: boolean }).replayed).toBe(true);
    expect((viaMcp.body as { data: { entry: Entry } }).data.entry.entryRef).toBe(rest.data.entry.entryRef);
    const mcpRead = await h.mcp('a1', 'clinical_chart_read', { patientRef: p });
    const restRead = await chart(p);
    expect((mcpRead.body as { data: Chart }).data.entries).toStrictEqual(restRead.entries);
    const foreign = await h.mcp('b1', 'clinical_chart_read', { patientRef: p });
    expect([foreign.status, foreign.code]).toStrictEqual([404, 'not_found']);
  });
});
