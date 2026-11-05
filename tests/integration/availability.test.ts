import { randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { seedTenancy, T_ALPHA, T_BETA, USER_A1, USER_A3, USER_B1 } from './support/fixtures';
import { MARKER } from './support/marker';
import { insertBookingFixture, seedSchedulingScopes } from './support/scheduling-fixtures';
import { createTestTokenIssuer } from './support/test-token-issuer';

/**
 * S9: availability search. Read-only, advisory, bounded and paginated; DST and month-end behaviour
 * follows ADR 0009 (S-S3-R2, S-S3-R3) and is asserted with fixed synthetic dates in America/New_York:
 * spring-forward 2030-03-10 and fall-back 2030-11-03 (both Sundays).
 */
let db: TestDatabase;
let app: FastifyInstance;
let logLines: string[];
const tokens: Record<string, string> = {};

beforeAll(async () => {
  db = await openTestDatabase('availability');
  await seedTenancy(db.admin);
  await seedSchedulingScopes(db.admin);
  const issuer = await createTestTokenIssuer();
  logLines = [];
  app = await buildApp({
    env: 'synthetic-test',
    logger: { level: 'info', stream: { write: (l: string) => logLines.push(l) } },
    identity: issuer.verifierConfig,
    membership: createMembershipSource(db.app),
    attempts: createSecurityAttemptSink(db.sink),
    tenantTransactions: createTenantTransactionRunner(db.app),
  });
  tokens.a1 = await issuer.issue({ sub: USER_A1, tid: T_ALPHA });
  tokens.a3 = await issuer.issue({ sub: USER_A3, tid: T_ALPHA });
  tokens.b1 = await issuer.issue({ sub: USER_B1, tid: T_BETA });
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

type Who = 'a1' | 'a3' | 'b1';
function call(
  who: Who,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
async function ok(who: Who, url: string, body: unknown, status = 201) {
  const res = await call(who, 'POST', url, body);
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}
const search = (who: Who, body: Record<string, unknown>) =>
  call(who, 'POST', '/v1/availability/search', body);

let provider: string;
let operatory: string;
let operatory2: string;
let sundayRoom: string;
let betaOperatory: string;

beforeAll(async () => {
  for (const loc of ['loc-north', 'loc-empty']) {
    await ok('a1', '/v1/scheduling/locations', {
      locationRef: loc,
      displayLabel: `Synthetic ${loc}`,
      timeZone: 'America/New_York',
    });
  }
  await ok('b1', '/v1/scheduling/locations', {
    locationRef: 'loc-north',
    displayLabel: 'Synthetic beta',
    timeZone: 'America/New_York',
  });
  const res = async (
    who: Who,
    kind: string,
    displayLabel: string,
    displayOrder = 0,
    locationRef = 'loc-north',
  ) =>
    (await ok(who, '/v1/scheduling/resources', { kind, locationRef, displayLabel, displayOrder })).data
      .resourceRef as string;
  provider = await res('a1', 'provider', 'Synthetic Provider A');
  operatory = await res('a1', 'operatory', 'Operatory 1', 1);
  operatory2 = await res('a1', 'operatory', 'Operatory 2', 2);
  sundayRoom = await res('a1', 'operatory', 'Operatory 3', 3);
  await res('a1', 'operatory', 'Operatory 9', 9, 'loc-empty');
  betaOperatory = await res('b1', 'operatory', 'Operatory 1');
  const weekdays = (start: string, end: string) =>
    [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start, end }));
  for (const r of [provider, operatory, operatory2]) {
    await ok('a1', `/v1/scheduling/resources/${r}/availability`, {
      effectiveFrom: '2030-01-07',
      weekly: weekdays('08:00', '12:00'),
    });
  }
  // From 2030-02-04 the provider works 09:00-11:00 only: effective-dated hours apply by date.
  await ok('a1', `/v1/scheduling/resources/${provider}/availability`, {
    effectiveFrom: '2030-02-04',
    weekly: weekdays('09:00', '11:00'),
  });
  // Sunday hours across the clock changes (synthetic, to exercise the DST rule).
  await ok('a1', `/v1/scheduling/resources/${sundayRoom}/availability`, {
    effectiveFrom: '2030-01-06',
    weekly: [{ weekday: 7, start: '00:30', end: '04:00' }],
  });
});

const base = (o: Record<string, unknown> = {}) => ({
  locationRef: 'loc-north',
  from: '2030-01-14',
  to: '2030-01-14',
  durationMinutes: 30,
  displayTimeZone: 'America/New_York',
  requirements: [{ kind: 'provider' }, { kind: 'operatory' }],
  ...o,
});

interface Window {
  startsAt: string;
  endsAt: string;
  localStart: string;
  localEnd: string;
  durationMinutes: number;
  resources: { kind: string; resourceRef: string }[];
}

async function allWindows(body: Record<string, unknown>): Promise<Window[]> {
  const out: Window[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i += 1) {
    const res = await search('a1', { ...body, limit: 100, ...(cursor ? { cursor } : {}) });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    out.push(...data.windows);
    cursor = data.nextCursor;
    if (!cursor) return out;
  }
  throw new Error('pagination did not end');
}

async function tableCounts(): Promise<Record<string, number>> {
  const { rows } = await db.admin.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'cuspatlas' AND c.relkind = 'r' ORDER BY 1`,
  );
  const out: Record<string, number> = {};
  for (const { relname } of rows) {
    if (relname === 'security_attempt_events') continue;
    out[relname] = (await db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${relname}`)).rows[0].n;
  }
  return out;
}

