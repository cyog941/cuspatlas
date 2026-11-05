import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAuthorize, createReadSurfaceService } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  count,
  createPatient,
  openAppointmentHarness,
  seedLocation,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { T_ALPHA, USER_A1, USER_A4 } from './support/fixtures';

/**
 * A21 (OR-03, OR-09, OR-10): the schedule view and appointment detail composers. One synthetic day:
 * every component in one round trip; a caller without billing or clinical read gets `restricted`
 * components; a missing producer gives `unavailable`; the view agrees with S9 search and S10 booking;
 * REST equals MCP; the composers write nothing but the sensitive-read access log. Synthetic data only.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let patient: string;
let appointment: string;
const DAY = '2030-03-05'; // a Tuesday; America/New_York is UTC-5 that day
const VIEW = `/v1/schedule/view?locationRef=loc-north&from=${DAY}`;
type Json = Record<string, any>;

beforeAll(async () => {
  db = await openTestDatabase('read_composers');
  h = await openAppointmentHarness(db, { mcp: true });
  await db.admin.query(
    'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1',
    [USER_A1, ['coverage.read', 'ledger.read', 'clinical.read', 'communications.read']],
  );
  // a4: scheduling and patient read only (no billing, coverage, clinical or contact read).
  await db.admin.query('UPDATE cuspatlas.memberships SET scopes = $2::text[] WHERE principal_id = $1', [
    USER_A4,
    ['scheduling.read', 'patients.read'],
  ]);
  loc = await seedLocation(h, 'loc-north');
  patient = h.ok<{ data: { patientRef: string } }>(
    await h.call('a1', 'POST', '/v1/patients', {
      legalName: { known: true, given: 'Composer', family: 'Synthetic' },
      birthDate: { known: true, value: '2001-03-06', precision: 'day' },
      contact: {
        known: true,
        points: [{ channel: 'phone', use: 'home', value: '+1 555 0100 777', preference: 'preferred' }],
      },
      identifiers: [{ type: 'chart_number', issuer: 'synthetic-practice', value: 'SYN-CHART-1' }],
    }),
    201,
  ).data.patientRef;
  const booked = h.ok<{ data: { appointmentRef: string; startsAt: string; endsAt: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/appointments', {
      patientRef: patient,
      locationRef: loc.locationRef,
      startsAt: `${DAY}T15:00:00.000Z`,
      endsAt: `${DAY}T15:30:00.000Z`,
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    }),
    201,
  ).data;
  appointment = booked.appointmentRef;
  h.ok(
    await h.call('a1', 'POST', '/v1/scheduling/time-blocks', {
      locationRef: loc.locationRef,
      startsAt: `${DAY}T17:00:00.000Z`,
      endsAt: `${DAY}T18:00:00.000Z`,
      reasonCode: 'lunch',
      resources: [
        { kind: 'provider', resourceRef: loc.provider },
        { kind: 'operatory', resourceRef: loc.operatory },
      ],
    }),
    201,
  );
  await createPatient(h, 'Unbooked');
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

const view = async (who = 'a1', extra = '') =>
  h.ok<{ data: Json }>(await h.call(who, 'GET', `${VIEW}${extra}`)).data;

describe('A21 schedule view (OR-03)', () => {
  it('returns every component for one synthetic day in one round trip', async () => {
    const v = await view();
    expect(v).toMatchObject({
      location: { locationRef: 'loc-north', timeZone: 'America/New_York' },
      from: DAY,
      to: DAY,
      grain: 'detailed',
    });
    expect(v.appointments).toHaveLength(1);
    const a = v.appointments[0];
    expect(a).toMatchObject({
      appointmentRef: appointment,
      startsAt: `${DAY}T15:00:00.000Z`,
      endsAt: `${DAY}T15:30:00.000Z`,
      localStart: `${DAY}T10:00:00-05:00`,
      resources: [
        { kind: 'provider', resourceRef: loc.provider },
        { kind: 'operatory', resourceRef: loc.operatory },
      ],
      attendance: { state: 'scheduled' },
      patient: {
        status: 'ok',
        data: { patientRef: patient, ageYears: 28, chartIdentifier: { value: 'SYN-CHART-1' } },
      },
      coverage: { status: 'ok', data: { coverages: [] } },
      balance: { status: 'ok', data: { balance: { currency: 'USD', minor: 0 } } },
      plannedProcedures: { status: 'ok', data: [] },
    });
    expect(a.attendance.next.length).toBeGreaterThan(0);
    expect(a.patient.data.phone).toBeUndefined(); // the schedule view carries no contact data
    for (const k of ['patient', 'coverage', 'balance', 'plannedProcedures'])
      expect(a[k].freshness).toMatchObject({ state: 'current', asOf: expect.any(String) });
    // One block object spanning both resources, not one per resource.
    expect(v.blocks).toEqual([
      expect.objectContaining({
        reasonCode: 'lunch',
        resourceRefs: [loc.provider, loc.operatory].sort(),
        locationWide: false,
      }),
    ]);
    const mine = v.unavailableIntervals.filter((u: Json) => u.resourceRef === loc.provider);
    expect(mine.map((u: Json) => [u.startsAt, u.endsAt, u.reason])).toEqual([
      [`${DAY}T05:00:00.000Z`, `${DAY}T13:00:00.000Z`, 'outside_availability'],
      [`${DAY}T17:00:00.000Z`, `${DAY}T18:00:00.000Z`, 'blocked'],
      [`${DAY}T22:00:00.000Z`, '2030-03-06T05:00:00.000Z', 'outside_availability'],
    ]);
    expect(v.counters.map((c: Json) => c.key)).toEqual(['open_requests', 'blocks', 'staging', 'waitlist']);
    expect(v.counters.find((c: Json) => c.key === 'blocks')).toMatchObject({
      value: 1,
      scope: { kind: 'location', locationRef: 'loc-north' },
    });
  });

  it('reports a closed day as closed, never as free time', async () => {
    const v = await view('a1', '&to=2030-03-09'); // Saturday: seedLocation hours are Monday to Friday
    const sat = v.unavailableIntervals.filter(
      (u: Json) => u.resourceRef === loc.provider && u.reason === 'closed',
    );
    expect(sat.map((u: Json) => u.startsAt)).toEqual(['2030-03-09T05:00:00.000Z']);
  });

  it('agrees with the S9 search and the S10 booking for the same day', async () => {
    const v = await view();
    const search = h.ok<{ data: { windows: Json[] } }>(
      await h.call('a1', 'POST', '/v1/availability/search', {
        locationRef: 'loc-north',
        from: DAY,
        to: DAY,
        durationMinutes: 30,
        displayTimeZone: 'America/New_York',
        requirements: [{ kind: 'provider' }, { kind: 'operatory' }],
        limit: 100,
      }),
    ).data;
    expect(search.windows.length).toBeGreaterThan(0);
    const busy = (ref: string) => [
      ...v.unavailableIntervals
        .filter((u: Json) => u.resourceRef === ref)
        .map((u: Json) => [u.startsAt, u.endsAt]),
      ...v.appointments
        .filter((a: Json) => a.resources.some((r: Json) => r.resourceRef === ref))
        .map((a: Json) => [a.startsAt, a.endsAt]),
    ];
    for (const w of search.windows) {
      for (const r of w.resources as Json[]) {
        for (const [s, e] of busy(r.resourceRef))
          expect(w.startsAt >= e || w.endsAt <= s, `${w.startsAt} vs ${s}`).toBe(true);
      }
    }
    // Every free half hour of the working day that the view leaves open is offered by S9.
    const offered = new Set(search.windows.map((w) => w.startsAt));
    expect(offered.has(`${DAY}T14:00:00.000Z`)).toBe(true);
    expect(offered.has(`${DAY}T15:00:00.000Z`)).toBe(false);
    expect(offered.has(`${DAY}T17:00:00.000Z`)).toBe(false);
  });

  it('gives a caller without billing, coverage or clinical read restricted components', async () => {
    const a = (await view('a4')).appointments[0];
    expect(a.patient.status).toBe('ok');
    expect(a.coverage).toEqual({
      status: 'restricted',
      owner: 'B5',
      requiredAction: 'rcm.coverages.resolve',
      requiredScope: 'coverage.read',
    });
    expect(a.balance).toMatchObject({ status: 'restricted', requiredScope: 'ledger.read' });
    expect(a.plannedProcedures).toMatchObject({ status: 'restricted', requiredScope: 'clinical.read' });
    expect(JSON.stringify(a.balance)).not.toContain('minor');
  });

  it('reports a missing producer as unavailable with its owner', async () => {
    const membership = createMembershipSource(db.app);
    const reads = createReadSurfaceService({
      authorize: createAuthorize(membership),
      withTenantTransaction: createTenantTransactionRunner(db.app),
      recording: { sink: createSecurityAttemptSink(db.sink), alert: () => undefined },
      producers: { plannedProcedures: null, balance: null },
    });
    const ctx = {
      tenantId: T_ALPHA,
      actorId: USER_A1,
      principal: 'human' as const,
      sessionId: 'synthetic-session',
      scopes: (await membership.load(USER_A1, T_ALPHA))?.scopes ?? [],
      correlationId: '00000000-0000-4000-8000-0000000000c1',
    };
    const d = (await reads.readAppointmentDetail(ctx, appointment)).data as Json;
    expect(d.plannedProcedures).toEqual({
      status: 'unavailable',
      owner: 'C11',
      reason: 'producer_not_deployed',
    });
    expect(d.balance).toEqual({ status: 'unavailable', owner: 'B2', reason: 'producer_not_deployed' });
    expect(d.coverage.status).toBe('ok');
  });

  it('compact grain changes only which fields are included', async () => {
    const v = await view('a1', '&grain=compact');
    expect(v.grain).toBe('compact');
    expect(Object.keys(v.appointments[0]).sort()).toEqual([
      'appointmentRef',
      'attendance',
      'endsAt',
      'patientRef',
      'resources',
      'startsAt',
    ]);
    const full = await view();
    expect(v.blocks).toEqual(full.blocks);
    expect(v.unavailableIntervals).toEqual(full.unavailableIntervals);
  });

  it('refuses a range beyond 14 days, another tenant and a location outside the membership', async () => {
    expect((await h.call('a1', 'GET', `${VIEW}&to=2030-03-25`)).statusCode).toBe(422);
    expect((await h.call('b1', 'GET', VIEW)).statusCode).toBe(404);
    expect(
      (await h.call('a3', 'GET', '/v1/schedule/view?locationRef=loc-south&from=2030-03-05')).statusCode,
    ).toBe(403);
  });
});

describe('A21 appointment detail (OR-10)', () => {
  it('returns the summary with labelled components in one call', async () => {
    const d = h.ok<{ data: Json }>(await h.call('a1', 'GET', `/v1/appointments/${appointment}/detail`)).data;
    expect(d).toMatchObject({
      appointmentRef: appointment,
      status: 'booked',
      patient: {
        status: 'ok',
        data: { ageYears: 28, phone: { status: 'ok', data: { value: '+1 555 0100 777' } } },
      },
      coverage: { status: 'ok' },
      balance: { status: 'ok' },
      plannedProcedures: { status: 'ok', data: [] },
      chart: { patientRef: patient, operation: 'clinical.chart.read' },
    });
    const r = h.ok<{ data: Json }>(await h.call('a4', 'GET', `/v1/appointments/${appointment}/detail`)).data;
    expect(r.patient.data.phone).toMatchObject({
      status: 'restricted',
      requiredScope: 'communications.read',
    });
    expect(JSON.stringify(r)).not.toContain('0100 777');
    expect(r.chart.status).toBe('restricted');
    expect((await h.call('b1', 'GET', `/v1/appointments/${appointment}/detail`)).statusCode).toBe(404);
    expect((await h.call('a1', 'GET', '/v1/appointments/not-a-ref/detail')).statusCode).toBe(404);
  });

  it('REST and MCP agree and the composers write nothing but the access log', async () => {
    const before = await Promise.all(
      ['audit_events', 'outbox_events', 'command_idempotency'].map((t) => count(db, t)),
    );
    const reads = await count(db, 'sensitive_read_events');
    const rest = h.ok<Json>(await h.call('a1', 'GET', `/v1/appointments/${appointment}/detail`));
    const mcp = await h.mcp('a1', 'appointments_detail', { appointmentRef: appointment });
    expect(mcp.status).toBe(200);
    const strip = (x: unknown) => JSON.parse(JSON.stringify(x).replace(/"asOf":"[^"]*"/g, '"asOf":"-"'));
    expect(strip(mcp.body)).toEqual(strip(rest));
    const restView = h.ok<Json>(await h.call('a1', 'GET', VIEW));
    const mcpView = await h.mcp('a1', 'schedule_view', { locationRef: 'loc-north', from: DAY });
    expect(strip(mcpView.body)).toEqual(strip(restView));
    expect(
      await Promise.all(['audit_events', 'outbox_events', 'command_idempotency'].map((t) => count(db, t))),
    ).toEqual(before);
    expect(await count(db, 'sensitive_read_events')).toBe(reads + 4);
  });
});
