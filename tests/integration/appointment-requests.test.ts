import { randomUUID } from 'node:crypto';
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
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';

/**
 * S8: the appointment request is its own fact. A request holds no resource and blocks nothing; it
 * reaches `scheduled` only through a booking link (S10). Every call goes through REST under the
 * runtime role; MCP parity is covered by the shared negative harness and tool drift tests.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };

const BASE = '/v1/scheduling/appointment-requests';
const body = (patientRef: string, extra: Record<string, unknown> = {}) => ({
  patientRef,
  locationRef: loc.locationRef,
  sourceChannel: 'phone',
  contactConsent: 'granted',
  flexibility: 'mornings',
  urgent: false,
  ...extra,
});

beforeAll(async () => {
  db = await openTestDatabase('appointment_requests');
  h = await openAppointmentHarness(db);
  loc = await seedLocation(h, 'loc-req');
});

afterAll(async () => {
  await h?.app.close();
  await db?.close();
});

async function createRequest(patientRef: string, extra: Record<string, unknown> = {}, key = randomUUID()) {
  return h.call('a1', 'POST', BASE, body(patientRef, extra), key);
}

describe('S8 appointment request as a separate fact', () => {
  it('1. a request creates no appointment, holds no resource and blocks no slot', async () => {
    const patient = await createPatient(h, 'Synthetic Requester');
    const occupancyBefore = await count(db, 'scheduling_occupancy');
    const res = h.ok<{ data: { requestRef: string; state: string }; version: number }>(
      await createRequest(patient, {
        preferredWindows: [{ startsAt: '2030-03-04T14:00:00Z', endsAt: '2030-03-04T16:00:00Z' }],
        providerPreference: loc.provider,
        appointmentTypeCode: 'recall-exam',
        urgent: true,
        note: `Synthetic note ${MARKER}`,
      }),
      201,
    );
    expect(res.data.state).toBe('open');
    expect(res.version).toBe(1);
    expect(await count(db, 'scheduling_occupancy')).toBe(occupancyBefore);
    const read = h.ok<{ data: Record<string, unknown> }>(
      await h.call('a1', 'GET', `${BASE}/${res.data.requestRef}`),
    );
    expect(read.data).toMatchObject({
      requestRef: res.data.requestRef,
      patientRef: patient,
      locationRef: loc.locationRef,
      origin: 'staff',
      sourceChannel: 'phone',
      urgent: true,
      state: 'open',
      appointmentRef: null,
      providerPreference: loc.provider,
    });
    // Urgency is a flag, never a state; the request still blocks nothing for availability.
    const search = h.ok<{ data: { windows: { startsAt: string }[] } }>(
      await h.call('a1', 'POST', '/v1/availability/search', {
        locationRef: loc.locationRef,
        from: '2030-03-04',
        to: '2030-03-04',
        durationMinutes: 60,
        displayTimeZone: 'America/New_York',
        requirements: [{ kind: 'provider', resourceRef: loc.provider }],
      }),
    );
    expect(search.data.windows.map((w) => w.startsAt)).toContain('2030-03-04T14:00:00.000Z');
    // No appointment table row exists for the patient (the booking table may not exist yet).
    const appointments = await db.admin.query(
      `SELECT to_regclass('cuspatlas.appointments') IS NOT NULL AS present`,
    );
    if (appointments.rows[0].present) {
      const { rows } = await db.admin.query(
        'SELECT count(*)::int AS n FROM cuspatlas.appointments WHERE subject_patient_id = $1',
        [patient],
      );
      expect(rows[0].n).toBe(0);
    }
    // The note never leaves the request table.
    expect(await leakTables(db)).not.toContain(MARKER);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });

  it('2. a replay under the same key returns the same request; a second request stays independent', async () => {
    const patient = await createPatient(h, 'Synthetic Replay');
    const key = randomUUID();
    const first = h.ok<{ data: { requestRef: string }; replayed: boolean }>(
      await createRequest(patient, {}, key),
      201,
    );
    const again = h.ok<{ data: { requestRef: string }; replayed: boolean }>(
      await createRequest(patient, {}, key),
      201,
    );
    expect(again.data.requestRef).toBe(first.data.requestRef);
    expect(again.replayed).toBe(true);
    const second = h.ok<{ data: { requestRef: string } }>(await createRequest(patient), 201);
    expect(second.data.requestRef).not.toBe(first.data.requestRef);
    const list = h.ok<{ data: { requestRef: string }[] }>(
      await h.call('a1', 'GET', `${BASE}?patientRef=${patient}`),
    );
    expect(list.data.map((r) => r.requestRef).sort()).toStrictEqual(
      [first.data.requestRef, second.data.requestRef].sort(),
    );
  });

  it('3. an inactive or deceased patient is refused naming the patient state', async () => {
    const inactive = await createPatient(h, 'Synthetic Inactive');
    await setPatientStatus(h, inactive, 'inactive');
    const deceased = await createPatient(h, 'Synthetic Deceased');
    await setPatientStatus(h, deceased, 'deceased');
    const before = await count(db, 'appointment_requests');
    for (const [ref, reason] of [
      [inactive, 'patient_inactive'],
      [deceased, 'patient_deceased'],
    ] as const) {
      const res = await createRequest(ref);
      expect([res.statusCode, res.json().code, res.json().detail?.reason]).toStrictEqual([
        409,
        'conflict',
        reason,
      ]);
    }
    expect(await count(db, 'appointment_requests')).toBe(before);
  });

  it("4. another tenant's patient or location is refused without revealing existence", async () => {
    const alphaPatient = await createPatient(h, 'Synthetic Alpha');
    await seedLocation(h, 'loc-beta-req', { who: 'b1' });
    const betaPatient = await createPatient(h, 'Synthetic Beta', 'b1');
    // Beta names alpha's patient at its own location; alpha names beta's patient.
    const asBeta = await h.call('b1', 'POST', BASE, { ...body(alphaPatient), locationRef: 'loc-beta-req' });
    const asAlpha = await createRequest(betaPatient);
    const missing = await createRequest(randomUUID());
    for (const r of [asBeta, asAlpha, missing])
      expect([r.statusCode, r.json().code]).toStrictEqual([404, 'not_found']);
    expect(asBeta.json().detail).toStrictEqual(missing.json().detail);
    // Alpha's location named by beta: identical to a location that does not exist.
    const betaPatientAtAlpha = await h.call('b1', 'POST', BASE, body(betaPatient));
    const nowhere = await h.call('b1', 'POST', BASE, { ...body(betaPatient), locationRef: 'loc-nowhere' });
    expect([betaPatientAtAlpha.statusCode, betaPatientAtAlpha.json().code]).toStrictEqual([404, 'not_found']);
    expect(betaPatientAtAlpha.json().detail).toStrictEqual(nowhere.json().detail);
  });

  it('5. closing as scheduled without a booking reference is refused and changes nothing', async () => {
    const patient = await createPatient(h, 'Synthetic Close');
    const r = h.ok<{ data: { requestRef: string } }>(await createRequest(patient), 201);
    const res = await h.call('a1', 'POST', `${BASE}/${r.data.requestRef}/close`, {
      expectedVersion: 1,
      state: 'scheduled',
      reasonCode: 'booked',
    });
    expect([res.statusCode, res.json().code]).toStrictEqual([422, 'validation_failed']);
    expect(res.json().detail.violations).toStrictEqual([{ pointer: '/appointmentRef', rule: 'required' }]);
    const read = h.ok<{ data: { state: string; version: number } }>(
      await h.call('a1', 'GET', `${BASE}/${r.data.requestRef}`),
    );
    expect([read.data.state, read.data.version]).toStrictEqual(['open', 1]);
  });

  it('5b. review and decline are recorded transitions with reasons and audit', async () => {
    const patient = await createPatient(h, 'Synthetic Decline');
    const r = h.ok<{ data: { requestRef: string } }>(await createRequest(patient), 201);
    const ref = r.data.requestRef;
    h.ok(await h.call('a1', 'POST', `${BASE}/${ref}/review`, { expectedVersion: 1 }));
    const closed = h.ok<{ data: { state: string }; version: number }>(
      await h.call('a1', 'POST', `${BASE}/${ref}/close`, {
        expectedVersion: 2,
        state: 'declined',
        reasonCode: 'patient_declined',
      }),
    );
    expect([closed.data.state, closed.version]).toStrictEqual(['declined', 3]);
    const read = h.ok<{
      data: { transitions: { from: string | null; to: string; reasonCode: string | null }[] };
    }>(await h.call('a1', 'GET', `${BASE}/${ref}`));
    expect(read.data.transitions.map((t) => [t.from, t.to, t.reasonCode])).toStrictEqual([
      [null, 'open', null],
      ['open', 'in_review', null],
      ['in_review', 'declined', 'patient_declined'],
    ]);
    const audit = await db.admin.query(
      `SELECT operation FROM cuspatlas.audit_events WHERE resource_ref = $1 ORDER BY occurred_at, operation`,
      [ref],
    );
    expect(audit.rows.map((a) => a.operation)).toStrictEqual([
      'scheduling.requests.create',
      'scheduling.requests.review',
      'scheduling.requests.close',
    ]);
    // A terminal request is listed by the report of requests that never became bookings.
    const report = h.ok<{ data: { count: number; requests: { requestRef: string; state: string }[] } }>(
      await h.call('a1', 'GET', '/v1/scheduling/reports/unbooked-requests'),
    );
    expect(report.data.requests).toContainEqual(
      expect.objectContaining({ requestRef: ref, state: 'declined', reasonCode: 'patient_declined' }),
    );
    // An open request is not terminal and is not on the report.
    const open = h.ok<{ data: { requestRef: string } }>(await createRequest(patient), 201);
    expect(report.data.requests.map((x) => x.requestRef)).not.toContain(open.data.requestRef);
  });

  it('6. expiry requires the configured expiry policy; without one the request does not expire', async () => {
    const patient = await createPatient(h, 'Synthetic Expiry');
    const r = h.ok<{ data: { requestRef: string } }>(await createRequest(patient), 201);
    const expire = (policy?: string) =>
      h.call('a1', 'POST', `${BASE}/${r.data.requestRef}/close`, {
        expectedVersion: 1,
        state: 'expired',
        reasonCode: 'no_response',
        ...(policy ? { expiryPolicyRef: policy } : {}),
      });
    const none = await expire('request-expiry-90d');
    expect([none.statusCode, none.json().detail.violations]).toStrictEqual([
      422,
      [{ pointer: '/expiryPolicyRef', rule: 'expiryPolicyNotConfigured' }],
    ]);
    await db.admin.query(
      `INSERT INTO cuspatlas.scheduling_policy_settings (tenant_id, request_expiry_policy_ref)
       VALUES ($1, 'request-expiry-90d')
       ON CONFLICT (tenant_id) DO UPDATE SET request_expiry_policy_ref = EXCLUDED.request_expiry_policy_ref`,
      [T_ALPHA],
    );
    const missing = await expire();
    expect(missing.json().detail.violations).toStrictEqual([
      { pointer: '/expiryPolicyRef', rule: 'required' },
    ]);
    const other = await expire('request-expiry-30d');
    expect(other.json().detail.violations).toStrictEqual([
      { pointer: '/expiryPolicyRef', rule: 'expiryPolicyMismatch' },
    ]);
    const done = h.ok<{ data: { state: string } }>(await expire('request-expiry-90d'));
    expect(done.data.state).toBe('expired');
  });

  it('preferences update under an expected version; a stale version is refused', async () => {
    const patient = await createPatient(h, 'Synthetic Prefs');
    const r = h.ok<{ data: { requestRef: string } }>(await createRequest(patient), 201);
    const url = `${BASE}/${r.data.requestRef}/preferences`;
    const updated = h.ok<{ version: number }>(
      await h.call('a1', 'POST', url, { expectedVersion: 1, flexibility: 'afternoons', urgent: true }),
    );
    expect(updated.version).toBe(2);
    const stale = await h.call('a1', 'POST', url, { expectedVersion: 1, urgent: false });
    expect([stale.statusCode, stale.json().code]).toStrictEqual([409, 'stale_version']);
    const read = h.ok<{ data: { flexibility: string; urgent: boolean; state: string } }>(
      await h.call('a1', 'GET', `${BASE}/${r.data.requestRef}`),
    );
    expect(read.data).toMatchObject({ flexibility: 'afternoons', urgent: true, state: 'open' });
  });

  it('a request needs a stated preference: windows or flexibility', async () => {
    const patient = await createPatient(h, 'Synthetic No Pref');
    const { flexibility: _f, ...rest } = body(patient);
    const res = await h.call('a1', 'POST', BASE, rest);
    expect([res.statusCode, res.json().detail.violations]).toStrictEqual([
      422,
      [{ pointer: '/', rule: 'preferenceRequired' }],
    ]);
  });
});

describe('S8 failure and recovery', () => {
  it('1. a merge before review re-points the request to the survivor and it stays open', async () => {
    const survivor = await createPatient(h, 'Synthetic Twin');
    const merged = await createPatient(h, 'Synthetic Twin');
    const r = h.ok<{ data: { requestRef: string } }>(await createRequest(merged), 201);
    await mergePatients(h, survivor, merged);
    const read = h.ok<{ data: { patientRef: string; state: string } }>(
      await h.call('a1', 'GET', `${BASE}/${r.data.requestRef}`),
    );
    expect(read.data).toMatchObject({ patientRef: survivor, state: 'open' });
    const history = h.ok<{ data: { moves: { recordClass: string; recordRef: string }[] } }>(
      await h.call('a1', 'GET', `/v1/patients/${merged}/merge-history`),
    );
    expect(JSON.stringify(history.data)).toContain(r.data.requestRef);
  });

  it('2. a request for a deactivated location is refused naming the location state', async () => {
    await seedLocation(h, 'loc-closed');
    await db.admin.query(
      `UPDATE cuspatlas.scheduling_locations SET status = 'inactive', version = version + 1 WHERE location_ref = 'loc-closed'`,
    );
    const patient = await createPatient(h, 'Synthetic Closed Loc');
    const res = await h.call('a1', 'POST', BASE, { ...body(patient), locationRef: 'loc-closed' });
    expect([res.statusCode, res.json().detail.violations]).toStrictEqual([
      422,
      [{ pointer: '/locationRef', rule: 'locationInactive' }],
    ]);
  });

  it('3. two staff closing the same request concurrently: one transition, one conflict', async () => {
    const patient = await createPatient(h, 'Synthetic Race');
    const r = h.ok<{ data: { requestRef: string } }>(await createRequest(patient), 201);
    const close = (state: string) =>
      h.call('a1', 'POST', `${BASE}/${r.data.requestRef}/close`, {
        expectedVersion: 1,
        state,
        reasonCode: 'patient_request',
      });
    const results = await Promise.all([close('withdrawn'), close('declined')]);
    const statuses = results.map((x) => x.statusCode).sort();
    expect(statuses).toStrictEqual([200, 409]);
    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.appointment_request_transitions WHERE request_id = $1
         AND to_state IN ('withdrawn', 'declined')`,
      [r.data.requestRef],
    );
    expect(rows[0].n).toBe(1);
  });

  it('4. reopening a closed request is an explicit command with a reason, never automatic', async () => {
    const patient = await createPatient(h, 'Synthetic Reopen');
    const r = h.ok<{ data: { requestRef: string } }>(await createRequest(patient), 201);
    const ref = r.data.requestRef;
    h.ok(
      await h.call('a1', 'POST', `${BASE}/${ref}/close`, {
        expectedVersion: 1,
        state: 'withdrawn',
        reasonCode: 'patient_request',
      }),
    );
    const noReason = await h.call('a1', 'POST', `${BASE}/${ref}/reopen`, { expectedVersion: 2 });
    expect(noReason.statusCode).toBe(400);
    const reopened = h.ok<{ data: { state: string }; version: number }>(
      await h.call('a1', 'POST', `${BASE}/${ref}/reopen`, {
        expectedVersion: 2,
        reasonCode: 'patient_called_back',
      }),
    );
    expect([reopened.data.state, reopened.version]).toStrictEqual(['open', 3]);
    // An open request cannot be "reopened".
    const again = await h.call('a1', 'POST', `${BASE}/${ref}/reopen`, {
      expectedVersion: 3,
      reasonCode: 'other',
    });
    expect([again.statusCode, again.json().detail.reason]).toStrictEqual([409, 'request_not_closed']);
  });

  it('a location-restricted scheduler cannot create or read requests at another location', async () => {
    const patient = await createPatient(h, 'Synthetic Restricted');
    const denied = await h.call('a3', 'POST', BASE, body(patient));
    expect([denied.statusCode, denied.json().code]).toStrictEqual([403, 'forbidden']);
    const r = h.ok<{ data: { requestRef: string } }>(await createRequest(patient), 201);
    const read = await h.call('a3', 'GET', `${BASE}/${r.data.requestRef}`);
    expect([read.statusCode, read.json().code]).toStrictEqual([404, 'not_found']);
    const list = h.ok<{ data: { requestRef: string }[] }>(await h.call('a3', 'GET', BASE));
    expect(list.data.map((x) => x.requestRef)).not.toContain(r.data.requestRef);
  });
});
