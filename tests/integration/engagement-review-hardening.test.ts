import { randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import type { TenantTransaction, WithTenantTransaction } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createPortalPrincipalSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  createAppointmentService,
  createAuthorize,
  createEngagementService,
  SYNTHETIC_TEST_MATCH_KEY_PEPPER,
} from '@cuspatlas/domain';
import { buildMcpServer } from '@cuspatlas/mcp';
import { createOutboundSender, type OutboundSender } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import {
  type EngagementHarness,
  email,
  MCP_AUDIENCE,
  openEngagementHarness,
  PORTAL_AUDIENCE,
  SVC_R1,
  SVC_W1,
} from './support/engagement-fixtures';
import { FakeMessaging } from './support/fake-messaging';
import { T_ALPHA } from './support/fixtures';
import { MARKER } from './support/marker';
import { TEST_AUDIENCE } from './support/test-token-issuer';

/**
 * Review hardening of E1-E7 (independent review of 75fdcee): portal abuse bounds hold under
 * concurrency; a decided or expired waitlist offer and a reminder whose visit has started are never
 * sent; a receipt that races the send record is kept and applied; concurrent duplicate receipts are
 * deduplicated; only a verified contact point is addressed; the portal audience can never equal the
 * staff or MCP audience.
 */
let db: TestDatabase;
let h: EngagementHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let slot = 0;
const MINOR = { known: true, value: '2016-05-05', precision: 'day' };

beforeAll(async () => {
  db = await openTestDatabase('e_review_hardening');
  h = await openEngagementHarness(db, { pool: 12 });
  loc = await seedLocation(h, 'loc-e-hardening');
  await db.admin.query(
    `INSERT INTO cuspatlas.scheduling_offer_policies (tenant_id, location_id, policy_ref, offer_ttl_minutes)
     SELECT tenant_id, id, 'waitlist-offer-pending-approval-1', 60 FROM cuspatlas.scheduling_locations
     WHERE location_ref = 'loc-e-hardening'`,
  );
  for (const [purpose, ref] of [
    ['reminder', 'eh-reminder'],
    ['waitlist_offer', 'eh-offer'],
  ] as const) {
    h.ok(
      await h.call('a1', 'POST', '/v1/communications/templates', {
        templateRef: ref,
        purpose,
        channel: 'email',
        body: 'There is an update for you. Sign in to the patient portal for details.',
      }),
      201,
    );
    h.ok(
      await h.call('a1', 'POST', '/v1/communications/channel-policies', {
        purpose,
        channel: 'email',
        templateRef: ref,
        // A one-minute window keeps the real-time offer sends outside quiet hours.
        quietHours:
          purpose === 'reminder' ? { start: '21:00', end: '08:00' } : { start: '03:00', end: '03:01' },
        ...(purpose === 'reminder' ? { reminderLeadMinutes: 1440 } : {}),
      }),
      201,
    );
  }
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

const DAYTIME = () => new Date('2030-07-10T17:00:00Z');
function sender(port: FakeMessaging, clock: () => Date = DAYTIME): OutboundSender {
  return createOutboundSender({
    workerPrincipalId: SVC_W1,
    withTenantTransaction: createTenantTransactionRunner(db.app),
    authorize: createAuthorize(createMembershipSource(db.app)),
    memberships: createMembershipSource(db.app),
    attempts: createSecurityAttemptSink(db.sink),
    port,
    clock,
    backoffSeconds: () => 60,
  });
}
function window() {
  const day = 2 + slot * 7;
  slot += 1;
  const at = (hh: number) => new Date(Date.UTC(2030, 8, day, hh)).toISOString();
  return {
    startsAt: at(14),
    endsAt: at(15),
    timeZone: 'America/New_York',
    provider: { kind: 'provider', resourceRef: loc.provider },
    operatory: { kind: 'operatory', resourceRef: loc.operatory },
  };
}
async function consenting(local: string, purpose = 'reminders', verify = true): Promise<string> {
  const p = await h.person(`Synthetic Hardening ${MARKER}`, [email(local)]);
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${p}/consents`, {
      channel: 'email',
      purpose,
      state: 'granted',
      source: 'staff_recorded',
      consentVersion: 'synthetic-consent-1',
    }),
    201,
  );
  if (verify) {
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${p}/contact-verifications`, {
        channel: 'email',
        value: `${local}@example.invalid`,
        method: 'synthetic_attested',
      }),
      201,
    );
  }
  return p;
}
async function book(patientRef: string): Promise<string> {
  return h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/appointments', {
      patientRef,
      locationRef: loc.locationRef,
      ...window(),
    }),
    201,
  ).data.appointmentRef;
}
const makeDue = (subjectRef: string) =>
  db.admin.query(
    `UPDATE cuspatlas.outbound_messages m SET next_attempt_at = now() - interval '1 second', version = version + 1
     FROM cuspatlas.notification_intents i WHERE i.id = m.intent_id AND m.state = 'queued' AND i.subject_id = $1`,
    [subjectRef],
  );
