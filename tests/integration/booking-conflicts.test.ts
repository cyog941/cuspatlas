import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  count,
  createPatient,
  leakTables,
  mergePatients,
  openAppointmentHarness,
  seedLocation,
  setPatientStatus,
  T_ALPHA,
  USER_A1,
  USER_A4,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';

/**
 * S10: booking, holds and the inspectable conflict result. One BookingResult with outcome
 * booked | held on success; conflict (409, typed refusal with a visibility-filtered conflict list)
 * and denied (403/404) never as 2xx. Synthetic data only; dates in 2030 so they stay in the future.
 * 2030-03-04 is a Monday; the location runs 08:00-17:00 America/New_York (13:00-22:00Z in March).
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };

const BOOK = '/v1/scheduling/appointments';
const HOLD = '/v1/scheduling/holds';
const at = (day: number, hourUtc: number, minute = 0) =>
  new Date(Date.UTC(2030, 2, day, hourUtc, minute)).toISOString();

function booking(patientRef: string, startsAt: string, endsAt: string, extra: Record<string, unknown> = {}) {
  return {
    patientRef,
    locationRef: loc.locationRef,
    startsAt,
    endsAt,
    timeZone: 'America/New_York',
    provider: { kind: 'provider', resourceRef: loc.provider },
    operatory: { kind: 'operatory', resourceRef: loc.operatory },
    ...extra,
  };
}

type Result = { data: { outcome: string; appointmentRef?: string; holdRef?: string; expiresAt?: string } };

beforeAll(async () => {
  db = await openTestDatabase('booking_conflicts');
  h = await openAppointmentHarness(db, { pool: 12, mcp: true });
  loc = await seedLocation(h, 'loc-book');
  // Override capability (scheduling.override) for a1 only.
  await db.admin.query(
    `UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY['scheduling.override'] WHERE principal_id = $1`,
    [USER_A1],
  );
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

const book = (body: unknown, who = 'a1', key = randomUUID()) => h.call(who, 'POST', BOOK, body, key);

describe('S10 acceptance', () => {
  it('1. two concurrent identical bookings: one booked, one conflict naming the resource; one appointment row', async () => {
    const patient = await createPatient(h, 'Synthetic Pair');
    const body = booking(patient, at(4, 14), at(4, 15));
    const [x, y] = await Promise.all([book(body), book(body)]);
    const sorted = [x, y].sort((a, b) => a.statusCode - b.statusCode);
    expect(sorted.map((r) => r.statusCode)).toStrictEqual([201, 409]);
    const won = sorted[0]?.json() as Result;
    expect(won.data.outcome).toBe('booked');
    const lost = sorted[1]?.json();
    expect(lost.code).toBe('conflict');
    expect(lost.detail.reason).toBe('booking_conflict');
    expect(lost.detail.conflicts.length).toBeGreaterThan(0);
    for (const c of lost.detail.conflicts) {
      expect(c.kind).toBe('resource_overlap');
      expect(c.overrideable).toBe(false);
      expect([loc.provider, loc.operatory]).toContain(c.resourceRef.resourceRef);
      // a1 may read appointments, so the blocking booking is named.
      expect(c.existingRef).toBe(won.data.appointmentRef);
    }
    const { rows } = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.appointments WHERE subject_patient_id = $1',
      [patient],
    );
    expect(rows[0].n).toBe(1);
  });

  it('2. a conflict writes no appointment, occupancy, outbox or audit success and leaves one attempt row', async () => {
    const patient = await createPatient(h, 'Synthetic Second');
    const first = h.ok<Result>(await book(booking(patient, at(4, 16), at(4, 17))), 201);
    expect(first.data.outcome).toBe('booked');
    const before = await Promise.all(
      ['appointments', 'scheduling_occupancy', 'outbox_events', 'audit_events'].map((t) => count(db, t)),
    );
    const res = await book(booking(patient, at(4, 16, 30), at(4, 17, 30)));
    expect([res.statusCode, res.json().code]).toStrictEqual([409, 'conflict']);
    const after = await Promise.all(
      ['appointments', 'scheduling_occupancy', 'outbox_events', 'audit_events'].map((t) => count(db, t)),
    );
    expect(after).toStrictEqual(before);
    const attempts = await db.admin.query(
      `SELECT operation, reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1`,
      [res.headers['x-correlation-id']],
    );
    expect(attempts.rows).toStrictEqual([
      { operation: 'scheduling.appointments.book', reason_code: 'booking_conflict' },
    ]);
  });

  it("3. another tenant's patient, provider or operatory is refused without disclosing the record", async () => {
    const beta = await seedLocation(h, 'loc-book-beta', { who: 'b1' });
    const betaPatient = await createPatient(h, 'Synthetic Beta Booker', 'b1');
    const alphaPatient = await createPatient(h, 'Synthetic Alpha Booker');
    const random = randomUUID();
    const cases = [
      booking(betaPatient, at(5, 14), at(5, 15)),
      booking(alphaPatient, at(5, 14), at(5, 15), {
        provider: { kind: 'provider', resourceRef: beta.provider },
      }),
      booking(alphaPatient, at(5, 14), at(5, 15), {
        operatory: { kind: 'operatory', resourceRef: beta.operatory },
      }),
    ];
    const missing = await book(booking(random, at(5, 14), at(5, 15)));
    for (const body of cases) {
      const res = await book(body);
      expect([res.statusCode, res.json().code, res.json().detail]).toStrictEqual([
        404,
        'not_found',
        missing.json().detail,
      ]);
      expect(res.body).not.toContain(beta.provider);
      expect(res.body).not.toContain(betaPatient);
    }
  });

  it('4. an authorized override of a soft conflict succeeds and is audited; resource overlap is never overridden', async () => {
    const patient = await createPatient(h, 'Synthetic Override');
    // 12:00Z = 07:00 local, before opening hours.
    const early = booking(patient, at(6, 12), at(6, 13));
    const soft = await book(early);
    expect([
      soft.statusCode,
      soft
        .json()
        .detail.conflicts.map((c: { kind: string; overrideable: boolean }) => [c.kind, c.overrideable]),
    ]).toStrictEqual([
      409,
      [
        ['outside_availability', true],
        ['outside_availability', true],
      ],
    ]);
    const override = { code: 'provider_approved', reasonCode: 'patient_emergency' };
    // a4 (granted write here, but no override scope) is denied.
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY['scheduling.write'] WHERE principal_id = $1`,
      [USER_A4],
    );
    try {
      const denied = await book({ ...early, override }, 'a4');
      expect([denied.statusCode, denied.json().code]).toStrictEqual([403, 'forbidden']);
    } finally {
      await db.admin.query(
        `UPDATE cuspatlas.memberships SET scopes = array_remove(scopes, 'scheduling.write') WHERE principal_id = $1`,
        [USER_A4],
      );
    }
    const overridden = await book({ ...early, override });
    const ok = h.ok<Result>(overridden, 201);
    expect(ok.data.outcome).toBe('booked');
    const read = h.ok<{
      data: { overrides: { code: string; reasonCode: string; kinds: string[]; actorRef: string }[] };
    }>(await h.call('a1', 'GET', `${BOOK}/${ok.data.appointmentRef}`));
    expect(read.data.overrides).toStrictEqual([
      {
        code: 'provider_approved',
        reasonCode: 'patient_emergency',
        kinds: ['outside_availability'],
        actorRef: USER_A1,
      },
    ]);
    // One audit row for the booking and one for the override record, in the same transaction.
    const audit = await db.admin.query(
      `SELECT operation, resource_type FROM cuspatlas.audit_events WHERE correlation_id = $1 ORDER BY operation`,
      [overridden.headers['x-correlation-id']],
    );
    expect(audit.rows).toStrictEqual([
      { operation: 'scheduling.appointments.book', resource_type: 'appointment' },
      { operation: 'scheduling.appointments.override', resource_type: 'appointmentOverride' },
    ]);
    // The same window again: the overlap with the overridden booking is not overrideable.
    const overlap = await book({ ...booking(patient, at(6, 12), at(6, 13)), override });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().detail.conflicts.some((c: { kind: string }) => c.kind === 'resource_overlap')).toBe(
      true,
    );
  });

  it('5. a hold blocks a booking and, after expiry, the slot books without staff action', async () => {
    const patient = await createPatient(h, 'Synthetic Hold');
    const held = h.ok<Result>(
      await h.call('a1', 'POST', HOLD, {
        locationRef: loc.locationRef,
        startsAt: at(7, 14),
        endsAt: at(7, 15),
        resources: [
          { kind: 'provider', resourceRef: loc.provider },
          { kind: 'operatory', resourceRef: loc.operatory },
        ],
        ttlMinutes: 10,
      }),
      201,
    );
    expect(held.data.outcome).toBe('held');
    const blocked = await book(booking(patient, at(7, 14), at(7, 15)));
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().detail.conflicts[0].existingRef).toBe(held.data.holdRef);
    // Time passes (test-only clock shift on the synthetic row): the hold has expired.
    await db.admin.query(
      `UPDATE cuspatlas.scheduling_holds SET expires_at = now() - interval '1 second', version = version + 1 WHERE id = $1`,
      [held.data.holdRef],
    );
    const booked = h.ok<Result>(await book(booking(patient, at(7, 14), at(7, 15))), 201);
    expect(booked.data.outcome).toBe('booked');
    const hold = await db.admin.query(
      'SELECT state, release_reason, released_at IS NOT NULL AS released FROM cuspatlas.scheduling_holds WHERE id = $1',
      [held.data.holdRef],
    );
    expect(hold.rows[0]).toStrictEqual({ state: 'released', release_reason: 'expired', released: true });
  });

  it('5b. booking from a hold converts it in one transaction', async () => {
    const patient = await createPatient(h, 'Synthetic Convert');
    const held = h.ok<Result>(
      await h.call('a1', 'POST', HOLD, {
        locationRef: loc.locationRef,
        startsAt: at(7, 16),
        endsAt: at(7, 17),
        resources: [
          { kind: 'provider', resourceRef: loc.provider },
          { kind: 'operatory', resourceRef: loc.operatory },
        ],
      }),
      201,
    );
    const booked = h.ok<Result>(
      await book(booking(patient, at(7, 16), at(7, 17), { holdRef: held.data.holdRef })),
      201,
    );
    const hold = await db.admin.query(
      'SELECT state, appointment_id FROM cuspatlas.scheduling_holds WHERE id = $1',
      [held.data.holdRef],
    );
    expect(hold.rows[0]).toStrictEqual({ state: 'converted', appointment_id: booked.data.appointmentRef });
    const occ = await db.admin.query(
      `SELECT source_kind, released_at IS NULL AS live FROM cuspatlas.scheduling_occupancy
       WHERE source_id = ANY ($1::uuid[]) ORDER BY source_kind, live`,
      [[held.data.holdRef, booked.data.appointmentRef]],
    );
    expect(occ.rows).toStrictEqual([
      { source_kind: 'appointment', live: true },
      { source_kind: 'appointment', live: true },
      { source_kind: 'hold', live: false },
      { source_kind: 'hold', live: false },
    ]);
    // A booking longer than the held window: the hold is too short.
    const held2 = h.ok<Result>(
      await h.call('a1', 'POST', HOLD, {
        locationRef: loc.locationRef,
        startsAt: at(8, 14),
        endsAt: at(8, 15),
        resources: [{ kind: 'provider', resourceRef: loc.provider }],
      }),
      201,
    );
    const short = await book(
      booking(patient, at(8, 14), at(8, 15, 30), {
        holdRef: held2.data.holdRef,
        operatory: null,
        noOperatoryReason: 'not_yet_assigned',
      }),
    );
    expect(short.json().detail.conflicts.map((c: { kind: string }) => c.kind)).toContain(
      'insufficient_duration',
    );
  });

  it('6. reschedule keeps the original, links both, and a stale version is a typed conflict', async () => {
    const patient = await createPatient(h, 'Synthetic Move');
    const first = h.ok<Result>(await book(booking(patient, at(11, 14), at(11, 15))), 201);
    const ref = first.data.appointmentRef as string;
    const target = { ...booking(patient, at(11, 16), at(11, 17)), reasonCode: 'patient_request' };
    const { patientRef: _p, locationRef: _l, ...move } = target;
    const stale = await h.call('a1', 'POST', `${BOOK}/${ref}/reschedule`, { ...move, expectedVersion: 7 });
    expect([stale.statusCode, stale.json().code, stale.json().detail.currentVersion]).toStrictEqual([
      409,
      'stale_version',
      1,
    ]);
    const moved = h.ok<Result>(
      await h.call('a1', 'POST', `${BOOK}/${ref}/reschedule`, { ...move, expectedVersion: 1 }),
    );
    expect(moved.data.outcome).toBe('booked');
    const original = h.ok<{ data: Record<string, unknown> }>(await h.call('a1', 'GET', `${BOOK}/${ref}`));
    const next = h.ok<{ data: Record<string, unknown> }>(
      await h.call('a1', 'GET', `${BOOK}/${moved.data.appointmentRef}`),
    );
    expect(original.data).toMatchObject({
      status: 'rescheduled',
      rescheduledTo: moved.data.appointmentRef,
      startsAt: at(11, 14).replace('.000', '.000'),
      version: 2,
    });
    expect(next.data).toMatchObject({ status: 'booked', rescheduledFrom: ref, version: 1 });
    // The original slot is free again.
    h.ok(await book(booking(await createPatient(h, 'Synthetic Taker'), at(11, 14), at(11, 15))), 201);
  });

  it('7. cancel records a reason and an outbox intent and never deletes the appointment', async () => {
    const patient = await createPatient(h, 'Synthetic Cancel');
    const b = h.ok<Result>(await book(booking(patient, at(12, 14), at(12, 15))), 201);
    const ref = b.data.appointmentRef as string;
    const cancelled = h.ok<{ data: { outcome: string; status: string } }>(
      await h.call('a1', 'POST', `${BOOK}/${ref}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    expect(cancelled.data.status).toBe('cancelled');
    const read = h.ok<{ data: { status: string; cancelReason: string; resources: { released: boolean }[] } }>(
      await h.call('a1', 'GET', `${BOOK}/${ref}`),
    );
    expect(read.data.status).toBe('cancelled');
    expect(read.data.cancelReason).toBe('patient_request');
    expect(read.data.resources.every((r) => r.released)).toBe(true);
    const outbox = await db.admin.query(
      `SELECT operation, payload FROM cuspatlas.outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at`,
      [ref],
    );
    expect(outbox.rows.map((o) => o.operation)).toStrictEqual([
      'scheduling.appointments.book',
      'scheduling.appointments.cancel',
    ]);
    expect(outbox.rows[1].payload).toStrictEqual({ changedFields: ['status', 'notificationIntent'] });
    const again = await h.call('a1', 'POST', `${BOOK}/${ref}/cancel`, {
      expectedVersion: 2,
      reasonCode: 'other',
    });
    expect([again.statusCode, again.json().detail.reason]).toStrictEqual([409, 'appointment_not_booked']);
    h.ok(await book(booking(patient, at(12, 14), at(12, 15))), 201);
  });
});

describe('S10 rules beyond the acceptance list', () => {
  it('no operatory is valid only with a typed exception reason', async () => {
    const patient = await createPatient(h, 'Synthetic No Room');
    const missing = await book(booking(patient, at(13, 14), at(13, 15), { operatory: null }));
    expect([missing.statusCode, missing.json().detail.violations]).toStrictEqual([
      422,
      [{ pointer: '/noOperatoryReason', rule: 'required' }],
    ]);
    const both = await book(booking(patient, at(13, 14), at(13, 15), { noOperatoryReason: 'off_site' }));
    expect(both.json().detail.violations).toStrictEqual([
      { pointer: '/noOperatoryReason', rule: 'onlyWithoutOperatory' },
    ]);
    const ok = h.ok<Result>(
      await book(
        booking(patient, at(13, 14), at(13, 15), { operatory: null, noOperatoryReason: 'off_site' }),
      ),
      201,
    );
    const read = h.ok<{ data: { operatory: unknown; noOperatoryReason: string } }>(
      await h.call('a1', 'GET', `${BOOK}/${ok.data.appointmentRef}`),
    );
    expect([read.data.operatory, read.data.noOperatoryReason]).toStrictEqual([null, 'off_site']);
  });

  it('an inactive patient is a typed conflict, never a booking', async () => {
    const patient = await createPatient(h, 'Synthetic Gone');
    await setPatientStatus(h, patient, 'inactive');
    const res = await book(booking(patient, at(13, 16), at(13, 17)));
    expect([res.statusCode, res.json().detail.conflicts]).toStrictEqual([
      409,
      [{ kind: 'patient_inactive', explanation: expect.any(String), overrideable: false }],
    ]);
  });

  it('a booking made from a request links both records; reopening waits until the booking no longer stands', async () => {
    const patient = await createPatient(h, 'Synthetic Linked');
    const req = h.ok<{ data: { requestRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/appointment-requests', {
        patientRef: patient,
        locationRef: loc.locationRef,
        sourceChannel: 'phone',
        contactConsent: 'granted',
        flexibility: 'any_time',
      }),
      201,
    );
    const b = h.ok<Result>(
      await book(booking(patient, at(14, 14), at(14, 15), { requestRef: req.data.requestRef })),
      201,
    );
    const request = h.ok<{ data: { state: string; appointmentRef: string; version: number } }>(
      await h.call('a1', 'GET', `/v1/scheduling/appointment-requests/${req.data.requestRef}`),
    );
    expect(request.data).toMatchObject({ state: 'scheduled', appointmentRef: b.data.appointmentRef });
    const appt = h.ok<{ data: { requestRef: string } }>(
      await h.call('a1', 'GET', `${BOOK}/${b.data.appointmentRef}`),
    );
    expect(appt.data.requestRef).toBe(req.data.requestRef);
    const reopen = (v: number) =>
      h.call('a1', 'POST', `/v1/scheduling/appointment-requests/${req.data.requestRef}/reopen`, {
        expectedVersion: v,
        reasonCode: 'booking_cancelled',
      });
    const early = await reopen(request.data.version);
    expect([early.statusCode, early.json().detail.reason]).toStrictEqual([409, 'booking_still_active']);
    h.ok(
      await h.call('a1', 'POST', `${BOOK}/${b.data.appointmentRef}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    const reopened = h.ok<{ data: { state: string } }>(await reopen(request.data.version));
    expect(reopened.data.state).toBe('open');
  });

  it('close as scheduled links an existing booking to a request (one link on both records)', async () => {
    const patient = await createPatient(h, 'Synthetic Close Link');
    const req = h.ok<{ data: { requestRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/appointment-requests', {
        patientRef: patient,
        locationRef: loc.locationRef,
        sourceChannel: 'walk_in',
        contactConsent: 'unknown',
        flexibility: 'any_time',
      }),
      201,
    );
    const b = h.ok<Result>(await book(booking(patient, at(14, 16), at(14, 17))), 201);
    h.ok(
      await h.call('a1', 'POST', `/v1/scheduling/appointment-requests/${req.data.requestRef}/close`, {
        expectedVersion: 1,
        state: 'scheduled',
        reasonCode: 'booked',
        appointmentRef: b.data.appointmentRef,
      }),
    );
    const { rows } = await db.admin.query(
      `SELECT q.appointment_id = a.id AS forward, a.request_id = q.id AS backward
       FROM cuspatlas.appointment_requests q JOIN cuspatlas.appointments a ON a.id = $2 WHERE q.id = $1`,
      [req.data.requestRef, b.data.appointmentRef],
    );
    expect(rows[0]).toStrictEqual({ forward: true, backward: true });
  });

  it('a writer without appointment-read rights sees the blocking resource but not the blocking record', async () => {
    const patient = await createPatient(h, 'Synthetic Blind');
    const first = h.ok<Result>(await book(booking(patient, at(15, 14), at(15, 15))), 201);
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = ARRAY['scheduling.write', 'patients.read'] WHERE principal_id = $1`,
      [USER_A4],
    );
    try {
      const res = await book(booking(patient, at(15, 14), at(15, 15)), 'a4');
      expect(res.statusCode).toBe(409);
      for (const c of res.json().detail.conflicts) {
        expect(c.resourceRef).toBeDefined();
        expect(c).not.toHaveProperty('existingRef');
      }
      expect(res.body).not.toContain(first.data.appointmentRef);
    } finally {
      await db.admin.query(
        `UPDATE cuspatlas.memberships SET scopes = ARRAY['syntheticTasks.read', 'patients.read', 'scheduling.read'] WHERE principal_id = $1`,
        [USER_A4],
      );
    }
  });

  it('one synthetic day: search, booking and recheck agree (S9 seam)', async () => {
    const patient = await createPatient(h, 'Synthetic Day');
    const search = async () =>
      h.ok<{ data: { windows: { startsAt: string; endsAt: string }[] } }>(
        await h.call('a1', 'POST', '/v1/availability/search', {
          locationRef: loc.locationRef,
          from: '2030-03-18',
          to: '2030-03-18',
          durationMinutes: 60,
          slotMinutes: 60,
          displayTimeZone: 'America/New_York',
          requirements: [
            { kind: 'provider', resourceRef: loc.provider },
            { kind: 'operatory', resourceRef: loc.operatory },
          ],
        }),
      ).data.windows;
    const before = await search();
    const w = before[0];
    if (!w) throw new Error('no window');
    h.ok(await book(booking(patient, w.startsAt, w.endsAt)), 201);
    const after = await search();
    expect(after.map((x) => x.startsAt)).not.toContain(w.startsAt);
    expect(after).toHaveLength(before.length - 1);
    const recheck = await book(booking(patient, w.startsAt, w.endsAt));
    expect(recheck.statusCode).toBe(409);
    // Every window the search still offers books.
    const next = after[0];
    if (!next) throw new Error('no next window');
    h.ok(await book(booking(patient, next.startsAt, next.endsAt)), 201);
  });

  it('a merge re-points a booking to the survivor', async () => {
    const survivor = await createPatient(h, 'Synthetic Booked Twin');
    const merged = await createPatient(h, 'Synthetic Booked Twin');
    const b = h.ok<Result>(await book(booking(merged, at(19, 14), at(19, 15))), 201);
    await mergePatients(h, survivor, merged);
    const read = h.ok<{ data: { patientRef: string } }>(
      await h.call('a1', 'GET', `${BOOK}/${b.data.appointmentRef}`),
    );
    expect(read.data.patientRef).toBe(survivor);
  });

  it('the marker never reaches logs, audit, outbox, attempts or idempotency', async () => {
    const res = await book({ ...booking(randomUUID(), at(20, 14), at(20, 15)), appointmentTypeCode: MARKER });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(MARKER);
    expect(await leakTables(db)).not.toContain(MARKER);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });
});

describe('S10 failure and recovery', () => {
  it('1. a retry under the same key returns the recorded booking once', async () => {
    const patient = await createPatient(h, 'Synthetic Retry');
    const key = randomUUID();
    const body = booking(patient, at(20, 16), at(20, 17));
    const first = await book(body, 'a1', key);
    const again = await book(body, 'a1', key);
    expect([first.statusCode, again.statusCode]).toStrictEqual([201, 201]);
    expect(again.json().data.appointmentRef).toBe(first.json().data.appointmentRef);
    expect(again.json().replayed).toBe(true);
  });

  it('3. two overlapping holds are refused; reconciliation releases an expired hold', async () => {
    const holdBody = {
      locationRef: loc.locationRef,
      startsAt: at(21, 14),
      endsAt: at(21, 15),
      resources: [{ kind: 'operatory', resourceRef: loc.operatory }],
    };
    const first = h.ok<Result>(await h.call('a1', 'POST', HOLD, holdBody), 201);
    const second = await h.call('a1', 'POST', HOLD, holdBody);
    expect([second.statusCode, second.json().detail.conflicts[0].kind]).toStrictEqual([
      409,
      'resource_overlap',
    ]);
    await db.admin.query(
      `UPDATE cuspatlas.scheduling_holds SET expires_at = now() - interval '1 second', version = version + 1 WHERE id = $1`,
      [first.data.holdRef],
    );
    const rec = h.ok<{ data: { released: number } }>(await h.call('a1', 'POST', `${HOLD}/reconcile`, {}));
    expect(rec.data.released).toBeGreaterThanOrEqual(1);
    const state = await db.admin.query(
      'SELECT state, release_reason FROM cuspatlas.scheduling_holds WHERE id = $1',
      [first.data.holdRef],
    );
    expect(state.rows[0]).toStrictEqual({ state: 'released', release_reason: 'expired' });
    // An explicit release of an active hold records its reason.
    const third = h.ok<Result>(await h.call('a1', 'POST', HOLD, holdBody), 201);
    const released = h.ok<{ data: { state: string } }>(
      await h.call('a1', 'POST', `${HOLD}/${third.data.holdRef}/release`, { reasonCode: 'offer_declined' }),
    );
    expect(released.data.state).toBe('released');
    const twice = await h.call('a1', 'POST', `${HOLD}/${third.data.holdRef}/release`, {
      reasonCode: 'other',
    });
    expect([twice.statusCode, twice.json().detail.reason]).toStrictEqual([409, 'hold_not_active']);
  });

  it('4. a resource deactivated between search and commit is a conflict naming the resource state', async () => {
    const patient = await createPatient(h, 'Synthetic Retired Room');
    const spare = h.ok<{ data: { resourceRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/resources', {
        kind: 'operatory',
        locationRef: loc.locationRef,
        displayLabel: 'Operatory 9',
      }),
      201,
    );
    h.ok(
      await h.call('a1', 'POST', `/v1/scheduling/resources/${spare.data.resourceRef}/deactivate`, {
        expectedVersion: 1,
      }),
    );
    const res = await book(
      booking(patient, at(22, 14), at(22, 15), {
        operatory: { kind: 'operatory', resourceRef: spare.data.resourceRef },
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().detail.conflicts).toContainEqual({
      kind: 'outside_availability',
      resourceRef: { kind: 'operatory', resourceRef: spare.data.resourceRef },
      explanation: 'The resource is inactive.',
      overrideable: false,
    });
  });
});

describe('S10 concurrency: repeated contention on one slot, REST and MCP mixed', () => {
  it('10 parallel attempts x 5 loops: exactly one booked per slot, every other a conflict, one audit success', async () => {
    const patient = await createPatient(h, 'Synthetic Crowd');
    const summary: { loop: number; booked: number; conflicts: number; audits: number; attempts: number }[] =
      [];
    for (let loop = 0; loop < 5; loop += 1) {
      const body = booking(patient, at(25, 13 + loop), at(25, 14 + loop));
      const attempts = Array.from({ length: 10 }, async (_, i) => {
        if (i % 2 === 0) {
          const r = await book(body);
          return { status: r.statusCode, body: r.json() as Record<string, unknown> };
        }
        const m = await h.mcp(
          'a1',
          'scheduling_appointments_book',
          { ...body, idempotencyKey: randomUUID() },
          201,
        );
        return {
          status: m.status,
          body: m.status === 201 ? m.body : { code: m.code, detail: m.body.detail },
        };
      });
      const results = await Promise.all(attempts);
      const won = results.filter((r) => r.status === 201);
      const lost = results.filter((r) => r.status === 409);
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(9);
      const winner = ((won[0] as { body: Record<string, unknown> }).body.data as { appointmentRef: string })
        .appointmentRef;
      for (const l of lost) {
        const detail = l.body.detail as {
          conflicts: { kind: string; resourceRef: { resourceRef: string }; existingRef?: string }[];
        };
        expect(detail.conflicts.length).toBeGreaterThan(0);
        for (const c of detail.conflicts) {
          expect(c.kind).toBe('resource_overlap');
          expect([loc.provider, loc.operatory]).toContain(c.resourceRef.resourceRef);
          expect(c.existingRef).toBe(winner);
        }
      }
      const audits = await db.admin.query(
        `SELECT count(*)::int AS n FROM cuspatlas.audit_events a
         JOIN cuspatlas.appointments p ON p.id = a.resource_ref
         WHERE a.operation = 'scheduling.appointments.book' AND p.starts_at = $1`,
        [body.startsAt],
      );
      const rows = await db.admin.query(
        'SELECT count(*)::int AS n FROM cuspatlas.appointments WHERE starts_at = $1 AND subject_patient_id = $2',
        [body.startsAt, patient],
      );
      expect(rows.rows[0].n).toBe(1);
      expect(audits.rows[0].n).toBe(1);
      const attemptRows = await db.admin.query(
        `SELECT count(*)::int AS n FROM cuspatlas.security_attempt_events
         WHERE operation = 'scheduling.appointments.book' AND reason_code = 'booking_conflict' AND tenant_id = $1`,
        [T_ALPHA],
      );
      summary.push({
        loop,
        booked: won.length,
        conflicts: lost.length,
        audits: audits.rows[0].n,
        attempts: attemptRows.rows[0].n,
      });
    }
    // Recorded in the ledger: one booked and nine conflicts in every loop (synthetic counts only).
    mkdirSync('node_modules/.cache/cuspatlas', { recursive: true });
    writeFileSync('node_modules/.cache/cuspatlas/s10-concurrency.json', JSON.stringify(summary));
    expect(summary.every((s) => s.booked === 1 && s.conflicts === 9 && s.audits === 1)).toBe(true);
  }, 120_000);
});
