import { randomUUID } from 'node:crypto';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAuthorize, createEngagementService, SYNTHETIC_TEST_MATCH_KEY_PEPPER } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, email, openEngagementHarness } from './support/engagement-fixtures';
import { MARKER } from './support/marker';

/**
 * E3: a portal appointment request is the S8 request, created by S8's own command with origin
 * `portal` (no second request table). The portal input is a closed shape: no tenant, no patient
 * other than the path patient, no urgency or free-text note; location and provider are validated by
 * S8. Authority is the E1 fresh check (`scheduling` scope), rechecked at execution and on replay.
 * Abuse bounds are per patient (open portal requests) and per principal (submissions per day).
 */
let db: TestDatabase;
let h: EngagementHarness;
let loc: { locationRef: string; provider: string; operatory: string };
const MINOR = { known: true, value: '2016-05-05', precision: 'day' };
const URL = (p: string) => `/portal/v1/patients/${p}/appointment-requests`;
const body = (extra: Record<string, unknown> = {}) => ({
  locationRef: loc.locationRef,
  flexibility: 'mornings',
  contactConsent: 'granted',
  ...extra,
});

let adult: string;
let adultP: string;
let child: string;

beforeAll(async () => {
  db = await openTestDatabase('portal_requests');
  h = await openEngagementHarness(db);
  loc = await seedLocation(h, 'loc-portal-req');
  adult = await h.person(`Synthetic Requester ${MARKER}`, [email('e3.adult')]);
  child = await h.person('Synthetic Requester Child', [], { birthDate: MINOR });
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${child}/relationships`, {
      counterpartyRef: adult,
      kind: 'guardian',
      scopes: ['scheduling'],
    }),
    201,
  );
  adultP = await h.enroll(adult, { channel: 'email', value: 'e3.adult@example.invalid' });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

const attempts = async (res: { headers: Record<string, unknown> }) =>
  (
    await db.admin.query(
      'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
      [res.headers['x-correlation-id']],
    )
  ).rows.map((r) => r.reason_code);
const requestCount = async () =>
  (await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.appointment_requests')).rows[0].n as number;

describe('E3 acceptance', () => {
  it('a portal submission is one request in the S8 aggregate staff read, with origin portal and the same audit', async () => {
    const res = h.ok<{ data: { requestRef: string; state: string } }>(
      await h.portal(adultP, 'POST', URL(adult), body()),
      201,
    );
    const ref = res.data.requestRef;
    expect(res.data.state).toBe('open');
    const staff = h.ok<{
      data: { requestRef: string; origin: string; sourceChannel: string; patientRef: string };
    }>(await h.call('a1', 'GET', `/v1/scheduling/appointment-requests/${ref}`)).data;
    expect(staff).toMatchObject({
      requestRef: ref,
      origin: 'portal',
      sourceChannel: 'portal',
      patientRef: adult,
    });
    const list = h.ok<{ data: { requestRef: string }[] }>(
      await h.call('a1', 'GET', `/v1/scheduling/appointment-requests?patientRef=${adult}`),
    ).data;
    expect(list.map((r) => r.requestRef)).toContain(ref);
    const audit = await db.admin.query(
      `SELECT operation, principal, actor_id FROM cuspatlas.audit_events WHERE resource_ref = $1 ORDER BY occurred_at`,
      [ref],
    );
    expect(audit.rows).toStrictEqual([
      { operation: 'scheduling.requests.create', principal: 'portal', actor_id: adultP },
    ]);
    // No second appointment-request table exists (I8 deletion requests and B adjustment requests are
    // imaging and billing records).
    const tables = await db.admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'cuspatlas' AND table_name ~ 'request'
         AND table_name !~ '^(imaging|billing|rcm)_'
       ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toStrictEqual([
      'appointment_request_transitions',
      'appointment_requests',
    ]);
    // The portal shows it pending, never booked.
    const view = h.ok<{ data: { fields: { requests: { requestRef: string; state: string }[] } } }>(
      await h.portal(adultP, 'GET', `/portal/v1/patients/${adult}/views/requests`),
    ).data;
    expect(view.fields.requests.find((r) => r.requestRef === ref)?.state).toBe('pending');
  });

  it('a duplicate submission with the same key (also after a lost response) returns the original request', async () => {
    const key = randomUUID();
    const before = await requestCount();
    const first = h.ok<{ data: { requestRef: string } }>(
      await h.portal(adultP, 'POST', URL(adult), body({ flexibility: 'afternoons' }), key),
      201,
    );
    const again = h.ok<{ data: { requestRef: string }; replayed: boolean }>(
      await h.portal(adultP, 'POST', URL(adult), body({ flexibility: 'afternoons' }), key),
      201,
    );
    expect(again.data.requestRef).toBe(first.data.requestRef);
    expect(again.replayed).toBe(true);
    expect(await requestCount()).toBe(before + 1);
    const changed = await h.portal(adultP, 'POST', URL(adult), body({ flexibility: 'evenings' }), key);
    expect([changed.statusCode, changed.json().code]).toStrictEqual([409, 'idempotency_conflict']);
  });

  it('only staff turn a request into an appointment; a later cancellation keeps the request history', async () => {
    const ref = h.ok<{ data: { requestRef: string } }>(
      await h.portal(adultP, 'POST', URL(adult), body({ flexibility: 'weekdays' })),
      201,
    ).data.requestRef;
    const booked = h.ok<{ data: { appointmentRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/appointments', {
        patientRef: adult,
        locationRef: loc.locationRef,
        startsAt: '2030-06-10T14:00:00Z',
        endsAt: '2030-06-10T15:00:00Z',
        timeZone: 'America/New_York',
        provider: { kind: 'provider', resourceRef: loc.provider },
        operatory: { kind: 'operatory', resourceRef: loc.operatory },
        requestRef: ref,
      }),
      201,
    ).data.appointmentRef;
    const view = async () =>
      h
        .ok<{ data: { fields: { requests: { requestRef: string; state: string }[] } } }>(
          await h.portal(adultP, 'GET', `/portal/v1/patients/${adult}/views/requests`),
        )
        .data.fields.requests.find((r) => r.requestRef === ref)?.state;
    expect(await view()).toBe('scheduled');
    const transitions = async () =>
      (
        await db.admin.query(
          'SELECT from_state, to_state FROM cuspatlas.appointment_request_transitions WHERE request_id = $1 ORDER BY request_version',
          [ref],
        )
      ).rows;
    const history = await transitions();
    h.ok(
      await h.call('a1', 'POST', `/v1/scheduling/appointments/${booked}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    expect(await transitions()).toStrictEqual(history);
    // No portal path books: there is no portal route that creates an appointment.
    const tryBook = await h.portal(adultP, 'POST', '/v1/scheduling/appointments', {});
    expect(tryBook.statusCode).toBe(401);
  });

  it('a guardian with scheduling scope requests for the minor; a proxy without it and an unrelated patient are denied', async () => {
    const ok = h.ok<{ data: { requestRef: string } }>(
      await h.portal(adultP, 'POST', URL(child), body()),
      201,
    );
    const row = await db.admin.query(
      'SELECT subject_patient_id, origin FROM cuspatlas.appointment_requests WHERE id = $1',
      [ok.data.requestRef],
    );
    expect(row.rows[0]).toStrictEqual({ subject_patient_id: child, origin: 'portal' });
    const holder = await h.person('Synthetic Proxy Requester', [email('e3.proxy')]);
    const subject = await h.person('Synthetic Proxy Requester Subject', []);
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${subject}/relationships`, {
        counterpartyRef: holder,
        kind: 'proxy',
        scopes: ['demographics'],
        effectiveUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      }),
      201,
    );
    const holderP = await h.enroll(holder, { channel: 'email', value: 'e3.proxy@example.invalid' });
    const before = await requestCount();
    const denied = await h.portal(holderP, 'POST', URL(subject), body());
    expect([denied.statusCode, denied.json().detail?.reason]).toStrictEqual([
      403,
      'relationship_scope_missing',
    ]);
    expect(await attempts(denied)).toStrictEqual(['relationship_scope_missing']);
    const unrelated = await h.portal(holderP, 'POST', URL(adult), body());
    const random = await h.portal(holderP, 'POST', URL(randomUUID()), body());
    expect(unrelated.statusCode).toBe(404);
    const { correlationId: _a, ...u } = unrelated.json();
    const { correlationId: _b, ...r } = random.json();
    expect(u).toStrictEqual(r);
    expect(await requestCount()).toBe(before);
  });

  it('a revocation between page load and submit fails the submit; a replay of an earlier key is reauthorized', async () => {
    const parent = await h.person('Synthetic Revoke Requester', [email('e3.revoke')]);
    const kid = await h.person('Synthetic Revoke Requester Kid', [], { birthDate: MINOR });
    const rel = h.ok<{ data: { relationshipRef: string } }>(
      await h.call('a1', 'POST', `/v1/patients/${kid}/relationships`, {
        counterpartyRef: parent,
        kind: 'guardian',
        scopes: ['scheduling'],
      }),
      201,
    ).data.relationshipRef;
    const p = await h.enroll(parent, { channel: 'email', value: 'e3.revoke@example.invalid' });
    const key = randomUUID();
    h.ok(await h.portal(p, 'POST', URL(kid), body(), key), 201);
    h.ok(await h.portal(p, 'GET', `/portal/v1/patients/${kid}/views/requests`));
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${kid}/relationships/${rel}/revoke`, {
        expectedVersion: 1,
        reasonCode: 'guardian_request',
      }),
    );
    const fresh = await h.portal(p, 'POST', URL(kid), body({ flexibility: 'evenings' }));
    expect([fresh.statusCode, fresh.json().detail?.reason]).toStrictEqual([403, 'relationship_revoked']);
    const replay = await h.portal(p, 'POST', URL(kid), body(), key);
    expect([replay.statusCode, replay.json().detail?.reason]).toStrictEqual([403, 'relationship_revoked']);
  });
});

