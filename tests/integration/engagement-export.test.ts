import { randomUUID } from 'node:crypto';
import {
  ENGAGEMENT_EXPORT_FORMAT,
  ENGAGEMENT_EXPORT_TABLES,
  type EngagementExport,
  type SchedulingExport,
} from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
  importExports,
} from '@cuspatlas/db';
import { createAuthorize } from '@cuspatlas/domain';
import { createOutboundSender } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation, T_ALPHA } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import {
  type EngagementHarness,
  email,
  openEngagementHarness,
  SVC_R1,
  SVC_T1,
  SVC_W1,
  synthPhone,
} from './support/engagement-fixtures';
import { FakeMessaging } from './support/fake-messaging';
import { MARKER } from './support/marker';

/**
 * E9 export round trip (minimal, E scope; M1 owns the full export contract), following S17: a
 * versioned JSON export of every workstream E record with references preserved and no tenant field,
 * produced by the domain under the runtime role, re-imported together with the S17 scheduling export
 * into a fresh synthetic database (every foreign key validated across both documents, any orphan rolls
 * the whole import back), and exported again: identical, and readable through the domain.
 */
let source: TestDatabase;
let target: TestDatabase;
let h: EngagementHarness;
let t: EngagementHarness;
let refs: { submission: string; thread: string; call: string; message: string; principal: string };

type Doc = { format: string; exportedAt: string; tables: Record<string, Record<string, unknown>[]> };
const exportOf = async (x: EngagementHarness, path: string) =>
  x.ok<{ data: Doc }>(await x.call('a1', 'GET', path)).data;

