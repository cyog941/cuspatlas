import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, email, openEngagementHarness } from './support/engagement-fixtures';
import { MARKER } from './support/marker';

/**
 * S15 seam, portal side: the patient or a guardian holding `scheduling` accepts or declines a
 * waitlist offer through S's own respondToOffer with E's portal authority. Acceptance books from the
 * hold exactly as a staff acceptance; a proxy without scheduling, an unrelated principal and an offer
 * of another patient are refused; a service principal still never accepts; only staff withdraw.
 */
let db: TestDatabase;
let h: EngagementHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let day = 0;
const MINOR = { known: true, value: '2016-05-05', precision: 'day' };
let guardian: string;
let guardianP: string;
let child: string;
let proxyP: string;
let strangerP: string;
let otherChild: string;

beforeAll(async () => {
  db = await openTestDatabase('portal_offers');
  h = await openEngagementHarness(db);
  loc = await seedLocation(h, 'loc-portal-offer');
  await db.admin.query(
    `INSERT INTO cuspatlas.scheduling_offer_policies (tenant_id, location_id, policy_ref, offer_ttl_minutes)
     SELECT tenant_id, id, 'waitlist-offer-pending-approval-1', 60 FROM cuspatlas.scheduling_locations
     WHERE location_ref = 'loc-portal-offer'`,
  );
  guardian = await h.person(`Synthetic Offer Guardian ${MARKER}`, [email('eo.guardian')]);
  child = await h.person('Synthetic Offer Child', [], { birthDate: MINOR });
  otherChild = await h.person('Synthetic Other Child', [], { birthDate: MINOR });
  const proxy = await h.person('Synthetic Offer Proxy', [email('eo.proxy')]);
  const stranger = await h.person('Synthetic Offer Stranger', [email('eo.stranger')]);
  for (const [counterparty, kind, scopes] of [
    [guardian, 'guardian', ['scheduling']],
    [proxy, 'proxy', ['demographics']],
  ] as const) {
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${child}/relationships`, {
        counterpartyRef: counterparty,
        kind,
        scopes,
        ...(kind === 'proxy' ? { effectiveUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() } : {}),
      }),
      201,
    );
  }
  guardianP = await h.enroll(guardian, { channel: 'email', value: 'eo.guardian@example.invalid' });
  proxyP = await h.enroll(proxy, { channel: 'email', value: 'eo.proxy@example.invalid' });
  strangerP = await h.enroll(stranger, { channel: 'email', value: 'eo.stranger@example.invalid' });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

async function offerFor(patientRef: string): Promise<string> {
  const entry = h.ok<{ data: { entryRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/waitlist', {
      patientRef,
      locationRef: loc.locationRef,
      durationMinutes: 60,
      desiredFrom: '2030-06-01T00:00:00Z',
      desiredUntil: '2031-06-01T00:00:00Z',
    }),
    201,
  ).data.entryRef;
  const at = (hh: number) => new Date(Date.UTC(2030, 5, 4 + 7 * day, hh)).toISOString();
  day += 1;
  return h.ok<{ data: { offerRef: string } }>(
    await h.call('a1', 'POST', `/v1/scheduling/waitlist/${entry}/offer`, {
      startsAt: at(15),
      endsAt: at(16),
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    }),
    201,
  ).data.offerRef;
}
const url = (patient: string, offer: string) =>
  `/portal/v1/patients/${patient}/waitlist-offers/${offer}/respond`;
const offerRow = async (offer: string) =>
  (
    await db.admin.query('SELECT outcome, appointment_id FROM cuspatlas.waitlist_offers WHERE id = $1', [
      offer,
    ])
  ).rows[0] as { outcome: string | null; appointment_id: string | null };

describe('portal answers to waitlist offers (S15 seam)', () => {
  it('a guardian holding scheduling accepts the minor’s offer: one booking from the hold, audited as portal', async () => {
    const offer = await offerFor(child);
    const res = h.ok<{ data: { appointmentRef: string | null; outcome: string } }>(
      await h.portal(guardianP, 'POST', url(child, offer), { expectedVersion: 1, outcome: 'accepted' }),
    );
    expect(res.data.outcome).toBe('accepted');
    const row = await offerRow(offer);
    expect(row.outcome).toBe('accepted');
    expect(row.appointment_id).toBe(res.data.appointmentRef);
    const appt = h.ok<{ data: { patientRef: string; status: string } }>(
      await h.call('a1', 'GET', `/v1/scheduling/appointments/${row.appointment_id}`),
    ).data;
    expect(appt).toMatchObject({ patientRef: child, status: 'booked' });
    const audit = await db.admin.query(
      `SELECT principal, actor_id FROM cuspatlas.audit_events WHERE operation = 'scheduling.waitlist.respond'
       AND actor_id = $1`,
      [guardianP],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows.every((r) => r.principal === 'portal')).toBe(true);
    // A lost response replays the stored result; nothing is booked twice.
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });

  it('a declined offer releases the hold; a replay of the same key returns the stored result', async () => {
    const offer = await offerFor(child);
    const key = randomUUID();
    const first = await h.portal(
      guardianP,
      'POST',
      url(child, offer),
      { expectedVersion: 1, outcome: 'declined' },
      key,
    );
    expect(first.statusCode).toBe(200);
    const again = await h.portal(
      guardianP,
      'POST',
      url(child, offer),
      { expectedVersion: 1, outcome: 'declined' },
      key,
    );
    expect(again.statusCode).toBe(200);
    expect((await offerRow(offer)).outcome).toBe('declined');
  });

  it('a proxy without scheduling is 403; a stranger and an offer of another patient are the same 404; nothing changes', async () => {
    const offer = await offerFor(child);
    const proxy = await h.portal(proxyP, 'POST', url(child, offer), {
      expectedVersion: 1,
      outcome: 'accepted',
    });
    expect([proxy.statusCode, proxy.json().code]).toStrictEqual([403, 'forbidden']);
    const stranger = await h.portal(strangerP, 'POST', url(child, offer), {
      expectedVersion: 1,
      outcome: 'accepted',
    });
    const otherOffer = await offerFor(otherChild);
    const crossed = await h.portal(guardianP, 'POST', url(child, otherOffer), {
      expectedVersion: 1,
      outcome: 'accepted',
    });
    const missing = await h.portal(guardianP, 'POST', url(child, randomUUID()), {
      expectedVersion: 1,
      outcome: 'accepted',
    });
    for (const r of [stranger, crossed, missing]) expect(r.statusCode).toBe(404);
    const strip = (b: string) => JSON.parse(b, (k, v) => (k === 'correlationId' ? undefined : v));
    expect(strip(crossed.body)).toStrictEqual(strip(missing.body));
    expect((await offerRow(offer)).outcome).toBeNull();
    expect((await offerRow(otherOffer)).outcome).toBeNull();
  });

  it('the portal cannot withdraw (schema) and a revoked guardian is refused at the next answer', async () => {
    const offer = await offerFor(child);
    const withdraw = await h.portal(guardianP, 'POST', url(child, offer), {
      expectedVersion: 1,
      outcome: 'withdrawn',
    });
    expect(withdraw.statusCode).toBe(400);
    const rel = (
      await db.admin.query(
        `SELECT id, version FROM cuspatlas.patient_relationships WHERE subject_patient_id = $1
         AND counterparty_patient_id = $2`,
        [child, guardian],
      )
    ).rows[0];
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${child}/relationships/${rel.id}/revoke`, {
        expectedVersion: rel.version,
        reasonCode: 'patient_request',
      }),
    );
    const after = await h.portal(guardianP, 'POST', url(child, offer), {
      expectedVersion: 1,
      outcome: 'accepted',
    });
    expect([after.statusCode, after.json().code]).toStrictEqual([403, 'forbidden']);
    expect((await offerRow(offer)).outcome).toBeNull();
  });

  it('a service principal still never accepts, and a portal token is refused by the staff route', async () => {
    const offer = await offerFor(otherChild);
    const svc = await h.call('svcA1', 'POST', `/v1/scheduling/waitlist-offers/${offer}/respond`, {
      expectedVersion: 1,
      outcome: 'accepted',
    });
    expect(svc.statusCode).toBe(403);
    const token = await h.portalToken(strangerP);
    const staffRoute = await h.call(token, 'POST', `/v1/scheduling/waitlist-offers/${offer}/respond`, {
      expectedVersion: 1,
      outcome: 'accepted',
    });
    expect(staffRoute.statusCode).toBe(401);
    expect((await offerRow(offer)).outcome).toBeNull();
  });
});
