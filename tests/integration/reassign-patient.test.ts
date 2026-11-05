import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient } from './support/appointment-fixtures';
import type { BillingHarness } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';
import { openRcmHarness, RCM_LOC, type RcmHarness } from './support/rcm-fixtures';

/**
 * S22 (OR-11): reassigning an appointment's patient is allowed only while no clinical (C5 encounter,
 * C10 note, C14 procedure), billing (charge, claim) or attendance fact references the appointment;
 * each refusal names its blocking refs and remediation; a concurrent clinical write makes the
 * reassignment lose with a typed conflict. Synthetic data only, runtime role.
 */
let db: TestDatabase;
let r: RcmHarness;
let h: BillingHarness;
let operatory: string;
let p1: string;
let p2: string;
let day = 0;

async function book(patientRef = p1): Promise<string> {
  // Weekdays only, from Monday 2030-02-04 (the location's hours are Monday to Friday).
  const d = new Date(Date.UTC(2030, 1, 4 + Math.floor(day / 5) * 7 + (day % 5))).toISOString().slice(0, 10);
  day += 1;
  const res = await h.call('a1', 'POST', '/v1/scheduling/appointments', {
    patientRef,
    locationRef: RCM_LOC,
    startsAt: `${d}T15:00:00Z`,
    endsAt: `${d}T16:00:00Z`,
    timeZone: 'America/New_York',
    provider: { kind: 'provider', resourceRef: r.provider },
    operatory: { kind: 'operatory', resourceRef: operatory },
  });
  return h.ok<{ data: { appointmentRef: string } }>(res, 201).data.appointmentRef;
}
const reassign = (appointmentRef: string, patientRef = p2, expectedVersion = 1, who = 'a1') =>
  h.call(who, 'POST', `/v1/scheduling/appointments/${appointmentRef}/reassign-patient`, {
    expectedVersion,
    patientRef,
    reasonCode: 'wrong_patient_booked',
  });
async function encounterFor(appointmentRef: string): Promise<{ encounterRef: string; version: number }> {
  return h.ok<{ data: { encounter: { encounterRef: string; version: number } } }>(
    await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef: p1, appointmentRef }),
    201,
  ).data.encounter;
}
const subjectOf = async (appointmentRef: string) =>
  (
    await db.admin.query('SELECT subject_patient_id AS s FROM cuspatlas.appointments WHERE id = $1', [
      appointmentRef,
    ])
  ).rows[0].s as string;

