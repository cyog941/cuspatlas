import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  openAppointmentHarness,
  seedLocation,
  setPatientStatus,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { SVC_A1, USER_A1 } from './support/fixtures';

/**
 * Hardening of S8-S11 after the independent review of 4b1a2e2 (SHOULD items 1-6 and two nits).
 * Runtime role, synthetic data only.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
/** A location whose hours are in force from two days ago (for windows that start in seconds). */
let now: { locationRef: string; provider: string; operatory: string };
let nowMove: { locationRef: string; provider: string; operatory: string };
const APPT = '/v1/scheduling/appointments';
const ALL_DAY = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '00:00', end: '24:00' }));
let n = 0;

beforeAll(async () => {
  db = await openTestDatabase('review_hardening_s2');
  h = await openAppointmentHarness(db, { pool: 10 });
  loc = await seedLocation(h, 'loc-harden', { weekly: ALL_DAY });
  const nowLocation = async (locationRef: string) => {
    h.ok(
      await h.call('a1', 'POST', '/v1/scheduling/locations', {
        locationRef,
        displayLabel: 'Synthetic Now',
        timeZone: 'America/New_York',
      }),
      201,
    );
    const define = async (kind: string) => {
      const r = h.ok<{ data: { resourceRef: string } }>(
        await h.call('a1', 'POST', '/v1/scheduling/resources', { kind, locationRef }),
        201,
      ).data.resourceRef;
      h.ok(
        await h.call('a1', 'POST', `/v1/scheduling/resources/${r}/availability`, {
          effectiveFrom: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
          weekly: ALL_DAY,
        }),
        201,
      );
      return r;
    };
    return { locationRef, provider: await define('provider'), operatory: await define('operatory') };
  };
  now = await nowLocation('loc-harden-now');
  nowMove = await nowLocation('loc-harden-move');
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

/** A fresh one-hour 2031 window (all-day hours), distinct per call. */
function window(o: { startsAt?: string; endsAt?: string } = {}, l = loc) {
  n += 1;
  const s = Date.UTC(2031, 0, 1, 0) + n * 2 * 3_600_000;
  return {
    startsAt: o.startsAt ?? new Date(s).toISOString(),
    endsAt: o.endsAt ?? new Date(s + 3_600_000).toISOString(),
    timeZone: 'America/New_York',
    provider: { kind: 'provider', resourceRef: l.provider },
    operatory: { kind: 'operatory', resourceRef: l.operatory },
  };
}
const book = async (
  patientRef: string,
  w: ReturnType<typeof window>,
  key = randomUUID(),
  who = 'a1',
  l = loc,
) => h.call(who, 'POST', APPT, { patientRef, locationRef: l.locationRef, ...w }, key);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nyDay = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
/**
 * A window starting a few seconds from now. H1 R-NIT: it stays inside one local day (the all-day
 * availability ends at local midnight), so near midnight it starts just after the day boundary.
 */
const soon = (seconds: number, minutes = 5) => {
  let s = Math.ceil((Date.now() + seconds * 1000) / 1000) * 1000;
  let span = minutes * 60_000;
  // Near local midnight: shrink to the whole minutes left in the day, or (under one minute left)
  // start in the first second of the next local day.
  while (span > 60_000 && nyDay(s) !== nyDay(s + span)) span -= 60_000;
  if (nyDay(s) !== nyDay(s + span)) {
    const day = nyDay(s);
    while (nyDay(s) === day) s += 1000;
  }
  return { startsAt: new Date(s).toISOString(), endsAt: new Date(s + span).toISOString() };
};

describe('SHOULD 1: window validation runs inside the idempotent handler', () => {
  it('a same-key retry after the start has passed returns the recorded booking, not a 422', async () => {
    const patient = await createPatient(h, 'Synthetic Early');
    const w = window(soon(2), now);
    const key = randomUUID();
    const first = h.ok<{ data: { appointmentRef: string } }>(await book(patient, w, key, 'a1', now), 201);
    await sleep(Math.max(0, Date.parse(w.startsAt) - Date.now()) + 1500);
    const retry = await book(patient, w, key, 'a1', now);
    expect([retry.statusCode, retry.json().replayed, retry.json().data?.appointmentRef]).toStrictEqual([
      201,
      true,
      first.data.appointmentRef,
    ]);
  }, 120_000);

  it('a same-key retry with a different, invalid window is an idempotency conflict, not a 422', async () => {
    const patient = await createPatient(h, 'Synthetic Mismatch');
    const key = randomUUID();
    h.ok(await book(patient, window(), key), 201);
    const w = window();
    const invalid = await book(patient, { ...w, endsAt: w.startsAt }, key);
    expect([invalid.statusCode, invalid.json().code]).toStrictEqual([409, 'idempotency_conflict']);
    // SHOULD 6: the booking-specific same-key, different-payload case (a valid, different window).
    const other = await book(await createPatient(h, 'Synthetic Other'), window(), key);
    expect([other.statusCode, other.json().code]).toStrictEqual([409, 'idempotency_conflict']);
  });

  it('a same-key reschedule retry after the new start has passed returns the recorded result', async () => {
    const patient = await createPatient(h, 'Synthetic Mover');
    const ref = h.ok<{ data: { appointmentRef: string } }>(
      await book(patient, window({}, nowMove), randomUUID(), 'a1', nowMove),
      201,
    ).data.appointmentRef;
    const target = window(soon(2), nowMove);
    const key = randomUUID();
    const body = { expectedVersion: 1, reasonCode: 'patient_request', ...target };
    const first = h.ok<{ data: { appointmentRef: string } }>(
      await h.call('a1', 'POST', `${APPT}/${ref}/reschedule`, body, key),
    );
    await sleep(Math.max(0, Date.parse(target.startsAt) - Date.now()) + 1500);
    const retry = await h.call('a1', 'POST', `${APPT}/${ref}/reschedule`, body, key);
    expect([retry.statusCode, retry.json().replayed, retry.json().data?.appointmentRef]).toStrictEqual([
      200,
      true,
      first.data.appointmentRef,
    ]);
  }, 120_000);
});

describe('SHOULD 2: stored refusals carry no visibility-filtered reference; resource conflicts are not replayed', () => {
  it('a booking conflict cleared by a cancellation books on the same-key retry', async () => {
    const w = window();
    const blocker = h.ok<{ data: { appointmentRef: string } }>(
      await book(await createPatient(h, 'Synthetic Blocker'), w),
      201,
    ).data.appointmentRef;
    const patient = await createPatient(h, 'Synthetic Waiting');
    const key = randomUUID();
    expect((await book(patient, w, key)).statusCode).toBe(409);
    h.ok(
      await h.call('a1', 'POST', `${APPT}/${blocker}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    const retry = await book(patient, w, key);
    expect([retry.statusCode, retry.json().replayed]).toStrictEqual([201, false]);
  });

  it('a replayed stored conflict shows no existingRef, even to a caller downgraded after the first attempt', async () => {
    const w = window();
    h.ok(await book(await createPatient(h, 'Synthetic Occupant'), w), 201);
    const key = randomUUID();
    const body = {
      locationRef: loc.locationRef,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      reasonCode: 'meeting',
      resources: [{ kind: 'operatory', resourceRef: loc.operatory }],
    };
    const first = await h.call('a1', 'POST', '/v1/scheduling/time-blocks', body, key);
    expect(first.statusCode).toBe(409);
    expect(first.json().detail.conflicts[0].existingRef).toBeDefined();
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = array_remove(scopes, 'scheduling.read') WHERE principal_id = $1`,
      [USER_A1],
    );
    try {
      const replay = await h.call('a1', 'POST', '/v1/scheduling/time-blocks', body, key);
      expect(replay.statusCode).toBe(409);
      expect(replay.json().detail.conflicts.length).toBeGreaterThan(0);
      for (const c of replay.json().detail.conflicts) expect(c.existingRef).toBeUndefined();
    } finally {
      await db.admin.query(
        `UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY['scheduling.read'] WHERE principal_id = $1`,
        [USER_A1],
      );
    }
    const { rows } = await db.admin.query(
      `SELECT result::text AS r FROM cuspatlas.command_idempotency WHERE operation = 'scheduling.timeBlocks.create'
       AND state = 'failed'`,
    );
    for (const r of rows) expect(r.r).not.toContain('existingRef');
  });
});

describe('SHOULD 3: confirmation provenance matches the principal kind', () => {
  it('automated confirmation needs a service principal and manual confirmation a person', async () => {
    const one = h.ok<{ data: { appointmentRef: string } }>(
      await book(await createPatient(h, 'Synthetic Confirm'), window()),
      201,
    ).data.appointmentRef;
    const byHuman = await h.call('a1', 'POST', `${APPT}/${one}/attendance`, {
      kind: 'confirmed_automated',
      provenanceRef: 'reminder-run.synthetic',
    });
    expect([byHuman.statusCode, byHuman.json().code]).toStrictEqual([403, 'forbidden']);
    const byService = await h.call('svcA1', 'POST', `${APPT}/${one}/attendance`, {
      kind: 'confirmed_manual',
    });
    expect([byService.statusCode, byService.json().code]).toStrictEqual([403, 'forbidden']);
    const attempts = await db.admin.query(
      'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = ANY ($1::uuid[])',
      [[byHuman.headers['x-correlation-id'], byService.headers['x-correlation-id']]],
    );
    expect(attempts.rows.map((r) => r.reason_code)).toStrictEqual([
      'principal_kind_denied',
      'principal_kind_denied',
    ]);
    h.ok(
      await h.call('svcA1', 'POST', `${APPT}/${one}/attendance`, {
        kind: 'confirmed_automated',
        provenanceRef: 'reminder-run.synthetic',
      }),
      201,
    );
    const { rows } = await db.admin.query(
      'SELECT actor_id, source FROM cuspatlas.appointment_attendance_transitions WHERE appointment_id = $1',
      [one],
    );
    expect(rows).toStrictEqual([{ actor_id: SVC_A1, source: 'automation' }]);
  });
});

describe('SHOULD 5: an expired, unreaped hold never blocks a time block with an empty conflict list', () => {
  it('a time block over an expired hold releases the hold and is created', async () => {
    const w = window();
    const hold = h.ok<{ data: { holdRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/holds', {
        locationRef: loc.locationRef,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        resources: [{ kind: 'operatory', resourceRef: loc.operatory }],
      }),
      201,
    ).data.holdRef;
    await db.admin.query(
      `UPDATE cuspatlas.scheduling_holds SET expires_at = now() - interval '1 minute', version = version + 1 WHERE id = $1`,
      [hold],
    );
    const block = await h.call('a1', 'POST', '/v1/scheduling/time-blocks', {
      locationRef: loc.locationRef,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      reasonCode: 'meeting',
      resources: [{ kind: 'operatory', resourceRef: loc.operatory }],
    });
    expect(block.statusCode).toBe(201);
    const { rows } = await db.admin.query(
      'SELECT state, release_reason FROM cuspatlas.scheduling_holds WHERE id = $1',
      [hold],
    );
    expect(rows[0]).toStrictEqual({ state: 'released', release_reason: 'expired' });
  });
});

describe('SHOULD 6: concurrency', () => {
  const liveOverlaps = async () =>
    (
      await db.admin.query(
        `SELECT count(*)::int AS n FROM cuspatlas.scheduling_occupancy a JOIN cuspatlas.scheduling_occupancy b
         ON a.resource_id = b.resource_id AND a.id < b.id AND a.during && b.during
         WHERE a.released_at IS NULL AND b.released_at IS NULL`,
      )
    ).rows[0].n;

  it('hold conversion and release race: exactly one wins and the state is consistent (5 rounds)', async () => {
    for (let round = 0; round < 5; round += 1) {
      const w = window();
      const hold = h.ok<{ data: { holdRef: string } }>(
        await h.call('a1', 'POST', '/v1/scheduling/holds', {
          locationRef: loc.locationRef,
          startsAt: w.startsAt,
          endsAt: w.endsAt,
          resources: [
            { kind: 'provider', resourceRef: loc.provider },
            { kind: 'operatory', resourceRef: loc.operatory },
          ],
        }),
        201,
      ).data.holdRef;
      const patient = await createPatient(h, 'Synthetic Racer');
      const [b, r] = await Promise.all([
        h.call('a1', 'POST', APPT, {
          patientRef: patient,
          locationRef: loc.locationRef,
          holdRef: hold,
          ...w,
        }),
        h.call('a1', 'POST', `/v1/scheduling/holds/${hold}/release`, { reasonCode: 'practice_request' }),
      ]);
      expect([
        [201, 409],
        [409, 200],
      ]).toContainEqual([b.statusCode, r.statusCode]);
      const state = (
        await db.admin.query('SELECT state FROM cuspatlas.scheduling_holds WHERE id = $1', [hold])
      ).rows[0].state;
      expect(state).toBe(b.statusCode === 201 ? 'converted' : 'released');
    }
    expect(await liveOverlaps()).toBe(0);
  });

  it('an expired hold: conversion and reconciliation race never book from the expired hold', async () => {
    for (let round = 0; round < 3; round += 1) {
      const w = window();
      const hold = h.ok<{ data: { holdRef: string } }>(
        await h.call('a1', 'POST', '/v1/scheduling/holds', {
          locationRef: loc.locationRef,
          startsAt: w.startsAt,
          endsAt: w.endsAt,
          resources: [
            { kind: 'provider', resourceRef: loc.provider },
            { kind: 'operatory', resourceRef: loc.operatory },
          ],
        }),
        201,
      ).data.holdRef;
      await db.admin.query(
        `UPDATE cuspatlas.scheduling_holds SET expires_at = now() - interval '1 minute', version = version + 1 WHERE id = $1`,
        [hold],
      );
      const patient = await createPatient(h, 'Synthetic Late');
      const [b, r] = await Promise.all([
        h.call('a1', 'POST', APPT, {
          patientRef: patient,
          locationRef: loc.locationRef,
          holdRef: hold,
          ...w,
        }),
        h.call('svcA1', 'POST', '/v1/scheduling/holds/reconcile', {}),
      ]);
      expect([b.statusCode, r.statusCode]).toStrictEqual([409, 200]);
      const row = (
        await db.admin.query('SELECT state, release_reason FROM cuspatlas.scheduling_holds WHERE id = $1', [
          hold,
        ])
      ).rows[0];
      expect(row).toStrictEqual({ state: 'released', release_reason: 'expired' });
    }
  });

  it('reschedule and a booking into the vacated slot race without double booking (5 rounds)', async () => {
    for (let round = 0; round < 5; round += 1) {
      const from = window();
      const to = window();
      const ref = h.ok<{ data: { appointmentRef: string } }>(
        await book(await createPatient(h, 'Synthetic Mover'), from),
        201,
      ).data.appointmentRef;
      const other = await createPatient(h, 'Synthetic Taker');
      const [r, b] = await Promise.all([
        h.call('a1', 'POST', `${APPT}/${ref}/reschedule`, {
          expectedVersion: 1,
          reasonCode: 'patient_request',
          ...to,
        }),
        book(other, from),
      ]);
      expect(r.statusCode).toBe(200);
      expect([201, 409]).toContain(b.statusCode);
    }
    expect(await liveOverlaps()).toBe(0);
  });

  it('cancel and an attendance transition race: exactly one succeeds (5 rounds)', async () => {
    for (let round = 0; round < 5; round += 1) {
      const ref = h.ok<{ data: { appointmentRef: string } }>(
        await book(await createPatient(h, 'Synthetic Arrival'), window()),
        201,
      ).data.appointmentRef;
      const [c, a] = await Promise.all([
        h.call('a1', 'POST', `${APPT}/${ref}/cancel`, { expectedVersion: 1, reasonCode: 'patient_request' }),
        h.call('a1', 'POST', `${APPT}/${ref}/attendance`, { kind: 'arrived' }),
      ]);
      const ok = [c.statusCode === 200, a.statusCode === 201].filter(Boolean);
      expect(ok).toHaveLength(1);
      expect([c.statusCode, a.statusCode]).toContain(409);
    }
  });
});

describe('NIT: conflict explanations do not reveal patient status without patients.read', () => {
  it('a caller without patients.read sees a generic patient_unavailable conflict', async () => {
    const patient = await createPatient(h, 'Synthetic Status');
    await setPatientStatus(h, patient, 'deceased');
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = array_remove(scopes, 'patients.read') WHERE principal_id = $1`,
      [SVC_A1],
    );
    try {
      const res = await book(patient, window(), randomUUID(), 'svcA1');
      expect(res.statusCode).toBe(409);
      expect(res.json().detail.conflicts).toStrictEqual([
        { kind: 'patient_unavailable', explanation: 'The patient cannot be scheduled.', overrideable: false },
      ]);
    } finally {
      await db.admin.query(
        `UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY['patients.read'] WHERE principal_id = $1`,
        [SVC_A1],
      );
    }
    const detailed = await book(patient, window());
    expect(detailed.json().detail.conflicts[0]).toMatchObject({ kind: 'patient_inactive' });
  });
});
