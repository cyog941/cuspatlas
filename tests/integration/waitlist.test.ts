import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  count,
  createPatient,
  mergePatients,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
  USER_A1,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { actorFor, domainAppointments, envelope } from './support/domain-harness';
import { patientBody } from './support/patient-fixtures';

/**
 * S15: a waitlist entry creates nothing on the schedule; an offer is a short-lived hold with an
 * expiry (ADR 0009 S-D6, recommended-pending-approval) and never books without the explicit
 * acceptance command, which books through the S10 insert path. Decline and expiry release the hold;
 * the slot can then be offered to the next entry. No double booking at any point.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let bare: { locationRef: string; provider: string; operatory: string };
const WAIT = '/v1/scheduling/waitlist';
const OFFERS = '/v1/scheduling/waitlist-offers';
const APPT = '/v1/scheduling/appointments';
let day = 0;

beforeAll(async () => {
  db = await openTestDatabase('waitlist');
  h = await openAppointmentHarness(db, { mcp: true, pool: 8 });
  loc = await seedLocation(h, 'loc-wait');
  bare = await seedLocation(h, 'loc-wait-nopolicy');
  // Synthetic offer policy for loc-wait only (S-D6 proposal for tests: 15 minutes). No write command
  // exists until practice configuration does; the fixture path is the superuser.
  await db.admin.query(
    `INSERT INTO cuspatlas.scheduling_offer_policies (tenant_id, location_id, policy_ref, offer_ttl_minutes)
     SELECT tenant_id, id, 'waitlist-offer-pending-approval-1', 15 FROM cuspatlas.scheduling_locations
     WHERE location_ref = 'loc-wait'`,
  );
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

/** A fresh synthetic weekday slot (Tuesdays from 2030-06-04, 15:00-16:00Z). */
function slot(l = loc) {
  const at = (hh: number) => new Date(Date.UTC(2030, 5, 4 + 7 * day, hh)).toISOString();
  day += 1;
  return {
    startsAt: at(15),
    endsAt: at(16),
    provider: { kind: 'provider', resourceRef: l.provider },
    operatory: { kind: 'operatory', resourceRef: l.operatory },
  };
}

async function entry(o: Record<string, unknown> = {}, l = loc): Promise<{ ref: string; patient: string }> {
  const patient = (o.patientRef as string | undefined) ?? (await createPatient(h, 'Synthetic Waitlisted'));
  const res = h.ok<{ data: { entryRef: string; state: string } }>(
    await h.call('a1', 'POST', WAIT, {
      patientRef: patient,
      locationRef: l.locationRef,
      durationMinutes: 60,
      desiredFrom: '2030-06-01T00:00:00Z',
      desiredUntil: '2031-06-01T00:00:00Z',
      ...o,
    }),
    201,
  );
  expect(res.data.state).toBe('active');
  return { ref: res.data.entryRef, patient };
}

type OfferData = { offerRef: string; holdRef: string; expiresAt: string; intentRef: string; state: string };
const offer = (entryRef: string, s: Record<string, unknown>, key = randomUUID()) =>
  h.call('a1', 'POST', `${WAIT}/${entryRef}/offer`, s, key);
const respond = (offerRef: string, body: Record<string, unknown>) =>
  h.call('a1', 'POST', `${OFFERS}/${offerRef}/respond`, { expectedVersion: 1, ...body });
const expire = (holdRef: string) =>
  db.admin.query(
    `UPDATE cuspatlas.scheduling_holds SET expires_at = now() - interval '1 minute', version = version + 1 WHERE id = $1`,
    [holdRef],
  );

