import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  count,
  createPatient,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { SVC_A1, SVC_B1, USER_A1 } from './support/fixtures';

/**
 * PT-02 cancellation recovery (docs/PRACTICE-TIME-AND-AUTOMATION.md): a cancelled future booking
 * opens a recovery work item; reading it prepares ranked waitlist candidates (provider, duration,
 * window and booking checks; consent is E6's decision, referenced only). Default mode is
 * prepare-for-approval: a person executes the prepared offer. Policy-authorized execution by a
 * service principal requires an explicit, revocable standing policy (owner, operation, scope,
 * limits, expiry) that is rechecked at execution and recorded on the offer. An offer is a
 * short-lived hold and a recorded intent with channel none; an invitation is not attendance.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
const APPT = '/v1/scheduling/appointments';
const WAIT = '/v1/scheduling/waitlist';
const REC = '/v1/scheduling/recoveries';
const POL = '/v1/scheduling/standing-policies';
let week = 0;

beforeAll(async () => {
  db = await openTestDatabase('cancellation_recovery');
  h = await openAppointmentHarness(db, { mcp: true, pool: 8 });
  loc = await seedLocation(h, 'loc-recovery');
  await db.admin.query(
    `INSERT INTO cuspatlas.scheduling_offer_policies (tenant_id, location_id, policy_ref, offer_ttl_minutes)
     SELECT tenant_id, id, 'waitlist-offer-pending-approval-1', 15 FROM cuspatlas.scheduling_locations
     WHERE location_ref = 'loc-recovery'`,
  );
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

/** Books and cancels a 60-minute Wednesday booking; returns the freed window and the recovery. */
async function freedSlot(): Promise<{
  appointmentRef: string;
  startsAt: string;
  endsAt: string;
  recoveryRef: string;
}> {
  const at = (hh: number) => new Date(Date.UTC(2030, 6, 3 + 7 * week, hh)).toISOString();
  week += 1;
  const window = {
    startsAt: at(14),
    endsAt: at(15),
    timeZone: 'America/New_York',
    provider: { kind: 'provider', resourceRef: loc.provider },
    operatory: { kind: 'operatory', resourceRef: loc.operatory },
  };
  const booked = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', APPT, {
      patientRef: await createPatient(h, 'Synthetic Canceller'),
      locationRef: loc.locationRef,
      ...window,
    }),
    201,
  ).data.appointmentRef;
  h.ok(
    await h.call('a1', 'POST', `${APPT}/${booked}/cancel`, {
      expectedVersion: 1,
      reasonCode: 'patient_request',
    }),
  );
  const list = h.ok<{
    data: { items: { workItemRef: string; evidenceRefs: { kind: string; ref: string }[] }[] };
  }>(await h.call('a1', 'GET', `${REC}?locationRef=${loc.locationRef}`)).data;
  const item = list.items.find((i) => i.evidenceRefs.some((e) => e.ref === booked));
  expect(item).toBeDefined();
  return {
    appointmentRef: booked,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    recoveryRef: item?.workItemRef as string,
  };
}

async function waitlist(o: Record<string, unknown> = {}): Promise<{ entryRef: string; patientRef: string }> {
  const patientRef = await createPatient(h, 'Synthetic Waiting');
  const res = h.ok<{ data: { entryRef: string } }>(
    await h.call('a1', 'POST', WAIT, {
      patientRef,
      locationRef: loc.locationRef,
      durationMinutes: 60,
      desiredFrom: '2030-06-01T00:00:00Z',
      desiredUntil: '2031-06-01T00:00:00Z',
      ...o,
    }),
    201,
  );
  return { entryRef: res.data.entryRef, patientRef };
}

type Recovery = {
  recoveryRef: string;
  state: string;
  version: number;
  automation: { mode: string; standingPolicyRef: string | null };
  candidates: { entryRef: string; rank: number; consent: { owner: string; state: string } }[];
  excluded: { entryRef: string; reason: string }[];
};
const read = async (ref: string) => h.ok<{ data: Recovery }>(await h.call('a1', 'GET', `${REC}/${ref}`)).data;

