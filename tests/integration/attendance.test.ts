import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  leakTables,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';

/**
 * S11: attendance is an append-only sequence of transitions, separate from the booking, from
 * clinical completion (C5) and from billing (B1). The current state is derived, never stored.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
const APPT = '/v1/scheduling/appointments';
let slot = 0;

beforeAll(async () => {
  db = await openTestDatabase('attendance');
  h = await openAppointmentHarness(db, { mcp: true });
  loc = await seedLocation(h, 'loc-visit');
  // Configured exception reasons (synthetic tenant configuration; no practice decision).
  for (const [kind, code] of [
    ['no_show', 'no_contact'],
    ['late', 'traffic'],
    ['left_without_treatment', 'wait_too_long'],
    ['amendment', 'entered_in_error'],
  ]) {
    await db.admin.query(
      'INSERT INTO cuspatlas.scheduling_attendance_reasons (tenant_id, kind, reason_code) VALUES ($1, $2, $3)',
      [T_ALPHA, kind, code],
    );
  }
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

/** Books a fresh synthetic appointment on a Monday from 2030-04-01, one hour per call. */
async function appointment(): Promise<string> {
  const patient = await createPatient(h, 'Synthetic Visitor');
  const hour = 13 + (slot % 8);
  const day = 1 + Math.floor(slot / 8) * 7;
  slot += 1;
  const at = (hh: number) => new Date(Date.UTC(2030, 3, day, hh)).toISOString();
  const res = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', APPT, {
      patientRef: patient,
      locationRef: loc.locationRef,
      startsAt: at(hour),
      endsAt: at(hour + 1),
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    }),
    201,
  );
  return res.data.appointmentRef;
}