beforeAll(async () => {
  source = await openTestDatabase('e_export_source');
  target = await openTestDatabase('e_export_target');
  h = await openEngagementHarness(source, { mcp: true });
  t = await openEngagementHarness(target);
  const loc = await seedLocation(h, 'loc-e-export');
  // Notices and reminders through the fake provider.
  for (const [purpose, ref] of [
    ['reminder', 'ex-reminder'],
    ['message_notice', 'ex-notice'],
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
        quietHours: { start: '03:00', end: '03:01' },
        ...(purpose === 'reminder' ? { reminderLeadMinutes: 1440 } : {}),
      }),
      201,
    );
  }
  const p = await h.person(`Synthetic Export ${MARKER}`, [email('e9.export'), synthPhone('61')]);
  for (const purpose of ['reminders', 'messaging']) {
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
  }
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${p}/contact-verifications`, {
      channel: 'email',
      value: 'e9.export@example.invalid',
      method: 'synthetic_attested',
    }),
    201,
  );
  const principal = await h.enroll(p, { channel: 'email', value: 'e9.export@example.invalid' });
  // A booking whose reminder is delivered and receipted.
  const appt = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/appointments', {
      patientRef: p,
      locationRef: loc.locationRef,
      startsAt: '2030-09-02T14:00:00Z',
      endsAt: '2030-09-02T15:00:00Z',
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    }),
    201,
  ).data.appointmentRef;
  // Intake: a portal submission with a consent and a demographics review.
  h.ok(
    await h.call('a1', 'POST', '/v1/intake/forms', {
      formRef: 'ex-intake',
      title: 'Synthetic export intake',
      fields: [
        {
          key: 'nickname',
          label: 'Nickname',
          kind: 'text',
          required: false,
          target: 'demographics.preferredName',
        },
      ],
      consents: [
        {
          key: 'sms_ok',
          label: 'Texts are fine',
          channel: 'sms',
          purpose: 'reminders',
          consentVersion: 'ex-1',
        },
      ],
    }),
    201,
  );
  const submission = h.ok<{ data: { submissionRef: string } }>(
    await h.portal(principal, 'POST', `/portal/v1/patients/${p}/intake-submissions`, {
      formRef: 'ex-intake',
      formVersion: 1,
      answers: { nickname: 'Exporter' },
      consents: { sms_ok: 'denied' },
    }),
    201,
  ).data.submissionRef;
  // Messaging: a portal thread and a staff reply with its notice.
  const thread = h.ok<{ data: { threadRef: string } }>(
    await h.portal(principal, 'POST', `/portal/v1/patients/${p}/message-threads`, {
      topic: 'general',
      locationRef: loc.locationRef,
      body: `Export question ${MARKER}`,
    }),
    201,
  ).data.threadRef;
  h.ok(
    await h.call('a1', 'POST', `/v1/messaging/threads/${thread}/messages`, { body: 'Export answer' }),
    201,
  );
  const port = new FakeMessaging();
  const sender = createOutboundSender({
    workerPrincipalId: SVC_W1,
    withTenantTransaction: createTenantTransactionRunner(source.app),
    authorize: createAuthorize(createMembershipSource(source.app)),
    memberships: createMembershipSource(source.app),
    attempts: createSecurityAttemptSink(source.sink),
    port,
    clock: () => new Date('2030-07-10T17:00:00Z'),
  });
  await sender.runOnce(T_ALPHA);
  await source.admin.query(
    `UPDATE cuspatlas.outbound_messages SET next_attempt_at = now() - interval '1 second', version = version + 1
     WHERE state = 'queued'`,
  );
  await sender.runOnce(T_ALPHA);
  const sent = (
    await source.admin.query(
      `SELECT m.id, m.provider_ref FROM cuspatlas.outbound_messages m JOIN cuspatlas.notification_intents i
       ON i.id = m.intent_id WHERE i.subject_id = $1 AND i.purpose = 'reminder'`,
      [appt],
    )
  ).rows[0];
  expect(sent?.provider_ref).toMatch(/^fake-msg-/);
  h.ok(
    await h.call(
      await h.issuer.issue({ sub: SVC_R1, tid: T_ALPHA }),
      'POST',
      '/v1/communications/receipts',
      {
        providerRef: sent.provider_ref,
        providerEventId: 'ex-evt-1',
        state: 'delivered',
        occurredAt: '2030-07-10T17:01:00Z',
      },
      'ex-rcpt-1',
    ),
  );
  // Recall: the attended visit is S16's qualifying event; E6 enrolls the due item.
  h.ok(
    await h.call('a1', 'POST', `/v1/scheduling/appointments/${appt}/attendance`, { kind: 'arrived' }),
    201,
  );
  h.ok(
    await h.call('a1', 'POST', '/v1/scheduling/recall/policies', {
      category: 'ex-hygiene',
      intervalMonths: 6,
      basis: 'attended_visit',
    }),
    201,
  );
  const enrolled = h.ok<{ data: { enrolled: number } }>(
    await h.call('a1', 'POST', '/v1/communications/recall-enrollments', {
      category: 'ex-hygiene',
      asOf: '2031-03-05T12:00:00Z',
      patientRefs: [p],
    }),
    201,
  ).data;
  expect(enrolled.enrolled).toBe(1);
  // Telephony: a configuration, a call from the fake adapter and a confirmed link.
  h.ok(
    await h.call('a1', 'POST', '/v1/telephony/config', {
      numbers: ['+1-202-555-0120'],
      timeZone: 'America/New_York',
      hours: [{ weekday: 1, start: '08:00', end: '17:00' }],
      routing: { open: { action: 'ring_queue', queue: 'front_desk' }, closed: { action: 'voicemail' } },
      recording: 'off',
    }),
    201,
  );
  const call = h.ok<{ data: { callRef: string } }>(
    await h.call(await h.issuer.issue({ sub: SVC_T1, tid: T_ALPHA }), 'POST', '/v1/telephony/calls', {
      providerCallRef: 'fake-call-export',
      direction: 'inbound',
      callerNumber: '+1-202-555-0161',
      dialedNumber: '+1-202-555-0120',
      occurredAt: new Date().toISOString(),
      outcome: 'answered',
    }),
    201,
  ).data.callRef;
  h.ok(
    await h.call('a1', 'POST', `/v1/telephony/calls/${call}/link`, {
      patientRef: p,
      reasonCode: 'caller_confirmed_identity',
    }),
    201,
  );
  refs = { submission, thread, call, message: sent.id as string, principal };
});

afterAll(async () => {
  await h?.close();
  await t?.close();
  await source?.close();
  await target?.close();
});

describe('E9 engagement export round trip', () => {
  it('exports every E record class, versioned, with references and no tenant field; REST and MCP agree', async () => {
    const doc = await exportOf(h, '/v1/communications/export');
    expect(doc.format).toBe(ENGAGEMENT_EXPORT_FORMAT);
    expect(Object.keys(doc.tables)).toStrictEqual([...ENGAGEMENT_EXPORT_TABLES]);
    for (const table of ENGAGEMENT_EXPORT_TABLES) {
      expect([table, (doc.tables[table] ?? []).length > 0]).toStrictEqual([table, true]);
    }
    expect(JSON.stringify(doc)).not.toContain(T_ALPHA);
    for (const rows of Object.values(doc.tables))
      for (const r of rows) expect(r).not.toHaveProperty('tenant_id');
    // Delivery rows are metadata: the export carries no recipient address.
    expect(JSON.stringify(doc.tables.outbound_messages)).not.toContain('@example.invalid');
    const m = await h.mcp('a1', 'communications_export', {});
    expect({ ...(m.body as { data: Doc }).data, exportedAt: null }).toStrictEqual({
      ...doc,
      exportedAt: null,
    });
    const logged = await source.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.sensitive_read_events WHERE operation = 'communications.export'`,
    );
    expect(logged.rows[0].n).toBeGreaterThan(0);
  });

  it('is refused to a member without admin.configure and to a location-restricted member; beta exports only itself', async () => {
    expect((await h.call('a4', 'GET', '/v1/communications/export')).statusCode).toBe(403);
    expect((await h.call('a3', 'GET', '/v1/communications/export')).statusCode).toBe(403);
    const alpha = JSON.stringify(await exportOf(h, '/v1/communications/export'));
    const b = h.ok<{ data: Doc }>(await h.call('b1', 'GET', '/v1/communications/export')).data;
    for (const rows of Object.values(b.tables)) {
      for (const r of rows) if (typeof r.id === 'string') expect(alpha).not.toContain(r.id);
    }
    expect(JSON.stringify(b)).not.toContain(refs.thread);
  });

  it('an orphan reference rolls the whole import back; an unknown format is refused', async () => {
    const s = (await exportOf(h, '/v1/scheduling/export')) as unknown as SchedulingExport;
    const e = await exportOf(h, '/v1/communications/export');
    const tampered: Doc = {
      ...e,
      tables: {
        ...e.tables,
        thread_messages: (e.tables.thread_messages ?? []).map((r, i) =>
          i === 0 ? { ...r, thread_id: randomUUID() } : r,
        ),
      },
    };
    await expect(
      importExports(target.admin, T_ALPHA, [s, tampered as unknown as EngagementExport]),
    ).rejects.toThrow(/foreign key/);
    const n = await target.admin.query('SELECT count(*)::int AS n FROM cuspatlas.message_threads');
    expect(n.rows[0].n).toBe(0);
    await expect(
      importExports(target.admin, T_ALPHA, [s, { ...e, format: 'other/9' } as unknown as EngagementExport]),
    ).rejects.toThrow(/format/);
  });

  it('re-imports with the S17 export into a fresh synthetic database without identifier loss and exports identically', async () => {
    const s = await exportOf(h, '/v1/scheduling/export');
    const e = await exportOf(h, '/v1/communications/export');
    const counts = await importExports(target.admin, T_ALPHA, [
      s as unknown as SchedulingExport,
      e as unknown as EngagementExport,
    ]);
    expect(counts.thread_messages).toBe(e.tables.thread_messages?.length);
    expect(counts.portal_principals).toBe(1);
    const again = await exportOf(t, '/v1/communications/export');
    expect({ ...again, exportedAt: null }).toStrictEqual({ ...e, exportedAt: null });
    const sAgain = await exportOf(t, '/v1/scheduling/export');
    expect({ ...sAgain, exportedAt: null }).toStrictEqual({ ...s, exportedAt: null });
    // The re-imported records are live domain data: reads match by reference.
    for (const path of [
      `/v1/intake/submissions/${refs.submission}`,
      `/v1/messaging/threads/${refs.thread}`,
      `/v1/telephony/calls/${refs.call}`,
      `/v1/communications/deliveries/${refs.message}`,
    ]) {
      const a = h.ok<{ data: unknown }>(await h.call('a1', 'GET', path)).data;
      const b = t.ok<{ data: unknown }>(await t.call('a1', 'GET', path)).data;
      expect([path, b]).toStrictEqual([path, a]);
    }
    // The re-imported portal principal authenticates against the target and reads its own thread.
    const read = await t.portal(refs.principal, 'GET', `/portal/v1/session`);
    expect(read.statusCode).toBe(200);
  });
});