describe('S9 acceptance', () => {
  it('1. returned windows are free for the full duration plus buffer for every required resource', async () => {
    // 2030-01-14 is a Monday. A booking on Operatory 1 09:30-10:00 local (14:30Z-15:00Z).
    const booking = await insertBookingFixture(db.admin, {
      tenantId: T_ALPHA,
      resourceRef: operatory,
      startsAt: '2030-01-14T14:30:00Z',
      endsAt: '2030-01-14T15:00:00Z',
      createdBy: USER_A1,
    });
    expect(booking).toMatch(/^[0-9a-f-]{36}$/);
    const windows = await allWindows(
      base({
        requirements: [{ kind: 'provider' }, { kind: 'operatory', resourceRef: operatory }],
        bufferMinutes: 15,
      }),
    );
    const starts = windows.map((w) => w.localStart);
    // 08:00..11:30 every 15 minutes, minus anything whose [start, end + 15) touches 09:30-10:00.
    expect(starts).toContain('2030-01-14T08:00:00-05:00');
    expect(starts).toContain('2030-01-14T08:45:00-05:00'); // ends 09:15, buffer to 09:30: free
    expect(starts).not.toContain('2030-01-14T09:00:00-05:00'); // buffer runs into the booking
    expect(starts).not.toContain('2030-01-14T09:30:00-05:00');
    expect(starts).not.toContain('2030-01-14T09:45:00-05:00');
    expect(starts).toContain('2030-01-14T10:00:00-05:00');
    expect(starts).toContain('2030-01-14T11:15:00-05:00'); // ends 11:45, buffer to 12:00
    expect(starts).not.toContain('2030-01-14T11:30:00-05:00'); // buffer beyond the hours
    for (const w of windows) {
      expect(w.durationMinutes).toBe(30);
      expect(Date.parse(w.endsAt) - Date.parse(w.startsAt)).toBe(30 * 60_000);
      expect(w.resources).toStrictEqual([
        { kind: 'provider', resourceRef: provider },
        { kind: 'operatory', resourceRef: operatory },
      ]);
    }
    // Without a named operatory, the search falls through to Operatory 2 during the booking.
    const any = await allWindows(base());
    const at930 = any.find((w) => w.localStart === '2030-01-14T09:30:00-05:00');
    expect(at930?.resources).toStrictEqual([
      { kind: 'provider', resourceRef: provider },
      { kind: 'operatory', resourceRef: operatory2 },
    ]);
  });

  it('2a. effective-dated hours, time blocks and location-wide holidays are applied', async () => {
    // Provider hours change on 2030-02-04 (Monday) to 09:00-11:00.
    const feb = await allWindows(
      base({ from: '2030-02-04', to: '2030-02-04', requirements: [{ kind: 'provider' }] }),
    );
    expect(feb[0]?.localStart).toBe('2030-02-04T09:00:00-05:00');
    expect(feb[feb.length - 1]?.localEnd).toBe('2030-02-04T11:00:00-05:00');
    // A provider time block 10:00-10:30 local on 2030-02-05.
    await ok('a1', '/v1/scheduling/time-blocks', {
      locationRef: 'loc-north',
      startsAt: '2030-02-05T15:00:00Z',
      endsAt: '2030-02-05T15:30:00Z',
      reasonCode: 'meeting',
      resources: [{ kind: 'provider', resourceRef: provider }],
    });
    const blocked = await allWindows(
      base({ from: '2030-02-05', to: '2030-02-05', requirements: [{ kind: 'provider' }] }),
    );
    expect(blocked.map((w) => w.localStart)).toStrictEqual([
      '2030-02-05T09:00:00-05:00',
      '2030-02-05T09:15:00-05:00',
      '2030-02-05T09:30:00-05:00',
      '2030-02-05T10:30:00-05:00',
    ]);
    // A location-wide holiday removes the whole day for every resource.
    await ok('a1', '/v1/scheduling/time-blocks', {
      locationRef: 'loc-north',
      startsAt: '2030-02-06T05:00:00Z',
      endsAt: '2030-02-07T05:00:00Z',
      reasonCode: 'holiday',
      resources: [],
    });
    const holiday = await search('a1', base({ from: '2030-02-06', to: '2030-02-06' }));
    expect(holiday.json().data).toMatchObject({ outcome: 'none_free', windows: [] });
  });

  it('2b. spring-forward day: real durations and local display follow the recorded DST rule', async () => {
    // Sunday hours 00:30-04:00 local on 2030-03-10: 00:30 EST = 05:30Z, 04:00 EDT = 08:00Z (150 real minutes).
    const windows = await allWindows(
      base({
        from: '2030-03-10',
        to: '2030-03-10',
        durationMinutes: 60,
        slotMinutes: 30,
        requirements: [{ kind: 'operatory', resourceRef: sundayRoom }],
      }),
    );
    const view = windows.map((w) => [w.startsAt, w.localStart, w.localEnd, w.durationMinutes]);
    process.stdout.write(`\nDST spring-forward 2030-03-10 America/New_York ${JSON.stringify(view)}\n`);
    expect(view).toStrictEqual([
      ['2030-03-10T05:30:00.000Z', '2030-03-10T00:30:00-05:00', '2030-03-10T01:30:00-05:00', 60],
      ['2030-03-10T06:00:00.000Z', '2030-03-10T01:00:00-05:00', '2030-03-10T03:00:00-04:00', 60],
      ['2030-03-10T06:30:00.000Z', '2030-03-10T01:30:00-05:00', '2030-03-10T03:30:00-04:00', 60],
      ['2030-03-10T07:00:00.000Z', '2030-03-10T03:00:00-04:00', '2030-03-10T04:00:00-04:00', 60],
    ]);
  });

  it('2c. fall-back day: a repeated local hour is real time, never collapsed or doubled', async () => {
    // 00:30 EDT = 04:30Z, 04:00 EST = 09:00Z (270 real minutes on a 25-hour day).
    const windows = await allWindows(
      base({
        from: '2030-11-03',
        to: '2030-11-03',
        durationMinutes: 60,
        slotMinutes: 30,
        requirements: [{ kind: 'operatory', resourceRef: sundayRoom }],
      }),
    );
    const view = windows.map((w) => [w.startsAt, w.localStart, w.localEnd]);
    process.stdout.write(`\nDST fall-back 2030-11-03 America/New_York ${JSON.stringify(view)}\n`);
    expect(windows).toHaveLength(8); // starts 04:30Z..08:00Z every 30 real minutes
    expect(view[2]).toStrictEqual([
      '2030-11-03T05:30:00.000Z',
      '2030-11-03T01:30:00-04:00',
      '2030-11-03T01:30:00-05:00',
    ]);
    expect(view[3]).toStrictEqual([
      '2030-11-03T06:00:00.000Z',
      '2030-11-03T01:00:00-05:00',
      '2030-11-03T02:00:00-05:00',
    ]);
    expect(view[7]).toStrictEqual([
      '2030-11-03T08:00:00.000Z',
      '2030-11-03T03:00:00-05:00',
      '2030-11-03T04:00:00-05:00',
    ]);
    for (const w of windows) expect(Date.parse(w.endsAt) - Date.parse(w.startsAt)).toBe(3_600_000);
    // A display zone other than the location's changes only the rendering.
    const la = await search(
      'a1',
      base({
        from: '2030-11-03',
        to: '2030-11-03',
        durationMinutes: 60,
        slotMinutes: 30,
        displayTimeZone: 'America/Los_Angeles',
        requirements: [{ kind: 'operatory', resourceRef: sundayRoom }],
      }),
    );
    expect(la.json().data.windows[0]).toMatchObject({
      startsAt: '2030-11-03T04:30:00.000Z',
      localStart: '2030-11-02T21:30:00-07:00',
      timeZone: 'America/Los_Angeles',
    });
  });

  it('2d. month-end: the local calendar is walked across short months with correct weekdays', async () => {
    // 2030-01-31 Thursday, 2030-02-01 Friday, 2030-02-28 Thursday, 2030-03-01 Friday (not a leap year).
    const jan = await allWindows(
      base({
        from: '2030-01-31',
        to: '2030-02-01',
        requirements: [{ kind: 'operatory', resourceRef: operatory2 }],
        durationMinutes: 240,
      }),
    );
    expect(jan.map((w) => w.localStart)).toStrictEqual([
      '2030-01-31T08:00:00-05:00',
      '2030-02-01T08:00:00-05:00',
    ]);
    const feb = await allWindows(
      base({
        from: '2030-02-28',
        to: '2030-03-03',
        requirements: [{ kind: 'operatory', resourceRef: operatory2 }],
        durationMinutes: 240,
      }),
    );
    // Saturday 2030-03-02 and Sunday 2030-03-03 have no hours.
    expect(feb.map((w) => w.localStart)).toStrictEqual([
      '2030-02-28T08:00:00-05:00',
      '2030-03-01T08:00:00-05:00',
    ]);
  });

  it('3. search writes no hold, no appointment, no outbox event and no other row', async () => {
    const before = await tableCounts();
    for (let i = 0; i < 3; i += 1)
      expect((await search('a1', base({ from: '2030-01-14', to: '2030-01-18' }))).statusCode).toBe(200);
    expect(await tableCounts()).toStrictEqual(before);
    const res = (await search('a1', base())).json().data;
    expect(res.advisory).toBe(true);
    expect(res.coverage.notConsidered).toEqual(
      expect.arrayContaining([
        'provider_credentials',
        'equipment_eligibility',
        'appointment_type_rules',
        'patient_availability',
      ]),
    );
  });

  it('4. another tenant’s resource is refused and never appears in results', async () => {
    const foreign = await search(
      'a1',
      base({ requirements: [{ kind: 'operatory', resourceRef: betaOperatory }] }),
    );
    const missing = await search(
      'a1',
      base({ requirements: [{ kind: 'operatory', resourceRef: randomUUID() }] }),
    );
    for (const r of [foreign, missing]) {
      expect(r.statusCode).toBe(404);
      expect(Object.keys(r.json()).sort()).toStrictEqual(['code', 'correlationId', 'retryable']);
    }
    const beta = await search('b1', base({ requirements: [{ kind: 'operatory' }] }));
    expect(beta.statusCode).toBe(200);
    for (const id of [provider, operatory, operatory2, sundayRoom]) expect(beta.body).not.toContain(id);
    const alphaFromBeta = await search(
      'b1',
      base({ requirements: [{ kind: 'operatory', resourceRef: operatory }] }),
    );
    expect(alphaFromBeta.statusCode).toBe(404);
    // A location-restricted scheduler cannot search another location.
    expect((await search('a3', base({ locationRef: 'loc-empty' }))).statusCode).toBe(403);
  });

  it('5. zero or excessive duration and an unparseable or unknown zone are rejected', async () => {
    for (const durationMinutes of [0, 4, 481]) {
      const r = await search('a1', base({ durationMinutes }));
      expect([durationMinutes, r.statusCode]).toStrictEqual([durationMinutes, 400]);
    }
    expect((await search('a1', base({ displayTimeZone: 'not a zone' }))).statusCode).toBe(400);
    const unknown = await search('a1', base({ displayTimeZone: 'Mars/Olympus_Mons' }));
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().detail.violations[0]).toStrictEqual({
      pointer: '/displayTimeZone',
      rule: 'unknownTimeZone',
    });
    expect((await search('a1', base({ from: '2030-02-30', to: '2030-02-30' }))).statusCode).toBe(422);
  });

  it('6. a range beyond the horizon is refused; results are paginated, never silently truncated', async () => {
    // OR-D6 (accepted 2026-11-04): the configured maximum window is 60 days, named in the refusal.
    const beyond = await search('a1', base({ from: '2030-01-01', to: '2030-03-02' }));
    expect(beyond.statusCode).toBe(422);
    expect(beyond.json().detail.violations[0]).toStrictEqual({ pointer: '/to', rule: 'beyondHorizon' });
    expect(beyond.json().detail.limit).toStrictEqual({ name: 'availabilityMaxWindowDays', value: 60 });
    expect((await search('a1', base({ from: '2030-01-01', to: '2030-03-01', limit: 1 }))).statusCode).toBe(
      200,
    );
    const backwards = await search('a1', base({ from: '2030-01-15', to: '2030-01-14' }));
    expect(backwards.statusCode).toBe(422);
    expect((await search('a1', base({ from: '2030-01-01', to: '2030-01-31' }))).statusCode).toBe(200);
    const page1 = (await search('a1', base({ limit: 2 }))).json().data;
    expect(page1.windows).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = (await search('a1', base({ limit: 2, cursor: page1.nextCursor }))).json().data;
    expect(Date.parse(page2.windows[0].startsAt)).toBeGreaterThan(Date.parse(page1.windows[1].startsAt));
    const all = await allWindows(base());
    expect(all.slice(0, 4).map((w) => w.startsAt)).toStrictEqual(
      [...page1.windows, ...page2.windows].map((w) => w.startsAt),
    );
    // A cursor is bound to its query and tenant; tampering is refused.
    expect(
      (await search('a1', base({ limit: 2, durationMinutes: 45, cursor: page1.nextCursor }))).statusCode,
    ).toBe(400);
    expect((await search('b1', base({ limit: 2, cursor: page1.nextCursor }))).statusCode).toBe(400);
    expect((await search('a1', base({ cursor: `x${page1.nextCursor}` }))).statusCode).toBe(400);
    expect((await search('a1', base({ limit: 101 }))).statusCode).toBe(400);
  });
});

