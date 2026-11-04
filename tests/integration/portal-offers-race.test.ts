import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, email, openEngagementHarness } from './support/engagement-fixtures';

/**
 * Review hardening: races on a waitlist offer answered through the portal (S15 seam). Each race runs
 * several times with fresh offers; every iteration ends in exactly one consistent outcome and never a
 * double booking. Synthetic data only.
 */
let db: TestDatabase;
let h: EngagementHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let day = 0;
const MINOR = { known: true, value: '2016-05-05', precision: 'day' };
const ROUNDS = 6;

beforeAll(async () => {
  db = await openTestDatabase('portal_offers_race');
  h = await openEngagementHarness(db);
  loc = await seedLocation(h, 'loc-offer-race');
  await db.admin.query(
    `INSERT INTO cuspatlas.scheduling_offer_policies (tenant_id, location_id, policy_ref, offer_ttl_minutes)
     SELECT tenant_id, id, 'waitlist-offer-pending-approval-1', 60 FROM cuspatlas.scheduling_locations
     WHERE location_ref = 'loc-offer-race'`,
  );
});
afterAll(async () => {
  await h?.close();
  await db?.close();
});

let seq = 0;
/** A minor with a guardian holding `scheduling`, the guardian's portal principal and a fresh offer. */
async function fixture() {
  seq += 1;
  const guardian = await h.person(`Synthetic Race Guardian ${seq}`, [email(`race.guardian.${seq}`)]);
  const child = await h.person(`Synthetic Race Child ${seq}`, [], { birthDate: MINOR });
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${child}/relationships`, {
      counterpartyRef: guardian,
      kind: 'guardian',
      scopes: ['scheduling'],
    }),
    201,
  );
  const principal = await h.enroll(guardian, {
    channel: 'email',
    value: `race.guardian.${seq}@example.invalid`,
  });
  const entry = h.ok<{ data: { entryRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/waitlist', {
      patientRef: child,
      locationRef: loc.locationRef,
      durationMinutes: 60,
      desiredFrom: '2030-06-01T00:00:00Z',
      desiredUntil: '2031-06-01T00:00:00Z',
    }),
    201,
  ).data.entryRef;
  const startsAt = new Date(Date.UTC(2030, 5, 4 + 7 * day, 15)).toISOString();
  const endsAt = new Date(Date.UTC(2030, 5, 4 + 7 * day, 16)).toISOString();
  day += 1;
  const made = h.ok<{ data: { offerRef: string; holdRef: string } }>(
    await h.call('a1', 'POST', `/v1/scheduling/waitlist/${entry}/offer`, {
      startsAt,
      endsAt,
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    }),
    201,
  ).data;
  return { guardian, child, principal, startsAt, endsAt, offer: made.offerRef, hold: made.holdRef };
}
const portalAccept = (principal: string, child: string, offer: string) =>
  h.portal(principal, 'POST', `/portal/v1/patients/${child}/waitlist-offers/${offer}/respond`, {
    expectedVersion: 1,
    outcome: 'accepted',
  });
const staffAccept = (offer: string) =>
  h.call('a1', 'POST', `/v1/scheduling/waitlist-offers/${offer}/respond`, {
    expectedVersion: 1,
    outcome: 'accepted',
  });
const bookings = async (patient: string) =>
  (
    await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.appointments WHERE subject_patient_id = $1 AND status = 'booked'`,
      [patient],
    )
  ).rows[0].n as number;
const offerOutcome = async (offer: string) =>
  (
    await db.admin.query('SELECT outcome, appointment_id FROM cuspatlas.waitlist_offers WHERE id = $1', [
      offer,
    ])
  ).rows[0] as { outcome: string | null; appointment_id: string | null };

