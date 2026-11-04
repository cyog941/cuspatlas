import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation, T_ALPHA } from '../integration/support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from '../integration/support/db';
import {
  type EngagementHarness,
  email,
  openEngagementHarness,
  SVC_R1,
  SVC_W1,
} from '../integration/support/engagement-fixtures';
import { FakeMessaging } from '../integration/support/fake-messaging';
import { MARKER } from '../integration/support/marker';
import {
  createAuthorize,
  createMembershipSource,
  createOutboundSender,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
  SUPPRESSION_REASONS,
} from '../integration/support/scenario-deps';

/**
 * E9 ordinary portal day (synthetic): a guardian registers a minor's appointment request through the
 * portal, completes an intake form with the reminder consent, staff book from the request, the minor
 * receives a notice-only reminder through the FAKE provider, the guardian opts out through the portal,
 * and the next booking's reminder is suppressed. Every step goes through REST transports and the
 * worker under the runtime role; the superuser connection only reads back and stands in for elapsed
 * time (making a queued reminder due).
 */
let db: TestDatabase;
let h: EngagementHarness;
const NOTICE = 'You have an upcoming visit. Sign in to the patient portal for the details.';

beforeAll(async () => {
  db = await openTestDatabase('ordinary_portal_day');
  h = await openEngagementHarness(db, { mcp: true });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('E9 ordinary portal day (synthetic)', () => {
  it('guardian request, intake, notice-only reminder, opt-out, next intent suppressed', async () => {
    const log: string[] = [];
    const step = (s: string) => log.push(s);

    // Practice setup by staff.
    const loc = await seedLocation(h, 'loc-portal-day');
    h.ok(
      await h.call('a1', 'POST', '/v1/communications/templates', {
        templateRef: 'day-reminder',
        purpose: 'reminder',
        channel: 'email',
        body: NOTICE,
      }),
      201,
    );
    h.ok(
      await h.call('a1', 'POST', '/v1/communications/channel-policies', {
        purpose: 'reminder',
        channel: 'email',
        templateRef: 'day-reminder',
        quietHours: { start: '21:00', end: '08:00' },
        reminderLeadMinutes: 1440,
      }),
      201,
    );
    h.ok(
      await h.call('a1', 'POST', '/v1/intake/forms', {
        formRef: 'day-intake',
        title: 'Synthetic child intake',
        fields: [
          {
            key: 'visit_reason',
            label: 'Reason for visit',
            kind: 'choice',
            required: true,
            options: ['checkup', 'concern'],
          },
        ],
        consents: [
          {
            key: 'email_reminders',
            label: 'Email appointment reminders',
            channel: 'email',
            purpose: 'reminders',
            consentVersion: 'day-consent-1',
          },
        ],
      }),
      201,
    );
    step('practice configured');

    // A family: the guardian holds scheduling, demographics and consent for the minor.
    const guardian = await h.person(`Synthetic Day Guardian ${MARKER}`, [email('day.guardian')]);
    const minor = await h.person(`Synthetic Day Minor ${MARKER}`, [email('day.minor')], {
      birthDate: { known: true, value: '2017-04-04', precision: 'day' },
    });
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${minor}/relationships`, {
        counterpartyRef: guardian,
        kind: 'guardian',
        scopes: ['scheduling', 'demographics', 'consent'],
      }),
      201,
    );
    const guardianP = await h.enroll(guardian, { channel: 'email', value: 'day.guardian@example.invalid' });
    step('guardian enrolled and verified');

    // 1. The guardian registers the minor's appointment request through the portal.
    const request = h.ok<{ data: { requestRef: string } }>(
      await h.portal(guardianP, 'POST', `/portal/v1/patients/${minor}/appointment-requests`, {
        locationRef: loc.locationRef,
        flexibility: 'mornings',
        contactConsent: 'granted',
      }),
      201,
    ).data.requestRef;
    step('portal request registered');

    // 2. The guardian completes the intake form with the reminder consent.
    const intake = h.ok<{ data: { consentCount: number; viaRelationshipRef: string | null } }>(
      await h.portal(guardianP, 'POST', `/portal/v1/patients/${minor}/intake-submissions`, {
        formRef: 'day-intake',
        formVersion: 1,
        answers: { visit_reason: 'checkup' },
        consents: { email_reminders: 'granted' },
      }),
      201,
    ).data;
    expect(intake.consentCount).toBe(1);
    expect(intake.viaRelationshipRef).not.toBeNull();
    step('intake completed with consent');

    // Staff attest the minor's contact and book from the request.
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${minor}/contact-verifications`, {
        channel: 'email',
        value: 'day.minor@example.invalid',
        method: 'synthetic_attested',
      }),
      201,
    );
    const book = async (day: string) =>
      h.ok<{ data: { appointmentRef: string } }>(
        await h.call('a1', 'POST', '/v1/scheduling/appointments', {
          patientRef: minor,
          locationRef: loc.locationRef,
          ...(day === '2030-09-02' ? { requestRef: request } : {}),
          startsAt: `${day}T14:00:00Z`,
          endsAt: `${day}T15:00:00Z`,
          timeZone: 'America/New_York',
          provider: { kind: 'provider', resourceRef: loc.provider },
          operatory: { kind: 'operatory', resourceRef: loc.operatory },
        }),
        201,
      ).data.appointmentRef;
    const first = await book('2030-09-02');
    const requestView = h.ok<{ data: { fields: { requests: { requestRef: string; state: string }[] } } }>(
      await h.portal(guardianP, 'GET', `/portal/v1/patients/${minor}/views/requests`),
    ).data;
    expect(requestView.fields.requests.find((r) => r.requestRef === request)?.state).toBe('scheduled');
    step('staff booked from the request');

    // 3. The reminder is delivered notice-only through the fake provider and receipted.
    const port = new FakeMessaging();
    const sender = createOutboundSender({
      workerPrincipalId: SVC_W1,
      withTenantTransaction: createTenantTransactionRunner(db.app),
      authorize: createAuthorize(createMembershipSource(db.app)),
      memberships: createMembershipSource(db.app),
      attempts: createSecurityAttemptSink(db.sink),
      port,
      clock: () => new Date('2030-09-01T15:00:00Z'),
    });
    await sender.runOnce(T_ALPHA);
    await db.admin.query(
      `UPDATE cuspatlas.outbound_messages SET next_attempt_at = now() - interval '1 second', version = version + 1
       WHERE state = 'queued'`,
    );
    await sender.runOnce(T_ALPHA);
    expect(port.effects).toHaveLength(1);
    const effect = port.effects[0];
    expect(effect?.deliveryKey).toBe(`reminder:${first}`);
    expect(effect?.recipient).toBe('day.minor@example.invalid');
    expect(effect?.body).toBe(NOTICE);
    expect(effect?.body).not.toContain(MARKER);
    h.ok(
      await h.call(
        await h.issuer.issue({ sub: SVC_R1, tid: T_ALPHA }),
        'POST',
        '/v1/communications/receipts',
        {
          providerRef: effect?.providerRef,
          providerEventId: 'day-evt-1',
          state: 'delivered',
          occurredAt: '2030-09-01T15:00:05Z',
        },
        'day-rcpt-1',
      ),
    );
    const delivered = await db.admin.query(
      `SELECT m.state FROM cuspatlas.outbound_messages m JOIN cuspatlas.notification_intents i ON i.id = m.intent_id
       WHERE i.subject_id = $1 AND i.purpose = 'reminder'`,
      [first],
    );
    expect(delivered.rows[0].state).toBe('delivered');
    step('notice-only reminder delivered and receipted');

    // 4. The guardian opts the minor out of email through the portal.
    h.ok(
      await h.portal(guardianP, 'POST', `/portal/v1/patients/${minor}/consents`, {
        channel: 'email',
        purpose: 'reminders',
        state: 'opted_out',
        consentVersion: 'day-consent-1',
      }),
      201,
    );
    step('guardian opted out');

    // 5. The next booking's reminder intent is suppressed (opt_out) and nothing more is sent.
    const second = await book('2030-09-09');
    const decision = await db.admin.query(
      `SELECT d.outcome, d.reason FROM cuspatlas.notification_intents i
       JOIN cuspatlas.suppression_decisions d ON d.id = i.suppression_decision_ref
       WHERE i.subject_id = $1 AND i.purpose = 'reminder'`,
      [second],
    );
    expect(decision.rows[0]).toStrictEqual({ outcome: 'suppressed', reason: 'opt_out' });
    await sender.runOnce(T_ALPHA);
    await db.admin.query(
      `UPDATE cuspatlas.outbound_messages SET next_attempt_at = now() - interval '1 second', version = version + 1
       WHERE state = 'queued'`,
    );
    await sender.runOnce(T_ALPHA);
    expect(port.effects).toHaveLength(1);
    const intent = h.ok<{ data: { suppressionDecision: { state: string; reason: string } } }>(
      await h.call(
        'a1',
        'GET',
        `/v1/scheduling/notifications/${
          (
            await db.admin.query(
              `SELECT id FROM cuspatlas.notification_intents WHERE subject_id = $1 AND purpose = 'reminder'`,
              [second],
            )
          ).rows[0].id
        }`,
      ),
    ).data;
    expect(intent.suppressionDecision).toMatchObject({ state: 'suppressed', reason: 'opt_out' });
    step('next intent suppressed');

    // Every recorded decision carries a reason from the single vocabulary; nothing leaked.
    const reasons = await db.admin.query(
      'SELECT DISTINCT reason FROM cuspatlas.suppression_decisions WHERE reason IS NOT NULL',
    );
    for (const r of reasons.rows) expect(SUPPRESSION_REASONS).toContain(r.reason);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
    expect(log).toStrictEqual([
      'practice configured',
      'guardian enrolled and verified',
      'portal request registered',
      'intake completed with consent',
      'staff booked from the request',
      'notice-only reminder delivered and receipted',
      'guardian opted out',
      'next intent suppressed',
    ]);
  });
});