type Message = {
  messageRef: string;
  state: string;
  suppressionReason: string | null;
  deliveryKey: string;
  providerRef: string | null;
  receipts: { state: string; applied: boolean; pending: boolean }[];
};
async function messageFor(subjectRef: string, purpose: string): Promise<Message> {
  const { rows } = await db.admin.query(
    `SELECT m.id FROM cuspatlas.outbound_messages m JOIN cuspatlas.notification_intents i ON i.id = m.intent_id
     WHERE i.subject_id = $1 AND i.purpose = $2`,
    [subjectRef, purpose],
  );
  expect(rows).toHaveLength(1);
  return h.ok<{ data: Message }>(await h.call('a1', 'GET', `/v1/communications/deliveries/${rows[0].id}`))
    .data;
}
const receipt = async (body: Record<string, unknown>, key = randomUUID()) =>
  h.call(
    await h.issuer.issue({ sub: SVC_R1, tid: T_ALPHA }),
    'POST',
    '/v1/communications/receipts',
    body,
    key,
  );

/**
 * A tenant-transaction runner that holds every transaction right after its abuse-bound count until
 * `n` transactions have counted (or 1.5 s pass), so concurrent submissions interleave
 * deterministically between the count and the insert. Without serialization all of them count below
 * the cap; with it, the later ones wait at the lock and the gate times out.
 */
function gatedRunner(match: RegExp, n: number): WithTenantTransaction {
  const inner = createTenantTransactionRunner(db.appPool(12));
  let arrived = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return (ctx, work) =>
    inner(ctx, (tx) => {
      const gated: TenantTransaction = {
        ctx: tx.ctx,
        savepoint: (w) => tx.savepoint(w),
        async query(text, values) {
          const r = await tx.query(text, values);
          if (match.test(text)) {
            arrived += 1;
            if (arrived >= n) open();
            await Promise.race([gate, new Promise((res) => setTimeout(res, 1500))]);
          }
          return r as never;
        },
      };
      return work(gated);
    });
}
function portalService(runner: WithTenantTransaction) {
  const authorize = createAuthorize(createMembershipSource(db.app));
  const recording = { sink: createSecurityAttemptSink(db.sink), alert: () => undefined };
  const appointments = createAppointmentService({
    authorize,
    withTenantTransaction: runner,
    memberships: createMembershipSource(db.app),
    recording,
  });
  return createEngagementService({
    appointments,
    authorize,
    withTenantTransaction: runner,
    recording,
    matchKeyPepper: SYNTHETIC_TEST_MATCH_KEY_PEPPER,
  });
}