describe('PT-02 cancellation recovery', () => {
  it('a cancelled future booking opens a recovery work item with owner, due time and next action', async () => {
    const freed = await freedSlot();
    const list = h.ok<{ data: { coverage: { status: string }; items: Record<string, unknown>[] } }>(
      await h.call('a1', 'GET', `${REC}?locationRef=${loc.locationRef}`),
    ).data;
    expect(list.coverage).toStrictEqual({ status: 'available' });
    expect(list.items.find((i) => i.workItemRef === freed.recoveryRef)).toMatchObject({
      kind: 'cancellation_recovery',
      reasonCode: 'slot_freed_by_cancellation',
      owner: { queue: 'scheduling', principalRef: null },
      nextActionOwedBy: 'practice',
      dueAt: new Date(freed.startsAt).toISOString(),
      suggestedNextAction: 'review_waitlist_candidates',
    });
  });

  it('candidates are matched on provider, duration, window and existing bookings, ranked by priority; consent stays E6', async () => {
    const freed = await freedSlot();
    const good = await waitlist({ priority: 2 });
    const better = await waitlist({ priority: 1 });
    const tooLong = await waitlist({ durationMinutes: 90 });
    const otherProvider = await waitlist({
      providerPreference: {
        kind: 'provider',
        resourceRef: (await seedLocation(h, 'loc-rec-other')).provider,
      },
    }).catch(() => null);
    const outside = await waitlist({ desiredFrom: '2031-01-01T00:00:00Z' });
    const r = await read(freed.recoveryRef);
    const ranked = r.candidates.filter((c) => [good.entryRef, better.entryRef].includes(c.entryRef));
    expect(ranked.map((c) => c.entryRef)).toStrictEqual([better.entryRef, good.entryRef]);
    expect(ranked[0]?.consent).toStrictEqual({ owner: 'E6', state: 'undecided' });
    const reasons = Object.fromEntries(r.excluded.map((e) => [e.entryRef, e.reason]));
    expect(reasons[tooLong.entryRef]).toBe('duration_exceeds_slot');
    expect(reasons[outside.entryRef]).toBe('outside_desired_window');
    expect(otherProvider).toBeNull(); // a provider of another location is refused at entry time (422)
    expect(r.automation).toStrictEqual({ mode: 'prepare_for_approval', standingPolicyRef: null });
  });

  it('prepare-for-approval: a person executes the prepared offer; the invitation is a hold and an intent, not attendance', async () => {
    const freed = await freedSlot();
    const w = await waitlist({ priority: 1 });
    const transitions = await count(db, 'appointment_attendance_transitions');
    const appointments = await count(db, 'appointments');
    const done = h.ok<{
      data: { offerRef: string; holdRef: string; intentRef: string; standingPolicyRef: string | null };
    }>(
      await h.call('a1', 'POST', `${REC}/${freed.recoveryRef}/execute`, {
        expectedVersion: 1,
        entryRef: w.entryRef,
      }),
      201,
    ).data;
    expect(done.standingPolicyRef).toBeNull();
    expect(await count(db, 'appointment_attendance_transitions')).toBe(transitions);
    expect(await count(db, 'appointments')).toBe(appointments);
    const intent = h.ok<{ data: { channel: string; purpose: string } }>(
      await h.call('a1', 'GET', `/v1/scheduling/notifications/${done.intentRef}`),
    ).data;
    expect(intent).toMatchObject({ channel: 'none', purpose: 'waitlist_offer' });
    const accepted = h.ok<{ data: { appointmentRef: string } }>(
      await h.call('a1', 'POST', `/v1/scheduling/waitlist-offers/${done.offerRef}/respond`, {
        expectedVersion: 1,
        outcome: 'accepted',
      }),
    ).data;
    const a = h.ok<{ data: { startsAt: string; patientRef: string } }>(
      await h.call('a1', 'GET', `${APPT}/${accepted.appointmentRef}`),
    ).data;
    expect([a.startsAt, a.patientRef]).toStrictEqual([new Date(freed.startsAt).toISOString(), w.patientRef]);
    expect((await read(freed.recoveryRef)).state).toBe('filled');
    const open = h
      .ok<{ data: { items: { workItemRef: string }[] } }>(
        await h.call('a1', 'GET', `${REC}?locationRef=${loc.locationRef}`),
      )
      .data.items.map((i) => i.workItemRef);
    expect(open).not.toContain(freed.recoveryRef);
  });

  it('a service principal cannot execute without a standing policy; nothing is written', async () => {
    const freed = await freedSlot();
    await waitlist({ priority: 1 });
    const before = await count(db, 'waitlist_offers');
    const res = await h.call('svcA1', 'POST', `${REC}/${freed.recoveryRef}/execute`, { expectedVersion: 1 });
    expect([res.statusCode, res.json().code, res.json().detail?.reason]).toStrictEqual([
      403,
      'forbidden',
      'standing_policy_required',
    ]);
    expect(await count(db, 'waitlist_offers')).toBe(before);
  });

  it('policy-authorized execution: a standing policy is granted by a person, rechecked at execution and recorded on the offer; revocation and expiry stop it', async () => {
    const granted = h.ok<{ data: { policyRef: string; version: number } }>(
      await h.call('a1', 'POST', POL, {
        operation: 'scheduling.recovery.execute',
        granteeRef: SVC_A1,
        locationRefs: [loc.locationRef],
        maxOffersPerRecovery: 1,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      }),
      201,
    ).data;
    // A service principal cannot grant itself a policy (human-only, admin.configure).
    const self = await h.call('svcA1', 'POST', POL, {
      operation: 'scheduling.recovery.execute',
      granteeRef: SVC_A1,
      locationRefs: [loc.locationRef],
      maxOffersPerRecovery: 1,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(self.statusCode).toBe(403);
    const freed = await freedSlot();
    await waitlist({ priority: 1 });
    const prepared = (await read(freed.recoveryRef)).candidates[0];
    const auto = h.ok<{
      data: { offerRef: string; standingPolicyRef: string; standingPolicyVersion: number; entryRef: string };
    }>(
      await h.call('svcA1', 'POST', `${REC}/${freed.recoveryRef}/execute`, { expectedVersion: 1 }),
      201,
    ).data;
    expect([auto.standingPolicyRef, auto.standingPolicyVersion]).toStrictEqual([granted.policyRef, 1]);
    expect(auto.entryRef).toBe(prepared?.entryRef);
    expect((await read(freed.recoveryRef)).automation).toStrictEqual({
      mode: 'policy_authorized',
      standingPolicyRef: granted.policyRef,
    });
    // Limit: one offer per recovery under this policy, even after the first is declined.
    h.ok(
      await h.call('a1', 'POST', `/v1/scheduling/waitlist-offers/${auto.offerRef}/respond`, {
        expectedVersion: 1,
        outcome: 'declined',
        reasonCode: 'patient_declined',
      }),
    );
    await waitlist({ priority: 1 });
    const limited = await h.call('svcA1', 'POST', `${REC}/${freed.recoveryRef}/execute`, {
      expectedVersion: 2,
    });
    expect([limited.statusCode, limited.json().detail?.reason]).toStrictEqual([409, 'standing_policy_limit']);
    // Revocation stops the next execution.
    const second = await freedSlot();
    await waitlist({ priority: 1 });
    h.ok(
      await h.call('a1', 'POST', `${POL}/${granted.policyRef}/revoke`, {
        expectedVersion: 1,
        reasonCode: 'practice_request',
      }),
    );
    const revoked = await h.call('svcA1', 'POST', `${REC}/${second.recoveryRef}/execute`, {
      expectedVersion: 1,
    });
    expect([revoked.statusCode, revoked.json().detail?.reason]).toStrictEqual([
      403,
      'standing_policy_required',
    ]);
    const policies = h.ok<{ data: { policyRef: string; state: string }[] }>(
      await h.call('a1', 'GET', POL),
    ).data;
    expect(policies.find((p) => p.policyRef === granted.policyRef)?.state).toBe('revoked');
  });

  it('an expired standing policy no longer authorizes execution', async () => {
    const granted = h.ok<{ data: { policyRef: string } }>(
      await h.call('a1', 'POST', POL, {
        operation: 'scheduling.recovery.execute',
        granteeRef: SVC_A1,
        locationRefs: [loc.locationRef],
        maxOffersPerRecovery: 2,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      201,
    ).data;
    // Test-only clock shift on the synthetic policy row (the grant is immutable by trigger for every
    // role that cannot disable triggers; the fixture superuser disables it for this one statement).
    await db.admin.query(
      'ALTER TABLE cuspatlas.scheduling_standing_policies DISABLE TRIGGER scheduling_standing_policies_guard',
    );
    try {
      await db.admin.query(
        `UPDATE cuspatlas.scheduling_standing_policies SET expires_at = now() - interval '1 minute', version = version + 1 WHERE id = $1`,
        [granted.policyRef],
      );
    } finally {
      await db.admin.query(
        'ALTER TABLE cuspatlas.scheduling_standing_policies ENABLE TRIGGER scheduling_standing_policies_guard',
      );
    }
    const freed = await freedSlot();
    await waitlist({ priority: 1 });
    const res = await h.call('svcA1', 'POST', `${REC}/${freed.recoveryRef}/execute`, { expectedVersion: 1 });
    expect([res.statusCode, res.json().detail?.reason]).toStrictEqual([403, 'standing_policy_required']);
  });

  it('a service principal cannot offer a slot directly or accept an offer without a person (S-D6 standing-policy gate)', async () => {
    const w = await waitlist({ priority: 1 });
    const slot = (n: number) => ({
      startsAt: new Date(Date.UTC(2031, 1, 3 + n, 14)).toISOString(),
      endsAt: new Date(Date.UTC(2031, 1, 3 + n, 15)).toISOString(),
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    });
    const holds = await count(db, 'scheduling_holds');
    const denied = await h.call('svcA1', 'POST', `${WAIT}/${w.entryRef}/offer`, slot(0));
    expect([denied.statusCode, denied.json().detail?.reason]).toStrictEqual([
      403,
      'standing_policy_required',
    ]);
    expect(await count(db, 'scheduling_holds')).toBe(holds);
    const person = h.ok<{ data: { offerRef: string } }>(
      await h.call('a1', 'POST', `${WAIT}/${w.entryRef}/offer`, slot(1)),
      201,
    ).data;
    const appts = await count(db, 'appointments');
    const accept = await h.call(
      'svcA1',
      'POST',
      `/v1/scheduling/waitlist-offers/${person.offerRef}/respond`,
      {
        expectedVersion: 1,
        outcome: 'accepted',
      },
    );
    expect(accept.statusCode).toBe(403);
    expect(await count(db, 'appointments')).toBe(appts);
    const granted = h.ok<{ data: { policyRef: string } }>(
      await h.call('a1', 'POST', POL, {
        operation: 'scheduling.recovery.execute',
        granteeRef: SVC_A1,
        locationRefs: [loc.locationRef],
        maxOffersPerRecovery: 1,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      201,
    ).data;
    const w2 = await waitlist({ priority: 1 });
    const allowed = h.ok<{
      data: { offerRef: string; standingPolicyRef: string; standingPolicyVersion: number };
    }>(await h.call('svcA1', 'POST', `${WAIT}/${w2.entryRef}/offer`, slot(2)), 201).data;
    expect([allowed.standingPolicyRef, allowed.standingPolicyVersion]).toStrictEqual([granted.policyRef, 1]);
    const accept2 = await h.call(
      'svcA1',
      'POST',
      `/v1/scheduling/waitlist-offers/${allowed.offerRef}/respond`,
      {
        expectedVersion: 1,
        outcome: 'accepted',
      },
    );
    expect(accept2.statusCode).toBe(403);
    h.ok(
      await h.call('a1', 'POST', `/v1/scheduling/waitlist-offers/${allowed.offerRef}/respond`, {
        expectedVersion: 1,
        outcome: 'declined',
        reasonCode: 'patient_declined',
      }),
    );
    const over = await h.call('svcA1', 'POST', `${WAIT}/${w2.entryRef}/offer`, slot(3));
    expect([over.statusCode, over.json().detail?.reason]).toStrictEqual([409, 'standing_policy_limit']);
    h.ok(
      await h.call('a1', 'POST', `${POL}/${granted.policyRef}/revoke`, {
        expectedVersion: 1,
        reasonCode: 'practice_request',
      }),
    );
  });

  it('an expired offer is not live in the recovery list or its candidates', async () => {
    const freed = await freedSlot();
    const w = await waitlist({ priority: 1 });
    const made = h.ok<{ data: { holdRef: string; offerRef: string } }>(
      await h.call('a1', 'POST', `${REC}/${freed.recoveryRef}/execute`, {
        expectedVersion: 1,
        entryRef: w.entryRef,
      }),
      201,
    ).data;
    const itemOf = async () =>
      h
        .ok<{ data: { items: { workItemRef: string; reasonCode: string }[] } }>(
          await h.call('a1', 'GET', `${REC}?locationRef=${loc.locationRef}`),
        )
        .data.items.find((i) => i.workItemRef === freed.recoveryRef);
    expect((await itemOf())?.reasonCode).toBe('offer_awaiting_answer');
    await db.admin.query(
      `UPDATE cuspatlas.scheduling_holds SET expires_at = now() - interval '1 minute', version = version + 1 WHERE id = $1`,
      [made.holdRef],
    );
    expect((await itemOf())?.reasonCode).toBe('slot_freed_by_cancellation');
    const r = await read(freed.recoveryRef);
    expect(r.candidates.map((c) => c.entryRef)).toContain(w.entryRef);
    expect(r.excluded.find((e) => e.entryRef === w.entryRef)).toBeUndefined();
    // Executing again reaps the expired offer first and offers the slot to the same entry.
    const next = await h.call('a1', 'POST', `${REC}/${freed.recoveryRef}/execute`, {
      expectedVersion: 2,
      entryRef: w.entryRef,
    });
    expect(next.statusCode).toBe(201);
  });

  it('a standing policy is granted only to a service principal with a live membership in this tenant', async () => {
    const revoked = randomUUID();
    await db.admin.query(
      `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'svc-a-revoked')`,
      [revoked],
    );
    await db.admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes, revoked_at)
       VALUES ($1, $2, ARRAY['scheduling.write'], now())`,
      [T_ALPHA, revoked],
    );
    const policies = await count(db, 'scheduling_standing_policies');
    const grant = (granteeRef: string) =>
      h.call('a1', 'POST', POL, {
        operation: 'scheduling.recovery.execute',
        granteeRef,
        locationRefs: [loc.locationRef],
        maxOffersPerRecovery: 1,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    const cases: [string, string][] = [
      ['a human', USER_A1],
      ['another tenant’s service principal', SVC_B1],
      ['an unknown principal', randomUUID()],
      ['a service principal whose membership is revoked', revoked],
    ];
    for (const [label, who] of cases) {
      const res = await grant(who);
      expect([label, res.statusCode, res.json().code]).toStrictEqual([label, 422, 'validation_failed']);
    }
    expect(await count(db, 'scheduling_standing_policies')).toBe(policies);
    const ok = await grant(SVC_A1);
    expect(ok.statusCode).toBe(201);
    h.ok(
      await h.call('a1', 'POST', `${POL}/${ok.json().data.policyRef}/revoke`, {
        expectedVersion: 1,
        reasonCode: 'practice_request',
      }),
    );
  });

  it('race-safe: two concurrent executions for one freed slot produce one offer and one refusal', async () => {
    const freed = await freedSlot();
    const a = await waitlist({ priority: 1 });
    const b = await waitlist({ priority: 1 });
    const [r1, r2] = await Promise.all([
      h.call('a1', 'POST', `${REC}/${freed.recoveryRef}/execute`, {
        expectedVersion: 1,
        entryRef: a.entryRef,
      }),
      h.call('a1', 'POST', `${REC}/${freed.recoveryRef}/execute`, {
        expectedVersion: 1,
        entryRef: b.entryRef,
      }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toStrictEqual([201, 409]);
    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.waitlist_offers WHERE recovery_id = $1 AND outcome IS NULL`,
      [freed.recoveryRef],
    );
    expect(rows[0].n).toBe(1);
  });

  it('cross-tenant callers cannot list, read or execute a recovery; REST and MCP agree', async () => {
    const freed = await freedSlot();
    expect((await h.call('b1', 'GET', `${REC}/${freed.recoveryRef}`)).statusCode).toBe(404);
    expect(
      (
        await h.call(
          'b1',
          'POST',
          `${REC}/${freed.recoveryRef}/execute`,
          { expectedVersion: 1 },
          randomUUID(),
        )
      ).statusCode,
    ).toBe(404);
    const beta = h.ok<{ data: { items: { workItemRef: string }[] } }>(await h.call('b1', 'GET', REC)).data;
    expect(beta.items.map((i) => i.workItemRef)).not.toContain(freed.recoveryRef);
    const m = await h.mcp('a1', 'scheduling_recovery_get', { recoveryRef: freed.recoveryRef });
    expect((m.body as { data: Recovery }).data.recoveryRef).toBe(freed.recoveryRef);
  });
});
