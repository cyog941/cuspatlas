import { randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import { validateAppointmentOperatoryAssignment } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, SVC_A1, seedTenancy, T_ALPHA, T_BETA, USER_A1, USER_A3, USER_B1 } from './support/fixtures';
import { MARKER } from './support/marker';
import { insertBookingFixture, SCHED_ALL, seedSchedulingScopes } from './support/scheduling-fixtures';
import { createTestTokenIssuer } from './support/test-token-issuer';

/**
 * S7: resource, operatory and time-block model. Every call goes through the REST surface under the
 * runtime role; fixtures beyond tenancy are created through the domain commands, except the
 * test-only booking fixture (an occupancy row S10 will create through booking).
 */
let db: TestDatabase;
let app: FastifyInstance;
let logLines: string[];
const tokens: Record<string, string> = {};

beforeAll(async () => {
  db = await openTestDatabase('resources');
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
  tokens.svcA1 = await issuer.issue({ sub: SVC_A1, tid: T_ALPHA });
  tokens.b1 = await issuer.issue({ sub: USER_B1, tid: T_BETA });
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

type Who = 'a1' | 'a3' | 'svcA1' | 'b1';

function call(
  who: Who,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  key: string | null = randomUUID(),
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(method === 'POST' && key !== null ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

const count = async (table: string) =>
  (await db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${table}`)).rows[0].n as number;

async function defineLocation(who: Who, locationRef: string, timeZone = 'America/New_York') {
  const res = await call(who, 'POST', '/v1/scheduling/locations', {
    locationRef,
    displayLabel: `Synthetic Location ${locationRef}`,
    timeZone,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function defineResource(who: Who, body: Record<string, unknown>): Promise<string> {
  const res = await call(who, 'POST', '/v1/scheduling/resources', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.resourceRef as string;
}

const weekdays = (start: string, end: string, days = [1, 2, 3, 4, 5]) =>
  days.map((weekday) => ({ weekday, start, end }));

let provider: string;
let operatory: string;
let operatory2: string;
let southOperatory: string;
let betaOperatory: string;

beforeAll(async () => {
  await defineLocation('a1', 'loc-north');
  await defineLocation('a1', 'loc-south', 'America/Chicago');
  await defineLocation('b1', 'loc-north');
  provider = await defineResource('a1', {
    kind: 'provider',
    locationRef: 'loc-north',
    displayLabel: 'Synthetic Provider A',
  });
  operatory = await defineResource('a1', {
    kind: 'operatory',
    locationRef: 'loc-north',
    displayLabel: 'Operatory 1',
    displayOrder: 1,
  });
  operatory2 = await defineResource('a1', {
    kind: 'operatory',
    locationRef: 'loc-north',
    displayLabel: 'Operatory 2',
    displayOrder: 2,
  });
  southOperatory = await defineResource('a1', {
    kind: 'operatory',
    locationRef: 'loc-south',
    displayLabel: 'Operatory 1',
  });
  betaOperatory = await defineResource('b1', {
    kind: 'operatory',
    locationRef: 'loc-north',
    displayLabel: 'Operatory 1',
  });
});

describe('S7 acceptance', () => {
  it('1. effective-dated hours: a later version applies from its date and the earlier stays readable', async () => {
    for (const r of [provider, operatory]) {
      const v1 = await call('a1', 'POST', `/v1/scheduling/resources/${r}/availability`, {
        effectiveFrom: '2030-01-07',
        weekly: weekdays('08:00', '17:00'),
      });
      expect(v1.statusCode, v1.body).toBe(201);
      const v2 = await call('a1', 'POST', `/v1/scheduling/resources/${r}/availability`, {
        effectiveFrom: '2030-03-04',
        weekly: weekdays('07:00', '15:00', [1, 2, 3, 4]),
      });
      expect(v2.statusCode, v2.body).toBe(201);
      expect(v2.json().data).toMatchObject({ resourceRef: r, effectiveFrom: '2030-03-04' });
    }
    const read = await call('a1', 'GET', `/v1/scheduling/resources/${provider}`);
    expect(read.statusCode).toBe(200);
    const data = read.json().data;
    expect(data).toMatchObject({
      resourceRef: provider,
      kind: 'provider',
      locationRef: 'loc-north',
      status: 'active',
    });
    expect(data.availability.map((v: { effectiveFrom: string }) => v.effectiveFrom)).toStrictEqual([
      '2030-01-07',
      '2030-03-04',
    ]);
    expect(data.availability[0]).toMatchObject({
      timeZone: 'America/New_York',
      effectiveUntil: '2030-03-04',
      weekly: weekdays('08:00', '17:00'),
    });
    expect(data.availability[1]).toMatchObject({ effectiveUntil: null });
  });

  it('2. a resource whose label matches the reserved state vocabulary is refused with a typed error', async () => {
    const before = await count('scheduling_resources');
    for (const displayLabel of [
      '8. NO SHOW',
      '9. CANCELLED APPTS.',
      'Checked-In',
      'asap',
      'Treatment Complete',
    ]) {
      const res = await call('a1', 'POST', '/v1/scheduling/resources', {
        kind: 'operatory',
        locationRef: 'loc-north',
        displayLabel,
      });
      expect([displayLabel, res.statusCode]).toStrictEqual([displayLabel, 422]);
      expect(res.json()).toMatchObject({
        code: 'validation_failed',
        detail: { violations: [{ pointer: '/displayLabel', rule: 'reservedStateLabel' }] },
      });
    }
    expect(await count('scheduling_resources')).toBe(before);
    // The database refuses it independently of the domain (owner/fixture path included).
    await expect(
      db.admin.query(
        `INSERT INTO cuspatlas.scheduling_resources (tenant_id, location_id, kind, display_label, created_by)
         SELECT tenant_id, id, 'operatory', '8. NO SHOW', $2 FROM cuspatlas.scheduling_locations
         WHERE tenant_id = $1 AND location_ref = 'loc-north'`,
        [T_ALPHA, USER_A1],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('2b. the data-quality query reports zero state-labelled resources for the synthetic fixture', async () => {
    const res = await call('a1', 'GET', '/v1/scheduling/data-quality/state-labelled-resources');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json().data;
    expect(body).toMatchObject({ stateLabelledCount: 0, stateLabelled: [] });
    expect(body.resourcesChecked).toBeGreaterThanOrEqual(4);
    expect(body.vocabularyVersion).toMatch(/^scheduling-state-labels\.\d+$/);
    process.stdout.write(
      `\nDATA-QUALITY (synthetic fixture) ${JSON.stringify({ ...body, checkedAt: '<now>' })}\n`,
    );
    // A label that only resembles a state passes the exact-match constraint but is listed for review.
    const lookalike = await defineResource('a1', {
      kind: 'operatory',
      locationRef: 'loc-south',
      displayLabel: 'Synthetic No Show Room',
    });
    const after = (await call('a1', 'GET', '/v1/scheduling/data-quality/state-labelled-resources')).json()
      .data;
    expect(after.stateLabelled).toStrictEqual([
      { resourceRef: lookalike, kind: 'operatory', locationRef: 'loc-south', matchedTerm: 'no show' },
    ]);
    // Location policy applies to the report: a loc-north admin does not see the loc-south row.
    const north = (await call('a3', 'GET', '/v1/scheduling/data-quality/state-labelled-resources')).json()
      .data;
    expect(north.stateLabelledCount).toBe(0);
  });

  it('3. a time block with a reason and no patient is created and is unavailable time', async () => {
    const res = await call('a1', 'POST', '/v1/scheduling/time-blocks', {
      locationRef: 'loc-north',
      startsAt: '2030-03-05T17:00:00Z',
      endsAt: '2030-03-05T18:00:00Z',
      reasonCode: 'meeting',
      resources: [{ kind: 'operatory', resourceRef: operatory }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const blockRef = res.json().data.timeBlockRef;
    const cols = await db.admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'cuspatlas'
       AND table_name = 'scheduling_time_blocks' AND column_name LIKE '%patient%'`,
    );
    expect(cols.rowCount).toBe(0);
    // Visible through the busy seam that availability search (S9) and booking (S10) read.
    const tx = createTenantTransactionRunner(db.app);
    const busy = await tx(ctxFor(T_ALPHA, USER_A1, 'human', SCHED_ALL), (t) =>
      t.query(
        'SELECT resource_id, source_kind, source_id FROM cuspatlas.scheduling_busy WHERE source_id = $1',
        [blockRef],
      ),
    );
    expect(busy.rows).toStrictEqual([
      { resource_id: operatory, source_kind: 'time_block', source_id: blockRef },
    ]);
    // Blocking time without a resource (location-wide, e.g. a holiday) is allowed.
    const wide = await call('a1', 'POST', '/v1/scheduling/time-blocks', {
      locationRef: 'loc-north',
      startsAt: '2030-07-04T04:00:00Z',
      endsAt: '2030-07-05T04:00:00Z',
      reasonCode: 'holiday',
      resources: [],
    });
    expect(wide.statusCode, wide.body).toBe(201);
  });

  it('4. booking-side contract: an appointment may hold no operatory with a typed exception reason', () => {
    expect(validateAppointmentOperatoryAssignment({ operatory: null, noOperatoryReason: 'no_show' })).toBe(
      true,
    );
    expect(validateAppointmentOperatoryAssignment({ operatory: null, noOperatoryReason: 'cancelled' })).toBe(
      true,
    );
    expect(
      validateAppointmentOperatoryAssignment({ operatory: { kind: 'operatory', resourceRef: operatory } }),
    ).toBe(true);
    // No operatory without a reason, an untyped reason, or a non-operatory in the slot are refused.
    expect(validateAppointmentOperatoryAssignment({ operatory: null })).toBe(false);
    expect(validateAppointmentOperatoryAssignment({ operatory: null, noOperatoryReason: 'NO SHOW' })).toBe(
      false,
    );
    expect(
      validateAppointmentOperatoryAssignment({ operatory: { kind: 'provider', resourceRef: provider } }),
    ).toBe(false);
    expect(
      validateAppointmentOperatoryAssignment({
        operatory: { kind: 'operatory', resourceRef: operatory },
        noOperatoryReason: 'no_show',
      }),
    ).toBe(false);
  });

  it('5. another tenant’s resource cannot be read or referenced', async () => {
    const missing = await call('a1', 'GET', `/v1/scheduling/resources/${randomUUID()}`);
    const foreign = await call('a1', 'GET', `/v1/scheduling/resources/${betaOperatory}`);
    const malformed = await call('a1', 'GET', '/v1/scheduling/resources/not-a-ref');
    for (const r of [missing, foreign, malformed]) {
      expect(r.statusCode).toBe(404);
      expect(Object.keys(r.json()).sort()).toStrictEqual(['code', 'correlationId', 'retryable']);
      expect(r.json().code).toBe('not_found');
    }
    const list = await call('a1', 'GET', '/v1/scheduling/resources?limit=100');
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(betaOperatory);

    const before = await count('scheduling_time_blocks');
    const block = await call('a1', 'POST', '/v1/scheduling/time-blocks', {
      locationRef: 'loc-north',
      startsAt: '2030-03-06T17:00:00Z',
      endsAt: '2030-03-06T18:00:00Z',
      reasonCode: 'maintenance',
      resources: [{ kind: 'operatory', resourceRef: betaOperatory }],
    });
    expect(block.statusCode).toBe(404);
    const avail = await call('a1', 'POST', `/v1/scheduling/resources/${betaOperatory}/availability`, {
      effectiveFrom: '2030-01-07',
      weekly: [],
    });
    expect(avail.statusCode).toBe(404);
    expect(await count('scheduling_time_blocks')).toBe(before);
    // Database-level: an occupancy row can never pair one tenant with another tenant's resource.
    await expect(
      db.admin.query(
        `INSERT INTO cuspatlas.scheduling_occupancy (tenant_id, resource_id, location_id, during, source_kind,
           source_id, created_by)
         SELECT $1, r.id, r.location_id, tstzrange('2030-03-06T17:00Z', '2030-03-06T18:00Z'), 'appointment',
           gen_random_uuid(), $3
         FROM cuspatlas.scheduling_resources r WHERE r.id = $2`,
        [T_ALPHA, betaOperatory, USER_A1],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('6. deactivating a resource with future bookings is refused with the bookings enumerated', async () => {
    const booking = await insertBookingFixture(db.admin, {
      tenantId: T_ALPHA,
      resourceRef: operatory2,
      startsAt: '2030-03-07T15:00:00Z',
      endsAt: '2030-03-07T16:00:00Z',
      createdBy: USER_A1,
    });
    const read = (await call('a1', 'GET', `/v1/scheduling/resources/${operatory2}`)).json().data;
    const res = await call('a1', 'POST', `/v1/scheduling/resources/${operatory2}/deactivate`, {
      expectedVersion: read.version,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'conflict',
      retryable: false,
      detail: {
        conflicts: [
          {
            kind: 'resource_overlap',
            resourceRef: { kind: 'operatory', resourceRef: operatory2 },
            existingRef: booking,
            overrideable: false,
          },
        ],
      },
    });
    expect((await call('a1', 'GET', `/v1/scheduling/resources/${operatory2}`)).json().data.status).toBe(
      'active',
    );
    // The alternative: end its availability at a date (an empty weekly set from that date).
    const end = await call('a1', 'POST', `/v1/scheduling/resources/${operatory2}/availability`, {
      effectiveFrom: '2030-04-01',
      weekly: [],
    });
    expect(end.statusCode, end.body).toBe(201);
  });
});

describe('S7 failure and recovery', () => {
  it('1. overlapping availability versions are rejected rather than merged', async () => {
    const r = await defineResource('a1', {
      kind: 'equipment',
      locationRef: 'loc-north',
      displayLabel: 'Synthetic Scanner',
    });
    const url = `/v1/scheduling/resources/${r}/availability`;
    expect(
      (await call('a1', 'POST', url, { effectiveFrom: '2030-02-04', weekly: weekdays('09:00', '12:00') }))
        .statusCode,
    ).toBe(201);
    const before = await count('scheduling_availability_versions');
    for (const effectiveFrom of ['2030-02-04', '2030-01-28']) {
      const res = await call('a1', 'POST', url, { effectiveFrom, weekly: weekdays('10:00', '11:00') });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'conflict',
        detail: { violations: [{ pointer: '/effectiveFrom', rule: 'availabilityOverlap' }] },
      });
    }
    // Overlapping intervals within one version are refused too, never merged.
    const inner = await call('a1', 'POST', url, {
      effectiveFrom: '2030-02-11',
      weekly: [
        { weekday: 1, start: '09:00', end: '12:00' },
        { weekday: 1, start: '11:00', end: '13:00' },
      ],
    });
    expect(inner.statusCode).toBe(422);
    expect(inner.json().detail.violations[0]).toStrictEqual({ pointer: '/weekly', rule: 'intervalsOverlap' });
    const backwards = await call('a1', 'POST', url, {
      effectiveFrom: '2030-02-11',
      weekly: [{ weekday: 1, start: '12:00', end: '09:00' }],
    });
    expect(backwards.statusCode).toBe(422);
    expect(await count('scheduling_availability_versions')).toBe(before);
  });

  it('2. changing a location zone while it has future occupied time is refused', async () => {
    const north = (await call('a1', 'GET', '/v1/scheduling/locations'))
      .json()
      .data.find((l: { locationRef: string }) => l.locationRef === 'loc-north');
    const refused = await call('a1', 'POST', '/v1/scheduling/locations/loc-north/time-zone', {
      timeZone: 'America/Chicago',
      expectedVersion: north.version,
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe('conflict');
    expect(refused.json().detail.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(refused.json().detail.conflicts[0]).toMatchObject({
      kind: 'policy_override_required',
      overrideable: false,
    });
    // A location with no future occupied time may change zone; stale versions are refused.
    await defineLocation('a1', 'loc-east');
    const ok = await call('a1', 'POST', '/v1/scheduling/locations/loc-east/time-zone', {
      timeZone: 'America/Detroit',
      expectedVersion: 1,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      data: { locationRef: 'loc-east', timeZone: 'America/Detroit' },
      version: 2,
    });
    const stale = await call('a1', 'POST', '/v1/scheduling/locations/loc-east/time-zone', {
      timeZone: 'America/New_York',
      expectedVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'stale_version', detail: { currentVersion: 2 } });
    const unknownZone = await call('a1', 'POST', '/v1/scheduling/locations', {
      locationRef: 'loc-west',
      displayLabel: 'Synthetic Location West',
      timeZone: 'Mars/Olympus_Mons',
    });
    expect(unknownZone.statusCode).toBe(422);
    expect(unknownZone.json().detail.violations[0]).toStrictEqual({
      pointer: '/timeZone',
      rule: 'unknownTimeZone',
    });
  });

  it('3. a deactivated resource retains its history and remains readable', async () => {
    const r = await defineResource('a1', {
      kind: 'staff',
      locationRef: 'loc-north',
      displayLabel: 'Synthetic Assistant B',
    });
    await call('a1', 'POST', `/v1/scheduling/resources/${r}/availability`, {
      effectiveFrom: '2030-01-07',
      weekly: weekdays('08:00', '12:00'),
    });
    const res = await call('a1', 'POST', `/v1/scheduling/resources/${r}/deactivate`, { expectedVersion: 1 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ data: { resourceRef: r, status: 'inactive' }, version: 2 });
    const read = (await call('a1', 'GET', `/v1/scheduling/resources/${r}`)).json().data;
    expect(read).toMatchObject({ status: 'inactive', version: 2, displayLabel: 'Synthetic Assistant B' });
    expect(read.availability).toHaveLength(1);
    const again = await call('a1', 'POST', `/v1/scheduling/resources/${r}/availability`, {
      effectiveFrom: '2030-06-03',
      weekly: [],
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().detail.violations[0]).toStrictEqual({ pointer: '/', rule: 'resourceInactive' });
    const block = await call('a1', 'POST', '/v1/scheduling/time-blocks', {
      locationRef: 'loc-north',
      startsAt: '2030-03-08T15:00:00Z',
      endsAt: '2030-03-08T16:00:00Z',
      reasonCode: 'training',
      resources: [{ kind: 'staff', resourceRef: r }],
    });
    expect(block.statusCode).toBe(422);
    // Reactivation is not an available transition, even for the owner path's ordinary roles.
    const tx = createTenantTransactionRunner(db.app);
    await expect(
      tx(ctxFor(T_ALPHA, USER_A1, 'human', SCHED_ALL), (t) =>
        t.query(
          `UPDATE cuspatlas.scheduling_resources SET status = 'active', deactivated_at = NULL WHERE id = $1`,
          [r],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('4. a time block that overlaps an existing booking is refused with the booking references', async () => {
    const booking = await insertBookingFixture(db.admin, {
      tenantId: T_ALPHA,
      resourceRef: provider,
      startsAt: '2030-03-12T14:00:00Z',
      endsAt: '2030-03-12T15:00:00Z',
      createdBy: USER_A1,
    });
    const before = await Promise.all(
      ['scheduling_time_blocks', 'scheduling_occupancy', 'audit_events', 'outbox_events'].map(count),
    );
    const res = await call('a1', 'POST', '/v1/scheduling/time-blocks', {
      locationRef: 'loc-north',
      startsAt: '2030-03-12T14:30:00Z',
      endsAt: '2030-03-12T15:30:00Z',
      reasonCode: 'meeting',
      resources: [
        { kind: 'operatory', resourceRef: operatory },
        { kind: 'provider', resourceRef: provider },
      ],
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().detail.conflicts).toStrictEqual([
      {
        kind: 'resource_overlap',
        resourceRef: { kind: 'provider', resourceRef: provider },
        existingRef: booking,
        explanation: expect.any(String),
        overrideable: false,
      },
    ]);
    expect(
      await Promise.all(
        ['scheduling_time_blocks', 'scheduling_occupancy', 'audit_events', 'outbox_events'].map(count),
      ),
    ).toStrictEqual(before);
    // A location-wide block over a booking is refused the same way.
    const wide = await call('a1', 'POST', '/v1/scheduling/time-blocks', {
      locationRef: 'loc-north',
      startsAt: '2030-03-12T00:00:00Z',
      endsAt: '2030-03-13T00:00:00Z',
      reasonCode: 'holiday',
      resources: [],
    });
    expect(wide.statusCode).toBe(409);
    expect(wide.json().detail.conflicts.map((c: { existingRef: string }) => c.existingRef)).toContain(
      booking,
    );
  });
});

describe('S7 database enforcement, policy and privacy', () => {
  it('overlap is enforced by a btree_gist exclusion constraint per resource', async () => {
    const ext = await db.admin.query(`SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`);
    expect(ext.rowCount).toBe(1);
    const con = await db.admin.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'scheduling_occupancy_no_overlap' AND contype = 'x'`,
    );
    expect(con.rows[0].def).toMatch(
      /EXCLUDE USING gist \(tenant_id WITH =, resource_id WITH =, during WITH &&\)/,
    );
    await insertBookingFixture(db.admin, {
      tenantId: T_ALPHA,
      resourceRef: southOperatory,
      startsAt: '2030-05-01T15:00:00Z',
      endsAt: '2030-05-01T16:00:00Z',
      createdBy: USER_A1,
    });
    await expect(
      insertBookingFixture(db.admin, {
        tenantId: T_ALPHA,
        resourceRef: southOperatory,
        startsAt: '2030-05-01T15:59:00Z',
        endsAt: '2030-05-01T16:30:00Z',
        createdBy: USER_A1,
      }),
    ).rejects.toMatchObject({ code: '23P01' });
    // Adjacent half-open ranges do not conflict.
    await insertBookingFixture(db.admin, {
      tenantId: T_ALPHA,
      resourceRef: southOperatory,
      startsAt: '2030-05-01T16:00:00Z',
      endsAt: '2030-05-01T16:30:00Z',
      createdBy: USER_A1,
    });
  });

  it('concurrent overlapping time blocks on one resource: exactly one succeeds', async () => {
    const body = {
      locationRef: 'loc-south',
      startsAt: '2030-05-02T15:00:00Z',
      endsAt: '2030-05-02T16:00:00Z',
      reasonCode: 'maintenance',
      resources: [{ kind: 'operatory', resourceRef: southOperatory }],
    };
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => call('a1', 'POST', '/v1/scheduling/time-blocks', body)),
    );
    expect(results.map((r) => r.statusCode).sort()).toStrictEqual([201, 409, 409, 409]);
    for (const r of results.filter((x) => x.statusCode === 409)) expect(r.json().code).toBe('conflict');
  });

  it('a location-restricted admin cannot configure another location; a scheduler without admin.configure cannot define resources', async () => {
    const before = await count('scheduling_resources');
    const south = await call('a3', 'POST', '/v1/scheduling/resources', {
      kind: 'operatory',
      locationRef: 'loc-south',
      displayLabel: 'Operatory 9',
    });
    expect(south.statusCode).toBe(403);
    const svc = await call('svcA1', 'POST', '/v1/scheduling/resources', {
      kind: 'operatory',
      locationRef: 'loc-north',
      displayLabel: 'Operatory 9',
    });
    expect(svc.statusCode).toBe(403);
    // Review hardening: another location's resource is hidden like a missing one (no existence oracle).
    const southRead = await call('a3', 'GET', `/v1/scheduling/resources/${southOperatory}`);
    expect(southRead.statusCode).toBe(404);
    const list = (await call('a3', 'GET', '/v1/scheduling/resources?limit=100')).json();
    expect(list.data.every((r: { locationRef: string }) => r.locationRef === 'loc-north')).toBe(true);
    expect(await count('scheduling_resources')).toBe(before);
    // A scheduler (no admin.configure) may still block time.
    const block = await call('svcA1', 'POST', '/v1/scheduling/time-blocks', {
      locationRef: 'loc-north',
      startsAt: '2030-05-03T15:00:00Z',
      endsAt: '2030-05-03T16:00:00Z',
      reasonCode: 'lunch',
      resources: [{ kind: 'provider', resourceRef: provider }],
    });
    expect(block.statusCode, block.body).toBe(201);
  });

  it('commands replay under one key and conflict when the payload changes', async () => {
    const key = randomUUID();
    const body = { kind: 'equipment', locationRef: 'loc-north', displayLabel: 'Synthetic Sterilizer' };
    const first = await call('a1', 'POST', '/v1/scheduling/resources', body, key);
    const second = await call('a1', 'POST', '/v1/scheduling/resources', body, key);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ data: first.json().data, replayed: true });
    const changed = await call(
      'a1',
      'POST',
      '/v1/scheduling/resources',
      { ...body, displayLabel: 'Other' },
      key,
    );
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe('idempotency_conflict');
    const missingKey = await call('a1', 'POST', '/v1/scheduling/resources', body, null);
    expect(missingKey.statusCode).toBe(400);
  });

  it('audit and outbox are written atomically with field names only; the marker never leaks', async () => {
    const res = await call('a1', 'POST', '/v1/scheduling/resources', {
      kind: 'equipment',
      locationRef: 'loc-north',
      displayLabel: `Synthetic ${MARKER}`,
    });
    expect(res.statusCode).toBe(201);
    const ref = res.json().data.resourceRef;
    const audit = await db.admin.query(
      `SELECT operation, resource_type FROM cuspatlas.audit_events WHERE resource_ref = $1`,
      [ref],
    );
    expect(audit.rows).toStrictEqual([
      { operation: 'scheduling.resources.define', resource_type: 'schedulingResource' },
    ]);
    const outbox = await db.admin.query(
      `SELECT payload FROM cuspatlas.outbox_events WHERE aggregate_id = $1`,
      [ref],
    );
    expect(outbox.rows[0].payload).toStrictEqual({
      changedFields: ['kind', 'locationRef', 'displayLabel', 'displayOrder'],
    });
    const denied = await call('b1', 'POST', '/v1/scheduling/time-blocks', {
      locationRef: MARKER.toLowerCase().replaceAll('_', '-'),
      startsAt: '2030-05-03T15:00:00Z',
      endsAt: '2030-05-03T16:00:00Z',
      reasonCode: 'other',
      resources: [{ kind: 'operatory', resourceRef: operatory }],
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.body).not.toContain(MARKER);
    const dumps = await Promise.all(
      ['audit_events', 'outbox_events', 'security_attempt_events', 'command_idempotency'].map(
        async (t) => (await db.admin.query(`SELECT * FROM cuspatlas.${t}`)).rows,
      ),
    );
    expect(JSON.stringify(dumps)).not.toContain(MARKER);
    expect(JSON.stringify(dumps).toLowerCase()).not.toContain(MARKER.toLowerCase().replaceAll('_', '-'));
    expect(logLines.join('\n')).not.toContain(MARKER);
  });

  it('the runtime role cannot delete resources, rewrite availability or change a resource kind', async () => {
    const tx = createTenantTransactionRunner(db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human', SCHED_ALL);
    for (const sql of [
      `DELETE FROM cuspatlas.scheduling_resources WHERE id = '${provider}'`,
      `UPDATE cuspatlas.scheduling_availability_versions SET weekly = '[]'::jsonb`,
      `UPDATE cuspatlas.scheduling_resources SET kind = 'staff' WHERE id = '${provider}'`,
      `DELETE FROM cuspatlas.scheduling_occupancy`,
      `DELETE FROM cuspatlas.scheduling_time_blocks`,
    ]) {
      await expect(tx(ctx, (t) => t.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });
});