describe('E3 forbidden fields, bounds and failure', () => {
  it('tenant, patient, urgency, note and unknown fields are refused; location and provider are S8-validated', async () => {
    const before = await requestCount();
    for (const extra of [
      { tenantId: '10000000-0000-4000-8000-00000000000b' },
      { patientRef: child },
      { urgent: true },
      { note: `free text ${MARKER}` },
      { sourceChannel: 'phone' },
    ]) {
      const res = await h.portal(adultP, 'POST', URL(adult), body(extra));
      expect([Object.keys(extra)[0], res.statusCode]).toStrictEqual([Object.keys(extra)[0], 400]);
      expect(res.body).not.toContain(MARKER);
    }
    const otherLoc = await h.portal(adultP, 'POST', URL(adult), body({ locationRef: 'loc-unknown' }));
    expect(otherLoc.statusCode).toBe(404);
    const badProvider = await h.portal(
      adultP,
      'POST',
      URL(adult),
      body({ providerPreference: loc.operatory }),
    );
    expect(badProvider.statusCode).toBe(422);
    expect(await requestCount()).toBe(before);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });

  it('a closed location refuses with a stated reason; abuse bounds refuse with 429 and a reason', async () => {
    const p = await h.person('Synthetic Bounded Requester', [email('e3.bounded')]);
    const pp = await h.enroll(p, { channel: 'email', value: 'e3.bounded@example.invalid' });
    for (let i = 0; i < 3; i += 1) h.ok(await h.portal(pp, 'POST', URL(p), body()), 201);
    const fourth = await h.portal(pp, 'POST', URL(p), body());
    expect([fourth.statusCode, fourth.json().detail?.reason]).toStrictEqual([
      429,
      'portal_open_request_limit',
    ]);
    expect(fourth.json().detail?.limit).toStrictEqual({ name: 'portalOpenRequestsPerPatient', value: 3 });
    expect(await attempts(fourth)).toStrictEqual(['portal_rate_limited']);
    await db.admin.query(`UPDATE cuspatlas.scheduling_locations SET status = 'inactive', version = version + 1
      WHERE location_ref = 'loc-portal-req'`);
    try {
      const closed = await h.portal(adultP, 'POST', URL(child), body());
      expect([closed.statusCode, closed.json().detail?.violations?.[0]?.rule]).toStrictEqual([
        422,
        'locationInactive',
      ]);
    } finally {
      await db.admin.query(`UPDATE cuspatlas.scheduling_locations SET status = 'active', version = version + 1
        WHERE location_ref = 'loc-portal-req'`);
    }
  });

  it('when the scheduling aggregate is unavailable the portal answers a typed unavailable state and stores nothing', async () => {
    const svc = createEngagementService({
      authorize: createAuthorize(createMembershipSource(db.app)),
      withTenantTransaction: createTenantTransactionRunner(db.app),
      recording: { sink: createSecurityAttemptSink(db.sink), alert: () => undefined },
      matchKeyPepper: SYNTHETIC_TEST_MATCH_KEY_PEPPER,
    });
    const ctx = {
      tenantId: '10000000-0000-4000-8000-00000000000a',
      actorId: adultP,
      principal: 'portal' as const,
      sessionId: randomUUID(),
      scopes: [],
      correlationId: randomUUID(),
    };
    const before = await requestCount();
    await expect(
      svc.submitPortalRequest(ctx, adult, {
        operation: 'portal.requests.submit',
        idempotencyKey: randomUUID(),
        payload: body(),
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable', detail: { reason: 'aggregate_unavailable' } });
    expect(await requestCount()).toBe(before);
  });
});
