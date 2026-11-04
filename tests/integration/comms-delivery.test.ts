import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAuthorize } from '@cuspatlas/domain';
import { createOutboundSender, type OutboundSender, type SenderLogLine } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import {
  type EngagementHarness,
  email,
  openEngagementHarness,
  SVC_R1,
  SVC_W1,
} from './support/engagement-fixtures';
import { FakeMessaging } from './support/fake-messaging';
import { T_ALPHA, T_BETA } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * E7: delivery through the F6 worker/adapter contract with a FAKE provider only (no network, no real
 * recipient). The sender enqueues one outbound message per intent E6 allowed, rechecks the E6
 * decision at send time (consent, opt-out, template, contact, quiet hours, subject state), sends with
 * the intent's stable delivery key, reconciles every uncertain outcome by lookup and never resends
 * blind. Receipts are deduplicated and monotonic. Failures and unknown outcomes are owned work items.
 */
let db: TestDatabase;
let h: EngagementHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let slot = 0;
const logs: SenderLogLine[] = [];

beforeAll(async () => {
  db = await openTestDatabase('comms_delivery');
  h = await openEngagementHarness(db, { mcp: true });
  loc = await seedLocation(h, 'loc-delivery');
  for (const [purpose, ref] of [
    ['reminder', 'e7-reminder'],
    ['cancellation', 'e7-cancellation'],
  ] as const) {
    h.ok(
      await h.call('a1', 'POST', '/v1/communications/templates', {
        templateRef: ref,
        purpose,
        channel: 'email',
        body: 'There is an update about your visit. Sign in to the patient portal for details.',
      }),
      201,
    );
    h.ok(
      await h.call('a1', 'POST', '/v1/communications/channel-policies', {
        purpose,
        channel: 'email',
        templateRef: ref,
        quietHours: { start: '21:00', end: '08:00' },
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

/** A clock outside the quiet window (13:00 New York on a summer day). */
const DAYTIME = () => new Date('2030-07-10T17:00:00Z');

function sender(
  port: FakeMessaging,
  opts: { clock?: () => Date; principal?: string; pool?: number; maxAttempts?: number } = {},
): OutboundSender {
  const pool = opts.pool === undefined ? db.app : db.appPool(opts.pool);
  return createOutboundSender({
    workerPrincipalId: opts.principal ?? SVC_W1,
    withTenantTransaction: createTenantTransactionRunner(pool),
    authorize: createAuthorize(createMembershipSource(db.app)),
    memberships: createMembershipSource(db.app),
    attempts: createSecurityAttemptSink(db.sink),
    port,
    clock: opts.clock ?? DAYTIME,
    log: (l) => logs.push(l),
    backoffSeconds: () => 60,
    ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
  });
}

function window() {
  const day = 2 + Math.floor(slot / 8) * 7;
  const hour = 13 + (slot % 8);
  slot += 1;
  const at = (hh: number) => new Date(Date.UTC(2030, 8, day, hh)).toISOString();
  return {
    startsAt: at(hour),
    endsAt: at(hour + 1),
    timeZone: 'America/New_York',
    provider: { kind: 'provider', resourceRef: loc.provider },
    operatory: { kind: 'operatory', resourceRef: loc.operatory },
  };
}
async function consenting(name: string, local: string): Promise<string> {
  const p = await h.person(`Synthetic ${name} ${MARKER}`, [email(local)]);
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${p}/consents`, {
      channel: 'email',
      purpose: 'reminders',
      state: 'granted',
      source: 'staff_recorded',
      consentVersion: 'synthetic-consent-1',
    }),
    201,
  );
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${p}/contact-verifications`, {
      channel: 'email',
      value: `${local}@example.invalid`,
      method: 'synthetic_attested',
    }),
    201,
  );
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
/** Synthetic elapsed time: the reminder's send instant (start minus lead) has come. */
const makeDue = (appointmentRef?: string) =>
  db.admin.query(
    `UPDATE cuspatlas.outbound_messages m SET next_attempt_at = now() - interval '1 second', version = version + 1
     FROM cuspatlas.notification_intents i WHERE i.id = m.intent_id AND m.state = 'queued'
       AND ($1::uuid IS NULL OR i.subject_id = $1::uuid)`,
    [appointmentRef ?? null],
  );
type Message = {
  messageRef: string;
  state: string;
  suppressionReason: string | null;
  deliveryKey: string;
  providerRef: string | null;
  attempts: { attempt: number; outcome: string }[];
  decisions: { stage: string; outcome: string; reason: string | null; deferredUntil: string | null }[];
  receipts: { state: string; applied: boolean }[];
};
async function messageFor(appointmentRef: string, purpose = 'reminder'): Promise<Message> {
  const { rows } = await db.admin.query(
    `SELECT m.id FROM cuspatlas.outbound_messages m JOIN cuspatlas.notification_intents i ON i.id = m.intent_id
     WHERE i.subject_id = $1 AND i.purpose = $2`,
    [appointmentRef, purpose],
  );
  expect(rows).toHaveLength(1);
  return h.ok<{ data: Message }>(await h.call('a1', 'GET', `/v1/communications/deliveries/${rows[0].id}`))
    .data;
}
const receipt = (body: Record<string, unknown>, who = SVC_R1, tid = T_ALPHA, key?: string) =>
  h.issuer
    .issue({ sub: who, tid })
    .then((t) =>
      h.call(t, 'POST', '/v1/communications/receipts', body, key ?? `rcpt-${String(body.providerEventId)}`),
    );

describe('S14 cases owned by E (closed by E6/E7)', () => {
  it('E7: an allowed decision yields exactly one delivery through the fake provider; a retry after timeout none', async () => {
    const p = await consenting('Allowed', 'e7.allowed');
    const appt = await book(p);
    const port = new FakeMessaging({ idempotent: false }, { afterAccept: () => 'timeout' });
    const s = sender(port);
    await s.runOnce(T_ALPHA);
    await makeDue(appt);
    await s.runOnce(T_ALPHA);
    let m = await messageFor(appt);
    expect(m.state).toBe('unknown');
    expect(port.effectsFor(m.deliveryKey)).toBe(1);
    port.hooks = {};
    // Reconciliation by delivery key, never a resend: the provider has it, so it is sent.
    await db.admin.query(
      `UPDATE cuspatlas.outbound_messages SET reconcile_after = now() - interval '1 second', version = version + 1
       WHERE id = $1`,
      [m.messageRef],
    );
    await s.runOnce(T_ALPHA);
    m = await messageFor(appt);
    expect(m.state).toBe('sent');
    expect(m.deliveryKey).toBe(`reminder:${appt}`);
    expect(port.effectsFor(m.deliveryKey)).toBe(1);
    expect(port.calls.filter((c) => c.deliveryKey === m.deliveryKey)).toHaveLength(1);
    expect(m.attempts.map((a) => a.outcome)).toStrictEqual(['unknown', 'reconciled_found']);
    // The notification payload is notice-only: no clinical content, no patient name.
    const effect = port.effects.find((e) => e.deliveryKey === m.deliveryKey);
    expect(effect?.body).not.toContain(MARKER);
    expect(effect?.recipient).toBe('e7.allowed@example.invalid');
  });

  it('E6/E7: an opt-out recorded between intent and delivery blocks delivery at execution', async () => {
    const p = await consenting('Opting Out', 'e7.optout');
    const appt = await book(p);
    const port = new FakeMessaging();
    const s = sender(port);
    await s.runOnce(T_ALPHA);
    expect((await messageFor(appt)).state).toBe('queued');
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${p}/opt-outs`, {
        channel: 'email',
        source: 'patient_reported',
      }),
      201,
    );
    await makeDue(appt);
    await s.runOnce(T_ALPHA);
    const m = await messageFor(appt);
    expect(m).toMatchObject({ state: 'suppressed', suppressionReason: 'opt_out' });
    expect(m.decisions.map((d) => [d.stage, d.outcome, d.reason])).toStrictEqual([
      ['intent', 'allowed', null],
      ['send', 'suppressed', 'opt_out'],
    ]);
    expect(port.effectsFor(m.deliveryKey)).toBe(0);
  });

  it('E6: missing contact data and quiet hours are distinguished by E6 vocabulary in the appointment history', async () => {
    const a = await consenting('Contact Removed', 'e7.removed');
    const apptA = await book(a);
    const b = await consenting('Quiet Hours', 'e7.quiet');
    const apptB = await book(b);
    const read = h.ok<{ data: { version: number } }>(await h.call('a1', 'GET', `/v1/patients/${a}`)).data;
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${a}/demographics`, {
        expectedVersion: read.version,
        contact: { known: false, reason: 'not_provided' },
      }),
    );
    const port = new FakeMessaging();
    await sender(port).runOnce(T_ALPHA);
    await makeDue(apptA);
    await makeDue(apptB);
    await sender(port).runOnce(T_ALPHA);
    // 23:30 New York is inside 21:00-08:00: the reminder is deferred to the window end, not sent early.
    await sender(port, { clock: () => new Date('2030-07-11T03:30:00Z') }).runOnce(T_ALPHA);
    const mA = await messageFor(apptA);
    const mB = await messageFor(apptB);
    expect(mA).toMatchObject({ state: 'suppressed', suppressionReason: 'missing_contact' });
    expect(mB.state).toBe('sent');
    const quietB = await (async () => {
      const b2 = await consenting('Quiet Hours Late', 'e7.quiet.late');
      const appt = await book(b2);
      await sender(port).runOnce(T_ALPHA);
      await makeDue(appt);
      await sender(port, { clock: () => new Date('2030-07-11T03:30:00Z') }).runOnce(T_ALPHA);
      return messageFor(appt);
    })();
    expect(quietB.state).toBe('queued');
    expect(quietB.decisions.at(-1)).toMatchObject({
      stage: 'send',
      outcome: 'suppressed',
      reason: 'quiet_hours',
      deferredUntil: '2030-07-11T12:00:00.000Z',
    });
    expect(port.effectsFor(quietB.deliveryKey)).toBe(0);
  });

  it('E6: E suppresses intents derived from a cancelled appointment; a delivered message stays as history', async () => {
    const p = await consenting('Cancelled', 'e7.cancelled');
    const delivered = await book(p);
    const port = new FakeMessaging();
    const s = sender(port);
    await s.runOnce(T_ALPHA);
    await makeDue(delivered);
    await s.runOnce(T_ALPHA);
    const sent = await messageFor(delivered);
    expect(sent.state).toBe('sent');
    h.ok(
      await receipt({
        providerRef: sent.providerRef,
        providerEventId: `evt-${sent.messageRef}`,
        state: 'delivered',
        occurredAt: '2030-07-10T17:01:00Z',
      }),
    );
    const cancelledEarly = await book(p);
    await s.runOnce(T_ALPHA);
    for (const ref of [delivered, cancelledEarly]) {
      h.ok(
        await h.call('a1', 'POST', `/v1/scheduling/appointments/${ref}/cancel`, {
          expectedVersion: 1,
          reasonCode: 'patient_request',
        }),
      );
    }
    await makeDue();
    await s.runOnce(T_ALPHA);
    expect(await messageFor(delivered)).toMatchObject({ state: 'delivered' });
    const early = await messageFor(cancelledEarly);
    expect(early).toMatchObject({ state: 'suppressed', suppressionReason: 'appointment_cancelled' });
    expect(port.effectsFor(early.deliveryKey)).toBe(0);
    // The cancellation notice itself is its own intent, decided and delivered once.
    expect((await messageFor(cancelledEarly, 'cancellation')).state).toBe('sent');
  });

  it('E7: a withdrawn template is suppressed at E7 execution; a crash after provider acceptance is reconciled', async () => {
    const p = await consenting('Template Crash', 'e7.crash');
    const crashed = await book(p);
    const port = new FakeMessaging({ idempotent: false });
    const s = sender(port);
    await s.runOnce(T_ALPHA);
    await makeDue(crashed);
    // The worker leases, the provider accepts, and the process dies before recording anything.
    const leased = await s.leaseBatch(T_ALPHA);
    const target = leased.find((l) => l.deliveryKey === `reminder:${crashed}`);
    expect(target).toBeDefined();
    await port.send({
      deliveryKey: target?.deliveryKey as string,
      tenantId: T_ALPHA,
      channel: 'email',
      recipient: 'e7.crash@example.invalid',
      templateRef: 'e7-reminder',
      templateVersion: 1,
      body: 'synthetic',
      attempt: target?.attempt as number,
    });
    for (const l of leased.filter((x) => x !== target)) await s.dispatch(l);
    await db.admin.query(
      `UPDATE cuspatlas.outbound_messages SET leased_until = now() - interval '1 hour', version = version + 1
       WHERE delivery_key = $1`,
      [`reminder:${crashed}`],
    );
    await s.runOnce(T_ALPHA);
    const m = await messageFor(crashed);
    expect(m.state).toBe('sent');
    expect(port.effectsFor(m.deliveryKey)).toBe(1);
    expect(m.attempts.at(-1)?.outcome).toBe('reconciled_found');
    // A template withdrawn between intent and send suppresses the queued reminder.
    const later = await book(p);
    await s.runOnce(T_ALPHA);
    h.ok(
      await h.call('a1', 'POST', '/v1/communications/templates/e7-reminder/withdraw', { expectedVersion: 1 }),
    );
    try {
      await makeDue(later);
      await s.runOnce(T_ALPHA);
      expect(await messageFor(later)).toMatchObject({
        state: 'suppressed',
        suppressionReason: 'template_withdrawn',
      });
    } finally {
      h.ok(
        await h.call('a1', 'POST', '/v1/communications/templates', {
          templateRef: 'e7-reminder',
          purpose: 'reminder',
          channel: 'email',
          body: 'There is an update about your visit. Sign in to the patient portal for details.',
        }),
        201,
      );
    }
  });
});

describe('E7 delivery guarantees', () => {
  it('two concurrent workers produce exactly one provider acceptance per message', async () => {
    const p = await consenting('Concurrent', 'e7.concurrent');
    const appt = await book(p);
    const port = new FakeMessaging({ idempotent: false });
    await sender(port).runOnce(T_ALPHA);
    await makeDue(appt);
    await Promise.all([
      sender(port, { pool: 2 }).runOnce(T_ALPHA),
      sender(port, { pool: 2 }).runOnce(T_ALPHA),
    ]);
    const m = await messageFor(appt);
    expect(m.state).toBe('sent');
    expect(port.effectsFor(m.deliveryKey)).toBe(1);
  });

  it('a transient rejection retries with backoff; exhaustion fails into an owned work item', async () => {
    const p = await consenting('Rejected', 'e7.rejected');
    const appt = await book(p);
    const port = new FakeMessaging({}, { reject: () => ({ retryable: true }) });
    const s = sender(port, { maxAttempts: 2 });
    await s.runOnce(T_ALPHA);
    await makeDue(appt);
    await s.runOnce(T_ALPHA);
    let m = await messageFor(appt);
    expect(m.state).toBe('queued');
    const next = await db.admin.query(
      'SELECT next_attempt_at > now() AS later FROM cuspatlas.outbound_messages WHERE id = $1',
      [m.messageRef],
    );
    expect(next.rows[0].later).toBe(true);
    await makeDue(appt);
    await s.runOnce(T_ALPHA);
    m = await messageFor(appt);
    expect(m.state).toBe('failed');
    expect(m.attempts.map((a) => a.outcome)).toStrictEqual(['rejected_transient', 'rejected_transient']);
    const work = h.ok<{
      data: {
        coverage: { status: string };
        items: {
          workItemRef: string;
          reasonCode: string;
          owner: { queue: string };
          dueAt: string | null;
          suggestedNextAction: string;
        }[];
      };
    }>(await h.call('a1', 'GET', '/v1/communications/deliveries/worklist')).data;
    const item = work.items.find((i) => i.workItemRef === m.messageRef);
    expect(item).toMatchObject({
      reasonCode: 'delivery_failed',
      owner: { queue: 'front_desk' },
      suggestedNextAction: 'verify_contact_then_resend',
    });
    expect(item?.dueAt).not.toBeNull();
    expect(port.effectsFor(m.deliveryKey)).toBe(0);
  });

  it('an unknown outcome the provider cannot confirm stays in the worklist, is never resent automatically, and staff resolve it', async () => {
    const p = await consenting('Unknown', 'e7.unknown');
    const appt = await book(p);
    const port = new FakeMessaging(
      { idempotent: false },
      { afterAccept: () => 'timeout', lookupUnavailable: () => true },
    );
    const s = sender(port);
    await s.runOnce(T_ALPHA);
    await makeDue(appt);
    await s.runOnce(T_ALPHA);
    for (let i = 0; i < 2; i += 1) {
      await db.admin.query(
        `UPDATE cuspatlas.outbound_messages SET reconcile_after = now() - interval '1 second', version = version + 1
         WHERE delivery_key = $1`,
        [`reminder:${appt}`],
      );
      await s.runOnce(T_ALPHA);
    }
    let m = await messageFor(appt);
    expect(m.state).toBe('unknown');
    expect(port.calls.filter((c) => c.deliveryKey === m.deliveryKey)).toHaveLength(1);
    const items = h.ok<{ data: { items: { workItemRef: string; reasonCode: string }[] } }>(
      await h.call('a1', 'GET', '/v1/communications/deliveries/worklist'),
    ).data.items;
    expect(items.find((i) => i.workItemRef === m.messageRef)?.reasonCode).toBe('delivery_outcome_unknown');
    const current = await db.admin.query('SELECT version FROM cuspatlas.outbound_messages WHERE id = $1', [
      m.messageRef,
    ]);
    h.ok(
      await h.call('a1', 'POST', `/v1/communications/deliveries/${m.messageRef}/resolve`, {
        expectedVersion: current.rows[0].version,
        action: 'abandon',
      }),
    );
    m = await messageFor(appt);
    expect(m.state).toBe('abandoned');
    const after = h.ok<{ data: { items: { workItemRef: string }[] } }>(
      await h.call('a1', 'GET', '/v1/communications/deliveries/worklist'),
    ).data.items;
    expect(after.map((i) => i.workItemRef)).not.toContain(m.messageRef);
  });

  it('receipts are deduplicated, monotonic, tenant-bound and never resurrect a suppressed message', async () => {
    const p = await consenting('Receipts', 'e7.receipts');
    const appt = await book(p);
    const port = new FakeMessaging();
    const s = sender(port);
    await s.runOnce(T_ALPHA);
    await makeDue(appt);
    await s.runOnce(T_ALPHA);
    const m = await messageFor(appt);
    const body = {
      providerRef: m.providerRef,
      providerEventId: `evt-a-${m.messageRef}`,
      state: 'delivered',
      occurredAt: '2030-07-10T17:05:00Z',
    };
    const first = h.ok<{ data: { deduplicated: boolean; applied: boolean; state: string } }>(
      await receipt(body),
    ).data;
    expect(first).toStrictEqual({ deduplicated: false, applied: true, state: 'delivered' });
    const again = h.ok<{ data: { deduplicated: boolean } }>(
      await receipt(body, SVC_R1, T_ALPHA, 'other-key'),
    ).data;
    expect(again.deduplicated).toBe(true);
    // An older failure arriving late does not regress delivered.
    const late = h.ok<{ data: { applied: boolean; state: string } }>(
      await receipt({
        ...body,
        providerEventId: `evt-b-${m.messageRef}`,
        state: 'failed',
        occurredAt: '2030-07-10T17:02:00Z',
      }),
    ).data;
    expect(late).toMatchObject({ applied: false, state: 'delivered' });
    const read = await messageFor(appt);
    expect(read.receipts.map((r) => [r.state, r.applied])).toStrictEqual([
      ['delivered', true],
      ['failed', false],
    ]);
    expect(await count(db, 'message_receipts')).toBeGreaterThanOrEqual(2);
    // Another tenant's integration cannot attach a receipt to an alpha message.
    await db.admin.query(
      `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ('30000000-0000-4000-8000-0000000000e4', 'service', 'svc-rb')
       ON CONFLICT DO NOTHING`,
    );
    await db.admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes)
       VALUES ($1, '30000000-0000-4000-8000-0000000000e4', ARRAY['communications.receipts']) ON CONFLICT DO NOTHING`,
      [T_BETA],
    );
    const foreign = await receipt(
      { ...body, providerEventId: `evt-c-${m.messageRef}` },
      '30000000-0000-4000-8000-0000000000e4',
      T_BETA,
    );
    expect(foreign.statusCode).toBe(404);
    // A staff member without the receipts scope cannot inject receipts.
    expect(
      (await h.call('a1', 'POST', '/v1/communications/receipts', { ...body, providerEventId: 'evt-d' }))
        .statusCode,
    ).toBe(403);
    // A receipt for a suppressed message is stored but changes nothing.
    const q = await consenting('Suppressed Receipt', 'e7.suppressed.receipt');
    const appt2 = await book(q);
    await s.runOnce(T_ALPHA);
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${q}/opt-outs`, {
        channel: 'email',
        source: 'patient_reported',
      }),
      201,
    );
    await makeDue(appt2);
    await s.runOnce(T_ALPHA);
    const sup = await messageFor(appt2);
    expect(sup.state).toBe('suppressed');
    expect(sup.providerRef).toBeNull();
  });

  it('with no channel policy nothing is enqueued; a revoked worker sends nothing; no marker or recipient leaks', async () => {
    const before = await count(db, 'outbound_messages');
    h.ok(
      await h.call('a1', 'POST', '/v1/communications/channel-policies', {
        purpose: 'reminder',
        channel: 'none',
      }),
      201,
    );
    try {
      const p = await consenting('Policy Off', 'e7.policy.off');
      await book(p);
      const port = new FakeMessaging();
      await sender(port).runOnce(T_ALPHA);
      expect(await count(db, 'outbound_messages')).toBe(before);
    } finally {
      h.ok(
        await h.call('a1', 'POST', '/v1/communications/channel-policies', {
          purpose: 'reminder',
          channel: 'email',
          templateRef: 'e7-reminder',
          quietHours: { start: '21:00', end: '08:00' },
          reminderLeadMinutes: 1440,
        }),
        201,
      );
    }
    const p2 = await consenting('Revoked Worker', 'e7.revoked.worker');
    const appt = await book(p2);
    const port = new FakeMessaging();
    await sender(port).runOnce(T_ALPHA);
    await makeDue(appt);
    await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1', [
      SVC_W1,
    ]);
    try {
      await expect(sender(port).runOnce(T_ALPHA)).rejects.toMatchObject({ code: 'forbidden' });
      const att = await db.admin.query(
        `SELECT reason_code FROM cuspatlas.security_attempt_events WHERE actor_id = $1 AND operation = 'communications.deliver'`,
        [SVC_W1],
      );
      expect(att.rows.map((r) => r.reason_code)).toContain('membership_inactive');
      expect(port.effects).toHaveLength(0);
    } finally {
      await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = NULL WHERE principal_id = $1', [
        SVC_W1,
      ]);
    }
    const surfaces = await db.admin.query(
      `SELECT (SELECT coalesce(json_agg(t)::text, '') FROM cuspatlas.outbound_messages t) ||
              (SELECT coalesce(json_agg(t)::text, '') FROM cuspatlas.delivery_attempts t) ||
              (SELECT coalesce(json_agg(t)::text, '') FROM cuspatlas.message_receipts t) ||
              (SELECT coalesce(json_agg(t)::text, '') FROM cuspatlas.audit_events t) ||
              (SELECT coalesce(json_agg(t)::text, '') FROM cuspatlas.outbox_events t) AS j`,
    );
    expect(surfaces.rows[0].j).not.toContain(MARKER);
    expect(surfaces.rows[0].j).not.toContain('@example.invalid');
    const logText = JSON.stringify(logs) + h.logLines.join('\n');
    expect(logText).not.toContain(MARKER);
    expect(logText).not.toContain('@example.invalid');
    expect(logText).not.toContain('Sign in to the patient portal');
  });

  it('the S notification worklist leaves allowed intents to E7; delivery reads are staff-only and tenant-bound', async () => {
    const p = await consenting('Worklist', 'e7.worklist');
    const appt = await book(p);
    const intent = await db.admin.query(
      `SELECT id FROM cuspatlas.notification_intents WHERE subject_id = $1 AND purpose = 'reminder'`,
      [appt],
    );
    const items = h.ok<{ data: { items: { workItemRef: string }[] } }>(
      await h.call('a1', 'GET', '/v1/scheduling/notifications/worklist'),
    ).data.items;
    expect(items.map((i) => i.workItemRef)).not.toContain(intent.rows[0].id);
    const read = h.ok<{ data: { delivery: { owner: string; state: string } } }>(
      await h.call('a1', 'GET', `/v1/scheduling/notifications/${intent.rows[0].id}`),
    ).data;
    expect(read.delivery.owner).toBe('E7');
    await sender(new FakeMessaging()).runOnce(T_ALPHA);
    const m = await messageFor(appt);
    expect((await h.call('b1', 'GET', `/v1/communications/deliveries/${m.messageRef}`)).statusCode).toBe(404);
    expect((await h.call('a5', 'GET', `/v1/communications/deliveries/${m.messageRef}`)).statusCode).toBe(403);
    const mcp = await h.mcp('a1', 'communications_deliveries_get', { messageRef: m.messageRef });
    expect((mcp.body as { data: { state: string } }).data.state).toBe(m.state);
  });
});
