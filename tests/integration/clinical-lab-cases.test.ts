import { randomUUID } from 'node:crypto';
import {
  validateLabCaseCommandResult,
  validateLabCaseExport,
  validateLabCaseList,
  validateLabCaseRead,
} from '@cuspatlas/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLINICAL_RECORD_ROUTES } from '../../apps/api/src/routes/clinical-record-manifest';
import {
  type AppointmentHarness,
  count,
  createPatient,
  leakTables,
  mergePatients,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
} from './support/appointment-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';

/**
 * C16: lab cases (synthetic engineering implementation; C-D9 recommended option: a configurable
 * proposed state set, print/export as the only channel, no electronic ordering). A case links the
 * patient, a plan detail or item and the S10 appointment it serves; due and return tracking is an
 * exception-first worklist (PT-03 lab returns); attachments are object references only (I stores
 * them). Every denial runs under the runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let betaLoc: { locationRef: string; provider: string; operatory: string };
let slot = 0;
const LAB = '/v1/clinical/lab-cases';
const PLANS = '/v1/clinical/treatment-plans';
type Lab = {
  labCaseRef: string;
  patientRef: string;
  sourcePatientRef: string;
  counterpartyRef: string;
  caseRef: string;
  planItemRef: string | null;
  planDetailRef: string | null;
  appointmentRef: string | null;
  appointmentStatus: string | null;
  expectedReturnDate: string | null;
  state: string;
  overdue: boolean;
  remakeOfRef: string | null;
  remadeAsRef: string | null;
  review: { planLinkSuperseded: boolean; appointmentCancelled: boolean };
  transitions: {
    sequence: number;
    fromState: string | null;
    toState: string;
    actorRef: string;
    at: string;
  }[];
  attachments: { attachmentRef: string }[];
  receivedDate: string | null;
  noAttachmentReason: string | null;
  version: number;
};

beforeAll(async () => {
  db = await openTestDatabase('clinical_lab_cases');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedClinicalScopes(db.admin);
  loc = await seedLocation(h, 'loc-lab');
  betaLoc = await seedLocation(h, 'loc-lab-beta', { who: 'b1' });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

async function appointment(patientRef: string, who: 'a1' | 'b1' = 'a1') {
  const l = who === 'b1' ? betaLoc : loc;
  const day = 1 + Math.floor(slot / 8) * 7;
  const hour = 13 + (slot % 8);
  slot += 1;
  const at = (hh: number) => new Date(Date.UTC(2030, 4, day, hh)).toISOString();
  return h.ok<{ data: { appointmentRef: string } }>(
    await h.call(who, 'POST', '/v1/scheduling/appointments', {
      patientRef,
      locationRef: l.locationRef,
      startsAt: at(hour),
      endsAt: at(hour + 1),
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: l.provider },
      operatory: { kind: 'operatory', resourceRef: l.operatory },
    }),
    201,
  ).data.appointmentRef;
}
async function planDetail(patientRef: string) {
  const plan = h.ok<{ data: { plan: { planRef: string; headVersionRef: string } } }>(
    await h.call('a1', 'POST', PLANS, { patientRef }, randomUUID()),
    201,
  ).data.plan;
  const detail = h.ok<{ data: { targetRef: string } }>(
    await h.call('a1', 'POST', `${PLANS}/versions/${plan.headVersionRef}/details`, {
      expectedRevision: 1,
      scope: 'whole_mouth',
    }),
    201,
  ).data.targetRef;
  return { ...plan, detail };
}
const create = (body: Record<string, unknown>, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', LAB, body, key);
const okLab = (res: Awaited<ReturnType<AppointmentHarness['call']>>, status = 201) => {
  const json = h.ok<{ data: Lab; replayed: boolean }>(res, status);
  expect(validateLabCaseCommandResult(json)).toBe(true);
  return json.data;
};
const state = (ref: string, body: Record<string, unknown>) =>
  h.call('a1', 'POST', `${LAB}/${ref}/state`, body);
const ret = (ref: string, body: Record<string, unknown>) =>
  h.call('a1', 'POST', `${LAB}/${ref}/return`, body);
const reason = (res: Awaited<ReturnType<AppointmentHarness['call']>>) => [
  res.statusCode,
  res.json().detail?.reason ?? res.json().detail?.violations?.[0]?.rule ?? res.json().code,
];
async function read(ref: string, who = 'a1') {
  const json = h.ok<{ data: Lab }>(await h.call(who, 'GET', `${LAB}/${ref}`));
  expect(validateLabCaseRead(json)).toBe(true);
  return json.data;
}
type Work = {
  kind: string;
  reasonCode: string;
  evidenceRefs: { kind: string; ref: string }[];
  dueAt: string | null;
};
async function worklist(asOf?: string) {
  return h.ok<{ data: { coverage: { status: string }; items: Work[] } }>(
    await h.call('a1', 'GET', `${LAB}/worklist${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`),
  ).data;
}
const itemsFor = (w: { items: Work[] }, ref: string) =>
  w.items.filter((i) => i.evidenceRefs.some((e) => e.ref === ref)).map((i) => i.kind);
const counterparty = () => `syn-lab-${randomUUID().slice(0, 8)}`;

describe('C16 acceptance cases', () => {
  it('1. a case linked to a plan detail and an appointment moves draft → sent → received and reads back its history', async () => {
    const p = await createPatient(h, 'Synthetic Lab Case');
    const pl = await planDetail(p);
    const appt = await appointment(p);
    const c = okLab(
      await create({
        patientRef: p,
        counterpartyRef: counterparty(),
        caseRef: 'SYN-CASE-001',
        planDetailRef: pl.detail,
        appointmentRef: appt,
        expectedReturnDate: '2030-05-20',
      }),
    );
    expect([c.state, c.planDetailRef, c.appointmentRef, c.appointmentStatus, c.version]).toStrictEqual([
      'draft',
      pl.detail,
      appt,
      'booked',
      1,
    ]);
    okLab(await state(c.labCaseRef, { expectedVersion: 1, state: 'sent' }), 200);
    const back = okLab(
      await ret(c.labCaseRef, {
        expectedVersion: 2,
        receivedDate: '2030-05-18',
        attachmentRefs: ['syn-obj-lab-1'],
      }),
      200,
    );
    expect([back.state, back.receivedDate, back.attachments.map((a) => a.attachmentRef)]).toStrictEqual([
      'received',
      '2030-05-18',
      ['syn-obj-lab-1'],
    ]);
    const r = await read(c.labCaseRef);
    expect(r.transitions.map((t) => [t.fromState, t.toState])).toStrictEqual([
      [null, 'draft'],
      ['draft', 'sent'],
      ['sent', 'received'],
    ]);
    expect(r.transitions.every((t) => t.actorRef.length > 0 && t.at.length > 0)).toBe(true);
    okLab(await state(c.labCaseRef, { expectedVersion: 3, state: 'seated' }), 200);
    const list = h.ok<{ data: Lab[] }>(await h.call('a1', 'GET', `/v1/clinical/patients/${p}/lab-cases`));
    expect(validateLabCaseList(list)).toBe(true);
    expect(list.data.map((x) => [x.labCaseRef, x.state])).toStrictEqual([[c.labCaseRef, 'seated']]);
  });

  it('2. a return without a received date, or without an attachment and without a reason, is refused', async () => {
    const p = await createPatient(h, 'Synthetic Lab Return');
    const c = okLab(
      await create({ patientRef: p, counterpartyRef: counterparty(), caseRef: 'SYN-CASE-002' }),
    );
    okLab(await state(c.labCaseRef, { expectedVersion: 1, state: 'sent' }), 200);
    expect((await ret(c.labCaseRef, { expectedVersion: 2, attachmentRefs: ['syn-obj-1'] })).statusCode).toBe(
      400,
    );
    expect(reason(await ret(c.labCaseRef, { expectedVersion: 2, receivedDate: '2030-05-18' }))).toStrictEqual(
      [422, 'attachmentOrReasonRequired'],
    );
    const ok = okLab(
      await ret(c.labCaseRef, {
        expectedVersion: 2,
        receivedDate: '2030-05-18',
        noAttachmentReason: 'paper_slip_only',
      }),
      200,
    );
    expect([ok.state, ok.noAttachmentReason, ok.attachments]).toStrictEqual([
      'received',
      'paper_slip_only',
      [],
    ]);
    // A transition outside the proposed set is refused, typed.
    expect(reason(await state(c.labCaseRef, { expectedVersion: 3, state: 'sent' }))).toStrictEqual([
      409,
      'lab_transition_not_allowed',
    ]);
    expect(reason(await state(c.labCaseRef, { expectedVersion: 1, state: 'seated' }))).toStrictEqual([
      409,
      'stale_version',
    ]);
  });

  it('3. a remake creates a linked case; the original stays readable as superseded by the remake', async () => {
    const p = await createPatient(h, 'Synthetic Lab Remake');
    const lab = counterparty();
    const c = okLab(await create({ patientRef: p, counterpartyRef: lab, caseRef: 'SYN-CASE-003' }));
    okLab(await state(c.labCaseRef, { expectedVersion: 1, state: 'sent' }), 200);
    okLab(
      await ret(c.labCaseRef, { expectedVersion: 2, receivedDate: '2030-05-18', noAttachmentReason: 'none' }),
      200,
    );
    const remake = okLab(
      await h.call('a1', 'POST', `${LAB}/${c.labCaseRef}/remake`, {
        expectedVersion: 3,
        reasonCode: 'shade_mismatch',
        caseRef: 'SYN-CASE-003R',
      }),
    );
    expect([remake.remakeOfRef, remake.state, remake.counterpartyRef]).toStrictEqual([
      c.labCaseRef,
      'draft',
      lab,
    ]);
    const orig = await read(c.labCaseRef);
    expect([orig.state, orig.remadeAsRef, orig.transitions.length]).toStrictEqual([
      'remake',
      remake.labCaseRef,
      4,
    ]);
  });

  it('4. a duplicate case reference for the same lab is refused; the same reference at another lab is allowed', async () => {
    const p = await createPatient(h, 'Synthetic Lab Duplicate');
    const lab = counterparty();
    okLab(await create({ patientRef: p, counterpartyRef: lab, caseRef: 'SYN-CASE-004' }));
    const dup = await create({ patientRef: p, counterpartyRef: lab, caseRef: 'SYN-CASE-004' });
    expect(reason(dup)).toStrictEqual([409, 'lab_case_ref_in_use']);
    okLab(await create({ patientRef: p, counterpartyRef: counterparty(), caseRef: 'SYN-CASE-004' }));
  });

  it('5. another tenant’s patient, appointment or plan is refused; no electronic ordering or sharing command exists', async () => {
    const p = await createPatient(h, 'Synthetic Lab Tenant');
    const beta = await createPatient(h, 'Synthetic Lab Beta', 'b1');
    const betaAppt = await appointment(beta, 'b1');
    const betaPlan = h.ok<{ data: { plan: { headVersionRef: string } } }>(
      await h.call('b1', 'POST', PLANS, { patientRef: beta }, randomUUID()),
      201,
    ).data.plan;
    const betaDetail = h.ok<{ data: { targetRef: string } }>(
      await h.call('b1', 'POST', `${PLANS}/versions/${betaPlan.headVersionRef}/details`, {
        expectedRevision: 1,
        scope: 'whole_mouth',
      }),
      201,
    ).data.targetRef;
    const base = { counterpartyRef: counterparty(), caseRef: 'SYN-CASE-005' };
    expect((await create({ ...base, patientRef: beta })).statusCode).toBe(404);
    expect((await create({ ...base, patientRef: p, appointmentRef: betaAppt })).statusCode).toBe(404);
    expect((await create({ ...base, patientRef: p, planDetailRef: betaDetail })).statusCode).toBe(404);
    // Another patient's appointment or plan in this tenant is a typed mismatch.
    const other = await createPatient(h, 'Synthetic Lab Other');
    const otherAppt = await appointment(other);
    expect(reason(await create({ ...base, patientRef: p, appointmentRef: otherAppt }))).toStrictEqual([
      422,
      'appointmentPatientMismatch',
    ]);
    // C-D9: print/export is the only channel; nothing orders or shares electronically.
    const labPaths = CLINICAL_RECORD_ROUTES.filter((r) => r.path.includes('lab-cases')).map(
      (r) => r.operationId,
    );
    expect(labPaths.filter((id) => /order|send|share|transmit/i.test(id))).toStrictEqual([]);
    const c = okLab(await create({ ...base, patientRef: p, caseRef: 'SYN-CASE-005B' }));
    const exp = h.ok<{ data: { format: string; labCase: Lab } }>(
      await h.call('a1', 'GET', `${LAB}/${c.labCaseRef}/export`),
    );
    expect(validateLabCaseExport(exp)).toBe(true);
    expect([exp.data.format, exp.data.labCase.labCaseRef]).toStrictEqual([
      'cuspatlas-lab-case-export/1',
      c.labCaseRef,
    ]);
    expect((await h.call('b1', 'GET', `${LAB}/${c.labCaseRef}/export`)).statusCode).toBe(404);
  });

  it('6. an overdue case appears in the worklist without any state change', async () => {
    const p = await createPatient(h, 'Synthetic Lab Overdue');
    const c = okLab(
      await create({
        patientRef: p,
        counterpartyRef: counterparty(),
        caseRef: 'SYN-CASE-006',
        expectedReturnDate: '2026-01-10',
      }),
    );
    okLab(await state(c.labCaseRef, { expectedVersion: 1, state: 'sent' }), 200);
    const before = await read(c.labCaseRef);
    const w = await worklist('2026-02-01T12:00:00Z');
    expect(w.coverage).toStrictEqual({ status: 'available' });
    expect(itemsFor(w, c.labCaseRef)).toStrictEqual(['lab_return_overdue']);
    const after = await read(c.labCaseRef);
    expect([after.version, after.state, after.overdue]).toStrictEqual([before.version, 'sent', true]);
    // Not yet overdue before the expected date; never overdue once received.
    expect(itemsFor(await worklist('2026-01-05T12:00:00Z'), c.labCaseRef)).toStrictEqual([]);
  });
});

describe('C16 failure and recovery cases', () => {
  it('1. a failed transition rolls back its state, audit and outbox rows', async () => {
    const p = await createPatient(h, 'Synthetic Lab Rollback');
    const c = okLab(
      await create({ patientRef: p, counterpartyRef: counterparty(), caseRef: 'SYN-CASE-101' }),
    );
    const counts = async () => [
      await count(db, 'clinical_lab_case_transitions'),
      await count(db, 'audit_events'),
      await count(db, 'outbox_events'),
    ];
    const before = await counts();
    await db.admin.query('REVOKE INSERT ON cuspatlas.outbox_events FROM cuspatlas_app');
    try {
      expect((await state(c.labCaseRef, { expectedVersion: 1, state: 'sent' })).statusCode).toBe(500);
    } finally {
      await db.admin.query('GRANT INSERT ON cuspatlas.outbox_events TO cuspatlas_app');
    }
    expect(await counts()).toStrictEqual(before);
    expect((await read(c.labCaseRef)).state).toBe('draft');
  });

  it('2. a case whose plan version is superseded keeps its link and is flagged for review', async () => {
    const p = await createPatient(h, 'Synthetic Lab Superseded');
    const pl = await planDetail(p);
    const c = okLab(
      await create({
        patientRef: p,
        counterpartyRef: counterparty(),
        caseRef: 'SYN-CASE-102',
        planDetailRef: pl.detail,
      }),
    );
    h.ok(
      await h.call('a1', 'POST', `${PLANS}/versions/${pl.headVersionRef}/supersede`, {
        expectedRevision: 2,
        reasonCode: 'treatment_changed',
      }),
      201,
    );
    const r = await read(c.labCaseRef);
    expect([r.planDetailRef, r.review.planLinkSuperseded]).toStrictEqual([pl.detail, true]);
    expect(itemsFor(await worklist(), c.labCaseRef)).toContain('lab_case_review');
  });

  it('3. a cancelled case retains every prior state and attachment reference', async () => {
    const p = await createPatient(h, 'Synthetic Lab Cancel');
    const c = okLab(
      await create({
        patientRef: p,
        counterpartyRef: counterparty(),
        caseRef: 'SYN-CASE-103',
        attachmentRefs: ['syn-obj-rx-1'],
      }),
    );
    okLab(await state(c.labCaseRef, { expectedVersion: 1, state: 'sent' }), 200);
    h.ok(
      await h.call('a1', 'POST', `${LAB}/${c.labCaseRef}/attachments`, { attachmentRef: 'syn-obj-rx-2' }),
      201,
    );
    const x = okLab(
      await state(c.labCaseRef, { expectedVersion: 3, state: 'cancelled', reasonCode: 'patient_request' }),
      200,
    );
    expect([
      x.state,
      x.transitions.map((t) => t.toState),
      x.attachments.map((a) => a.attachmentRef),
    ]).toStrictEqual(['cancelled', ['draft', 'sent', 'cancelled'], ['syn-obj-rx-1', 'syn-obj-rx-2']]);
    expect(reason(await state(c.labCaseRef, { expectedVersion: 4, state: 'sent' }))).toStrictEqual([
      409,
      'lab_transition_not_allowed',
    ]);
  });

  it('4. a case for a visit whose appointment is cancelled keeps the link and shows the appointment state', async () => {
    const p = await createPatient(h, 'Synthetic Lab Appt Cancel');
    const appt = await appointment(p);
    const c = okLab(
      await create({
        patientRef: p,
        counterpartyRef: counterparty(),
        caseRef: 'SYN-CASE-104',
        appointmentRef: appt,
      }),
    );
    h.ok(
      await h.call('a1', 'POST', `/v1/scheduling/appointments/${appt}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    const r = await read(c.labCaseRef);
    expect([r.appointmentRef, r.appointmentStatus, r.review.appointmentCancelled]).toStrictEqual([
      appt,
      'cancelled',
      true,
    ]);
    expect(itemsFor(await worklist(), c.labCaseRef)).toContain('lab_case_review');
  });
});

describe('C16 boundaries', () => {
  it('a disabled state of the configurable set is refused; a merged patient’s case follows the survivor', async () => {
    const p = await createPatient(h, 'Synthetic Lab Config');
    const c = okLab(
      await create({ patientRef: p, counterpartyRef: counterparty(), caseRef: 'SYN-CASE-201' }),
    );
    okLab(await state(c.labCaseRef, { expectedVersion: 1, state: 'sent' }), 200);
    await db.admin.query(
      `INSERT INTO cuspatlas.clinical_lab_case_state_config (tenant_id, state, enabled) VALUES ($1, 'in_progress', false)`,
      [T_ALPHA],
    );
    try {
      expect(reason(await state(c.labCaseRef, { expectedVersion: 2, state: 'in_progress' }))).toStrictEqual([
        409,
        'lab_state_disabled',
      ]);
    } finally {
      await db.admin.query(`DELETE FROM cuspatlas.clinical_lab_case_state_config WHERE tenant_id = $1`, [
        T_ALPHA,
      ]);
    }
    const survivor = await createPatient(h, 'Synthetic Lab Merge');
    const merged = await createPatient(h, 'Synthetic Lab Merge');
    const m = okLab(
      await create({ patientRef: merged, counterpartyRef: counterparty(), caseRef: 'SYN-CASE-202' }),
    );
    await mergePatients(h, survivor, merged);
    const after = await read(m.labCaseRef);
    expect([after.patientRef, after.sourcePatientRef]).toStrictEqual([survivor, merged]);
  });

  it('a read-only member reads but cannot create; a service principal cannot create; no caller tenant', async () => {
    const p = await createPatient(h, 'Synthetic Lab Roles');
    const body = { patientRef: p, counterpartyRef: counterparty(), caseRef: 'SYN-CASE-301' };
    expect(reason(await create(body, 'a4'))).toStrictEqual([403, 'forbidden']);
    expect(reason(await create(body, 'svcA1'))).toStrictEqual([403, 'forbidden']);
    expect((await create({ ...body, tenantId: T_ALPHA })).statusCode).toBe(400);
    const c = okLab(await create(body));
    expect((await h.call('a4', 'GET', `${LAB}/${c.labCaseRef}`)).statusCode).toBe(200);
  });

  it('the marker never leaks; MCP create replays a REST key; transitions are append-only under the runtime role', async () => {
    const p = await createPatient(h, 'Synthetic Lab Mcp');
    await create({ patientRef: p, counterpartyRef: counterparty(), caseRef: 'SYN-CASE-401', note: MARKER });
    const body = { patientRef: p, counterpartyRef: counterparty(), caseRef: 'SYN-CASE-402' };
    const key = randomUUID();
    const rest = okLab(await create(body, 'a1', key));
    const m = await h.mcp('a1', 'clinical_lab_cases_create', { ...body, idempotencyKey: key }, 201);
    expect([m.code, (m.body as { replayed: boolean }).replayed]).toStrictEqual([null, true]);
    const got = await h.mcp('a1', 'clinical_lab_cases_get', { labCaseRef: rest.labCaseRef });
    expect((got.body as { data: Lab }).data).toStrictEqual(await read(rest.labCaseRef));
    expect(`${await leakTables(db)}${h.logLines.join('\n')}`).not.toContain(MARKER);
    const client = await db.app.connect();
    try {
      for (const sql of [
        `UPDATE cuspatlas.clinical_lab_case_transitions SET to_state = 'seated' WHERE case_id = $1`,
        'DELETE FROM cuspatlas.clinical_lab_case_transitions WHERE case_id = $1',
        `UPDATE cuspatlas.clinical_lab_cases SET case_ref = 'SYN-X' WHERE id = $1`,
        'DELETE FROM cuspatlas.clinical_lab_cases WHERE id = $1',
      ]) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
        const code = await client.query(sql, [rest.labCaseRef]).then(
          () => 'ok',
          (err: { code?: string }) => err.code,
        );
        await client.query('ROLLBACK');
        expect([sql, code]).toStrictEqual([sql, '42501']);
      }
    } finally {
      client.release();
    }
  });
});
