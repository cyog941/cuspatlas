import { randomUUID } from 'node:crypto';
import {
  validateTreatmentPlanCommandResult,
  validateTreatmentPlanList,
  validateTreatmentPlanRead,
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
  USER_A1,
} from './support/appointment-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';

/**
 * C11: treatment plan, detail and item (synthetic engineering implementation; C-D2 provisional SYN-
 * procedure codes; item transition set designed, pending clinical approval). Plan-version
 * acceptance belongs to C12 and is exercised here only through its domain seam. No amount exists on
 * any level. Every denial runs under the runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
const PLANS = '/v1/clinical/treatment-plans';

beforeAll(async () => {
  db = await openTestDatabase('clinical_plans');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedClinicalScopes(db.admin);
  loc = await seedLocation(h, 'loc-plans');
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

type Transition = {
  from: string | null;
  to: string;
  cause: string;
  reasonCode: string | null;
  parentDetailRef: string | null;
};
type Item = {
  itemRef: string;
  detailRef: string;
  procedureCodeRef: string;
  sequence: number;
  feeScheduleRef: string | null;
  chartEntryRef: string | null;
  tooth: { canonicalRef: string } | null;
  state: string;
  appointmentRef: string | null;
  derivedFromItemRef: string | null;
  transitions: Transition[];
};
type Detail = {
  detailRef: string;
  scope: string;
  state: string;
  reasonCode: string | null;
  derivedFromDetailRef: string | null;
  items: Item[];
};
type Version = {
  planVersionRef: string;
  number: number;
  state: string;
  revision: number;
  supersedesRef: string | null;
  supersededByRef: string | null;
  acceptance: { acceptanceRef: string; acceptedAt: string } | null;
  estimateReadiness: { complete: boolean; itemCount: number; itemsWithoutFeeScheduleRef: string[] };
  details: Detail[];
};
type Plan = {
  planRef: string;
  patientRef: string;
  sourcePatientRef: string;
  headVersionRef: string;
  versions: Version[];
};
type Result = { data: { targetRef: string; plan: Plan }; version: number; replayed: boolean };

const tooth = (code: string) => ({ system: 'universal', code });
async function charted(patientRef: string, code: string, kind = 'condition', findingRef = 'SYN-COND-100') {
  return h.ok<{ data: { entry: { entryRef: string } } }>(
    await h.call('a1', 'POST', '/v1/clinical/chart/entries', {
      patientRef,
      provenance: 'recorded',
      tooth: tooth(code),
      kind,
      findingRef,
    }),
    201,
  ).data.entry.entryRef;
}
const ok = (res: Awaited<ReturnType<AppointmentHarness['call']>>, status = 201) => {
  const json = h.ok<Result>(res, status);
  expect(validateTreatmentPlanCommandResult(json)).toBe(true);
  return json;
};
const create = (patientRef: string, extra: Record<string, unknown> = {}, who = 'a1') =>
  h.call(who, 'POST', PLANS, { patientRef, ...extra }, randomUUID());
const addDetail = (versionRef: string, body: Record<string, unknown>, key = randomUUID()) =>
  h.call('a1', 'POST', `${PLANS}/versions/${versionRef}/details`, body, key);
const addItem = (detailRef: string, body: Record<string, unknown>, key = randomUUID()) =>
  h.call('a1', 'POST', `${PLANS}/details/${detailRef}/items`, body, key);
const setItem = (itemRef: string, body: Record<string, unknown>) =>
  h.call('a1', 'POST', `${PLANS}/items/${itemRef}/state`, body);
const setDetail = (detailRef: string, body: Record<string, unknown>) =>
  h.call('a1', 'POST', `${PLANS}/details/${detailRef}/state`, body);
const supersede = (versionRef: string, body: Record<string, unknown>) =>
  h.call('a1', 'POST', `${PLANS}/versions/${versionRef}/supersede`, body);
async function read(planRef: string, who = 'a1') {
  const json = h.ok<{ data: Plan }>(await h.call(who, 'GET', `${PLANS}/${planRef}`));
  expect(validateTreatmentPlanRead(json)).toBe(true);
  return json.data;
}
const head = (p: Plan) => p.versions.find((v) => v.planVersionRef === p.headVersionRef) as Version;

/** A plan with one tooth detail (two items) and one whole-mouth detail (one item). */
async function threeLevelPlan(name: string, withFees = false) {
  const patientRef = await createPatient(h, name);
  const entry = await charted(patientRef, '3');
  let r = ok(await create(patientRef, { displayText: 'Synthetic plan' }));
  const versionRef = head(r.data.plan).planVersionRef;
  r = ok(
    await addDetail(versionRef, {
      expectedRevision: 1,
      scope: 'tooth',
      tooth: tooth('3'),
      chartEntryRef: entry,
      phase: 1,
    }),
  );
  const toothDetail = r.data.targetRef;
  r = ok(await addDetail(versionRef, { expectedRevision: 2, scope: 'whole_mouth', phase: 2 }));
  const mouthDetail = r.data.targetRef;
  r = ok(
    await addItem(toothDetail, {
      expectedRevision: 3,
      procedureCodeRef: 'SYN-PROC-001',
      sequence: 1,
      tooth: tooth('3'),
      chartEntryRef: entry,
      feeScheduleRef: 'synthetic-fee-schedule-1',
    }),
  );
  const itemA = r.data.targetRef;
  r = ok(
    await addItem(toothDetail, {
      expectedRevision: 4,
      procedureCodeRef: 'SYN-PROC-002',
      sequence: 2,
      tooth: tooth('3'),
      ...(withFees ? { feeScheduleRef: 'synthetic-fee-schedule-2' } : {}),
    }),
  );
  const itemB = r.data.targetRef;
  r = ok(
    await addItem(mouthDetail, {
      expectedRevision: 5,
      procedureCodeRef: 'SYN-PROC-003',
      sequence: 1,
      ...(withFees ? { feeScheduleRef: 'synthetic-fee-schedule-3' } : {}),
    }),
  );
  const itemC = r.data.targetRef;
  return {
    patientRef,
    entry,
    planRef: r.data.plan.planRef,
    versionRef,
    toothDetail,
    mouthDetail,
    itemA,
    itemB,
    itemC,
    revision: 6,
  };
}

