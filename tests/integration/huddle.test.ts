import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  openAppointmentHarness,
  seedLocation,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { T_ALPHA, USER_A1, USER_A4 } from './support/fixtures';

/**
 * A18 (PT-01): the daily huddle with readiness flags from their producers (source and freshness;
 * restricted is never zero; a missing producer is unavailable, never checked), the shared-display
 * projection with no patient identity, and the display principal forced to anonymized projections on
 * the huddle and the S21 floor (closing the S21 seam). Synthetic data only.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let display: string; // bearer token of a shared-display principal
let appointment: string;
const DAY = '2030-03-05';
const MARKER = 'Zephyrine';
type Json = Record<string, any>;
const HUDDLE = `/v1/huddle?locationRef=loc-north&onDate=${DAY}`;

beforeAll(async () => {
  db = await openTestDatabase('huddle');
  h = await openAppointmentHarness(db, { mcp: true });
  await db.admin.query(
    'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1',
    [USER_A1, ['coverage.read', 'ledger.read', 'clinical.read']],
  );
  await db.admin.query('UPDATE cuspatlas.memberships SET scopes = $2::text[] WHERE principal_id = $1', [
    USER_A4,
    ['scheduling.read', 'patients.read'],
  ]);
  const displayRef = randomUUID();
  await db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'display-front-desk')`,
    [displayRef],
  );
  await db.admin.query(
    'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3::text[])',
    [T_ALPHA, displayRef, ['display.shared', 'scheduling.read', 'patients.read', 'admin.configure']],
  );
  display = await h.issuer.issue({ sub: displayRef, tid: T_ALPHA });
  const loc = await seedLocation(h, 'loc-north');
  const patient = h.ok<{ data: { patientRef: string } }>(
    await h.call('a1', 'POST', '/v1/patients', {
      legalName: { known: true, given: MARKER, family: 'Synthetic' },
      birthDate: { known: true, value: '2001-02-03', precision: 'day' },
    }),
    201,
  ).data.patientRef;
  appointment = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/appointments', {
      patientRef: patient,
      locationRef: 'loc-north',
      startsAt: `${DAY}T15:00:00.000Z`,
      endsAt: `${DAY}T15:30:00.000Z`,
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    }),
    201,
  ).data.appointmentRef;
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('A18 daily huddle', () => {
  it('lists the day with readiness flags, each with owner and freshness; forms is unavailable, never checked', async () => {
    const d = h.ok<{ data: Json }>(await h.call('a1', 'GET', HUDDLE)).data;
    expect(d).toMatchObject({
      onDate: DAY,
      zone: 'America/New_York',
      display: 'staff',
      displayForced: false,
    });
    expect(d.appointments).toHaveLength(1);
    const a = d.appointments[0];
    expect(a).toMatchObject({
      appointmentRef: appointment,
      patient: { status: 'ok', data: { legalName: { given: MARKER } } },
      forms: { status: 'unavailable', owner: 'C13', reason: 'producer_not_deployed' },
      eligibility: { status: 'ok', owner: 'B5', data: { state: 'no_coverage' } },
      balance: { status: 'ok', owner: 'B2', data: { state: 'zero' } },
      labs: { status: 'ok', owner: 'C16', data: { state: 'none' } },
      clinical: { status: 'ok', owner: 'C10', data: { unsignedNotes: 0 } },
    });
    for (const k of ['eligibility', 'balance', 'labs', 'clinical'])
      expect(a[k].freshness.asOf).toEqual(expect.any(String));
    expect(d.sections.find((s: Json) => s.key === 'forms')).toEqual({
      key: 'forms',
      owner: 'C13',
      status: 'unavailable',
    });
  });

  it('a caller without the financial or clinical scopes sees restricted flags, not zero', async () => {
    const a = h.ok<{ data: Json }>(await h.call('a4', 'GET', HUDDLE)).data.appointments[0];
    expect(a.balance).toEqual({
      status: 'restricted',
      owner: 'B2',
      requiredAction: 'billing.balances.read',
      requiredScope: 'ledger.read',
    });
    expect(a.clinical.status).toBe('restricted');
    expect(a.labs.status).toBe('restricted');
    expect(a.eligibility.status).toBe('restricted');
    expect(JSON.stringify(a.balance)).not.toContain('zero');
  });

  it('defaults to the next local day of the location and names the zone', async () => {
    const d = h.ok<{ data: Json }>(await h.call('a1', 'GET', '/v1/huddle?locationRef=loc-north')).data;
    const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
      new Date(Date.now() + 86_400_000),
    );
    expect([d.onDate, d.zone]).toEqual([tomorrow, 'America/New_York']);
  });

  it('shared display exposes no patient identity, no appointment reference and no clinical or financial detail', async () => {
    const res = await h.call('a1', 'GET', `${HUDDLE}&display=shared`);
    const body = res.body;
    expect(res.json().data.appointments[0]).toEqual({
      startsAt: `${DAY}T15:00:00.000Z`,
      localStart: expect.any(String),
      localEnd: expect.any(String),
      resources: expect.any(Array),
      attendanceState: 'scheduled',
      patient: 'anonymized',
    });
    for (const marker of [MARKER, appointment, 'balance', 'eligibility', 'labs', 'clinical', 'patientRef'])
      expect(body).not.toContain(marker);
  });

  it('a display principal is forced to the anonymized projections and refused everything else', async () => {
    const forced = await h.call(display, 'GET', HUDDLE); // asks for the staff view by default
    expect(forced.statusCode, forced.body).toBe(200);
    expect(forced.json().data).toMatchObject({ display: 'shared', displayForced: true });
    expect(forced.body).not.toContain(MARKER);
    const floor = await h.call(
      display,
      'GET',
      '/v1/scheduling/floor?locationRef=loc-north&projection=standard',
    );
    expect(floor.statusCode, floor.body).toBe(200);
    expect(floor.json().data.projection).toBe('anonymized');
    for (const url of [
      `/v1/schedule/view?locationRef=loc-north&from=${DAY}`,
      `/v1/appointments/${appointment}/detail`,
      '/v1/scheduling/locations',
      '/v1/navigation',
    ])
      expect((await h.call(display, 'GET', url)).statusCode, url).toBe(403);
    expect(
      (
        await h.call(display, 'POST', '/v1/scheduling/locations', {
          locationRef: 'loc-x',
          displayLabel: 'X',
          timeZone: 'UTC',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('REST equals MCP; cross-tenant and revoked callers are refused', async () => {
    const rest = h.ok<Json>(await h.call('a1', 'GET', HUDDLE));
    const mcp = await h.mcp('a1', 'huddle_read', { locationRef: 'loc-north', onDate: DAY });
    const strip = (x: unknown) => JSON.parse(JSON.stringify(x).replace(/"asOf":"[^"]*"/g, '"asOf":"-"'));
    expect(strip(mcp.body)).toEqual(strip(rest));
    expect((await h.call('b1', 'GET', HUDDLE)).statusCode).toBe(404);
    expect((await h.call('a2', 'GET', HUDDLE)).statusCode).toBe(403);
  });
});

describe('A batch 3 hardening: huddle sensitive reads', () => {
  it('logs a sensitive read when a balance section is returned without patients.read', async () => {
    const scopes = (
      await db.admin.query('SELECT scopes FROM cuspatlas.memberships WHERE principal_id = $1', [USER_A4])
    ).rows[0].scopes as string[];
    await db.admin.query('UPDATE cuspatlas.memberships SET scopes = $2::text[] WHERE principal_id = $1', [
      USER_A4,
      [...scopes.filter((s) => s !== 'patients.read'), 'ledger.read'],
    ]);
    try {
      const n = async () =>
        (
          await db.admin.query(
            `SELECT count(*)::int AS n FROM cuspatlas.sensitive_read_events WHERE operation = 'huddle.read'`,
          )
        ).rows[0].n as number;
      const before = await n();
      const a = h.ok<{ data: Json }>(await h.call('a4', 'GET', HUDDLE)).data.appointments[0];
      expect([a.patient.status, a.balance.status]).toEqual(['restricted', 'ok']);
      expect(await n()).toBe(before + 1);
    } finally {
      await db.admin.query('UPDATE cuspatlas.memberships SET scopes = $2::text[] WHERE principal_id = $1', [
        USER_A4,
        scopes,
      ]);
    }
  });
});
