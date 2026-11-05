import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAuthorize, createReadSurfaceService } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  openAppointmentHarness,
  seedLocation,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { T_ALPHA, USER_A1, USER_A3, USER_A4, USER_B1 } from './support/fixtures';

/**
 * A16 (PT-06): measures with declared definitions, version, unit, filters, as-of, freshness and
 * small-cell suppression; undefined is distinct from zero; aggregation is not authorization; financial
 * measures reuse B11. Synthetic data only.
 */
let db: TestDatabase;
let h: AppointmentHarness;
const DAY = '2030-03-05';
const M = '/v1/analytics/measures';
type Json = Record<string, any>;
const setScopes = (who: string, scopes: string[]) =>
  db.admin.query('UPDATE cuspatlas.memberships SET scopes = $2::text[] WHERE principal_id = $1', [
    who,
    scopes,
  ]);

beforeAll(async () => {
  db = await openTestDatabase('analytics');
  h = await openAppointmentHarness(db, { mcp: true });
  await db.admin.query(
    'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1',
    [USER_A1, ['analytics.read', 'receivables.read', 'openClaims.read', 'messaging.read']],
  );
  await setScopes(USER_A4, ['scheduling.read', 'patients.read']);
  await setScopes(USER_A3, ['scheduling.read', 'analytics.read']);
  await db.admin.query(
    'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1',
    [USER_B1, ['analytics.read', 'scheduling.read']],
  );
  const loc = await seedLocation(h, 'loc-north');
  const patient = await createPatient(h, 'Measured');
  h.ok(
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
  );
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

const read = (who: string, key: string, q = `locationRef=loc-north&from=${DAY}`) =>
  h.call(who, 'GET', `${M}/${key}?${q}`);

describe('A16 analytics measures', () => {
  it('publishes every definition with version, unit, date basis, filters and suppression', async () => {
    const list = h.ok<{ data: Json[]; suppression: Json; envelope: Json }>(await h.call('a1', 'GET', M));
    expect(list.data.map((d) => d.measureKey)).toEqual(
      expect.arrayContaining([
        'scheduling.no_show_rate',
        'scheduling.utilization',
        'financial.open_insurer_receivable',
        'communications.reply_sla',
      ]),
    );
    for (const d of list.data) {
      expect(d.definition.length).toBeGreaterThan(20);
      expect(d.definitionVersion).toEqual(expect.any(String));
    }
    expect(list.suppression).toMatchObject({ threshold: 11, approval: 'pending' });
    const mcp = await h.mcp('a1', 'analytics_measures_list', {});
    expect(mcp.body.data).toEqual(list.data);
  });

  it('suppresses a small population with no value that would let a reader derive it', async () => {
    const r = h.ok<{ data: Json }>(await read('a1', 'scheduling.utilization')).data;
    expect(r).toMatchObject({
      measureKey: 'scheduling.utilization',
      definitionVersion: 'scheduling.utilization.1',
      appliedFilters: { locationRef: 'loc-north', from: DAY, to: DAY, timeZone: 'America/New_York' },
      freshness: { state: 'current' },
      result: { state: 'suppressed' },
    });
    expect(Object.keys(r.result)).toEqual(['state']);
    expect(r.asOf).toEqual(expect.any(String));
  });

  it('reports the value under a lower configured threshold, and undefined (not zero) for a zero denominator', async () => {
    const membership = createMembershipSource(db.app);
    const reads = createReadSurfaceService({
      authorize: createAuthorize(membership),
      withTenantTransaction: createTenantTransactionRunner(db.app),
      recording: { sink: createSecurityAttemptSink(db.sink), alert: () => undefined },
      suppressionThreshold: 1,
    });
    const ctx = {
      tenantId: T_ALPHA,
      actorId: USER_A1,
      principal: 'human' as const,
      sessionId: 'synthetic-session',
      scopes: (await membership.load(USER_A1, T_ALPHA))?.scopes ?? [],
      correlationId: '00000000-0000-4000-8000-0000000000c2',
    };
    const q = { locationRef: 'loc-north', from: DAY };
    const u = ((await reads.readMeasure(ctx, 'scheduling.utilization', q)) as { data: Json }).data;
    // One provider, 08:00-17:00 local (540 minutes), one booked half hour.
    expect(u.result).toEqual({ state: 'value', value: 0.0556, numerator: 30, denominator: 540 });
    const ns = ((await reads.readMeasure(ctx, 'scheduling.no_show_rate', q)) as { data: Json }).data;
    expect(ns.result).toEqual({ state: 'undefined', reason: 'zero_denominator' });
    const sla = ((await reads.readMeasure(ctx, 'communications.reply_sla', q)) as { data: Json }).data;
    expect(sla.result.state).toBe('undefined');
  });

  it('refuses without analytics.read identically for an empty and a non-empty population', async () => {
    const full = await read('a4', 'scheduling.utilization');
    const empty = await read('a4', 'scheduling.utilization', 'locationRef=loc-north&from=2030-03-09');
    expect([full.statusCode, empty.statusCode]).toEqual([403, 403]);
    expect(full.json().code).toBe(empty.json().code);
  });

  it('aggregation is not authorization: analytics.read without the financial scopes is refused', async () => {
    expect((await read('a3', 'financial.claims_over_30_days', '')).statusCode).toBe(403);
    const ok = h.ok<{ data: Json }>(await read('a1', 'financial.claims_over_30_days', '')).data;
    expect(ok.result).toEqual({ state: 'value', value: 0 });
    expect(ok.definitionVersion).toEqual(expect.any(String));
    const money = h.ok<{ data: Json }>(await read('a1', 'financial.open_insurer_receivable', '')).data;
    expect(money.result.value).toMatchObject({ currency: 'USD' });
  });

  it('serves only registered definitions and versions, and is tenant scoped', async () => {
    expect((await read('a1', 'scheduling.unknown_measure')).statusCode).toBe(404);
    expect(
      (
        await read(
          'a1',
          'scheduling.utilization',
          `locationRef=loc-north&from=${DAY}&version=scheduling.utilization.0`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await read(
          'a1',
          'scheduling.utilization',
          `locationRef=loc-north&from=${DAY}&version=scheduling.utilization.1`,
        )
      ).statusCode,
    ).toBe(200);
    expect((await read('b1', 'scheduling.utilization')).statusCode).toBe(404);
    expect(
      (await read('a1', 'scheduling.utilization', `locationRef=loc-north&from=${DAY}&to=2030-09-01`))
        .statusCode,
    ).toBe(422);
  });
});