let slot = 0;
async function booking(patientRef: string): Promise<string> {
  slot += 1;
  const day = 7 + (slot % 5);
  const hour = 13 + Math.floor(slot / 5);
  const res = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/appointments', {
      patientRef,
      locationRef: loc.locationRef,
      startsAt: `2030-01-${String(day).padStart(2, '0')}T${hour}:00:00Z`,
      endsAt: `2030-01-${String(day).padStart(2, '0')}T${hour}:30:00Z`,
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    }),
    201,
  );
  return res.data.appointmentRef;
}

/**
 * Acceptance is C12's command (it calls the C11 seam `recordPlanVersionAcceptance` with a real
 * acceptance record): a complete estimate version pricing every item is generated and presented, then
 * accepted at the plan revision. A refusal is thrown as its typed body so the C11 cases assert on code
 * and detail.
 */
async function accept(versionRef: string, expectedRevision: number) {
  const items = await db.admin.query(
    'SELECT id FROM cuspatlas.clinical_plan_items WHERE plan_version_id = $1',
    [versionRef],
  );
  const estimate = await h.call('a1', 'POST', `${PLANS}/versions/${versionRef}/estimates`, {
    lines: items.rows.map((r) => ({ planItemRef: r.id, fee: { currency: 'USD', minor: 1000 } })),
  });
  if (estimate.statusCode !== 201) throw estimate.json();
  const shown = await h.call(
    'a1',
    'POST',
    `/v1/clinical/estimates/${estimate.json().data.estimateRef}/presentation`,
    {},
  );
  if (shown.statusCode !== 200) throw shown.json();
  const res = await h.call(
    'a1',
    'POST',
    `/v1/clinical/estimates/${estimate.json().data.estimateRef}/acceptance`,
    {
      expectedRevision,
      scope: 'full',
    },
  );
  if (res.statusCode !== 201) throw res.json();
  return res.json().data;
}