const record = (ref: string, body: Record<string, unknown>, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', `${APPT}/${ref}/attendance`, body, key);

type Transition = {
  transitionRef: string;
  kind: string;
  source: string;
  actorRef: string;
  occurredAt: string;
  claimedAt: string | null;
  reasonCode: string | null;
  provenanceRef: string | null;
  amendsTransitionRef: string | null;
  sequence: number;
};

async function history(ref: string): Promise<Transition[]> {
  return h.ok<{ data: Transition[] }>(await h.call('a1', 'GET', `${APPT}/${ref}/attendance`)).data;
}

describe('S11 acceptance', () => {
  it('1. a visit progresses through automated confirmation, arrival, in-chair and left-without-treatment', async () => {
    const ref = await appointment();
    const steps: Record<string, unknown>[] = [
      { kind: 'confirmed_automated', provenanceRef: 'reminder-run.2030-03-31' },
      { kind: 'arrived' },
      { kind: 'in_care' },
      { kind: 'left_without_treatment', reasonCode: 'wait_too_long' },
    ];
    const seen: Transition[][] = [];
    for (const s of steps) {
      h.ok(await record(ref, s), 201);
      seen.push(await history(ref));
    }
    const final = seen[seen.length - 1] as Transition[];
    expect(final.map((t) => [t.sequence, t.kind])).toStrictEqual([
      [1, 'confirmed_automated'],
      [2, 'arrived'],
      [3, 'in_care'],
      [4, 'left_without_treatment'],
    ]);
    for (const t of final) {
      expect(t.actorRef).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(t.occurredAt)).not.toBeNaN();
    }
    // No earlier transition changed as later ones were appended.
    for (let i = 0; i < seen.length; i += 1) {
      expect(final.slice(0, i + 1)).toStrictEqual(seen[i]);
    }
    const status = h.ok<{ data: Record<string, unknown> }>(
      await h.call('a1', 'GET', `${APPT}/${ref}/visit-status`),
    );
    expect(status.data).toStrictEqual({
      appointmentRef: ref,
      booking: { status: 'booked', version: 1 },
      attendance: {
        state: 'left_without_treatment',
        confirmation: 'automated',
        lastTransitionAt: final[3]?.occurredAt,
        transitions: 4,
      },
      clinicalCompletion: { ref: null, owner: 'C5', statement: expect.any(String) },
      billing: { ref: null, owner: 'B1', statement: expect.any(String) },
    });
  });

  it('2. automated and manual confirmation are distinct facts with provenance, counted separately', async () => {
    const auto = await appointment();
    const manual = await appointment();
    h.ok(await record(auto, { kind: 'confirmed_automated', provenanceRef: 'reminder-run.2030-03-31' }), 201);
    h.ok(await record(manual, { kind: 'confirmed_manual' }), 201);
    const noProvenance = await record(await appointment(), { kind: 'confirmed_automated' });
    expect([noProvenance.statusCode, noProvenance.json().detail.violations]).toStrictEqual([
      422,
      [{ pointer: '/provenanceRef', rule: 'required' }],
    ]);
    const [a] = await history(auto);
    const [m] = await history(manual);
    expect([a?.source, a?.provenanceRef]).toStrictEqual(['automation', 'reminder-run.2030-03-31']);
    expect([m?.source, m?.provenanceRef]).toStrictEqual(['staff', null]);
    const list = h.ok<{ data: { counts: Record<string, number> } }>(
      await h.call('a1', 'GET', `/v1/scheduling/worklist?locationRef=${loc.locationRef}&date=2030-04-01`),
    );
    expect(list.data.counts.confirmedAutomated).toBeGreaterThanOrEqual(2);
    expect(list.data.counts.confirmedManual).toBeGreaterThanOrEqual(1);
  });

  it('3. a no-show needs a configured reason; with one and a note it is recorded, the note never copied out', async () => {
    const ref = await appointment();
    const missing = await record(ref, { kind: 'no_show' });
    expect([missing.statusCode, missing.json().detail.violations]).toStrictEqual([
      422,
      [{ pointer: '/reasonCode', rule: 'required' }],
    ]);
    const unknown = await record(ref, { kind: 'no_show', reasonCode: 'made_up' });
    expect(unknown.json().detail.violations).toStrictEqual([
      { pointer: '/reasonCode', rule: 'notConfigured' },
    ]);
    h.ok(await record(ref, { kind: 'no_show', reasonCode: 'no_contact', note: `Synthetic ${MARKER}` }), 201);
    const [t] = await history(ref);
    expect([t?.kind, t?.reasonCode]).toStrictEqual(['no_show', 'no_contact']);
    expect(await leakTables(db)).not.toContain(MARKER);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
    // The note lives only in the attendance row: no clinical note table exists or receives it.
    const clinical = await db.admin.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'cuspatlas' AND table_name ~ 'clinical|note'`,
    );
    expect(clinical.rows[0].n).toBe(0);
  });

  it('4-5. clinical completion and financial facts cannot be recorded as attendance', async () => {
    const ref = await appointment();
    for (const kind of ['treatment_complete', 'completed', 'checked_out', 'billed', 'paid']) {
      const res = await record(ref, { kind });
      expect([kind, res.statusCode, res.json().code]).toStrictEqual([kind, 400, 'invalid_request']);
    }
    for (const extra of [
      { clinicalCompletionRef: randomUUID() },
      { billingRef: randomUUID() },
      { procedureCodes: ['D0120'] },
    ]) {
      const res = await record(ref, { kind: 'arrived', ...extra });
      expect(res.statusCode).toBe(400);
    }
    expect(await history(ref)).toStrictEqual([]);
  });

  it('structurally, recording attendance writes only attendance, audit, outbox and idempotency rows', async () => {
    const ref = await appointment();
    const tables = (
      await db.admin.query(
        `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'cuspatlas' AND c.relkind = 'r' ORDER BY 1`,
      )
    ).rows.map((r) => r.relname as string);
    const snap = async () =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async (t) => [
            t,
            (await db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${t}`)).rows[0].n,
          ]),
        ),
      );
    const before = await snap();
    h.ok(await record(ref, { kind: 'arrived_curbside' }), 201);
    const after = await snap();
    const changed = tables.filter((t) => before[t] !== after[t]).sort();
    expect(changed).toStrictEqual([
      'appointment_attendance_transitions',
      'audit_events',
      'command_idempotency',
      'outbox_events',
    ]);
    // The attendance table carries no clinical or financial column, and the runtime role may only
    // read and append it.
    const cols = await db.admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'cuspatlas'
         AND table_name = 'appointment_attendance_transitions' ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((r) => r.column_name)).toStrictEqual([
      'id',
      'tenant_id',
      'appointment_id',
      'sequence',
      'kind',
      'source',
      'provenance_ref',
      'reason_code',
      'note',
      'claimed_at',
      'amends_transition_id',
      'actor_id',
      'occurred_at',
    ]);
    const grants = await db.admin.query(
      `SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'cuspatlas'
         AND table_name = 'appointment_attendance_transitions' AND grantee = 'cuspatlas_app' ORDER BY 1`,
    );
    expect(grants.rows.map((r) => r.privilege_type)).toStrictEqual(['INSERT', 'SELECT']);
  });

  it('6. a cross-tenant or read-only caller is denied and audited', async () => {
    const ref = await appointment();
    const cross = await record(ref, { kind: 'arrived' }, 'b1');
    const readOnly = await record(ref, { kind: 'arrived' }, 'a4');
    expect([cross.statusCode, cross.json().code]).toStrictEqual([404, 'not_found']);
    expect([readOnly.statusCode, readOnly.json().code]).toStrictEqual([403, 'forbidden']);
    for (const r of [cross, readOnly]) {
      const { rows } = await db.admin.query(
        'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
        [r.headers['x-correlation-id']],
      );
      expect(rows).toHaveLength(1);
    }
    expect(await history(ref)).toStrictEqual([]);
  });

  it('7. arrival keeps the server instant and a separate client-claimed instant', async () => {
    const ref = await appointment();
    const claimed = '2030-04-01T13:58:00Z';
    h.ok(await record(ref, { kind: 'arrived', claimedAt: claimed }), 201);
    const [t] = await history(ref);
    expect(t?.claimedAt).toBe(new Date(claimed).toISOString());
    expect(t?.occurredAt).not.toBe(t?.claimedAt);
    expect(Math.abs(Date.parse(t?.occurredAt ?? '') - Date.now())).toBeLessThan(60_000);
  });
});

