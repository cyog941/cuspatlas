import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  count,
  createPatient,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
  USER_A1,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { actorFor, domainAppointments, envelope } from './support/domain-harness';

/**
 * S13: a recurrence series with a deliberate cap (ADR 0009 S-D1, recommended-pending-approval: 26 per
 * request, configuration ceiling 52, explicit continuation). Every occurrence is a real booking made
 * through the S10 insert path, individually addressable. Creation is atomic by default; the
 * documented `skipConflicts` flag creates only the conflict-free occurrences and enumerates the rest.
 * Month-end (S-S3-R1) and daylight-saving (S-S3-R2) rules are asserted with fixed synthetic dates.
 */
let db: TestDatabase;
let h: AppointmentHarness;
const SERIES = '/v1/scheduling/series';
const APPT = '/v1/scheduling/appointments';
type Loc = { locationRef: string; provider: string; operatory: string };
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '00:00', end: '24:00' }));

beforeAll(async () => {
  db = await openTestDatabase('recurrence');
  h = await openAppointmentHarness(db, { pool: 8 });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

let n = 0;
const newLocation = (weekly?: typeof ALL_WEEK) => {
  n += 1;
  return seedLocation(h, `loc-series-${n}`, weekly ? { weekly } : {});
};

function body(loc: Loc, patientRef: string, o: Record<string, unknown> = {}) {
  return {
    patientRef,
    locationRef: loc.locationRef,
    provider: { kind: 'provider', resourceRef: loc.provider },
    operatory: { kind: 'operatory', resourceRef: loc.operatory },
    pattern: { frequency: 'weekly', interval: 1 },
    firstDate: '2031-01-06',
    startTime: '10:00',
    durationMinutes: 60,
    count: 3,
    ...o,
  };
}

type SeriesData = {
  seriesRef: string;
  state: string;
  requested: number;
  created: number;
  skipped: number;
  partial: boolean;
  appointmentRefs: string[];
  skippedOccurrences: { index: number; localDate: string; reason: string }[];
};
type Occurrence = {
  index: number;
  localDate: string;
  startsAt: string;
  endsAt: string;
  outcome: string;
  appointmentRef: string | null;
  currentAppointmentRef: string | null;
  status: string | null;
};

async function create(loc: Loc, patient: string, o: Record<string, unknown> = {}, key = randomUUID()) {
  return h.call('a1', 'POST', SERIES, body(loc, patient, o), key);
}
async function read(ref: string) {
  return h.ok<{
    data: {
      state: string;
      version: number;
      occurrences: Occurrence[];
      exceptions: { index: number; kind: string; appointmentRef: string; reasonCode: string }[];
    };
  }>(await h.call('a1', 'GET', `${SERIES}/${ref}`)).data;
}

describe('S13 acceptance', () => {
  it('1. exactly the configured limit creates every occurrence; one over is refused naming the limit and writes nothing', async () => {
    const loc = await newLocation();
    const patient = await createPatient(h, 'Synthetic Series');
    const ok = h.ok<{ data: SeriesData }>(await create(loc, patient, { count: 26 }), 201);
    expect(ok.data.partial).toBe(false);
    expect([ok.data.requested, ok.data.created, ok.data.skipped]).toStrictEqual([26, 26, 0]);
    expect(new Set(ok.data.appointmentRefs).size).toBe(26);
    const series = await read(ok.data.seriesRef);
    expect(series.occurrences.map((o) => o.index)).toStrictEqual(Array.from({ length: 26 }, (_, i) => i + 1));
    // Each occurrence is individually addressable as a booking.
    for (const ref of ok.data.appointmentRefs.slice(0, 3)) {
      const a = h.ok<{ data: { status: string; version: number } }>(
        await h.call('a1', 'GET', `${APPT}/${ref}`),
      );
      expect([a.data.status, a.data.version]).toStrictEqual(['booked', 1]);
    }
    const tables = ['appointment_series', 'appointment_series_occurrences', 'appointments', 'audit_events'];
    const before = await Promise.all(tables.map((t) => count(db, t)));
    const loc2 = await newLocation();
    const beforeLoc = await Promise.all(tables.map((t) => count(db, t)));
    const over = await create(loc2, patient, { count: 27 });
    expect([
      over.statusCode,
      over.json().code,
      over.json().detail?.reason,
      over.json().detail?.limit,
    ]).toStrictEqual([
      422,
      'validation_failed',
      'series_limit_exceeded',
      { name: 'scheduling.series.occurrenceLimit', value: 26 },
    ]);
    expect(await Promise.all(tables.map((t) => count(db, t)))).toStrictEqual(beforeLoc);
    expect(before.length).toBe(4);
    // Above the configuration ceiling (52) the schema refuses the request outright.
    expect((await create(loc2, patient, { count: 53 })).statusCode).toBe(400);
  });

  it('2. each occurrence is independently editable; cancelling one records a series exception naming it', async () => {
    const loc = await newLocation();
    const patient = await createPatient(h, 'Synthetic Series');
    const s = h.ok<{ data: SeriesData }>(await create(loc, patient, { count: 3 }), 201).data;
    const [first, second, third] = s.appointmentRefs as [string, string, string];
    // Reschedule the second occurrence by one hour; the others keep version 1.
    const moved = h.ok<{ data: { appointmentRef: string } }>(
      await h.call('a1', 'POST', `${APPT}/${second}/reschedule`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
        startsAt: '2031-01-13T16:00:00Z',
        endsAt: '2031-01-13T17:00:00Z',
        timeZone: 'America/New_York',
        provider: { kind: 'provider', resourceRef: loc.provider },
        operatory: { kind: 'operatory', resourceRef: loc.operatory },
      }),
    );
    h.ok(
      await h.call('a1', 'POST', `${APPT}/${third}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    for (const ref of [first]) {
      const a = h.ok<{ data: { version: number; status: string } }>(
        await h.call('a1', 'GET', `${APPT}/${ref}`),
      );
      expect([a.data.status, a.data.version]).toStrictEqual(['booked', 1]);
    }
    const series = await read(s.seriesRef);
    expect(series.exceptions.map((e) => [e.index, e.kind, e.appointmentRef])).toStrictEqual([
      [2, 'rescheduled', second],
      [3, 'cancelled', third],
    ]);
    expect(series.occurrences.map((o) => [o.index, o.currentAppointmentRef, o.status])).toStrictEqual([
      [1, first, 'booked'],
      [2, moved.data.appointmentRef, 'booked'],
      [3, third, 'cancelled'],
    ]);
  });

  it('3. planSeries returns a conflict for every blocked occurrence and writes nothing', async () => {
    const loc = await newLocation();
    const patient = await createPatient(h, 'Synthetic Series');
    // Block the 2nd and 3rd Mondays at 10:00 with ordinary bookings.
    for (const day of ['2031-01-13', '2031-01-20']) {
      h.ok(
        await h.call('a1', 'POST', APPT, {
          patientRef: await createPatient(h, 'Synthetic Blocker'),
          locationRef: loc.locationRef,
          startsAt: `${day}T15:00:00Z`,
          endsAt: `${day}T16:00:00Z`,
          timeZone: 'America/New_York',
          provider: { kind: 'provider', resourceRef: loc.provider },
          operatory: { kind: 'operatory', resourceRef: loc.operatory },
        }),
        201,
      );
    }
    const tables = [
      'appointment_series',
      'appointments',
      'audit_events',
      'command_idempotency',
      'outbox_events',
    ];
    const before = await Promise.all(tables.map((t) => count(db, t)));
    const plan = h.ok<{
      data: {
        limit: { name: string; value: number; ceiling: number };
        conflicted: number;
        occurrences: { index: number; localDate: string; conflicts: { kind: string }[] }[];
      };
    }>(await h.call('a1', 'POST', `${SERIES}/plan`, body(loc, patient, { count: 4 }), null));
    expect(plan.data.limit).toStrictEqual({
      name: 'scheduling.series.occurrenceLimit',
      value: 26,
      ceiling: 52,
    });
    expect(plan.data.occurrences.map((o) => [o.index, o.localDate, o.conflicts.length > 0])).toStrictEqual([
      [1, '2031-01-06', false],
      [2, '2031-01-13', true],
      [3, '2031-01-20', true],
      [4, '2031-01-27', false],
    ]);
    expect(plan.data.conflicted).toBe(2);
    expect(await Promise.all(tables.map((t) => count(db, t)))).toStrictEqual(before);
  });

  it('4. later conflicts refuse the series atomically; with skipConflicts the created and skipped sets reconcile', async () => {
    const loc = await newLocation();
    const patient = await createPatient(h, 'Synthetic Series');
    h.ok(
      await h.call('a1', 'POST', APPT, {
        patientRef: await createPatient(h, 'Synthetic Blocker'),
        locationRef: loc.locationRef,
        startsAt: '2031-01-20T15:00:00Z',
        endsAt: '2031-01-20T16:00:00Z',
        timeZone: 'America/New_York',
        provider: { kind: 'provider', resourceRef: loc.provider },
        operatory: { kind: 'operatory', resourceRef: loc.operatory },
      }),
      201,
    );
    const before = await count(db, 'appointments');
    const refused = await create(loc, patient, { count: 4 });
    expect([refused.statusCode, refused.json().detail?.reason]).toStrictEqual([409, 'booking_conflict']);
    expect(
      refused
        .json()
        .detail.occurrences.map((o: { index: number; startsAt: string }) => [o.index, o.startsAt]),
    ).toStrictEqual([[3, '2031-01-20T15:00:00.000Z']]);
    expect(await count(db, 'appointments')).toBe(before);
    const partial = h.ok<{ data: SeriesData }>(
      await create(loc, patient, { count: 4, skipConflicts: true }),
      201,
    );
    expect([partial.data.requested, partial.data.created, partial.data.skipped]).toStrictEqual([4, 3, 1]);
    expect(partial.data.created + partial.data.skipped).toBe(partial.data.requested);
    // The 201 stays, but the result says explicitly that it is partial; a complete series is not.
    expect(partial.data.partial).toBe(true);
    expect(partial.data.skippedOccurrences).toStrictEqual([
      { index: 3, localDate: '2031-01-20', reason: 'resource_overlap' },
    ]);
    const series = await read(partial.data.seriesRef);
    expect(series.occurrences.map((o) => [o.index, o.outcome])).toStrictEqual([
      [1, 'booked'],
      [2, 'booked'],
      [3, 'skipped'],
      [4, 'booked'],
    ]);
  });

  it('5. month-end rule (S-S3-R1): an anchor on day 31 falls on the last day of shorter months and returns to 31', async () => {
    const loc = await newLocation(ALL_WEEK);
    const patient = await createPatient(h, 'Synthetic Series');
    const s = h.ok<{ data: SeriesData }>(
      await create(loc, patient, {
        pattern: { frequency: 'monthly', interval: 1 },
        firstDate: '2031-01-31',
        count: 4,
      }),
      201,
    ).data;
    expect((await read(s.seriesRef)).occurrences.map((o) => o.localDate)).toStrictEqual([
      '2031-01-31',
      '2031-02-28',
      '2031-03-31',
      '2031-04-30',
    ]);
    const leap = h.ok<{ data: SeriesData }>(
      await create(loc, patient, {
        pattern: { frequency: 'monthly', interval: 1 },
        firstDate: '2032-01-31',
        startTime: '11:00',
        count: 3,
      }),
      201,
    ).data;
    expect((await read(leap.seriesRef)).occurrences.map((o) => o.localDate)).toStrictEqual([
      '2032-01-31',
      '2032-02-29',
      '2032-03-31',
    ]);
  });

  it('5b. daylight-saving rule (S-S3-R2): a missing local time moves forward by the gap; a repeated one takes the earlier instant', async () => {
    const loc = await newLocation(ALL_WEEK);
    const patient = await createPatient(h, 'Synthetic Series');
    const spring = h.ok<{ data: SeriesData }>(
      await create(loc, patient, {
        firstDate: '2031-03-02',
        startTime: '02:30',
        durationMinutes: 30,
        count: 3,
      }),
      201,
    ).data;
    expect((await read(spring.seriesRef)).occurrences.map((o) => [o.localDate, o.startsAt])).toStrictEqual([
      ['2031-03-02', '2031-03-02T07:30:00.000Z'],
      ['2031-03-09', '2031-03-09T07:30:00.000Z'],
      ['2031-03-16', '2031-03-16T06:30:00.000Z'],
    ]);
    const fall = h.ok<{ data: SeriesData }>(
      await create(loc, patient, {
        firstDate: '2031-10-26',
        startTime: '01:30',
        durationMinutes: 60,
        count: 3,
      }),
      201,
    ).data;
    expect((await read(fall.seriesRef)).occurrences.map((o) => [o.startsAt, o.endsAt])).toStrictEqual([
      ['2031-10-26T05:30:00.000Z', '2031-10-26T06:30:00.000Z'],
      ['2031-11-02T05:30:00.000Z', '2031-11-02T06:30:00.000Z'],
      ['2031-11-09T06:30:00.000Z', '2031-11-09T07:30:00.000Z'],
    ]);
  });

  it('6. re-submission with the same key returns the same occurrence set without duplicates', async () => {
    const loc = await newLocation();
    const patient = await createPatient(h, 'Synthetic Series');
    const key = randomUUID();
    const a = h.ok<{ data: SeriesData; replayed: boolean }>(await create(loc, patient, {}, key), 201);
    const before = await count(db, 'appointments');
    const b = h.ok<{ data: SeriesData; replayed: boolean }>(await create(loc, patient, {}, key), 201);
    expect(b.replayed).toBe(true);
    expect(b.data.appointmentRefs).toStrictEqual(a.data.appointmentRefs);
    expect(b.data.seriesRef).toBe(a.data.seriesRef);
    expect(await count(db, 'appointments')).toBe(before);
  });

  it('7. a cross-tenant series is refused and never references a foreign resource', async () => {
    const loc = await newLocation();
    const patient = await createPatient(h, 'Synthetic Series');
    const s = h.ok<{ data: SeriesData }>(await create(loc, patient), 201).data;
    const foreignRead = await h.call('b1', 'GET', `${SERIES}/${s.seriesRef}`);
    expect(foreignRead.statusCode).toBe(404);
    const betaPatient = await createPatient(h, 'Synthetic Beta', 'b1');
    const foreign = await h.call('b1', 'POST', SERIES, body(loc, betaPatient));
    expect([foreign.statusCode, foreign.json().code]).toStrictEqual([404, 'not_found']);
    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.appointments a JOIN cuspatlas.scheduling_resources r
       ON r.id = a.provider_id WHERE a.tenant_id <> r.tenant_id`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('S13 failure and recovery', () => {
  it('1. a creation that fails after its last occurrence is written rolls back every occurrence and audit row', async () => {
    const loc = await newLocation();
    const patient = await createPatient(h, 'Synthetic Series');
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    const tables = [
      'appointment_series',
      'appointment_series_occurrences',
      'appointments',
      'audit_events',
      'outbox_events',
    ];
    const before = await Promise.all(tables.map((t) => count(db, t)));
    const faulty = domainAppointments(db, {
      execute: async (_c, _e, _t, handler) => {
        await handler();
        throw new Error('synthetic fault after the last occurrence');
      },
    });
    await expect(
      faulty.createSeries(a1, envelope('scheduling.series.create', body(loc, patient, { count: 5 }))),
    ).rejects.toThrow();
    expect(await Promise.all(tables.map((t) => count(db, t)))).toStrictEqual(before);
  });

  it('2. lowering the configured limit never truncates an existing series; it applies to new requests only', async () => {
    const loc = await newLocation();
    const patient = await createPatient(h, 'Synthetic Series');
    const s = h.ok<{ data: SeriesData }>(
      await create(loc, patient, { count: 12, startTime: '14:00' }),
      201,
    ).data;
    await db.admin.query(
      `INSERT INTO cuspatlas.scheduling_policy_settings (tenant_id, series_occurrence_limit) VALUES ($1, 10)
       ON CONFLICT (tenant_id) DO UPDATE SET series_occurrence_limit = 10`,
      [T_ALPHA],
    );
    try {
      expect((await read(s.seriesRef)).occurrences).toHaveLength(12);
      const over = await create(loc, patient, { count: 11, startTime: '09:00' });
      expect(over.json().detail?.limit).toStrictEqual({
        name: 'scheduling.series.occurrenceLimit',
        value: 10,
      });
      const ext = await h.call('a1', 'POST', `${SERIES}/${s.seriesRef}/extend`, {
        expectedVersion: 1,
        count: 11,
      });
      expect([ext.statusCode, ext.json().detail?.limit?.value]).toStrictEqual([422, 10]);
    } finally {
      await db.admin.query('UPDATE cuspatlas.scheduling_policy_settings SET series_occurrence_limit = 26');
    }
    expect((await read(s.seriesRef)).occurrences).toHaveLength(12);
  });

  it('continuation is explicit: extendSeries books the next block from where the series stopped', async () => {
    const loc = await newLocation();
    const patient = await createPatient(h, 'Synthetic Series');
    const s = h.ok<{ data: SeriesData }>(await create(loc, patient, { count: 2 }), 201).data;
    const ext = h.ok<{ data: SeriesData; version: number }>(
      await h.call('a1', 'POST', `${SERIES}/${s.seriesRef}/extend`, { expectedVersion: 1, count: 2 }),
      201,
    );
    expect([ext.data.created, ext.version]).toStrictEqual([2, 2]);
    expect((await read(s.seriesRef)).occurrences.map((o) => [o.index, o.localDate])).toStrictEqual([
      [1, '2031-01-06'],
      [2, '2031-01-13'],
      [3, '2031-01-20'],
      [4, '2031-01-27'],
    ]);
    const stale = await h.call('a1', 'POST', `${SERIES}/${s.seriesRef}/extend`, {
      expectedVersion: 1,
      count: 1,
    });
    expect([stale.statusCode, stale.json().code]).toStrictEqual([409, 'stale_version']);
  });

  it('3. a provider leaving the schedule requires endSeries and explicit reassignment; ending deletes nothing', async () => {
    const loc = await newLocation();
    const patient = await createPatient(h, 'Synthetic Series');
    const s = h.ok<{ data: SeriesData }>(await create(loc, patient, { count: 3 }), 201).data;
    // S7 refuses to deactivate a resource that still has future bookings (it points to ending its
    // availability at a date instead), so the provider leaves the schedule through an availability
    // version with no hours after the series' last occurrence.
    const deactivate = await h.call('a1', 'POST', `/v1/scheduling/resources/${loc.provider}/deactivate`, {
      expectedVersion: 1,
    });
    expect([deactivate.statusCode, deactivate.json().code]).toStrictEqual([409, 'conflict']);
    h.ok(
      await h.call('a1', 'POST', `/v1/scheduling/resources/${loc.provider}/availability`, {
        effectiveFrom: '2031-01-21',
        weekly: [],
      }),
      201,
    );
    const ext = await h.call('a1', 'POST', `${SERIES}/${s.seriesRef}/extend`, {
      expectedVersion: 1,
      count: 1,
    });
    expect([ext.statusCode, ext.json().detail?.reason]).toStrictEqual([409, 'booking_conflict']);
    const ended = h.ok<{ data: SeriesData & { openOccurrenceRefs: string[] } }>(
      await h.call('a1', 'POST', `${SERIES}/${s.seriesRef}/end`, {
        expectedVersion: 1,
        reasonCode: 'provider_unavailable',
      }),
    );
    expect(ended.data.state).toBe('ended');
    // Future occurrences still stand and are named for explicit reassignment.
    expect([...ended.data.openOccurrenceRefs].sort()).toStrictEqual([...s.appointmentRefs].sort());
    for (const ref of s.appointmentRefs) {
      expect(
        h.ok<{ data: { status: string } }>(await h.call('a1', 'GET', `${APPT}/${ref}`)).data.status,
      ).toBe('booked');
    }
    const again = await h.call('a1', 'POST', `${SERIES}/${s.seriesRef}/extend`, {
      expectedVersion: 2,
      count: 1,
    });
    expect([again.statusCode, again.json().detail?.reason]).toStrictEqual([409, 'series_not_active']);
  });

  it('4. two concurrent creations of the same series produce one series and one full-set conflict', async () => {
    const loc = await newLocation();
    const p1 = await createPatient(h, 'Synthetic Series');
    const p2 = await createPatient(h, 'Synthetic Series');
    const [r1, r2] = await Promise.all([create(loc, p1, { count: 3 }), create(loc, p2, { count: 3 })]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toStrictEqual([201, 409]);
    const loser = r1.statusCode === 409 ? r1 : r2;
    expect(loser.json().detail.occurrences.map((o: { index: number }) => o.index)).toStrictEqual([1, 2, 3]);
    const { rows } = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.appointments WHERE provider_id = $1',
      [loc.provider],
    );
    expect(rows[0].n).toBe(3);
  });
});