describe('portal offer races', () => {
  it('accept vs expiry: an expired offer is never booked, whichever side runs first', async () => {
    for (let i = 0; i < ROUNDS; i += 1) {
      const f = await fixture();
      await db.admin.query(
        `UPDATE cuspatlas.scheduling_holds SET expires_at = now() - interval '1 minute', version = version + 1 WHERE id = $1`,
        [f.hold],
      );
      const [accept, reconcile] = await Promise.all([
        portalAccept(f.principal, f.child, f.offer),
        h.call('svcA1', 'POST', '/v1/scheduling/waitlist/offers/reconcile', {}),
      ]);
      expect(accept.statusCode).toBe(409);
      expect(accept.json().retryable).not.toBe(true);
      expect(reconcile.statusCode).toBe(200);
      expect(await bookings(f.child)).toBe(0);
      expect((await offerOutcome(f.offer)).outcome).toBe('expired');
    }
  });

  it('portal accept vs staff accept: exactly one booking, one winner, the loser sees a closed offer', async () => {
    for (let i = 0; i < ROUNDS; i += 1) {
      const f = await fixture();
      const [portal, staff] = await Promise.all([
        portalAccept(f.principal, f.child, f.offer),
        staffAccept(f.offer),
      ]);
      const codes = [portal.statusCode, staff.statusCode].sort();
      expect(codes).toStrictEqual([200, 409]);
      const loser = portal.statusCode === 409 ? portal : staff;
      expect(loser.json().retryable).not.toBe(true);
      expect(await bookings(f.child)).toBe(1);
      const o = await offerOutcome(f.offer);
      expect(o.outcome).toBe('accepted');
      expect(o.appointment_id).not.toBeNull();
    }
  });

  it('portal accept vs a staff booking of the same window: the window holds one appointment', async () => {
    for (let i = 0; i < ROUNDS; i += 1) {
      const f = await fixture();
      const other = await h.person(`Synthetic Race Walk-in ${seq}-${i}`, [email(`race.walkin.${seq}.${i}`)]);
      const [portal, staff] = await Promise.all([
        portalAccept(f.principal, f.child, f.offer),
        h.call('a1', 'POST', '/v1/scheduling/appointments', {
          patientRef: other,
          locationRef: loc.locationRef,
          startsAt: f.startsAt,
          endsAt: f.endsAt,
          timeZone: 'America/New_York',
          provider: { kind: 'provider', resourceRef: loc.provider },
          operatory: { kind: 'operatory', resourceRef: loc.operatory },
        }),
      ]);
      // The hold blocks the staff booking; the guardian's acceptance converts the hold.
      expect([portal.statusCode, staff.statusCode]).toStrictEqual([200, 409]);
      const inWindow = await db.admin.query(
        `SELECT count(*)::int AS n FROM cuspatlas.appointments WHERE status = 'booked' AND starts_at = $1`,
        [f.startsAt],
      );
      expect(inWindow.rows[0].n).toBe(1);
      expect(await bookings(f.child)).toBe(1);
      expect(await bookings(other)).toBe(0);
    }
  });

  it('relationship revocation vs portal accept: either the answer lands before the revoke or it is refused, never both', async () => {
    const results: string[] = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      const f = await fixture();
      const rel = (
        await db.admin.query(
          `SELECT id, version FROM cuspatlas.patient_relationships WHERE subject_patient_id = $1
           AND counterparty_patient_id = $2`,
          [f.child, f.guardian],
        )
      ).rows[0];
      const [accept, revoke] = await Promise.all([
        portalAccept(f.principal, f.child, f.offer),
        h.call('a1', 'POST', `/v1/patients/${f.child}/relationships/${rel.id}/revoke`, {
          expectedVersion: rel.version,
          reasonCode: 'patient_request',
        }),
      ]);
      expect(revoke.statusCode).toBe(200);
      const booked = await bookings(f.child);
      if (accept.statusCode === 200) {
        expect(booked).toBe(1);
        expect((await offerOutcome(f.offer)).outcome).toBe('accepted');
        results.push('accepted_first');
      } else {
        expect([accept.statusCode, accept.json().code]).toStrictEqual([403, 'forbidden']);
        expect(booked).toBe(0);
        expect((await offerOutcome(f.offer)).outcome).toBeNull();
        results.push('revoked_first');
      }
      // Whatever happened, the next answer by the revoked guardian is refused.
      const later = await portalAccept(f.principal, f.child, f.offer);
      expect([403, 409]).toContain(later.statusCode);
      expect(await bookings(f.child)).toBe(booked);
    }
    expect(results).toHaveLength(ROUNDS);
  });
});