describe('S11 failure and recovery', () => {
  it('1. an out-of-order transition is refused with a typed code and changes nothing', async () => {
    const ref = await appointment();
    for (const kind of ['in_care', 'waiting', 'left_without_treatment']) {
      const body = kind === 'left_without_treatment' ? { kind, reasonCode: 'wait_too_long' } : { kind };
      const res = await record(ref, body);
      expect([kind, res.statusCode, res.json().code, res.json().detail.reason]).toStrictEqual([
        kind,
        409,
        'conflict',
        'attendance_transition_invalid',
      ]);
    }
    h.ok(await record(ref, { kind: 'no_show', reasonCode: 'no_contact' }), 201);
    const after = await record(ref, { kind: 'arrived' });
    expect(after.json().detail.reason).toBe('attendance_transition_invalid');
    expect((await history(ref)).map((t) => t.kind)).toStrictEqual(['no_show']);
  });

  it('2. the same transition under the same key is recorded once', async () => {
    const ref = await appointment();
    const key = randomUUID();
    const a = h.ok<{ data: { transitionRef: string }; replayed: boolean }>(
      await record(ref, { kind: 'arrived' }, 'a1', key),
      201,
    );
    const b = h.ok<{ data: { transitionRef: string }; replayed: boolean }>(
      await record(ref, { kind: 'arrived' }, 'a1', key),
      201,
    );
    expect(b.data.transitionRef).toBe(a.data.transitionRef);
    expect(b.replayed).toBe(true);
    expect(await history(ref)).toHaveLength(1);
  });

  it('3. a correction is an explicit amendment with a reason; nothing is overwritten', async () => {
    const ref = await appointment();
    h.ok(await record(ref, { kind: 'arrived' }), 201);
    const wrong = h.ok<{ data: { transitionRef: string } }>(await record(ref, { kind: 'in_care' }), 201);
    const noReason = await record(ref, { kind: 'waiting', amendsTransitionRef: wrong.data.transitionRef });
    expect(noReason.json().detail.violations).toStrictEqual([{ pointer: '/reasonCode', rule: 'required' }]);
    const amended = h.ok<{ data: { state: string } }>(
      await record(ref, {
        kind: 'waiting',
        amendsTransitionRef: wrong.data.transitionRef,
        reasonCode: 'entered_in_error',
      }),
      201,
    );
    expect(amended.data.state).toBe('waiting');
    const all = await history(ref);
    expect(all.map((t) => [t.kind, t.amendsTransitionRef])).toStrictEqual([
      ['arrived', null],
      ['in_care', null],
      ['waiting', wrong.data.transitionRef],
    ]);
    // Only the latest effective transition can be amended.
    const stale = await record(ref, {
      kind: 'in_care',
      amendsTransitionRef: all[0]?.transitionRef,
      reasonCode: 'entered_in_error',
    });
    expect(stale.json().detail.reason).toBe('amend_latest_only');
    // The table itself refuses UPDATE and DELETE for every role without trigger bypass.
    await expect(
      db.app.query(`UPDATE cuspatlas.appointment_attendance_transitions SET kind = 'in_care'`),
    ).rejects.toThrow();
  });

  it('4. cancellation is a booking command that appends the attendance fact; after it attendance is closed', async () => {
    const ref = await appointment();
    h.ok(await record(ref, { kind: 'confirmed_manual' }), 201);
    h.ok(
      await h.call('a1', 'POST', `${APPT}/${ref}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    const all = await history(ref);
    expect(all.map((t) => [t.kind, t.source])).toStrictEqual([
      ['confirmed_manual', 'staff'],
      ['cancelled', 'booking_command'],
    ]);
    const direct = await record(await appointment(), { kind: 'cancelled' });
    expect([direct.statusCode, direct.json().detail.violations]).toStrictEqual([
      422,
      [{ pointer: '/kind', rule: 'useBookingCommand' }],
    ]);
    const late = await record(ref, { kind: 'arrived' });
    expect(late.json().detail.reason).toBe('attendance_transition_invalid');
  });

  it('a started visit cannot be cancelled or rescheduled', async () => {
    const ref = await appointment();
    h.ok(await record(ref, { kind: 'arrived' }), 201);
    const cancel = await h.call('a1', 'POST', `${APPT}/${ref}/cancel`, {
      expectedVersion: 1,
      reasonCode: 'other',
    });
    expect([cancel.statusCode, cancel.json().detail.reason]).toStrictEqual([409, 'attendance_started']);
  });

  it('daily worklist shows the separated facts per appointment, and MCP returns the same', async () => {
    const ref = await appointment();
    const appt = h.ok<{ data: { startsAt: string } }>(await h.call('a1', 'GET', `${APPT}/${ref}`));
    const date = appt.data.startsAt.slice(0, 10);
    h.ok(await record(ref, { kind: 'confirmed_manual' }), 201);
    const rest = h.ok<{ data: { date: string; timeZone: string; appointments: Record<string, unknown>[] } }>(
      await h.call('a1', 'GET', `/v1/scheduling/worklist?locationRef=${loc.locationRef}&date=${date}`),
    );
    expect([rest.data.date, rest.data.timeZone]).toStrictEqual([date, 'America/New_York']);
    expect(rest.data.appointments.find((a) => a.appointmentRef === ref)).toMatchObject({
      status: 'booked',
      attendanceState: 'confirmed',
      confirmation: 'manual',
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    });
    const mcp = await h.mcp('a1', 'scheduling_worklist_daily', {
      locationRef: loc.locationRef,
      date,
    });
    expect(mcp.status).toBe(200);
    expect((mcp.body.data as { appointments: unknown[] }).appointments).toStrictEqual(rest.data.appointments);
  });
});
