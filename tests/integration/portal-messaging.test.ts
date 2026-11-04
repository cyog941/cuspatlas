import { randomUUID } from 'node:crypto';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAuthorize, SYNTHETIC_TEST_MATCH_KEY_PEPPER } from '@cuspatlas/domain';
import { createOutboundSender } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, email, openEngagementHarness, SVC_W1 } from './support/engagement-fixtures';
import { FakeMessaging } from './support/fake-messaging';
import { T_ALPHA, USER_A1, USER_A4 } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * E5 secure messaging: threads between portal principals and staff queues, immutable messages,
 * attachment references only, an access audit of every read, retention as policy data with a legal
 * hold placeholder (nothing deletes), notices of staff replies only through E6/E7 and notice-only.
 */
let db: TestDatabase;
let h: EngagementHarness;
let loc: { locationRef: string };
const MINOR = { known: true, value: '2016-05-05', precision: 'day' };
let adult: string;
let adultP: string;
let kid: string;
let parentP: string;
let noConsentP: string;
let strangerP: string;
const NOTICE = 'You have a new secure message from the practice. Sign in to the patient portal to read it.';

beforeAll(async () => {
  db = await openTestDatabase('portal_messaging');
  h = await openEngagementHarness(db, { mcp: true });
  loc = await seedLocation(h, 'loc-msg');
  adult = await h.person(`Synthetic Messaging Adult ${MARKER}`, [email('e5.adult')]);
  kid = await h.person('Synthetic Messaging Kid', [], { birthDate: MINOR });
  const parent = await h.person('Synthetic Messaging Parent', [email('e5.parent')]);
  const other = await h.person('Synthetic Messaging Other Parent', [email('e5.other')]);
  const stranger = await h.person('Synthetic Messaging Stranger', [email('e5.stranger')]);
  for (const [counterparty, scopes] of [
    [parent, ['consent', 'demographics']],
    [other, ['scheduling']],
  ] as const) {
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${kid}/relationships`, {
        counterpartyRef: counterparty,
        kind: 'guardian',
        scopes,
      }),
      201,
    );
  }
  adultP = await h.enroll(adult, { channel: 'email', value: 'e5.adult@example.invalid' });
  parentP = await h.enroll(parent, { channel: 'email', value: 'e5.parent@example.invalid' });
  noConsentP = await h.enroll(other, { channel: 'email', value: 'e5.other@example.invalid' });
  strangerP = await h.enroll(stranger, { channel: 'email', value: 'e5.stranger@example.invalid' });
  // Notice channel: notice-only template, quiet hours, messaging consent and a verified contact.
  h.ok(
    await h.call('a1', 'POST', '/v1/communications/templates', {
      templateRef: 'e5-notice',
      purpose: 'message_notice',
      channel: 'email',
      body: NOTICE,
    }),
    201,
  );
  h.ok(
    await h.call('a1', 'POST', '/v1/communications/channel-policies', {
      purpose: 'message_notice',
      channel: 'email',
      templateRef: 'e5-notice',
      quietHours: { start: '03:00', end: '03:01' },
    }),
    201,
  );
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${adult}/consents`, {
      channel: 'email',
      purpose: 'messaging',
      state: 'granted',
      source: 'staff_recorded',
      consentVersion: 'synthetic-consent-1',
    }),
    201,
  );
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${adult}/contact-verifications`, {
      channel: 'email',
      value: 'e5.adult@example.invalid',
      method: 'synthetic_attested',
    }),
    201,
  );
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

const THREADS = (p: string) => `/portal/v1/patients/${p}/message-threads`;
const open = (who: string, p: string, body: string, extra: Record<string, unknown> = {}) =>
  h.portal(who, 'POST', THREADS(p), { topic: 'general', locationRef: loc.locationRef, body, ...extra });
type Thread = {
  threadRef: string;
  version: number;
  state: string;
  awaiting: string;
  messages: {
    messageRef: string;
    authorKind: string;
    body: string;
    attachments: { kind: string; ref: string; authorization: string }[];
    notice: { state: string; reason: string | null } | null;
  }[];
};
const staffRead = async (ref: string) =>
  h.ok<{ data: Thread }>(await h.call('a1', 'GET', `/v1/messaging/threads/${ref}`)).data;
const sender = () =>
  createOutboundSender({
    workerPrincipalId: SVC_W1,
    withTenantTransaction: createTenantTransactionRunner(db.app),
    authorize: createAuthorize(createMembershipSource(db.app)),
    memberships: createMembershipSource(db.app),
    attempts: createSecurityAttemptSink(db.sink),
    port,
    matchKeyPepper: SYNTHETIC_TEST_MATCH_KEY_PEPPER,
    clock: () => new Date(),
  });
const port = new FakeMessaging();

describe('E5 acceptance', () => {
  it('a patient writes, the practice queue owns it, a staff reply is noticed notice-only through E7, the patient reads it', async () => {
    const attachment = h.attachments.register(T_ALPHA, adult, 'imageRef', randomUUID());
    const res = h.ok<{ data: { threadRef: string } }>(
      await open(adultP, adult, `My synthetic question ${MARKER}`, {
        attachments: [{ kind: 'imageRef', ref: attachment }],
      }),
      201,
    ).data;
    const work = h
      .ok<{ data: { items: { workItemRef: string; kind: string; owner: { queue: string } }[] } }>(
        await h.call('a1', 'GET', '/v1/messaging/threads/worklist'),
      )
      .data.items.find((i) => i.workItemRef === res.threadRef);
    expect(work).toMatchObject({ kind: 'message_awaiting_reply', owner: { queue: 'front_desk' } });
    let t = await staffRead(res.threadRef);
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]?.attachments).toStrictEqual([
      { kind: 'imageRef', ref: attachment, authorization: 'separate_grant_required' },
    ]);
    const reply = h.ok<{ data: { noticeOutcome: string } }>(
      await h.call('a1', 'POST', `/v1/messaging/threads/${res.threadRef}/messages`, {
        body: `Synthetic staff answer ${MARKER}`,
      }),
      201,
    ).data;
    expect(reply.noticeOutcome).toBe('allowed');
    await sender().runOnce(T_ALPHA);
    t = await staffRead(res.threadRef);
    expect(t.awaiting).toBe('patient');
    expect(t.messages[1]?.notice).toStrictEqual({ state: 'sent', reason: null });
    // The notice carries the approved notice-only template: no message content, no name.
    const effect = port.effects.find((e) => e.deliveryKey === `message_notice:${t.messages[1]?.messageRef}`);
    expect(effect?.body).toBe(NOTICE);
    expect(effect?.recipient).toBe('e5.adult@example.invalid');
    const portal = h.ok<{ data: { messages: { from: string; body: string; mine: boolean }[] } }>(
      await h.portal(adultP, 'GET', `${THREADS(adult)}/${res.threadRef}`),
    ).data;
    expect(portal.messages.map((m) => [m.from, m.mine])).toStrictEqual([
      ['patient_side', true],
      ['practice', false],
    ]);
    expect(JSON.stringify(portal)).not.toContain(USER_A1);
    const worklist = h.ok<{ data: { items: { workItemRef: string }[] } }>(
      await h.call('a1', 'GET', '/v1/messaging/threads/worklist'),
    ).data.items;
    expect(worklist.map((i) => i.workItemRef)).not.toContain(res.threadRef);
    // The messages view lists the thread without bodies.
    const view = h.ok<{ data: { fields: { threads: Record<string, unknown>[] } } }>(
      await h.portal(adultP, 'GET', `/portal/v1/patients/${adult}/views/messages`),
    ).data;
    expect(Object.keys(view.fields.threads[0] ?? {})).toStrictEqual([
      'threadRef',
      'topic',
      'state',
      'awaitingReplyFrom',
      'lastMessageAt',
    ]);
  });

  it('every read is access-audited and no body reaches logs, audit, outbox, attempts, idempotency or delivery rows', async () => {
    const res = h.ok<{ data: { threadRef: string } }>(
      await open(adultP, adult, `Audit me ${MARKER}`),
      201,
    ).data;
    await staffRead(res.threadRef);
    h.ok(await h.portal(adultP, 'GET', `${THREADS(adult)}/${res.threadRef}`));
    const reads = await db.admin.query(
      `SELECT operation, principal FROM cuspatlas.sensitive_read_events WHERE $1::uuid = ANY (resource_refs)
       ORDER BY occurred_at`,
      [res.threadRef],
    );
    expect(reads.rows).toStrictEqual([
      { operation: 'messaging.threads.read', principal: 'human' },
      { operation: 'portal.threads.read', principal: 'portal' },
    ]);
    const leaks = await db.admin.query(
      `SELECT (SELECT count(*) FROM cuspatlas.audit_events a WHERE a::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.outbox_events o WHERE o::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.security_attempt_events s WHERE s::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.command_idempotency c WHERE c::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.sensitive_read_events r WHERE r::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.outbound_messages m WHERE m::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.delivery_attempts d WHERE d::text LIKE $1) AS n`,
      [`%${MARKER}%`],
    );
    expect(Number(leaks.rows[0].n)).toBe(0);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
    for (const e of port.effects) expect(e.body).not.toContain(MARKER);
  });

  it('messages are immutable and threads are never deleted; there is no edit or delete route', async () => {
    const res = h.ok<{ data: { threadRef: string; messageRef: string } }>(
      await open(adultP, adult, 'Immutable'),
      201,
    ).data;
    await expect(
      db.app.query(`UPDATE cuspatlas.thread_messages SET body = 'x' WHERE id = $1`, [res.messageRef]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.admin.query('DELETE FROM cuspatlas.message_threads WHERE id = $1', [res.threadRef]),
    ).rejects.toMatchObject({ code: '42501' });
    for (const method of ['PATCH', 'DELETE', 'PUT'] as const) {
      const r = await h.app.inject({
        method,
        url: `/v1/messaging/threads/${res.threadRef}/messages/${res.messageRef}`,
        headers: { authorization: `Bearer ${h.tokens.a1}` },
      });
      expect(r.statusCode).toBe(404);
    }
  });

  it('a guardian with consent writes for the minor; without consent 403; a stranger and a foreign thread are the same 404', async () => {
    const res = h.ok<{ data: { threadRef: string } }>(await open(parentP, kid, 'For my child'), 201).data;
    const rel = await db.admin.query(
      'SELECT via_relationship_id FROM cuspatlas.message_threads WHERE id = $1',
      [res.threadRef],
    );
    expect(rel.rows[0].via_relationship_id).not.toBeNull();
    const denied = await open(noConsentP, kid, 'No consent scope');
    expect([denied.statusCode, denied.json().detail?.reason]).toStrictEqual([
      403,
      'relationship_scope_missing',
    ]);
    const foreign = await h.portal(strangerP, 'GET', `${THREADS(kid)}/${res.threadRef}`);
    const missing = await h.portal(parentP, 'GET', `${THREADS(kid)}/${randomUUID()}`);
    const own = h.ok<{ data: { threadRef: string } }>(await open(adultP, adult, 'Mine'), 201).data;
    const crossed = await h.portal(parentP, 'GET', `${THREADS(kid)}/${own.threadRef}`);
    const strip = (b: string) => JSON.parse(b, (k, v) => (k === 'correlationId' ? undefined : v));
    expect([foreign.statusCode, crossed.statusCode, missing.statusCode]).toStrictEqual([404, 404, 404]);
    expect(strip(crossed.body)).toStrictEqual(strip(missing.body));
  });

  it('staff without a messaging scope cannot read a thread even with patient access; beta and a restricted member get 404', async () => {
    const res = h.ok<{ data: { threadRef: string } }>(await open(adultP, adult, 'Scoped read'), 201).data;
    const a4 = await h.call('a4', 'GET', `/v1/messaging/threads/${res.threadRef}`);
    expect([a4.statusCode, a4.json().code]).toStrictEqual([403, 'forbidden']);
    expect((await h.call('a4', 'GET', `/v1/patients/${adult}`)).statusCode).toBe(200);
    const mcp = await h.mcp('a4', 'messaging_threads_get', { threadRef: res.threadRef });
    expect(mcp.status).toBe(403);
    const beta = await h.call('b1', 'GET', `/v1/messaging/threads/${res.threadRef}`);
    const random = await h.call('b1', 'GET', `/v1/messaging/threads/${randomUUID()}`);
    expect([beta.statusCode, random.statusCode]).toStrictEqual([404, 404]);
    expect((await h.call('a3', 'GET', `/v1/messaging/threads/${res.threadRef}`)).statusCode).toBe(404);
  });

  it('closing stops participant messages but not staff replies; a suppressed notice leaves the reply unnotified', async () => {
    const res = h.ok<{ data: { threadRef: string } }>(await open(parentP, kid, 'Close me'), 201).data;
    const t = await staffRead(res.threadRef);
    h.ok(
      await h.call('a1', 'POST', `/v1/messaging/threads/${res.threadRef}/close`, {
        expectedVersion: t.version,
        reasonCode: 'resolved',
      }),
    );
    const late = await h.portal(parentP, 'POST', `${THREADS(kid)}/${res.threadRef}/messages`, {
      body: 'One more',
    });
    expect([late.statusCode, late.json().detail.reason]).toStrictEqual([409, 'thread_closed']);
    const reply = h.ok<{ data: { noticeOutcome: string; noticeReason: string } }>(
      await h.call('a1', 'POST', `/v1/messaging/threads/${res.threadRef}/messages`, {
        body: 'Staff follow-up',
      }),
      201,
    ).data;
    // The minor has no messaging consent: the notice is suppressed, the message is still readable.
    expect([reply.noticeOutcome, reply.noticeReason]).toStrictEqual(['suppressed', 'no_consent']);
    const after = await staffRead(res.threadRef);
    expect(after.messages.at(-1)?.notice).toStrictEqual({ state: 'unnotified', reason: 'no_consent' });
    const portal = h.ok<{ data: { messages: { body: string }[] } }>(
      await h.portal(parentP, 'GET', `${THREADS(kid)}/${res.threadRef}`),
    ).data;
    expect(portal.messages.at(-1)?.body).toBe('Staff follow-up');
  });

  it('assignment needs an eligible staff member; retention names held threads and deletes nothing', async () => {
    const res = h.ok<{ data: { threadRef: string } }>(await open(adultP, adult, 'Assign and hold'), 201).data;
    let t = await staffRead(res.threadRef);
    const ineligible = await h.call('a1', 'POST', `/v1/messaging/threads/${res.threadRef}/assign`, {
      expectedVersion: t.version,
      assigneeRef: USER_A4,
    });
    expect(ineligible.statusCode).toBe(422);
    h.ok(
      await h.call('a1', 'POST', `/v1/messaging/threads/${res.threadRef}/assign`, {
        expectedVersion: t.version,
        assigneeRef: USER_A1,
      }),
    );
    const item = h
      .ok<{ data: { items: { workItemRef: string; owner: { principalRef: string | null } }[] } }>(
        await h.call('a1', 'GET', '/v1/messaging/threads/worklist'),
      )
      .data.items.find((i) => i.workItemRef === res.threadRef);
    expect(item?.owner.principalRef).toBe(USER_A1);
    const ret = h.ok<{ data: { eligible: boolean; heldReason: string; policy: { status: string } } }>(
      await h.call('a1', 'GET', `/v1/messaging/threads/${res.threadRef}/retention`),
    ).data;
    expect(ret).toMatchObject({
      eligible: false,
      heldReason: 'retention_period_undecided',
      policy: { status: 'pending_legal_review' },
    });
    t = await staffRead(res.threadRef);
    const noReason = await h.call('a1', 'POST', `/v1/messaging/threads/${res.threadRef}/legal-hold`, {
      expectedVersion: t.version,
      hold: true,
    });
    expect(noReason.statusCode).toBe(422);
    h.ok(
      await h.call('a1', 'POST', `/v1/messaging/threads/${res.threadRef}/legal-hold`, {
        expectedVersion: t.version,
        hold: true,
        reasonCode: 'synthetic_litigation_hold',
      }),
    );
    const held = h.ok<{ data: { eligible: boolean; heldReason: string } }>(
      await h.call('a1', 'GET', `/v1/messaging/threads/${res.threadRef}/retention`),
    ).data;
    expect(held).toMatchObject({ eligible: false, heldReason: 'legal_hold' });
    expect(
      (
        await h.call('svcA1', 'POST', `/v1/messaging/threads/${res.threadRef}/legal-hold`, {
          expectedVersion: t.version + 1,
          hold: false,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('a malformed attachment or an extra field is refused; a portal token is refused by staff routes', async () => {
    const bad = await open(adultP, adult, 'Bad attachment', { attachments: [{ kind: 'bytes', ref: 'x' }] });
    expect(bad.statusCode).toBe(400);
    const extra = await open(adultP, adult, 'Extra', { tenantId: T_ALPHA });
    expect(extra.statusCode).toBe(400);
    const token = await h.portalToken(adultP);
    expect((await h.call(token, 'GET', '/v1/messaging/threads/worklist')).statusCode).toBe(401);
  });
});