describe('C11 acceptance cases', () => {
  it('1. a plan with two details and several items reads back at all three levels with stable identifiers', async () => {
    const f = await threeLevelPlan('Synthetic Plan One');
    const p = await read(f.planRef);
    const v = head(p);
    expect([p.versions.length, v.number, v.state, v.revision]).toStrictEqual([1, 1, 'draft', 6]);
    expect(v.details.map((d) => [d.detailRef, d.scope, d.items.map((i) => i.itemRef)])).toStrictEqual([
      [f.toothDetail, 'tooth', [f.itemA, f.itemB]],
      [f.mouthDetail, 'whole_mouth', [f.itemC]],
    ]);
    const a = v.details[0]?.items[0] as Item;
    expect([a.detailRef, a.state, a.chartEntryRef, a.tooth?.canonicalRef, a.transitions]).toMatchObject([
      f.toothDetail,
      'proposed',
      f.entry,
      'perm-ur-6',
      [{ from: null, to: 'proposed', cause: 'created', reasonCode: null, parentDetailRef: null }],
    ]);
    expect(await read(f.planRef)).toStrictEqual(p);
    const list = h.ok<{ data: { planRef: string; headVersionRef: string }[] }>(
      await h.call('a1', 'GET', `/v1/clinical/patients/${f.patientRef}/treatment-plans`),
    );
    expect(validateTreatmentPlanList(list)).toBe(true);
    expect(list.data.map((x) => [x.planRef, x.headVersionRef])).toStrictEqual([[f.planRef, f.versionRef]]);
  });

  it('2. an item without a detail or a detail without a plan version is refused; no amount is accepted', async () => {
    const f = await threeLevelPlan('Synthetic Plan Two');
    const noDetail = await addItem(randomUUID(), {
      expectedRevision: 6,
      procedureCodeRef: 'SYN-PROC-001',
      sequence: 3,
    });
    expect([noDetail.statusCode, noDetail.json().code]).toStrictEqual([404, 'not_found']);
    const noVersion = await addDetail(randomUUID(), { expectedRevision: 1, scope: 'whole_mouth' });
    expect([noVersion.statusCode, noVersion.json().code]).toStrictEqual([404, 'not_found']);
    const amount = await addItem(f.mouthDetail, {
      expectedRevision: 6,
      procedureCodeRef: 'SYN-PROC-001',
      sequence: 3,
      amount: { currency: 'USD', minor: 100 },
    });
    expect(amount.statusCode).toBe(400);
    const client = await db.app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
      await client.query(`SELECT set_config('cuspatlas.actor_id', $1, true)`, [USER_A1]);
      const code = await client
        .query(
          `INSERT INTO cuspatlas.clinical_plan_items (tenant_id, detail_id, plan_version_id, sequence, procedure_code_ref,
             created_by, created_by_role, created_by_credential_ref)
             VALUES ($1, NULL, $2, 9, 'SYN-PROC-009', $3, 'dentist', 'SYN-CRED-A1')`,
          [T_ALPHA, f.versionRef, USER_A1],
        )
        .then(
          () => 'ok',
          (e) => e.code,
        );
      expect(code).toBe('23502');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('3. superseding an accepted version creates a new one; the accepted version stays retrievable and unchanged', async () => {
    const f = await threeLevelPlan('Synthetic Plan Three', true);
    await accept(f.versionRef, f.revision);
    const accepted = head(await read(f.planRef));
    expect([accepted.state, accepted.acceptance !== null]).toStrictEqual(['accepted', true]);
    const frozen = await addDetail(f.versionRef, {
      expectedRevision: accepted.revision,
      scope: 'whole_mouth',
    });
    expect([frozen.statusCode, frozen.json().detail?.reason]).toStrictEqual([409, 'plan_version_accepted']);
    // Item states still move on an accepted version (they are separate facts, not content).
    ok(await setItem(f.itemC, { expectedRevision: accepted.revision, state: 'accepted' }), 200);
    const before = head(await read(f.planRef));
    const r = ok(
      await supersede(f.versionRef, { expectedRevision: before.revision, reasonCode: 'treatment_changed' }),
    );
    const p = r.data.plan;
    const [v1, v2] = p.versions as [Version, Version];
    expect([
      v1.state,
      v1.supersededByRef,
      v2.number,
      v2.state,
      v2.supersedesRef,
      p.headVersionRef,
    ]).toStrictEqual(['superseded', v2.planVersionRef, 2, 'draft', v1.planVersionRef, v2.planVersionRef]);
    expect({ ...v1, state: before.state, supersededByRef: null }).toStrictEqual(before);
    const carried = v2.details.flatMap((d) => d.items);
    expect(carried.map((i) => [i.derivedFromItemRef, i.state, i.transitions[0]?.cause])).toStrictEqual([
      [f.itemA, 'proposed', 'carried_forward'],
      [f.itemB, 'proposed', 'carried_forward'],
      [f.itemC, 'accepted', 'carried_forward'],
    ]);
    const onOld = await setItem(f.itemA, { expectedRevision: v1.revision, state: 'accepted' });
    expect([onOld.statusCode, onOld.json().detail]).toStrictEqual([
      409,
      { reason: 'plan_version_superseded', blockingRefs: [{ kind: 'planVersion', ref: v2.planVersionRef }] },
    ]);
    const again = await supersede(f.versionRef, {
      expectedRevision: v1.revision,
      reasonCode: 'treatment_changed',
    });
    expect([again.statusCode, again.json().detail?.reason]).toStrictEqual([409, 'plan_version_superseded']);
  });

  it('4. declining a detail records each resulting item state with the reason and the parent reference', async () => {
    const f = await threeLevelPlan('Synthetic Plan Four');
    ok(
      await setItem(f.itemB, {
        expectedRevision: 6,
        state: 'discontinued',
        reasonCode: 'no_longer_indicated',
      }),
      200,
    );
    const r = ok(
      await setDetail(f.toothDetail, {
        expectedRevision: 7,
        state: 'declined',
        reasonCode: 'patient_declined',
      }),
      200,
    );
    const d = head(r.data.plan).details.find((x) => x.detailRef === f.toothDetail) as Detail;
    expect([d.state, d.reasonCode]).toStrictEqual(['declined', 'patient_declined']);
    const [a, b] = d.items as [Item, Item];
    expect([a.state, a.transitions.at(-1)]).toMatchObject([
      'declined',
      {
        from: 'proposed',
        to: 'declined',
        cause: 'detail_declined',
        reasonCode: 'patient_declined',
        parentDetailRef: f.toothDetail,
      },
    ]);
    expect([b.state, b.transitions.length]).toStrictEqual(['discontinued', 2]);
    const second = await setDetail(f.toothDetail, {
      expectedRevision: 8,
      state: 'discontinued',
      reasonCode: 'patient_declined',
    });
    expect([second.statusCode, second.json().detail?.reason]).toStrictEqual([409, 'detail_not_active']);
    const addToDeclined = await addItem(f.toothDetail, {
      expectedRevision: 8,
      procedureCodeRef: 'SYN-PROC-004',
      sequence: 3,
    });
    expect([addToDeclined.statusCode, addToDeclined.json().detail?.reason]).toStrictEqual([
      409,
      'detail_not_active',
    ]);
  });

  it('5. another tenant is hidden; a tooth absent from the chart needs an explicit chart entry, never an implicit one', async () => {
    const p = await createPatient(h, 'Synthetic Plan Five');
    const foreign = await create(p, {}, 'b1');
    expect([foreign.statusCode, foreign.json().code]).toStrictEqual([404, 'not_found']);
    const plan = ok(await create(p)).data.plan;
    const v = head(plan).planVersionRef;
    const entries = async () =>
      (await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.clinical_chart_entries')).rows[0].n;
    const before = await entries();
    const uncharted = await addDetail(v, { expectedRevision: 1, scope: 'tooth', tooth: tooth('14') });
    expect([uncharted.statusCode, uncharted.json().detail?.reason]).toStrictEqual([409, 'tooth_not_charted']);
    expect(await entries()).toBe(before);
    const other = await createPatient(h, 'Synthetic Plan Five Other');
    const otherEntry = await charted(other, '14');
    const mismatch = await addDetail(v, {
      expectedRevision: 1,
      scope: 'tooth',
      tooth: tooth('14'),
      chartEntryRef: otherEntry,
    });
    expect([mismatch.statusCode, mismatch.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/chartEntryRef', rule: 'chartEntryPatientMismatch' }] },
    ]);
    // A missing tooth is plannable only through its chart entry (for example a replacement).
    const missing = await charted(p, '14', 'missing', 'SYN-MISS-001');
    const r = ok(
      await addDetail(v, { expectedRevision: 1, scope: 'tooth', tooth: tooth('14'), chartEntryRef: missing }),
    );
    expect(r.data.plan.versions[0]?.details[0]?.detailRef).toBe(r.data.targetRef);
    const wrongTooth = await addItem(r.data.targetRef, {
      expectedRevision: 2,
      procedureCodeRef: 'SYN-PROC-005',
      sequence: 1,
      tooth: tooth('15'),
    });
    expect([wrongTooth.statusCode, wrongTooth.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/tooth', rule: 'toothOutsideDetail' }] },
    ]);
    const crossRead = await h.call('b1', 'GET', `${PLANS}/${plan.planRef}`);
    expect(crossRead.statusCode).toBe(404);
  });

  it('6. a version without fee references is estimate-incomplete, never priced', async () => {
    const f = await threeLevelPlan('Synthetic Plan Six');
    const p = await read(f.planRef);
    expect(head(p).estimateReadiness).toStrictEqual({
      complete: false,
      itemCount: 3,
      itemsWithoutFeeScheduleRef: [f.itemB, f.itemC],
    });
    expect(JSON.stringify(p)).not.toMatch(/amount|minor|currency|price/i);
  });
});

describe('C11 transitions, failure and recovery cases', () => {
  it('item transitions follow the explicit set; scheduling names a booked appointment of the same patient; completion is C14', async () => {
    const f = await threeLevelPlan('Synthetic Plan Transitions');
    let rev = f.revision;
    const notAllowed = await setItem(f.itemA, { expectedRevision: rev, state: 'scheduled' });
    expect([notAllowed.statusCode, notAllowed.json().detail?.reason]).toStrictEqual([
      409,
      'transition_not_allowed',
    ]);
    rev = ok(await setItem(f.itemA, { expectedRevision: rev, state: 'accepted' }), 200).version;
    const noAppt = await setItem(f.itemA, { expectedRevision: rev, state: 'scheduled' });
    expect([noAppt.statusCode, noAppt.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/appointmentRef', rule: 'required' }] },
    ]);
    const otherPatient = await createPatient(h, 'Synthetic Plan Transitions Other');
    const wrong = await setItem(f.itemA, {
      expectedRevision: rev,
      state: 'scheduled',
      appointmentRef: await booking(otherPatient),
    });
    expect([wrong.statusCode, wrong.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/appointmentRef', rule: 'appointmentPatientMismatch' }] },
    ]);
    const appt = await booking(f.patientRef);
    const scheduled = ok(
      await setItem(f.itemA, { expectedRevision: rev, state: 'scheduled', appointmentRef: appt }),
      200,
    );
    rev = scheduled.version;
    const item = head(scheduled.data.plan).details[0]?.items[0] as Item;
    expect([item.state, item.appointmentRef]).toStrictEqual(['scheduled', appt]);
    // Scheduling writes no scheduling table: the appointment row is unchanged.
    const { rows } = await db.admin.query(
      'SELECT version, status FROM cuspatlas.appointments WHERE id = $1',
      [appt],
    );
    expect(rows).toStrictEqual([{ version: 1, status: 'booked' }]);
    const complete = await setItem(f.itemA, { expectedRevision: rev, state: 'completed' });
    expect([
      complete.statusCode,
      complete.json().detail?.reason,
      complete.json().detail?.alternative,
    ]).toStrictEqual([409, 'completion_requires_rendered_procedure', 'clinical.procedures.render']);
    const noReason = await setItem(f.itemA, { expectedRevision: rev, state: 'accepted' });
    expect([noReason.statusCode, noReason.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/reasonCode', rule: 'required' }] },
    ]);
    rev = ok(
      await setItem(f.itemA, {
        expectedRevision: rev,
        state: 'accepted',
        reasonCode: 'appointment_cancelled',
      }),
      200,
    ).version;
    rev = ok(
      await setItem(f.itemB, { expectedRevision: rev, state: 'declined', reasonCode: 'patient_declined' }),
      200,
    ).version;
    const back = ok(
      await setItem(f.itemB, {
        expectedRevision: rev,
        state: 'proposed',
        reasonCode: 'patient_reconsidered',
      }),
      200,
    );
    const b = head(back.data.plan).details[0]?.items[1] as Item;
    expect(b.transitions.map((t) => [t.from, t.to])).toStrictEqual([
      [null, 'proposed'],
      ['proposed', 'declined'],
      ['declined', 'proposed'],
    ]);
  });

  it('1. concurrent item edits conflict on the plan version; one edit is kept', async () => {
    const f = await threeLevelPlan('Synthetic Plan Race');
    const results = await Promise.all(
      ['SYN-PROC-010', 'SYN-PROC-011'].map((code) =>
        addItem(f.mouthDetail, { expectedRevision: f.revision, procedureCodeRef: code, sequence: 2 }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toStrictEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json()).toMatchObject({
      code: 'stale_version',
      detail: { currentVersion: f.revision + 1 },
    });
    const items = head(await read(f.planRef)).details[1]?.items ?? [];
    expect(items).toHaveLength(2);
  });

  it('2. a detail is never deleted; discontinuation with a reason is the supported path', async () => {
    const f = await threeLevelPlan('Synthetic Plan Delete');
    const route = await h.app.inject({
      method: 'DELETE',
      url: `${PLANS}/details/${f.toothDetail}`,
      headers: { authorization: `Bearer ${h.tokens.a1}` },
    });
    expect(route.statusCode).toBe(404);
    for (const sql of [
      'DELETE FROM cuspatlas.clinical_plan_details',
      'DELETE FROM cuspatlas.clinical_plan_items',
      `UPDATE cuspatlas.clinical_plan_items SET procedure_code_ref = 'SYN-PROC-999'`,
      `UPDATE cuspatlas.clinical_plan_versions SET display_text = 'rewritten', revision = revision + 1`,
      'DELETE FROM cuspatlas.clinical_plan_item_events',
      `INSERT INTO cuspatlas.clinical_plan_item_events (tenant_id, item_id, sequence, from_state, to_state, cause,
         recorded_by, recorded_by_role, recorded_by_credential_ref)
       SELECT tenant_id, id, 2, 'proposed', 'completed', 'direct', created_by, 'dentist', 'SYN-CRED-A1'
       FROM cuspatlas.clinical_plan_items WHERE id = '${f.itemC}'`,
      `INSERT INTO cuspatlas.clinical_plan_item_events (tenant_id, item_id, sequence, from_state, to_state, cause,
         recorded_by, recorded_by_role, recorded_by_credential_ref)
       SELECT tenant_id, id, 2, 'proposed', 'scheduled', 'direct', created_by, 'dentist', 'SYN-CRED-A1'
       FROM cuspatlas.clinical_plan_items WHERE id = '${f.itemC}'`,
    ]) {
      const client = await db.app.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
        await client.query(`SELECT set_config('cuspatlas.actor_id', $1, true)`, [USER_A1]);
        const code = await client.query(sql).then(
          () => 'ok',
          (e) => e.code,
        );
        expect([sql, code]).toStrictEqual([sql, '42501']);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
    const r = ok(
      await setDetail(f.toothDetail, {
        expectedRevision: f.revision,
        state: 'discontinued',
        reasonCode: 'no_longer_indicated',
      }),
      200,
    );
    const d = head(r.data.plan).details[0] as Detail;
    expect([d.state, d.items.map((i) => i.state)]).toStrictEqual([
      'discontinued',
      ['discontinued', 'discontinued'],
    ]);
  });

  it('3. acceptance recorded while an item is being edited conflicts and leaves the plan unaccepted', async () => {
    const f = await threeLevelPlan('Synthetic Plan Accept Race', true);
    ok(
      await addItem(f.mouthDetail, {
        expectedRevision: f.revision,
        procedureCodeRef: 'SYN-PROC-012',
        sequence: 2,
        feeScheduleRef: 'synthetic-fee-schedule-12',
      }),
    );
    await expect(accept(f.versionRef, f.revision)).rejects.toMatchObject({
      code: 'stale_version',
      detail: { currentVersion: f.revision + 1 },
    });
    expect(head(await read(f.planRef)).state).toBe('draft');
    const [edit, acc] = await Promise.allSettled([
      addItem(f.mouthDetail, {
        expectedRevision: f.revision + 1,
        procedureCodeRef: 'SYN-PROC-013',
        sequence: 3,
        feeScheduleRef: 'synthetic-fee-schedule-13',
      }),
      accept(f.versionRef, f.revision + 1),
    ]);
    const v = head(await read(f.planRef));
    const editOk = edit.status === 'fulfilled' && edit.value.statusCode === 201;
    const accOk = acc.status === 'fulfilled';
    expect([editOk !== accOk, v.state]).toStrictEqual([true, accOk ? 'accepted' : 'draft']);
  });

  it('4. a merged patient’s plan keeps its structure and records the new patient reference with an audit entry', async () => {
    const survivor = await createPatient(h, 'Synthetic Merge Plan');
    const merged = await createPatient(h, 'Synthetic Merge Plan');
    const entry = await charted(merged, '19');
    const plan = ok(await create(merged)).data.plan;
    ok(
      await addDetail(head(plan).planVersionRef, {
        expectedRevision: 1,
        scope: 'tooth',
        tooth: tooth('19'),
        chartEntryRef: entry,
      }),
    );
    const rows = async () =>
      (
        await db.admin.query(
          `SELECT (SELECT json_agg(v ORDER BY v.id) FROM cuspatlas.clinical_plan_versions v) AS v,
             (SELECT json_agg(d ORDER BY d.id) FROM cuspatlas.clinical_plan_details d) AS d,
             (SELECT json_agg(i ORDER BY i.id) FROM cuspatlas.clinical_plan_items i) AS i`,
        )
      ).rows[0];
    const before = await rows();
    const mergeRef = await mergePatients(h, survivor, merged);
    expect(await rows()).toStrictEqual(before);
    const after = await read(plan.planRef);
    expect([after.patientRef, after.sourcePatientRef]).toStrictEqual([survivor, merged]);
    const audit = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.audit_events WHERE operation = 'patients.merge'
         AND resource_type = 'clinicalTreatmentPlan' AND resource_ref = $1`,
      [plan.planRef],
    );
    expect(audit.rows[0].n).toBe(1);
    const redirected = await create(merged);
    expect([redirected.statusCode, redirected.json().detail?.reason]).toStrictEqual([409, 'patient_merged']);
    ok(await create(survivor));
    const unmerge = await h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, {
      reasonCode: 'merged_in_error',
    });
    expect([unmerge.statusCode, unmerge.json().detail]).toStrictEqual([
      422,
      { reason: 'reconciliation_review_required' },
    ]);
  });
});

describe('C11 authorship, privacy and parity', () => {
  it('a read-only member and a service principal cannot write; the read-only member reads', async () => {
    const f = await threeLevelPlan('Synthetic Plan Authors');
    expect((await create(f.patientRef, {}, 'a4')).statusCode).toBe(403);
    expect((await create(f.patientRef, {}, 'svcA1')).statusCode).toBe(403);
    expect((await h.call('a4', 'GET', `${PLANS}/${f.planRef}`)).statusCode).toBe(200);
  });

  it('the marker in plan, detail and item text never leaks; reads are sensitive reads', async () => {
    const p = await createPatient(h, 'Synthetic Plan Marker');
    const plan = ok(await create(p, { displayText: `Synthetic ${MARKER}` })).data.plan;
    const d = ok(
      await addDetail(head(plan).planVersionRef, {
        expectedRevision: 1,
        scope: 'whole_mouth',
        displayText: MARKER,
      }),
    );
    ok(
      await addItem(d.data.targetRef, {
        expectedRevision: 2,
        procedureCodeRef: 'SYN-PROC-020',
        sequence: 1,
        displayText: MARKER,
      }),
    );
    await read(plan.planRef);
    await create(p, { displayText: MARKER }, 'b1');
    const reads = (
      await db.admin.query(
        `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.sensitive_read_events t`,
      )
    ).rows[0].j as string;
    expect(`${await leakTables(db)}${reads}${h.logLines.join('\n')}`).not.toContain(MARKER);
    const logged = await db.admin.query(
      `SELECT DISTINCT operation FROM cuspatlas.sensitive_read_events WHERE operation = 'clinical.treatmentPlans.read'`,
    );
    expect(logged.rows).toHaveLength(1);
  });

  it('MCP creates replay a REST key; reads and refusals match across surfaces', async () => {
    const p = await createPatient(h, 'Synthetic Plan Parity');
    const key = randomUUID();
    const rest = ok(await h.call('a1', 'POST', PLANS, { patientRef: p }, key));
    const viaMcp = await h.mcp(
      'a1',
      'clinical_treatment_plans_create',
      { patientRef: p, idempotencyKey: key },
      201,
    );
    expect([viaMcp.code, (viaMcp.body as { replayed: boolean }).replayed]).toStrictEqual([null, true]);
    const mcpRead = await h.mcp('a1', 'clinical_treatment_plans_get', { planRef: rest.data.plan.planRef });
    expect((mcpRead.body as { data: Plan }).data).toStrictEqual(await read(rest.data.plan.planRef));
    const foreign = await h.mcp('b1', 'clinical_treatment_plans_get', { planRef: rest.data.plan.planRef });
    expect([foreign.status, foreign.code]).toStrictEqual([404, 'not_found']);
  });
});