beforeAll(async () => {
  db = await openTestDatabase('reassign_patient');
  r = await openRcmHarness(db, { mcp: true });
  h = r.h;
  operatory = (
    await db.admin.query(
      `SELECT r.id FROM cuspatlas.scheduling_resources r JOIN cuspatlas.scheduling_locations l ON l.id = r.location_id
       WHERE l.location_ref = $1 AND r.kind = 'operatory' LIMIT 1`,
      [RCM_LOC],
    )
  ).rows[0].id;
  p1 = await createPatient(h, 'Synthetic Booked');
  p2 = await createPatient(h, 'Synthetic Intended');
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('S22 reassign appointment patient', () => {
  it('is allowed with no attached facts; audited; the booking itself is unchanged', async () => {
    const a = await book();
    const occupancy = async () =>
      (
        await db.admin.query(
          `SELECT count(*)::int AS n FROM cuspatlas.scheduling_occupancy WHERE source_id = $1 AND released_at IS NULL`,
          [a],
        )
      ).rows[0].n;
    const before = await occupancy();
    expect((await reassign(a, p2, 7)).statusCode).toBe(409);
    const res = await reassign(a);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ appointmentRef: a, patientRef: p2, previousPatientRef: p1 });
    expect(await subjectOf(a)).toBe(p2);
    expect(await occupancy()).toBe(before);
    const history = await db.admin.query(
      'SELECT prior_patient_id, new_patient_id, reason_code FROM cuspatlas.appointment_patient_reassignments WHERE appointment_id = $1',
      [a],
    );
    expect(history.rows).toStrictEqual([
      { prior_patient_id: p1, new_patient_id: p2, reason_code: 'wrong_patient_booked' },
    ]);
    const audit = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.audit_events
       WHERE resource_ref = $1 AND operation = 'scheduling.appointments.reassignPatient'`,
      [a],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('attendance_recorded names the transitions and the remediation', async () => {
    const a = await book();
    h.ok(await h.call('a1', 'POST', `/v1/scheduling/appointments/${a}/attendance`, { kind: 'arrived' }), 201);
    const res = await reassign(a);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatchObject({
      reason: 'attendance_recorded',
      alternative: 'scheduling.appointments.book',
      blockingRefs: [{ kind: 'attendanceTransition', ref: expect.any(String) }],
    });
    expect(await subjectOf(a)).toBe(p1);
  });

  it('clinical_facts_attached names the encounter and the C14 remediation', async () => {
    const a = await book();
    const e = await encounterFor(a);
    const res = await reassign(a);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatchObject({
      reason: 'clinical_facts_attached',
      alternative: 'clinical.procedures.correct',
    });
    expect(res.json().detail.blockingRefs).toContainEqual({ kind: 'encounter', ref: e.encounterRef });
    expect(res.body).not.toContain(MARKER);
  });

  it('charges_attached names the charge and the billing remediation', async () => {
    const a = await book();
    const e = await encounterFor(a);
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/encounters/${e.encounterRef}/assignments`, {
        expectedVersion: e.version,
        role: 'treating_provider',
        assignee: { kind: 'provider', resourceRef: r.provider },
      }),
      201,
    );
    await r.publishFee('syn-fee-standard', [['SYN-REASSIGN', 10000]]);
    const procedure = await r.render(e.encounterRef, 'SYN-REASSIGN');
    const consumed = await r.consume(procedure);
    expect(consumed.statusCode, consumed.body).toBe(200);
    const res = await reassign(a);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatchObject({
      reason: 'charges_attached',
      alternative: 'billing.entries.reverse',
    });
    const kinds = (res.json().detail.blockingRefs as { kind: string }[]).map((b) => b.kind);
    expect(kinds).toEqual(expect.arrayContaining(['charge', 'encounter', 'procedure']));
    expect(await subjectOf(a)).toBe(p1);
  });

  it('a concurrent clinical write makes the reassignment lose with a typed conflict', async () => {
    const template = await book();
    const tpl = await encounterFor(template);
    const a = await book();
    const writer = await db.admin.connect();
    try {
      await writer.query('BEGIN');
      // An uncommitted encounter (with a rendered procedure) for the appointment, as a C14 visit would.
      const inserted = await writer.query(
        `INSERT INTO cuspatlas.clinical_encounters
         SELECT (jsonb_populate_record(NULL::cuspatlas.clinical_encounters,
           to_jsonb(e) || jsonb_build_object('id', $1::uuid, 'appointment_id', $2::uuid))).*
         FROM cuspatlas.clinical_encounters e WHERE e.id = $3 RETURNING id`,
        [randomUUID(), a, tpl.encounterRef],
      );
      expect(inserted.rowCount).toBe(1);
      const pending = reassign(a);
      await new Promise((ok) => setTimeout(ok, 750));
      await writer.query('COMMIT');
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(res.json().detail.reason).toBe('clinical_facts_attached');
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
    }
    expect(await subjectOf(a)).toBe(p1);
  });

  it('REST and MCP agree; another tenant gets 404 and changes nothing', async () => {
    const a = await book();
    expect((await reassign(a, p2, 1, 'b1')).statusCode).toBe(404);
    expect(await subjectOf(a)).toBe(p1);
    const m = await h.mcp(
      'a1',
      'scheduling_appointments_reassign_patient',
      {
        appointmentRef: a,
        expectedVersion: 1,
        patientRef: p2,
        reasonCode: 'wrong_patient_booked',
        idempotencyKey: randomUUID(),
      },
      200,
    );
    expect(m.status).toBe(200);
    expect(await subjectOf(a)).toBe(p2);
  });
});

