import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  count,
  createPatient,
  openAppointmentHarness,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';

/**
 * S21 (OR-06, OR-D1): per-operatory floor read from S11 attendance, provider request facts with
 * acknowledge/clear (internal staff notification only, never patient-facing) and expiring self-set
 * staff presence. The shared-display rule is served as an explicit `anonymized` projection until the
 * A18 display principal exists. Synthetic data only, runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let patient: string;
let appointment: string;
const FLOOR = '/v1/scheduling/floor';

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
type Op = { operatoryRef: string; currentVisit: Record<string, unknown> | null } & Record<string, unknown>;
const floor = async (projection?: string) => {
  const res = await h.call(
    'a1',
    'GET',
    `${FLOOR}?locationRef=${loc.locationRef}${projection ? `&projection=${projection}` : ''}`,
  );
  expect(res.statusCode, res.body).toBe(200);
  return res;
};
const visitOf = async () => {
  const data = (await floor()).json().data as { operatories: Op[] };
  return data.operatories.find((o) => o.operatoryRef === loc.operatory)?.currentVisit ?? null;
};

beforeAll(async () => {
  db = await openTestDatabase('floor_view');
  h = await openAppointmentHarness(db, { mcp: true });
  // Hours from yesterday (seedLocation hours start in 2030): the visit happens now.
  const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
    new Date(now - 86_400_000),
  );
  h.ok(
    await h.call('a1', 'POST', '/v1/scheduling/locations', {
      locationRef: 'loc-north',
      displayLabel: 'Synthetic floor',
      timeZone: 'America/New_York',
    }),
    201,
  );
  const define = async (kind: string, displayLabel: string) => {
    const ref = h.ok<{ data: { resourceRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/resources', {
        kind,
        locationRef: 'loc-north',
        displayLabel,
      }),
      201,
    ).data.resourceRef;
    h.ok(
      await h.call('a1', 'POST', `/v1/scheduling/resources/${ref}/availability`, {
        effectiveFrom: yesterday,
        weekly: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '00:00', end: '24:00' })),
      }),
      201,
    );
    return ref;
  };
  loc = {
    locationRef: 'loc-north',
    provider: await define('provider', 'Synthetic Provider'),
    operatory: await define('operatory', 'Operatory 1'),
  };
  patient = await createPatient(h, 'Synthetic Floor');
  // Today's booking a little after now; arrival is recorded early (no arrival tolerance in S11).
  // Daily hours never span local midnight, so a booking that would cross it moves past midnight.
  const nyDate = (ms: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
  let start = Math.ceil((now + 5 * 60_000) / 300_000) * 300_000;
  if (nyDate(start) !== nyDate(start + 15 * 60_000)) start += 30 * 60_000;
  const r = await h.call('a1', 'POST', '/v1/scheduling/appointments', {
    patientRef: patient,
    locationRef: loc.locationRef,
    startsAt: iso(start),
    endsAt: iso(start + 15 * 60_000),
    timeZone: 'America/New_York',
    provider: { kind: 'provider', resourceRef: loc.provider },
    operatory: { kind: 'operatory', resourceRef: loc.operatory },
  });
  appointment = h.ok<{ data: { appointmentRef: string } }>(r, 201).data.appointmentRef;
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('S21 floor view, provider request and presence', () => {
  it('synthetic visit: arrival, in care, provider requested, acknowledged, cleared', async () => {
    const empty = (await floor()).json().data;
    expect(empty.envelope).toMatchObject({
      scope: { kind: 'explicit_locations', locationRefs: [loc.locationRef] },
      ordering: { key: 'displayOrder', direction: 'asc', tieBreak: 'operatoryRef' },
    });
    expect(await visitOf()).toBeNull();
    // A provider cannot be requested before the visit has begun.
    const early = await h.call('a1', 'POST', `/v1/scheduling/appointments/${appointment}/provider-requests`, {
      reasonCode: 'exam_ready',
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().detail.reason).toBe('visit_not_in_progress');

    for (const kind of ['arrived', 'in_care']) {
      const a = await h.call('a1', 'POST', `/v1/scheduling/appointments/${appointment}/attendance`, { kind });
      expect(a.statusCode, a.body).toBe(201);
    }
    let visit = await visitOf();
    expect(visit).toMatchObject({
      appointmentRef: appointment,
      patient: { patientRef: patient },
      attendanceState: 'in_care',
      label: 'In care',
      providerRequest: null,
    });
    expect(visit?.elapsedMinutes).toEqual(expect.any(Number));
    expect(visit?.nextActions).toEqual(expect.arrayContaining(['request_provider']));

    const intentsBefore = await count(db, 'notification_intents');
    const req = await h.call('a1', 'POST', `/v1/scheduling/appointments/${appointment}/provider-requests`, {
      reasonCode: 'exam_ready',
    });
    expect(req.statusCode, req.body).toBe(201);
    const request = req.json().data as { requestRef: string; state: string };
    expect(request.state).toBe('open');
    expect(
      (
        await h.call('a1', 'POST', `/v1/scheduling/appointments/${appointment}/provider-requests`, {
          reasonCode: 'exam_ready',
        })
      ).json().detail.reason,
    ).toBe('provider_request_open');
    // Internal staff notification only: an outbox fact, never a patient-facing intent.
    expect(await count(db, 'notification_intents')).toBe(intentsBefore);
    const outbox = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.outbox_events WHERE operation = 'scheduling.floor.requestProvider'`,
    );
    expect(outbox.rows[0].n).toBe(1);
    visit = await visitOf();
    expect(visit?.providerRequest).toMatchObject({ requestRef: request.requestRef, state: 'open' });
    expect(visit?.nextActions).toEqual(expect.arrayContaining(['acknowledge_provider_request']));

    const open = (
      await h.call('a1', 'GET', `${FLOOR}/provider-requests?locationRef=${loc.locationRef}`)
    ).json().data;
    expect(open.items.map((i: { requestRef: string }) => i.requestRef)).toStrictEqual([request.requestRef]);
    expect(open.envelope.count).toStrictEqual({ exact: 1 });

    const ack = await h.call(
      'a3',
      'POST',
      `/v1/scheduling/provider-requests/${request.requestRef}/acknowledge`,
      {
        expectedVersion: 1,
      },
    );
    expect(ack.statusCode, ack.body).toBe(200);
    expect(ack.json().data.state).toBe('acknowledged');
    const stale = await h.call('a1', 'POST', `/v1/scheduling/provider-requests/${request.requestRef}/clear`, {
      expectedVersion: 1,
      reasonCode: 'provider_arrived',
    });
    expect(stale.statusCode).toBe(409);
    const clear = await h.call('a3', 'POST', `/v1/scheduling/provider-requests/${request.requestRef}/clear`, {
      expectedVersion: 2,
      reasonCode: 'provider_arrived',
    });
    expect(clear.statusCode, clear.body).toBe(200);
    expect((await visitOf())?.providerRequest).toBeNull();
    const audit = await db.admin.query(
      'SELECT operation FROM cuspatlas.audit_events WHERE resource_ref = $1 ORDER BY resource_version',
      [request.requestRef],
    );
    expect(audit.rows.map((r) => r.operation)).toStrictEqual([
      'scheduling.floor.requestProvider',
      'scheduling.floor.acknowledgeProviderRequest',
      'scheduling.floor.clearProviderRequest',
    ]);
  });

  it('the anonymized display projection carries no patient or appointment identity', async () => {
    const res = await floor('anonymized');
    expect(res.body).not.toContain(patient);
    expect(res.body).not.toContain(appointment);
    const op = (res.json().data.operatories as Op[]).find((o) => o.operatoryRef === loc.operatory);
    expect(op?.currentVisit).toMatchObject({ patient: 'anonymized', attendanceState: 'in_care' });
    expect(res.json().data.projection).toBe('anonymized');
  });

  it('presence is self-set, audited and expires', async () => {
    const set = await h.call('a1', 'POST', '/v1/scheduling/presence', {
      locationRef: loc.locationRef,
      status: 'available',
      operatoryRef: loc.operatory,
      expiresInMinutes: 60,
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(
      (
        await h.call('a3', 'POST', '/v1/scheduling/presence', {
          locationRef: loc.locationRef,
          status: 'busy',
          expiresInMinutes: 30,
        })
      ).statusCode,
    ).toBe(200);
    // There is no field naming another principal: presence is always the caller's own.
    expect(
      (
        await h.call('a1', 'POST', '/v1/scheduling/presence', {
          locationRef: loc.locationRef,
          status: 'away',
          principalRef: '20000000-0000-4000-8000-0000000000a3',
        })
      ).statusCode,
    ).toBe(400);
    const list = async () =>
      (await h.call('a1', 'GET', `/v1/scheduling/presence?locationRef=${loc.locationRef}`)).json().data;
    expect((await list()).items).toHaveLength(2);
    expect((await list()).envelope.count).toStrictEqual({ exact: 2 });
    await db.admin.query(
      `UPDATE cuspatlas.scheduling_staff_presence SET set_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
       WHERE principal_id = '20000000-0000-4000-8000-0000000000a3'`,
    );
    const after = await list();
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ status: 'available', operatoryRef: loc.operatory });
    const audit = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.audit_events WHERE operation = 'scheduling.presence.set'`,
    );
    expect(audit.rows[0].n).toBe(2);
  });

  it('REST and MCP agree; another tenant is refused and nothing leaks', async () => {
    const rest = (await floor()).json().data;
    const m = await h.mcp('a1', 'scheduling_floor_read', { locationRef: loc.locationRef }, 200);
    const mdata = (m.body as { data: typeof rest }).data;
    const strip = (d: typeof rest) => ({
      ...d,
      envelope: { ...d.envelope, asOf: null },
      operatories: d.operatories.map((o: Op) =>
        o.currentVisit ? { ...o, currentVisit: { ...o.currentVisit, elapsedMinutes: null } } : o,
      ),
    });
    expect(strip(mdata)).toStrictEqual(strip(rest));
    const foreign = await h.call('b1', 'GET', `${FLOOR}?locationRef=${loc.locationRef}`);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain(MARKER);
    const req = await db.admin.query('SELECT id FROM cuspatlas.scheduling_provider_requests LIMIT 1');
    const ack = await h.call('b1', 'POST', `/v1/scheduling/provider-requests/${req.rows[0].id}/acknowledge`, {
      expectedVersion: 3,
    });
    expect(ack.statusCode).toBe(404);
  });
});
