import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
} from '../integration/support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from '../integration/support/db';
import { patientBody } from '../integration/support/patient-fixtures';

/**
 * S17 ordinary synthetic practice day, end to end through REST and MCP only, under the runtime role.
 * Every operational step goes through the domain transports; the superuser connection is used only
 * for read-back assertions and for the two configuration rows that have no write command yet (the
 * attendance reason vocabulary and the per-location offer policy), which a practice would configure.
 * Synthetic data only. Dates are in 2030 (bookings refuse a past start).
 */
let db: TestDatabase;
let h: AppointmentHarness;
const APPT = '/v1/scheduling/appointments';
const DAY = '2030-09-10'; // a Tuesday
const at = (hh: number, mm = 0) => `${DAY}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`;

beforeAll(async () => {
  db = await openTestDatabase('ordinary_day');
  h = await openAppointmentHarness(db, { mcp: true, pool: 8 });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('S17 ordinary scheduling day (synthetic)', () => {
  it('runs a practice day end to end with no direct table access outside the domain layer', async () => {
    const log: string[] = [];
    const step = (s: string) => log.push(s);

    // Morning setup: a location with a provider and an operatory, configured through admin commands.
    const loc = await seedLocation(h, 'loc-day');
    step('location, provider and operatory configured');
    const configuration = [
      ['no_show', 'no_contact'],
      ['left_without_treatment', 'wait_too_long'],
    ];
    for (const [kind, code] of configuration) {
      await db.admin.query(
        'INSERT INTO cuspatlas.scheduling_attendance_reasons (tenant_id, kind, reason_code) VALUES ($1, $2, $3)',
        [T_ALPHA, kind, code],
      );
    }
    await db.admin.query(
      `INSERT INTO cuspatlas.scheduling_offer_policies (tenant_id, location_id, policy_ref, offer_ttl_minutes)
       SELECT tenant_id, id, 'waitlist-offer-pending-approval-1', 30 FROM cuspatlas.scheduling_locations
       WHERE location_ref = 'loc-day'`,
    );

    // Patient registration (REST) and a guardian (MCP).
    const register = async (given: string, overrides: Record<string, unknown> = {}) =>
      h.ok<{ data: { patientRef: string } }>(
        await h.call('a1', 'POST', '/v1/patients', patientBody(given, overrides)),
        201,
      ).data.patientRef;
    const ada = await register('Synthetic Ada');
    const ben = await register('Synthetic Ben');
    const cleo = await register('Synthetic Cleo');
    const dan = await register('Synthetic Dan');
    const child = await register('Synthetic Child', {
      birthDate: { known: true, value: '2016-05-05', precision: 'day' },
    });
    const guardian = await h.mcp(
      'a1',
      'patients_add_relationship',
      {
        patientRef: child,
        counterpartyRef: ada,
        kind: 'guardian',
        scopes: ['demographics', 'scheduling'],
        evidenceRef: 'synthetic-evidence-day',
        idempotencyKey: 'day-guardian-1',
      },
      201,
    );
    expect(guardian.code).toBeNull();
    step('patients registered; guardian relationship recorded through MCP');

    // A phone request, then an availability search and a booking from the request.
    const request = h.ok<{ data: { requestRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/appointment-requests', {
        patientRef: ben,
        locationRef: loc.locationRef,
        sourceChannel: 'phone',
        contactConsent: 'unknown',
        flexibility: 'mornings',
      }),
      201,
    ).data.requestRef;
    const search = h.ok<{ data: { outcome: string; windows: { startsAt: string; endsAt: string }[] } }>(
      await h.call(
        'a1',
        'POST',
        '/v1/availability/search',
        {
          locationRef: loc.locationRef,
          from: DAY,
          to: DAY,
          durationMinutes: 60,
          displayTimeZone: 'America/New_York',
          requirements: [
            { kind: 'provider', resourceRef: loc.provider },
            { kind: 'operatory', resourceRef: loc.operatory },
          ],
        },
        null,
      ),
    ).data;
    expect(search.outcome).toBe('windows');
    const slot = (startsAt: string, endsAt: string) => ({
      startsAt,
      endsAt,
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    });
    const book = (patientRef: string, s: ReturnType<typeof slot>, extra: Record<string, unknown> = {}) =>
      h.call('a1', 'POST', APPT, { patientRef, locationRef: loc.locationRef, ...s, ...extra });
    const nine = slot(at(13), at(14)); // 09:00 EDT
    const benAppt = h.ok<{ data: { appointmentRef: string } }>(
      await book(ben, nine, { requestRef: request }),
      201,
    ).data.appointmentRef;
    step('request recorded, availability searched, booked from the request');

    // A second booking of the same slot is an inspectable conflict, not a silent failure.
    const clash = await book(cleo, nine);
    expect([clash.statusCode, clash.json().detail?.reason]).toStrictEqual([409, 'booking_conflict']);
    expect(clash.json().detail.conflicts[0].existingRef).toBe(benAppt);
    step('double booking refused with the conflict naming the booking');

    // Cleo and Dan book other slots; Ada books later and then reschedules.
    const cleoAppt = h.ok<{ data: { appointmentRef: string } }>(await book(cleo, slot(at(14), at(15))), 201)
      .data.appointmentRef;
    const danAppt = h.ok<{ data: { appointmentRef: string } }>(await book(dan, slot(at(15), at(16))), 201)
      .data.appointmentRef;
    const adaFirst = h.ok<{ data: { appointmentRef: string } }>(await book(ada, slot(at(16), at(17))), 201)
      .data.appointmentRef;
    const adaAppt = h.ok<{ data: { appointmentRef: string } }>(
      await h.call('a1', 'POST', `${APPT}/${adaFirst}/reschedule`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
        ...slot(at(17), at(18)),
      }),
    ).data.appointmentRef;
    step('bookings made; one rescheduled with both records linked');

    // Check-in: Ben confirmed by staff, arrives, waits and is seen; attendance never writes clinical state.
    for (const kind of ['confirmed_manual', 'arrived', 'waiting', 'in_care']) {
      h.ok(await h.call('a1', 'POST', `${APPT}/${benAppt}/attendance`, { kind }), 201);
    }
    const visit = h.ok<{ data: { attendance: { state: string }; clinicalCompletion: { ref: null } } }>(
      await h.call('a1', 'GET', `${APPT}/${benAppt}/visit-status`),
    ).data;
    expect([visit.attendance.state, visit.clinicalCompletion.ref]).toStrictEqual(['in_care', null]);
    // Cleo arrives but leaves without treatment; Dan does not come (no-show with a configured reason).
    h.ok(await h.call('a1', 'POST', `${APPT}/${cleoAppt}/attendance`, { kind: 'arrived' }), 201);
    h.ok(
      await h.call('a1', 'POST', `${APPT}/${cleoAppt}/attendance`, {
        kind: 'left_without_treatment',
        reasonCode: 'wait_too_long',
      }),
      201,
    );
    const noShow = await h.mcp(
      'a1',
      'scheduling_attendance_record',
      { appointmentRef: danAppt, kind: 'no_show', reasonCode: 'no_contact', idempotencyKey: 'day-no-show-1' },
      201,
    );
    expect(noShow.code).toBeNull();
    step('check-in through attendance states; left-without-treatment; no-show through MCP');

    // Cancellation recovery: Ada cancels; a waitlisted patient is offered the slot and accepts.
    const entry = h.ok<{ data: { entryRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/waitlist', {
        patientRef: cleo,
        locationRef: loc.locationRef,
        durationMinutes: 60,
        desiredFrom: `${DAY}T00:00:00Z`,
        desiredUntil: `${DAY}T23:59:00Z`,
        priority: 1,
      }),
      201,
    ).data.entryRef;
    h.ok(
      await h.call('a1', 'POST', `${APPT}/${adaAppt}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    const recovery = h
      .ok<{ data: { items: { workItemRef: string; evidenceRefs: { ref: string }[] }[] } }>(
        await h.call('a1', 'GET', `/v1/scheduling/recoveries?locationRef=${loc.locationRef}`),
      )
      .data.items.find((i) => i.evidenceRefs.some((e) => e.ref === adaAppt));
    expect(recovery).toBeDefined();
    const prepared = h.ok<{ data: { candidates: { entryRef: string }[]; automation: { mode: string } } }>(
      await h.call('a1', 'GET', `/v1/scheduling/recoveries/${recovery?.workItemRef}`),
    ).data;
    expect([prepared.candidates[0]?.entryRef, prepared.automation.mode]).toStrictEqual([
      entry,
      'prepare_for_approval',
    ]);
    const offer = h.ok<{ data: { offerRef: string; intentRef: string } }>(
      await h.call('a1', 'POST', `/v1/scheduling/recoveries/${recovery?.workItemRef}/execute`, {
        expectedVersion: 1,
        entryRef: entry,
      }),
      201,
    ).data;
    const accepted = h.ok<{ data: { appointmentRef: string } }>(
      await h.call('a1', 'POST', `/v1/scheduling/waitlist-offers/${offer.offerRef}/respond`, {
        expectedVersion: 1,
        outcome: 'accepted',
      }),
    ).data;
    step('cancellation recovered: prepared candidate offered (hold + intent) and accepted');

    // End of day: the worklist shows the separated facts, recall and notifications are lists, not sends.
    const worklist = h.ok<{
      data: {
        counts: Record<string, number>;
        appointments: { appointmentRef: string; attendanceState: string }[];
      };
    }>(await h.call('a1', 'GET', `/v1/scheduling/worklist?locationRef=${loc.locationRef}&date=${DAY}`)).data;
    const states = Object.fromEntries(
      worklist.appointments.map((a) => [a.appointmentRef, a.attendanceState]),
    );
    expect([
      states[benAppt],
      states[cleoAppt],
      states[danAppt],
      states[adaAppt],
      states[accepted.appointmentRef],
    ]).toStrictEqual(['in_care', 'left_without_treatment', 'no_show', 'cancelled', 'scheduled']);
    h.ok(
      await h.call('a1', 'POST', '/v1/scheduling/recall/policies', {
        category: 'hygiene',
        intervalMonths: 6,
        basis: 'attended_visit',
      }),
      201,
    );
    const recall = h.ok<{
      data: {
        due: { patientRef: string }[];
        noBaseline: { patientRef: string }[];
        policy: { version: number };
      };
    }>(
      await h.call(
        'a1',
        'GET',
        `/v1/scheduling/recall/due?category=hygiene&asOf=${encodeURIComponent('2031-04-01T12:00:00Z')}`,
      ),
    ).data;
    expect(recall.due.map((d) => d.patientRef)).toContain(ben);
    expect(recall.noBaseline.map((d) => d.patientRef)).toEqual(expect.arrayContaining([dan, child]));
    const notices = h.ok<{ data: { items: { workItemRef: string; reasonCode: string }[] } }>(
      await h.call('a1', 'GET', `/v1/scheduling/notifications/worklist?locationRef=${loc.locationRef}`),
    ).data;
    expect(notices.items.map((i) => i.workItemRef)).toContain(offer.intentRef);
    expect(new Set(notices.items.map((i) => i.reasonCode))).toStrictEqual(new Set(['no_verified_channel']));
    const receipts = await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.delivery_receipts');
    expect(receipts.rows[0].n).toBe(0);
    const followUp = h.ok<{ data: { coverage: { status: string }; notCovered: unknown[] } }>(
      await h.call('a1', 'GET', '/v1/scheduling/follow-up/worklist'),
    ).data;
    expect([followUp.coverage.status, followUp.notCovered.length]).toStrictEqual(['available', 3]);
    const exported = h.ok<{ data: { tables: Record<string, unknown[]> } }>(
      await h.call('a1', 'GET', '/v1/scheduling/export'),
    ).data;
    expect((exported.tables.appointments ?? []).length).toBe(6);
    step('end of day: worklist, recall due list, notification and follow-up work items, export');

    // No double booking anywhere in the day: at most one live appointment per resource and instant.
    const overlaps = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.scheduling_occupancy a JOIN cuspatlas.scheduling_occupancy b
       ON a.resource_id = b.resource_id AND a.id < b.id AND a.during && b.during
       WHERE a.released_at IS NULL AND b.released_at IS NULL`,
    );
    expect(overlaps.rows[0].n).toBe(0);
    // Structural: this scenario writes through the transports only; its superuser statements are reads
    // except the two configuration inserts named above.
    const source = readFileSync(new URL(import.meta.url), 'utf8');
    const writes = [...source.matchAll(/db\.admin\.query\(\s*[`'"](\s*)(INSERT|UPDATE|DELETE)/g)];
    expect(writes.length).toBe(2);
    expect(log).toHaveLength(8);
    process.stdout.write(
      `\nORDINARY DAY (${log.length} steps)\n${log.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n`,
    );
  });
});