describe('S22 hardening (R1-R3)', () => {
  const ctxOf = async (a: string) =>
    (
      await db.admin.query(
        `SELECT a.tenant_id, (SELECT e.actor_id FROM cuspatlas.audit_events e WHERE e.resource_ref = a.id LIMIT 1) AS actor
         FROM cuspatlas.appointments a WHERE a.id = $1`,
        [a],
      )
    ).rows[0] as { tenant_id: string; actor: string };

  it('R1: an active visit context item refuses the reassignment (no silent relink)', async () => {
    const a = await book();
    const { actor } = await ctxOf(a);
    await db.admin.query(
      `INSERT INTO cuspatlas.visit_context_items (tenant_id, appointment_id, item_kind, producer, item_ref, actor_id)
       SELECT tenant_id, id, 'form_assignment', 'C13', $2, $3 FROM cuspatlas.appointments WHERE id = $1`,
      [a, randomUUID(), actor],
    );
    const res = await reassign(a);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail.reason).toBe('visit_context_active');
    expect(await subjectOf(a)).toBe(p1);
  });

  it('R1: an appointment that belongs to a series refuses the reassignment', async () => {
    const created = await h.call('a1', 'POST', '/v1/scheduling/series', {
      patientRef: p1,
      locationRef: RCM_LOC,
      provider: { kind: 'provider', resourceRef: r.provider },
      operatory: { kind: 'operatory', resourceRef: operatory },
      pattern: { frequency: 'weekly', interval: 1 },
      firstDate: '2031-03-03',
      startTime: '10:00',
      durationMinutes: 30,
      count: 1,
    });
    expect(created.statusCode, created.body).toBe(201);
    const a = (
      await db.admin.query(
        `SELECT o.appointment_id FROM cuspatlas.appointment_series_occurrences o
         JOIN cuspatlas.appointment_series s ON s.id = o.series_id
         WHERE s.subject_patient_id = $1 AND o.appointment_id IS NOT NULL ORDER BY o.starts_at DESC LIMIT 1`,
        [p1],
      )
    ).rows[0].appointment_id as string;
    const res = await reassign(a);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail.reason).toBe('series_linked');
  });

  it('R1: the reminder intent is superseded by one for the new patient in the same transaction', async () => {
    const a = await book();
    const live = async () =>
      (
        await db.admin.query(
          `SELECT i.id, i.delivery_key FROM cuspatlas.notification_intents i
           WHERE i.subject_id = $1 AND i.purpose = 'reminder'
             AND NOT EXISTS (SELECT 1 FROM cuspatlas.notification_intents n WHERE n.superseded_intent_id = i.id)`,
          [a],
        )
      ).rows as { id: string; delivery_key: string }[];
    const before = await live();
    expect(before).toHaveLength(1);
    const res = await reassign(a);
    expect(res.statusCode, res.body).toBe(200);
    const after = await live();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).not.toBe(before[0]?.id);
    const link = await db.admin.query(
      'SELECT superseded_intent_id FROM cuspatlas.notification_intents WHERE id = $1',
      [after[0]?.id],
    );
    expect(link.rows[0].superseded_intent_id).toBe(before[0]?.id);
  });

  it('R2: after a reassignment, an encounter for the old patient is refused (reverse race)', async () => {
    const template = await book();
    const tpl = await encounterFor(template);
    const a = await book();
    expect((await reassign(a)).statusCode).toBe(200);
    await expect(
      db.admin.query(
        `INSERT INTO cuspatlas.clinical_encounters
         SELECT (jsonb_populate_record(NULL::cuspatlas.clinical_encounters,
           to_jsonb(e) || jsonb_build_object('id', $1::uuid, 'appointment_id', $2::uuid))).*
         FROM cuspatlas.clinical_encounters e WHERE e.id = $3`,
        [randomUUID(), a, tpl.encounterRef],
      ),
    ).rejects.toMatchObject({ code: '40001' });
  });

  it('R2/R3: the runtime role cannot move the patient without a reassignment, or to an inactive patient', async () => {
    const a = await book();
    const { tenant_id, actor } = await ctxOf(a);
    const inTx = async (fn: (c: import('pg').PoolClient) => Promise<unknown>) => {
      const c = await db.app.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          `SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)`,
          [tenant_id, actor],
        );
        const out = await fn(c);
        // The relink guard is a deferred constraint trigger: it decides at commit.
        await c.query('COMMIT');
        return out;
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    };
    await expect(
      inTx((c) =>
        c.query(
          'UPDATE cuspatlas.appointments SET subject_patient_id = $1, version = version + 1 WHERE id = $2',
          [p2, a],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // R3: an inactive target is refused at the reassignment record itself.
    const p3 = await createPatient(h, 'Synthetic Inactive');
    await db.admin.query(`UPDATE cuspatlas.patients SET status = 'inactive' WHERE id = $1`, [p3]);
    const record = (c: import('pg').PoolClient, target: string) =>
      c.query(
        `INSERT INTO cuspatlas.appointment_patient_reassignments (tenant_id, appointment_id, prior_patient_id,
           new_patient_id, reason_code, appointment_version, actor_id)
         VALUES ($1, $2, $3, $4, 'wrong_patient_booked', 2, $5)`,
        [tenant_id, a, p1, target, actor],
      );
    const move = (c: import('pg').PoolClient, target: string) =>
      c.query(
        'UPDATE cuspatlas.appointments SET subject_patient_id = $1, version = version + 1 WHERE id = $2',
        [target, a],
      );
    await expect(inTx((c) => record(c, p3))).rejects.toMatchObject({ code: '42501' });
    // R3: the relink branch is self-contained: a blocker written after the reassignment record, in the
    // same transaction, still refuses the move at commit.
    await expect(
      inTx(async (c) => {
        await record(c, p2);
        await move(c, p2);
        await c.query(
          `INSERT INTO cuspatlas.visit_context_items (tenant_id, appointment_id, item_kind, producer, item_ref, actor_id)
           VALUES ($1, $2, 'form_assignment', 'C13', $3, $4)`,
          [tenant_id, a, randomUUID(), actor],
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await subjectOf(a)).toBe(p1);
  });
});
