import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  openAppointmentHarness,
  seedLocation,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';

/**
 * S20 (OR-05, OR-D2): a bounded per-location staging list for appointments being moved. An entry
 * references a booked appointment (which keeps its booking and occupancy) or an open request; a move
 * is the S10 reschedule in one transaction; capacity is configurable (default 10) and a refusal names
 * it. Synthetic data only, runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let patient: string;
const APPT = '/v1/scheduling/appointments';
const STAGING = '/v1/scheduling/staging';

const slot = (startsAt: string, endsAt: string) => ({
  startsAt,
  endsAt,
  timeZone: 'America/New_York',
  provider: { kind: 'provider', resourceRef: loc.provider },
  operatory: { kind: 'operatory', resourceRef: loc.operatory },
});
async function book(startsAt: string, endsAt: string): Promise<string> {
  const r = await h.call('a1', 'POST', APPT, {
    patientRef: patient,
    locationRef: loc.locationRef,
    ...slot(startsAt, endsAt),
  });
  return h.ok<{ data: { appointmentRef: string } }>(r, 201).data.appointmentRef;
}
const stage = (body: Record<string, unknown>, who: 'a1' | 'a3' = 'a1') =>
  h.call(who, 'POST', `${STAGING}/entries`, {
    locationRef: loc.locationRef,
    reasonCode: 'provider_out',
    ...body,
  });
const move = (entryRef: string, version: number, startsAt: string, endsAt: string, who: 'a1' | 'a3' = 'a1') =>
  h.call(who, 'POST', `${STAGING}/entries/${entryRef}/move`, {
    expectedVersion: version,
    reasonCode: 'provider_out',
    ...slot(startsAt, endsAt),
  });
const list = async () =>
  h.ok<{ data: Record<string, unknown> & { items: Record<string, unknown>[] } }>(
    await h.call('a1', 'GET', `${STAGING}?locationRef=${loc.locationRef}`),
    200,
  ).data;
const liveOccupancy = async (appointmentRef: string) =>
  (
    await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.scheduling_occupancy
       WHERE source_kind = 'appointment' AND source_id = $1 AND released_at IS NULL`,
      [appointmentRef],
    )
  ).rows[0].n as number;
const statusOf = async (appointmentRef: string) =>
  (await db.admin.query('SELECT status FROM cuspatlas.appointments WHERE id = $1', [appointmentRef])).rows[0]
    .status as string;

beforeAll(async () => {
  db = await openTestDatabase('staging_list');
  h = await openAppointmentHarness(db, { mcp: true });
  loc = await seedLocation(h, 'loc-north');
  patient = await createPatient(h, 'Synthetic Staged');
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('S20 staging list', () => {
  it('lists an empty list with the default capacity and the OR-01 envelope', async () => {
    const data = await list();
    expect(data).toMatchObject({ locationRef: loc.locationRef, capacity: 10, items: [] });
    expect(data.envelope).toMatchObject({
      count: { exact: 0 },
      truncated: false,
      nextCursor: null,
      scope: { kind: 'explicit_locations', locationRefs: [loc.locationRef] },
      ordering: { key: 'stagedAt', direction: 'asc', tieBreak: 'entryRef' },
    });
  });

  it('a staged appointment keeps its booking and occupancy; capacity refusal names the capacity', async () => {
    const configured = await h.call('a1', 'POST', `${STAGING}/settings`, {
      locationRef: loc.locationRef,
      capacity: 2,
    });
    expect(configured.statusCode, configured.body).toBe(200);
    // A read-only member cannot configure.
    expect(
      (await h.call('a4', 'POST', `${STAGING}/settings`, { locationRef: loc.locationRef, capacity: 5 }))
        .statusCode,
    ).toBe(403);
    const a = await book('2030-01-07T14:00:00Z', '2030-01-07T15:00:00Z');
    const request = h.ok<{ data: { requestRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/appointment-requests', {
        patientRef: patient,
        locationRef: loc.locationRef,
        sourceChannel: 'phone',
        contactConsent: 'granted',
        flexibility: 'mornings',
      }),
      201,
    ).data.requestRef;
    const occupied = await liveOccupancy(a);
    expect(occupied).toBeGreaterThan(0);
    const first = await stage({ appointmentRef: a });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().data).toMatchObject({ subjectKind: 'appointment', subjectRef: a, state: 'staged' });
    expect((await stage({ appointmentRef: a })).json().detail).toMatchObject({ reason: 'already_staged' });
    expect((await stage({ requestRef: request })).statusCode).toBe(201);
    expect(await liveOccupancy(a)).toBe(occupied);
    expect(await statusOf(a)).toBe('booked');
    const b = await book('2030-01-08T14:00:00Z', '2030-01-08T15:00:00Z');
    const over = await stage({ appointmentRef: b });
    expect(over.statusCode).toBe(409);
    expect(over.json().detail).toMatchObject({
      reason: 'staging_capacity_reached',
      limit: { name: 'stagingCapacity', value: 2 },
    });
    const data = await list();
    expect(data.items).toHaveLength(2);
    expect(data.envelope).toMatchObject({ count: { exact: 2 } });
    // A request entry is booked through S10 booking, never "moved".
    const reqEntry = data.items.find((i) => i.subjectKind === 'request') as {
      entryRef: string;
      version: number;
    };
    const refused = await move(
      reqEntry.entryRef,
      reqEntry.version,
      '2030-01-09T14:00:00Z',
      '2030-01-09T15:00:00Z',
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().detail).toMatchObject({
      reason: 'staging_entry_is_request',
      alternative: 'scheduling.appointments.book',
    });
    const removed = await h.call('a1', 'POST', `${STAGING}/entries/${reqEntry.entryRef}/remove`, {
      expectedVersion: reqEntry.version,
      reasonCode: 'no_longer_needed',
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().data.state).toBe('removed');
    const again = await h.call('a1', 'POST', `${STAGING}/entries/${reqEntry.entryRef}/remove`, {
      expectedVersion: reqEntry.version + 1,
      reasonCode: 'no_longer_needed',
    });
    expect(again.statusCode).toBe(409);
  });

  it('a move is the S10 reschedule (atomic); a conflicting move leaves the original booking and entry intact', async () => {
    await h.call('a1', 'POST', `${STAGING}/settings`, { locationRef: loc.locationRef, capacity: 10 });
    const original = await book('2030-01-14T14:00:00Z', '2030-01-14T15:00:00Z');
    const taken = await book('2030-01-15T14:00:00Z', '2030-01-15T15:00:00Z');
    const occupied = await liveOccupancy(original);
    const entry = h.ok<{ data: { entryRef: string; version: number } }>(
      await stage({ appointmentRef: original }),
      201,
    ).data;
    const clash = await move(entry.entryRef, entry.version, '2030-01-15T14:00:00Z', '2030-01-15T15:00:00Z');
    expect(clash.statusCode).toBe(409);
    expect(clash.body).not.toContain(MARKER);
    expect(await statusOf(original)).toBe('booked');
    expect(await statusOf(taken)).toBe('booked');
    expect(await liveOccupancy(original)).toBe(occupied);
    const still = (await list()).items.find((i) => i.entryRef === entry.entryRef);
    expect(still).toMatchObject({ state: 'staged', version: entry.version });

    const moved = await move(entry.entryRef, entry.version, '2030-01-16T14:00:00Z', '2030-01-16T15:00:00Z');
    expect(moved.statusCode, moved.body).toBe(200);
    const data = moved.json().data;
    expect(data).toMatchObject({
      entryRef: entry.entryRef,
      state: 'moved',
      previousAppointmentRef: original,
    });
    expect(await statusOf(original)).toBe('rescheduled');
    expect(await statusOf(data.appointmentRef)).toBe('booked');
    expect(await liveOccupancy(original)).toBe(0);
    expect((await list()).items.some((i) => i.entryRef === entry.entryRef)).toBe(false);
    const audit = await db.admin.query(
      `SELECT operation FROM cuspatlas.audit_events WHERE resource_ref = $1 ORDER BY occurred_at`,
      [entry.entryRef],
    );
    expect(audit.rows.map((r) => r.operation)).toStrictEqual([
      'scheduling.staging.add',
      'scheduling.staging.move',
    ]);
  });

  it('two staff moving the same entry: one success and one typed conflict', async () => {
    const appt = await book('2030-01-21T14:00:00Z', '2030-01-21T15:00:00Z');
    const entry = h.ok<{ data: { entryRef: string; version: number } }>(
      await stage({ appointmentRef: appt }),
      201,
    ).data;
    const results = await Promise.all([
      move(entry.entryRef, entry.version, '2030-01-22T14:00:00Z', '2030-01-22T15:00:00Z', 'a1'),
      move(entry.entryRef, entry.version, '2030-01-23T14:00:00Z', '2030-01-23T15:00:00Z', 'a3'),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toStrictEqual([200, 409]);
    const loser = results.find((r) => r.statusCode === 409);
    expect(['conflict', 'stale_version']).toContain(loser?.json().code);
    const booked = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.appointments WHERE rescheduled_from_id = $1`,
      [appt],
    );
    expect(booked.rows[0].n).toBe(1);
  });

  it('REST and MCP agree; another tenant sees nothing and changes nothing', async () => {
    const rest = await list();
    const m = await h.mcp('a1', 'scheduling_staging_list', { locationRef: loc.locationRef }, 200);
    const mdata = (m.body as { data: typeof rest }).data;
    expect({ ...mdata, envelope: { ...(mdata.envelope as object), asOf: null } }).toStrictEqual({
      ...rest,
      envelope: { ...(rest.envelope as object), asOf: null },
    });
    expect((await h.call('b1', 'GET', `${STAGING}?locationRef=${loc.locationRef}`)).statusCode).toBe(404);
    const entry = rest.items[0] as { entryRef: string; version: number };
    const foreign = await h.call('b1', 'POST', `${STAGING}/entries/${entry.entryRef}/remove`, {
      expectedVersion: entry.version,
      reasonCode: 'no_longer_needed',
    });
    expect(foreign.statusCode).toBe(404);
    expect((await list()).items).toHaveLength(rest.items.length);
  });
});