describe('REQUIRED 1: portal abuse bounds hold under concurrent submissions', () => {
  const submitVia =
    (svc: ReturnType<typeof portalService>) =>
    async (principal: string, patient: string): Promise<{ statusCode: number }> => {
      try {
        await svc.submitPortalRequest(
          {
            tenantId: T_ALPHA,
            actorId: principal,
            principal: 'portal',
            sessionId: randomUUID(),
            scopes: [],
            correlationId: randomUUID(),
          },
          patient,
          {
            operation: 'portal.requests.submit',
            idempotencyKey: randomUUID(),
            payload: { locationRef: loc.locationRef, flexibility: 'mornings', contactConsent: 'granted' },
          },
        );
        return { statusCode: 201 };
      } catch (err) {
        const code = (err as { code?: string }).code;
        return { statusCode: code === 'rate_limited' ? 429 : code === 'conflict' ? 409 : 500 };
      }
    };
  const submit = (principal: string, patient: string) =>
    h.portal(principal, 'POST', `/portal/v1/patients/${patient}/appointment-requests`, {
      locationRef: loc.locationRef,
      flexibility: 'mornings',
      contactConsent: 'granted',
    });

  it('six concurrent submissions with different keys create at most three open requests for one patient', async () => {
    const adult = await h.person('Synthetic Concurrent Adult', [email('eh.concurrent')]);
    const principal = await h.enroll(adult, { channel: 'email', value: 'eh.concurrent@example.invalid' });
    const concurrent = submitVia(portalService(gatedRunner(/state IN ('open', 'in_review')/, 6)));
    const results = await Promise.all(Array.from({ length: 6 }, () => concurrent(principal, adult)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    for (const c of codes) expect([201, 429]).toContain(c);
    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.appointment_requests WHERE subject_patient_id = $1 AND origin = 'portal'`,
      [adult],
    );
    expect(rows[0].n).toBe(3);
  });

  it('the per-principal daily cap of ten holds when the tenth and later submissions arrive together', async () => {
    const guardian = await h.person('Synthetic Busy Guardian', [email('eh.busy')]);
    const kids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const kid = await h.person(`Synthetic Busy Kid ${i}`, [], { birthDate: MINOR });
      h.ok(
        await h.call('a1', 'POST', `/v1/patients/${kid}/relationships`, {
          counterpartyRef: guardian,
          kind: 'guardian',
          scopes: ['scheduling'],
        }),
        201,
      );
      kids.push(kid);
    }
    const principal = await h.enroll(guardian, { channel: 'email', value: 'eh.busy@example.invalid' });
    for (const kid of kids.slice(0, 3))
      for (let i = 0; i < 3; i += 1) h.ok(await submit(principal, kid), 201);
    const last = kids[3] as string;
    const concurrent = submitVia(portalService(gatedRunner(/interval '24 hours'/, 3)));
    const results = await Promise.all(Array.from({ length: 3 }, () => concurrent(principal, last)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.appointment_requests WHERE created_by = $1 AND origin = 'portal'`,
      [principal],
    );
    expect(rows[0].n).toBe(10);
  });
});

describe('SHOULD 2-3: decided offers and stale reminders are never sent', () => {
  it('an offer declined before send is suppressed offer_closed; an open offer is sent', async () => {
    const offerFor = async (local: string) => {
      const p = await consenting(local, 'messaging');
      const entry = h.ok<{ data: { entryRef: string } }>(
        await h.call('a1', 'POST', '/v1/scheduling/waitlist', {
          patientRef: p,
          locationRef: loc.locationRef,
          durationMinutes: 60,
          desiredFrom: '2030-06-01T00:00:00Z',
          desiredUntil: '2031-06-01T00:00:00Z',
        }),
        201,
      ).data.entryRef;
      const { startsAt, endsAt, provider, operatory } = window();
      return h.ok<{ data: { offerRef: string } }>(
        await h.call('a1', 'POST', `/v1/scheduling/waitlist/${entry}/offer`, {
          startsAt,
          endsAt,
          provider,
          operatory,
        }),
        201,
      ).data.offerRef;
    };
    const declined = await offerFor('eh.declined');
    const open = await offerFor('eh.open');
    h.ok(
      await h.call('a1', 'POST', `/v1/scheduling/waitlist-offers/${declined}/respond`, {
        expectedVersion: 1,
        outcome: 'declined',
        reasonCode: 'patient_declined',
      }),
    );
    const port = new FakeMessaging();
    await sender(port, () => new Date()).runOnce(T_ALPHA);
    const d = await messageFor(declined, 'waitlist_offer');
    expect([d.state, d.suppressionReason]).toStrictEqual(['suppressed', 'offer_closed']);
    expect(port.effectsFor(d.deliveryKey)).toBe(0);
    const o = await messageFor(open, 'waitlist_offer');
    expect(o.state).toBe('sent');
    expect(port.effectsFor(o.deliveryKey)).toBe(1);
  });

  it('a reminder still queued when its visit has started (worker outage) is suppressed subject_past', async () => {
    const p = await consenting('eh.outage');
    const appt = await book(p);
    const port = new FakeMessaging();
    await sender(port).runOnce(T_ALPHA);
    await makeDue(appt);
    const starts = (
      await db.admin.query('SELECT starts_at FROM cuspatlas.appointments WHERE id = $1', [appt])
    ).rows[0].starts_at as Date;
    // The worker comes back ten minutes after the visit started.
    await sender(port, () => new Date(starts.getTime() + 10 * 60_000)).runOnce(T_ALPHA);
    const m = await messageFor(appt, 'reminder');
    expect([m.state, m.suppressionReason]).toStrictEqual(['suppressed', 'subject_past']);
    expect(port.effectsFor(m.deliveryKey)).toBe(0);
  });
});

describe('SHOULD 4: early and concurrent duplicate receipts', () => {
  it('a receipt arriving while the message is sending is kept pending and applied when the send finalizes', async () => {
    const p = await consenting('eh.early');
    const appt = await book(p);
    let early: { status: number; body: Record<string, unknown> } | undefined;
    const port = new FakeMessaging(
      {},
      {
        whileAccepted: async (req, providerRef) => {
          const r = await receipt({
            providerRef,
            providerEventId: `early-${randomUUID()}`,
            state: 'delivered',
            occurredAt: '2030-07-10T17:00:01Z',
            deliveryKey: req.deliveryKey,
          });
          early = { status: r.statusCode, body: r.json() };
        },
      },
    );
    const s = sender(port);
    await s.runOnce(T_ALPHA);
    await makeDue(appt);
    await s.runOnce(T_ALPHA);
    expect(early?.status).toBe(200);
    expect((early?.body.data as Record<string, unknown> | undefined)?.pending).toBe(true);
    const m = await messageFor(appt, 'reminder');
    expect(m.state).toBe('delivered');
    expect(m.receipts).toStrictEqual([
      expect.objectContaining({ state: 'delivered', applied: false, pending: true }),
    ]);
    // An unknown provider reference without a matching delivery key is still not found.
    const stray = await receipt({
      providerRef: 'fake-msg-unknown',
      providerEventId: `stray-${randomUUID()}`,
      state: 'delivered',
      occurredAt: '2030-07-10T17:00:01Z',
    });
    expect(stray.statusCode).toBe(404);
  });

  it('concurrent duplicates of one provider event return the deduplicated answer, never a 500', async () => {
    const p = await consenting('eh.dupes');
    const appt = await book(p);
    const port = new FakeMessaging();
    const s = sender(port);
    await s.runOnce(T_ALPHA);
    await makeDue(appt);
    await s.runOnce(T_ALPHA);
    const m = await messageFor(appt, 'reminder');
    expect(m.state).toBe('sent');
    const event = `dupe-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        receipt({
          providerRef: m.providerRef,
          providerEventId: event,
          state: 'delivered',
          occurredAt: '2030-07-10T17:05:00Z',
        }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toStrictEqual([200, 200, 200, 200, 200, 200]);
    expect(results.filter((r) => r.json().data.deduplicated === false)).toHaveLength(1);
    const after = await messageFor(appt, 'reminder');
    expect(after.state).toBe('delivered');
    expect(after.receipts).toHaveLength(1);
  });
});

describe('SHOULD 5: only a verified contact point is addressed', () => {
  it('an unverified email is suppressed no_verified_channel; a verified one is sent; a value not on record is refused', async () => {
    const unverified = await consenting('eh.unverified', 'reminders', false);
    const verified = await consenting('eh.verified');
    const a = await book(unverified);
    const b = await book(verified);
    const port = new FakeMessaging();
    const s = sender(port);
    await s.runOnce(T_ALPHA);
    await makeDue(a);
    await makeDue(b);
    await s.runOnce(T_ALPHA);
    const ma = await messageFor(a, 'reminder');
    expect([ma.state, ma.suppressionReason]).toStrictEqual(['suppressed', 'no_verified_channel']);
    expect(port.effectsFor(ma.deliveryKey)).toBe(0);
    expect((await messageFor(b, 'reminder')).state).toBe('sent');
    const wrong = await h.call('a1', 'POST', `/v1/patients/${unverified}/contact-verifications`, {
      channel: 'email',
      value: 'someone.else@example.invalid',
      method: 'synthetic_attested',
    });
    expect([wrong.statusCode, wrong.json().detail.violations[0].rule]).toStrictEqual([
      422,
      'contactNotOnRecord',
    ]);
    // The verification stores a digest only, never the contact value.
    const { rows } = await db.admin.query(
      'SELECT to_jsonb(v)::text AS t FROM cuspatlas.contact_verifications v',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.t).not.toContain('@example.invalid');
    expect(h.logLines.join('\n')).not.toContain('eh.verified@example.invalid');
  });

  it('a service principal cannot attest a verification (human only)', async () => {
    const p = await h.person('Synthetic Service Verify', [email('eh.service')]);
    const r = await h.call('svcA1', 'POST', `/v1/patients/${p}/contact-verifications`, {
      channel: 'email',
      value: 'eh.service@example.invalid',
      method: 'synthetic_attested',
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('SHOULD 6: startup guard on audiences', () => {
  it('the API refuses to boot when the portal audience equals the MCP audience', async () => {
    await expect(
      buildApp({
        env: 'synthetic-test',
        identity: h.issuer.verifierConfig,
        membership: createMembershipSource(db.app),
        attempts: createSecurityAttemptSink(db.sink),
        tenantTransactions: createTenantTransactionRunner(db.app),
        portalIdentity: { ...h.issuer.verifierConfig, audience: MCP_AUDIENCE },
        portalPrincipals: createPortalPrincipalSource(db.app),
        mcpAudience: MCP_AUDIENCE,
      }),
    ).rejects.toThrow(/portal audience must differ from the MCP audience/);
  });

  it('the MCP server refuses to boot when its audience equals the portal audience', () => {
    expect(() =>
      buildMcpServer({
        env: 'synthetic-test',
        identity: { ...h.issuer.verifierConfig, audience: PORTAL_AUDIENCE },
        restAudience: TEST_AUDIENCE,
        portalAudience: PORTAL_AUDIENCE,
        membership: createMembershipSource(db.app),
        attempts: createSecurityAttemptSink(db.sink),
        tenantTransactions: createTenantTransactionRunner(db.app),
      }),
    ).toThrow(/MCP audience must differ from the portal audience/);
  });
});