describe('S9 failure and recovery', () => {
  it('1. results are advisory: a booking committed after search removes the window and the recheck refuses a second', async () => {
    const first = (
      await search(
        'a1',
        base({
          from: '2030-01-15',
          to: '2030-01-15',
          requirements: [{ kind: 'operatory', resourceRef: operatory2 }],
        }),
      )
    ).json().data;
    expect(first.advisory).toBe(true);
    const w: Window = first.windows[0];
    await insertBookingFixture(db.admin, {
      tenantId: T_ALPHA,
      resourceRef: operatory2,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      createdBy: USER_A1,
    });
    const again = (
      await search(
        'a1',
        base({
          from: '2030-01-15',
          to: '2030-01-15',
          requirements: [{ kind: 'operatory', resourceRef: operatory2 }],
        }),
      )
    ).json().data;
    expect(again.windows.map((x: Window) => x.startsAt)).not.toContain(w.startsAt);
    // The database recheck (S10's authority) refuses a second occupant for the stale window.
    await expect(
      insertBookingFixture(db.admin, {
        tenantId: T_ALPHA,
        resourceRef: operatory2,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        createdBy: USER_A1,
      }),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('2. a deactivated resource is absent from results with an explicit coverage note', async () => {
    const extra = (
      await ok('a1', '/v1/scheduling/resources', {
        kind: 'equipment',
        locationRef: 'loc-north',
        displayLabel: 'Synthetic Scanner',
      })
    ).data.resourceRef;
    await ok('a1', `/v1/scheduling/resources/${extra}/availability`, {
      effectiveFrom: '2030-01-07',
      weekly: [{ weekday: 1, start: '08:00', end: '12:00' }],
    });
    await ok('a1', `/v1/scheduling/resources/${extra}/deactivate`, { expectedVersion: 1 }, 200);
    const named = (
      await search('a1', base({ requirements: [{ kind: 'equipment', resourceRef: extra }] }))
    ).json().data;
    expect(named).toMatchObject({ outcome: 'no_eligible_resource', windows: [] });
    expect(named.coverage.excludedResources).toStrictEqual([
      { resourceRef: { kind: 'equipment', resourceRef: extra }, reason: 'inactive' },
    ]);
    const byKind = (await search('a1', base({ requirements: [{ kind: 'equipment' }] }))).json().data;
    expect(byKind.outcome).toBe('no_eligible_resource');
    expect(byKind.coverage.excludedResources).toContainEqual({
      resourceRef: { kind: 'equipment', resourceRef: extra },
      reason: 'inactive',
    });
  });

  it('3. a location with no availability configured says so instead of returning an empty list', async () => {
    const res = await search('a1', base({ locationRef: 'loc-empty', requirements: [{ kind: 'operatory' }] }));
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      outcome: 'no_availability_configured',
      windows: [],
      nextCursor: null,
    });
    expect(res.json().data.coverage.excludedResources[0].reason).toBe('no_availability_configured');
    expect(logLines.join('\n')).not.toContain(MARKER);
  });
});

describe('S18 availability filters (OR-04)', () => {
  const local = (w: Window) => w.localStart.slice(11, 16);
  const weekdayOf = (w: Window) => new Date(`${w.localStart.slice(0, 10)}T12:00:00Z`).getUTCDay();

  it('duration-only search with a weekday set and a morning window returns only matching windows', async () => {
    const res = await search(
      'a1',
      base({
        from: '2030-01-21',
        to: '2030-01-27',
        requirements: [{ kind: 'operatory' }],
        weekdays: [2, 4],
        timeWindows: [{ start: '08:00', end: '09:30' }],
        limit: 100,
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.windows.length).toBeGreaterThan(0);
    for (const w of data.windows as Window[]) {
      expect([2, 4]).toContain(weekdayOf(w));
      expect(local(w) >= '08:00' && w.localEnd.slice(11, 16) <= '09:30').toBe(true);
    }
    expect(new Set((data.windows as Window[]).map((w) => w.localStart.slice(0, 10)))).toStrictEqual(
      new Set(['2030-01-22', '2030-01-24']),
    );
    expect(data.constraints.applied).toEqual(expect.arrayContaining(['weekdays', 'time_windows']));
    expect(data.constraints.weekdays).toStrictEqual([2, 4]);
    expect(data.envelope).toMatchObject({
      appliedFilters: {
        weekdays: [2, 4],
        timeWindows: [{ start: '08:00', end: '09:30' }],
        maxWindowDays: 60,
      },
      scope: { kind: 'location_set', locationRefs: ['loc-north'] },
      truncated: false,
      nextCursor: null,
      count: { exact: data.windows.length },
      ordering: { key: 'startsAt', direction: 'asc', tieBreak: 'resourceRefs' },
    });
    expect(Date.parse(data.envelope.asOf)).not.toBeNaN();
  });

  it('next-3 mode returns the first three openings from the start date without an end date', async () => {
    const res = await search('a1', {
      locationRef: 'loc-north',
      from: '2030-01-19',
      durationMinutes: 30,
      displayTimeZone: 'America/New_York',
      requirements: [{ kind: 'operatory' }],
      next: 3,
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.windows).toHaveLength(3);
    // Saturday 19th: nothing until the Sunday room opens at 00:30 on 2030-01-20.
    expect((data.windows as Window[]).map(local)).toStrictEqual(['00:30', '00:45', '01:00']);
    expect(data.windows[0].localStart.slice(0, 10)).toBe('2030-01-20');
    expect(data.nextCursor).toBeNull();
    expect(data.envelope.appliedFilters).toMatchObject({ next: 3, to: '2030-03-19' });
    expect(data.envelope.count).toStrictEqual({ atLeast: 3 });
    // Without next, an end date is required.
    const noTo = await search('a1', { ...base(), to: undefined });
    expect(noTo.statusCode).toBe(422);
    expect(noTo.json().detail.violations[0]).toStrictEqual({ pointer: '/to', rule: 'required' });
  });

  it('a provider preference is tried first; another tenant or location provider is refused', async () => {
    const second = (
      await ok('a1', '/v1/scheduling/resources', {
        kind: 'provider',
        locationRef: 'loc-north',
        displayLabel: 'Synthetic Provider B',
        displayOrder: 5,
      })
    ).data.resourceRef as string;
    await ok('a1', `/v1/scheduling/resources/${second}/availability`, {
      effectiveFrom: '2030-01-07',
      weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '08:00', end: '12:00' })),
    });
    const plain = (await search('a1', base({ from: '2030-01-23', to: '2030-01-23', limit: 1 }))).json().data;
    expect(plain.windows[0].resources[0].resourceRef).toBe(provider);
    const preferred = await search(
      'a1',
      base({ from: '2030-01-23', to: '2030-01-23', limit: 1, preferredProviderRefs: [second] }),
    );
    expect(preferred.statusCode, preferred.body).toBe(200);
    expect(preferred.json().data.windows[0].resources[0].resourceRef).toBe(second);
    expect(preferred.json().data.constraints.applied).toContain('provider_preference');
    const foreign = await search('a1', base({ preferredProviderRefs: [betaOperatory] }));
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain(MARKER);
  });

  it('a window above the configured maximum is refused with the limit named', async () => {
    const res = await search('a1', base({ from: '2030-01-01', to: '2030-04-30' }));
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatchObject({
      violations: [{ pointer: '/to', rule: 'beyondHorizon' }],
      limit: { name: 'availabilityMaxWindowDays', value: 60 },
    });
    const bad = await search('a1', base({ weekdays: [0] }));
    expect(bad.statusCode).toBe(400);
    const order = await search('a1', base({ timeWindows: [{ start: '10:00', end: '09:00' }] }));
    expect(order.statusCode).toBe(422);
  });
});