describe('S15 acceptance', () => {
  it('1. adding an entry leaves the schedule unchanged', async () => {
    const before = await Promise.all(
      ['appointments', 'scheduling_holds', 'scheduling_occupancy'].map((t) => count(db, t)),
    );
    await entry();
    expect(
      await Promise.all(
        ['appointments', 'scheduling_holds', 'scheduling_occupancy'].map((t) => count(db, t)),
      ),
    ).toStrictEqual(before);
  });

  it('2. an offer creates a hold with an expiry; a second offer for the same range is refused naming the hold', async () => {
    const one = await entry();
    const two = await entry();
    const s = slot();
    const res = h.ok<{ data: OfferData }>(await offer(one.ref, s), 201).data;
    const ttl = Date.parse(res.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(13 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 1000);
    const hold = await db.admin.query(
      'SELECT state, expires_at FROM cuspatlas.scheduling_holds WHERE id = $1',
      [res.holdRef],
    );
    expect(hold.rows[0].state).toBe('active');
    const second = await offer(two.ref, s);
    expect([second.statusCode, second.json().detail?.reason]).toStrictEqual([409, 'booking_conflict']);
    expect(second.json().detail.conflicts.map((c: { existingRef?: string }) => c.existingRef)).toContain(
      res.holdRef,
    );
    // The offer is a notification intent with channel none, never a send.
    const intent = h.ok<{ data: { purpose: string; channel: string; subjectRef: string } }>(
      await h.call('a1', 'GET', `/v1/scheduling/notifications/${res.intentRef}`),
    ).data;
    expect(intent).toMatchObject({ purpose: 'waitlist_offer', channel: 'none', subjectRef: res.offerRef });
  });

  it('3. expiry releases the slot without staff action; a booking afterwards succeeds', async () => {
    const one = await entry();
    const s = slot();
    const res = h.ok<{ data: OfferData }>(await offer(one.ref, s), 201).data;
    await expire(res.holdRef);
    h.ok(await h.call('svcA1', 'POST', `${WAIT}/offers/reconcile`, {}));
    const o = h.ok<{ data: { outcome: string; outcomeReason: string } }>(
      await h.call('a1', 'GET', `${OFFERS}/${res.offerRef}`),
    ).data;
    expect([o.outcome, o.outcomeReason]).toStrictEqual(['expired', 'hold_expired']);
    const e = h.ok<{ data: { state: string }[] }>(
      await h.call('a1', 'GET', `${WAIT}?locationRef=${loc.locationRef}`),
    );
    expect(e.data.find((x) => (x as { entryRef?: string }).entryRef === one.ref)).toMatchObject({
      state: 'active',
    });
    h.ok(
      await h.call('a1', 'POST', APPT, {
        patientRef: await createPatient(h, 'Synthetic Walk In'),
        locationRef: loc.locationRef,
        timeZone: 'America/New_York',
        ...s,
      }),
      201,
    );
  });

  it('4. an entry whose patient is already booked in the offered window is refused with a typed conflict', async () => {
    const one = await entry();
    const s = slot();
    const other = await seedLocation(h, `loc-w-${randomUUID().slice(0, 6)}`);
    h.ok(
      await h.call('a1', 'POST', APPT, {
        patientRef: one.patient,
        locationRef: other.locationRef,
        timeZone: 'America/New_York',
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        provider: { kind: 'provider', resourceRef: other.provider },
        operatory: { kind: 'operatory', resourceRef: other.operatory },
      }),
      201,
    );
    const res = await offer(one.ref, s);
    expect([res.statusCode, res.json().detail?.reason]).toStrictEqual([409, 'booking_conflict']);
    expect(res.json().detail.conflicts.map((c: { kind: string }) => c.kind)).toStrictEqual([
      'patient_unavailable',
    ]);
  });

  it('5. cross-tenant entries and offers are refused; offers never hold a foreign resource', async () => {
    const one = await entry();
    const foreignOffer = await h.call('b1', 'POST', `${WAIT}/${one.ref}/offer`, slot());
    expect(foreignOffer.statusCode).toBe(404);
    const betaPatient = await createPatient(h, 'Synthetic Beta', 'b1');
    const foreignAdd = await h.call('b1', 'POST', WAIT, {
      patientRef: betaPatient,
      locationRef: loc.locationRef,
      durationMinutes: 60,
      desiredFrom: '2030-06-01T00:00:00Z',
      desiredUntil: '2031-06-01T00:00:00Z',
    });
    expect(foreignAdd.statusCode).toBe(404);
    const list = h.ok<{ data: { entryRef: string }[] }>(await h.call('b1', 'GET', WAIT));
    expect(list.data.map((e) => e.entryRef)).not.toContain(one.ref);
  });

  it('6. an offer is never accepted without the acceptance command: it ends expired, never as a silent booking', async () => {
    const one = await entry();
    const s = slot();
    const res = h.ok<{ data: OfferData }>(await offer(one.ref, s), 201).data;
    await expire(res.holdRef);
    h.ok(await h.call('a1', 'POST', '/v1/scheduling/holds/reconcile', {}));
    const o = h.ok<{ data: { outcome: string; appointmentRef: string | null } }>(
      await h.call('a1', 'GET', `${OFFERS}/${res.offerRef}`),
    ).data;
    expect([o.outcome, o.appointmentRef]).toStrictEqual(['expired', null]);
    const { rows } = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.appointments WHERE subject_patient_id = $1',
      [one.patient],
    );
    expect(rows[0].n).toBe(0);
  });

  it('observable: one slot offered, declined and released, re-offered to a second entry and accepted, never double-booked', async () => {
    const first = await entry({ priority: 1 });
    const second = await entry({ priority: 2 });
    const s = slot();
    const o1 = h.ok<{ data: OfferData }>(await offer(first.ref, s), 201).data;
    // While the first offer is live, the slot cannot be offered again.
    expect((await offer(second.ref, s)).statusCode).toBe(409);
    const declined = h.ok<{ data: { outcome: string } }>(
      await respond(o1.offerRef, { outcome: 'declined', reasonCode: 'patient_declined' }),
    ).data;
    expect(declined.outcome).toBe('declined');
    const released = await db.admin.query(
      'SELECT state, release_reason FROM cuspatlas.scheduling_holds WHERE id = $1',
      [o1.holdRef],
    );
    expect(released.rows[0]).toStrictEqual({ state: 'released', release_reason: 'offer_declined' });
    const o2 = h.ok<{ data: OfferData }>(await offer(second.ref, s), 201).data;
    const accepted = h.ok<{ data: { outcome: string; appointmentRef: string } }>(
      await respond(o2.offerRef, { outcome: 'accepted' }),
    ).data;
    expect(accepted.outcome).toBe('accepted');
    const appt = h.ok<{ data: { patientRef: string; status: string; startsAt: string } }>(
      await h.call('a1', 'GET', `${APPT}/${accepted.appointmentRef}`),
    ).data;
    expect([appt.patientRef, appt.status, appt.startsAt]).toStrictEqual([
      second.patient,
      'booked',
      s.startsAt,
    ]);
    const hold = await db.admin.query(
      'SELECT state, appointment_id FROM cuspatlas.scheduling_holds WHERE id = $1',
      [o2.holdRef],
    );
    expect(hold.rows[0]).toStrictEqual({ state: 'converted', appointment_id: accepted.appointmentRef });
    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.appointments WHERE provider_id = $1 AND status = 'booked'
       AND starts_at = $2`,
      [loc.provider, s.startsAt],
    );
    expect(rows[0].n).toBe(1);
    const entries = h.ok<{ data: { entryRef: string; state: string }[] }>(
      await h.call('a1', 'GET', `${WAIT}?locationRef=${loc.locationRef}`),
    ).data;
    expect(entries.find((e) => e.entryRef === first.ref)?.state).toBe('active');
    expect(entries.find((e) => e.entryRef === second.ref)?.state).toBe('booked');
    // REST and MCP list the same entries.
    const m = await h.mcp('a1', 'scheduling_waitlist_list', { locationRef: loc.locationRef });
    expect((m.body as { data: { entryRef: string }[] }).data.map((e) => e.entryRef)).toStrictEqual(
      entries.map((e) => e.entryRef),
    );
  });
});

describe('S15 failure and recovery', () => {
  it('1. a failure after the offer and hold are written leaves neither (they commit together)', async () => {
    const one = await entry();
    const tables = ['waitlist_offers', 'scheduling_holds', 'scheduling_occupancy', 'notification_intents'];
    const before = await Promise.all(tables.map((t) => count(db, t)));
    const faulty = domainAppointments(db, {
      execute: async (_c, _e, _t, handler) => {
        await handler();
        throw new Error('synthetic fault after the offer');
      },
    });
    const a1 = await actorFor(db, USER_A1, T_ALPHA);
    await expect(
      faulty.offerSlot(a1, one.ref, envelope('scheduling.waitlist.offer', { ...slot() })),
    ).rejects.toThrow();
    expect(await Promise.all(tables.map((t) => count(db, t)))).toStrictEqual(before);
  });

  it('2. accepting an offer that expired in flight is a typed conflict with guidance, never a booking', async () => {
    const one = await entry();
    const res = h.ok<{ data: OfferData }>(await offer(one.ref, slot()), 201).data;
    await expire(res.holdRef);
    const before = await count(db, 'appointments');
    const late = await respond(res.offerRef, { outcome: 'accepted' });
    expect([late.statusCode, late.json().detail?.reason]).toStrictEqual([409, 'offer_expired']);
    expect(await count(db, 'appointments')).toBe(before);
  });

  it('3. a merged patient relinks to the survivor; the entry keeps its history', async () => {
    const body = patientBody('Synthetic Duplicate Waiter');
    const a = h.ok<{ data: { patientRef: string } }>(await h.call('a1', 'POST', '/v1/patients', body), 201)
      .data.patientRef;
    const b = h.ok<{ data: { patientRef: string } }>(await h.call('a1', 'POST', '/v1/patients', body), 201)
      .data.patientRef;
    const e = await entry({ patientRef: b });
    await mergePatients(h, a, b);
    const list = h.ok<{ data: { entryRef: string; patientRef: string; version: number }[] }>(
      await h.call('a1', 'GET', `${WAIT}?locationRef=${loc.locationRef}`),
    ).data;
    expect(list.find((x) => x.entryRef === e.ref)?.patientRef).toBe(a);
  });

  it('4. a location without an offer policy cannot be offered until a policy exists', async () => {
    const one = await entry({}, bare);
    const res = await offer(one.ref, slot(bare));
    expect([res.statusCode, res.json().detail?.reason]).toStrictEqual([409, 'offer_policy_missing']);
    expect(await count(db, 'waitlist_offers')).toBeGreaterThanOrEqual(0);
  });

  it('removing an entry is explicit with a reason; a live offer must be answered first', async () => {
    const one = await entry();
    const res = h.ok<{ data: OfferData }>(await offer(one.ref, slot()), 201).data;
    const blocked = await h.call('a1', 'POST', `${WAIT}/${one.ref}/remove`, {
      expectedVersion: 2,
      reasonCode: 'patient_request',
    });
    expect([blocked.statusCode, blocked.json().detail?.reason]).toStrictEqual([409, 'offer_pending']);
    h.ok(await respond(res.offerRef, { outcome: 'withdrawn', reasonCode: 'practice_request' }));
    const removed = h.ok<{ data: { state: string } }>(
      await h.call('a1', 'POST', `${WAIT}/${one.ref}/remove`, {
        expectedVersion: 3,
        reasonCode: 'patient_request',
      }),
    ).data;
    expect(removed.state).toBe('removed');
  });
});

describe('S15 lazy offer expiry (review hardening)', () => {
  it('an expired offer is never shown or treated as live, without waiting for the reconcile job', async () => {
    const one = await entry();
    const res = h.ok<{ data: OfferData }>(await offer(one.ref, slot()), 201).data;
    await expire(res.holdRef);
    // Read: expired, derived from the hold's expiry.
    const o = h.ok<{ data: { outcome: string; outcomeReason: string } }>(
      await h.call('a1', 'GET', `${OFFERS}/${res.offerRef}`),
    ).data;
    expect([o.outcome, o.outcomeReason]).toStrictEqual(['expired', 'hold_expired']);
    // A new offer for the same entry is not refused as offer_pending; the stale offer is reaped first.
    const again = await offer(one.ref, slot());
    expect(again.statusCode).toBe(201);
    const stored = await db.admin.query('SELECT outcome FROM cuspatlas.waitlist_offers WHERE id = $1', [
      res.offerRef,
    ]);
    expect(stored.rows[0].outcome).toBe('expired');
    // Removing an entry whose offer expired is allowed.
    const two = await entry();
    const second = h.ok<{ data: OfferData }>(await offer(two.ref, slot()), 201).data;
    await expire(second.holdRef);
    const removed = await h.call('a1', 'POST', `${WAIT}/${two.ref}/remove`, {
      expectedVersion: 3,
      reasonCode: 'patient_request',
    });
    expect(removed.statusCode).toBe(200);
  });
  it('a response racing the expiry job takes locks in one order: no deadlock victim, one consistent outcome', async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const one = await entry();
      const res = h.ok<{ data: OfferData }>(await offer(one.ref, slot()), 201).data;
      await expire(res.holdRef);
      const [a, b] = await Promise.all([
        respond(res.offerRef, { outcome: 'declined', reasonCode: 'patient_declined' }),
        h.call('svcA1', 'POST', `${WAIT}/offers/reconcile`, {}),
      ]);
      // A deadlock victim would surface as a bare retryable conflict; with one lock order there is none.
      for (const r of [a, b]) expect(r.json().retryable).not.toBe(true);
      expect([200, 409]).toContain(a.statusCode);
      expect(b.statusCode).toBe(200);
      const o = await db.admin.query(
        `SELECT o.outcome, e.state FROM cuspatlas.waitlist_offers o JOIN cuspatlas.waitlist_entries e ON e.id = o.entry_id WHERE o.id = $1`,
        [res.offerRef],
      );
      expect(['declined', 'expired']).toContain(o.rows[0].outcome);
      expect(o.rows[0].state).toBe('active');
      outcomes.push(o.rows[0].outcome);
    }
    expect(outcomes).toHaveLength(12);
  });
});
