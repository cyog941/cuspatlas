import { randomUUID } from 'node:crypto';
import { addBusinessDays } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, email, openEngagementHarness } from './support/engagement-fixtures';
import { USER_A1, USER_A4 } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * E10 / OR-08: the needs-reply messaging queue. needs_reply is derived from the E5 awaiting-reply
 * state (the same predicate as the message_awaiting_reply work item), the reply-due time comes from a
 * per-queue policy (default one business day), an overdue thread is escalated exactly once per
 * unanswered episode, unread is a per-staff read-receipt fact, and every list carries the OR-01 envelope.
 */
let db: TestDatabase;
let h: EngagementHarness;
let south: { locationRef: string };
let north: { locationRef: string };
let adult: string;
let adultP: string;
let other: string;
let otherP: string;

type Item = {
  threadRef: string;
  queue: string;
  state: string;
  awaiting: string;
  assigneeRef: string | null;
  lastMessageAt: string;
  unread: boolean;
  needsReply: boolean;
  replyDueAt: string | null;
  overdue: boolean;
  escalatedAt: string | null;
  version: number;
};
type List = {
  asOf: string;
  appliedFilters: Record<string, unknown>;
  scope: { kind: string; locationRefs?: string[] };
  limit: number;
  truncated: boolean;
  nextCursor: string | null;
  ordering: { key: string; direction: string; tieBreak: string };
  count: { exact: number } | { atLeast: number };
  counts: { all: number; unread: number; needs_reply: number };
  policies: Record<string, { replyDueBusinessDays: number }>;
  items: Item[];
};

beforeAll(async () => {
  db = await openTestDatabase('needs_reply_queue');
  h = await openEngagementHarness(db, { mcp: true });
  south = await seedLocation(h, 'loc-south');
  north = await seedLocation(h, 'loc-north');
  adult = await h.person(`Synthetic Needs Reply Adult ${MARKER}`, [email('e10.adult')]);
  other = await h.person('Synthetic Needs Reply Other', [email('e10.other')]);
  adultP = await h.enroll(adult, { channel: 'email', value: 'e10.adult@example.invalid' });
  otherP = await h.enroll(other, { channel: 'email', value: 'e10.other@example.invalid' });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

const portalOpen = async (who: string, p: string, locationRef: string, body: string, topic = 'general') =>
  h.ok<{ data: { threadRef: string } }>(
    await h.portal(who, 'POST', `/portal/v1/patients/${p}/message-threads`, { topic, locationRef, body }),
    201,
  ).data.threadRef;
const portalPost = async (who: string, p: string, threadRef: string, body: string) =>
  h.ok(
    await h.portal(who, 'POST', `/portal/v1/patients/${p}/message-threads/${threadRef}/messages`, { body }),
    201,
  );
const list = async (who: 'a1' | 'a3', query = '') =>
  h.ok<{ data: List }>(await h.call(who, 'GET', `/v1/messaging/threads${query}`)).data;
const find = (l: List, ref: string) => l.items.find((i) => i.threadRef === ref);
// Shifts the whole thread (its messages too) into the past, as if it had been written days ago.
const backdate = async (ref: string, days: number) => {
  const c = await db.admin.connect();
  try {
    await c.query('SET session_replication_role = replica');
    await c.query(
      `UPDATE cuspatlas.thread_messages SET created_at = created_at - make_interval(days => $2) WHERE thread_id = $1`,
      [ref, days],
    );
    await c.query(
      `UPDATE cuspatlas.message_threads SET last_message_at = last_message_at - make_interval(days => $2),
         version = version + 1 WHERE id = $1`,
      [ref, days],
    );
  } finally {
    await c.query('RESET session_replication_role');
    c.release();
  }
};
const escalations = async (ref: string) =>
  Number(
    (
      await db.admin.query(
        'SELECT count(*) AS n FROM cuspatlas.thread_reply_escalations WHERE thread_id = $1',
        [ref],
      )
    ).rows[0].n,
  );
const staffReply = async (ref: string) =>
  h.ok(await h.call('a1', 'POST', `/v1/messaging/threads/${ref}/messages`, { body: 'Synthetic reply' }), 201);

describe('E10 needs-reply queue (OR-08)', () => {
  it('a portal message creates exactly one needs-reply item with a one-business-day due time; a staff reply clears it', async () => {
    const t = await portalOpen(adultP, adult, south.locationRef, `Please call me ${MARKER}`);
    const before = await list('a1', '?filter=needs_reply');
    const item = find(before, t);
    expect(before.items.filter((i) => i.threadRef === t)).toHaveLength(1);
    expect(item).toMatchObject({ needsReply: true, awaiting: 'practice', overdue: false, escalatedAt: null });
    // R7: due is measured from the episode's first portal message (written with the thread activity).
    expect(
      Math.abs(
        Date.parse(item?.replyDueAt as string) -
          addBusinessDays(new Date(item?.lastMessageAt as string), 1, 'America/New_York').getTime(),
      ),
    ).toBeLessThan(1000);
    expect(before.policies.front_desk?.replyDueBusinessDays).toBe(1);
    // The same predicate feeds the existing work item (one mechanism): the same item, the same due time.
    const work = h
      .ok<{ data: { items: { workItemRef: string; dueAt: string }[] } }>(
        await h.call('a1', 'GET', '/v1/messaging/threads/worklist'),
      )
      .data.items.find((i) => i.workItemRef === t);
    expect(work?.dueAt).toBe(item?.replyDueAt);
    // A second portal message in the same unanswered episode does not create a second item.
    await portalPost(adultP, adult, t, 'Follow up');
    expect((await list('a1', '?filter=needs_reply')).items.filter((i) => i.threadRef === t)).toHaveLength(1);
    await staffReply(t);
    const after = await list('a1', '?filter=needs_reply');
    expect(find(after, t)).toBeUndefined();
    expect(after.counts.needs_reply).toBe(before.counts.needs_reply - 1);
    expect(find(await list('a1'), t)).toMatchObject({
      needsReply: false,
      awaiting: 'patient',
      replyDueAt: null,
    });
    const gone = h.ok<{ data: { items: { workItemRef: string }[] } }>(
      await h.call('a1', 'GET', '/v1/messaging/threads/worklist'),
    ).data.items;
    expect(gone.map((i) => i.workItemRef)).not.toContain(t);
  });

  it('an overdue item escalates exactly once per unanswered episode, however often it is read; a new episode escalates again', async () => {
    const t = await portalOpen(adultP, adult, south.locationRef, 'Overdue one');
    expect(await escalations(t)).toBe(0);
    await backdate(t, 4);
    const first = find(await list('a1', '?filter=needs_reply'), t);
    expect(first).toMatchObject({ overdue: true, needsReply: true });
    expect(first?.escalatedAt).not.toBeNull();
    const second = find(await list('a1', '?filter=needs_reply'), t);
    h.ok(await h.call('a1', 'GET', '/v1/messaging/threads/worklist'));
    expect((await h.mcp('a1', 'messaging_threads_list', { filter: 'needs_reply' })).status).toBe(200);
    expect(second?.escalatedAt).toBe(first?.escalatedAt);
    expect(await escalations(t)).toBe(1);
    // The escalation fact is append-only.
    await expect(
      db.admin.query('UPDATE cuspatlas.thread_reply_escalations SET due_at = now() WHERE thread_id = $1', [
        t,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    // Answered, then the patient writes again: a new episode, not yet overdue, no new escalation.
    await staffReply(t);
    await portalPost(adultP, adult, t, 'Again');
    expect(find(await list('a1', '?filter=needs_reply'), t)).toMatchObject({
      overdue: false,
      escalatedAt: null,
    });
    expect(await escalations(t)).toBe(1);
    await backdate(t, 4);
    expect(find(await list('a1', '?filter=needs_reply'), t)?.escalatedAt).not.toBeNull();
    expect(await escalations(t)).toBe(2);
  });

  it('a per-queue policy sets the due time; a business day is Monday to Friday in the location zone', async () => {
    h.ok(
      await h.call('a1', 'POST', '/v1/messaging/reply-policies', {
        queue: 'billing',
        replyDueBusinessDays: 3,
      }),
      200,
    );
    const t = await portalOpen(adultP, adult, south.locationRef, 'A billing question', 'billing');
    const l = await list('a1', '?filter=needs_reply');
    const item = find(l, t);
    expect(l.policies.billing?.replyDueBusinessDays).toBe(3);
    // R7: due is measured from the episode's first portal message (written with the thread activity).
    expect(
      Math.abs(
        Date.parse(item?.replyDueAt as string) -
          addBusinessDays(new Date(item?.lastMessageAt as string), 3, 'America/New_York').getTime(),
      ),
    ).toBeLessThan(1000);
    const bad = await h.call('a1', 'POST', '/v1/messaging/reply-policies', {
      queue: 'billing',
      replyDueBusinessDays: 0,
    });
    expect(bad.statusCode).toBe(400);
    const denied = await h.call('a4', 'POST', '/v1/messaging/reply-policies', {
      queue: 'billing',
      replyDueBusinessDays: 2,
    });
    expect(denied.statusCode).toBe(403);
  });

  it('unread is a per-staff-member read receipt: reading as one member leaves it unread for another', async () => {
    const t = await portalOpen(otherP, other, north.locationRef, 'Unread north');
    expect(find(await list('a1', '?filter=unread'), t)?.unread).toBe(true);
    expect(find(await list('a3', '?filter=unread'), t)?.unread).toBe(true);
    const a1Before = (await list('a1')).counts.unread;
    const a3Before = (await list('a3')).counts.unread;
    h.ok(await h.call('a1', 'GET', `/v1/messaging/threads/${t}`));
    expect(find(await list('a1', '?filter=unread'), t)).toBeUndefined();
    expect((await list('a1')).counts.unread).toBe(a1Before - 1);
    expect(find(await list('a3', '?filter=unread'), t)?.unread).toBe(true);
    expect((await list('a3')).counts.unread).toBe(a3Before);
    // A read does not clear needs_reply: that takes a reply.
    expect(find(await list('a1', '?filter=needs_reply'), t)).toMatchObject({
      unread: false,
      needsReply: true,
    });
    // A new portal message makes it unread again for the member who had read it.
    await portalPost(otherP, other, t, 'More');
    expect(find(await list('a1', '?filter=unread'), t)?.unread).toBe(true);
    const rows = await db.admin.query(
      'SELECT principal_id FROM cuspatlas.thread_read_receipts WHERE thread_id = $1',
      [t],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('assignment filters the queue; a location-restricted member sees, counts and escalates only its locations', async () => {
    const tSouth = await portalOpen(adultP, adult, south.locationRef, 'South only');
    const tNorth = await portalOpen(otherP, other, north.locationRef, 'North only');
    const a3 = await list('a3', '?filter=all&limit=100');
    expect(a3.scope).toStrictEqual({ kind: 'assigned_locations', locationRefs: ['loc-north'] });
    expect(find(a3, tSouth)).toBeUndefined();
    expect(find(a3, tNorth)).toBeDefined();
    const a1 = await list('a1', '?filter=all&limit=100');
    expect(a1.scope).toStrictEqual({ kind: 'tenant_wide' });
    expect(find(a1, tSouth)).toBeDefined();
    expect(a3.counts.all).toBe(a3.items.length);
    // An overdue south thread is not escalated by a3's read (outside its scope); a1's read escalates it.
    await backdate(tSouth, 5);
    await list('a3', '?filter=needs_reply');
    expect(await escalations(tSouth)).toBe(0);
    await list('a1', '?filter=needs_reply');
    expect(await escalations(tSouth)).toBe(1);
    // Assignment (E5) feeds the assignee filter.
    const v = find(await list('a1', '?limit=100'), tNorth)?.version;
    h.ok(
      await h.call('a1', 'POST', `/v1/messaging/threads/${tNorth}/assign`, {
        expectedVersion: v,
        assigneeRef: USER_A1,
      }),
    );
    const mine = await list('a1', `?filter=needs_reply&assigneeRef=${USER_A1}&limit=100`);
    expect(mine.items.map((i) => i.threadRef)).toStrictEqual([tNorth]);
    expect(mine.appliedFilters).toMatchObject({ filter: 'needs_reply', assigneeRef: USER_A1 });
    expect(mine.items[0]?.assigneeRef).toBe(USER_A1);
  });

  it('every list carries the OR-01 envelope: empty, truncated with a cursor, defaults echoed, bad input refused', async () => {
    const empty = await list('a1', `?filter=needs_reply&assigneeRef=${randomUUID()}`);
    expect(empty.items).toStrictEqual([]);
    expect(empty.count).toStrictEqual({ exact: 0 });
    expect(empty.truncated).toBe(false);
    expect(empty.nextCursor).toBeNull();
    expect(Object.keys(empty).sort()).toStrictEqual(
      [
        'appliedFilters',
        'asOf',
        'count',
        'counts',
        'items',
        'limit',
        'nextCursor',
        'ordering',
        'policies',
        'scope',
        'truncated',
      ].sort(),
    );
    const dflt = await list('a1');
    expect(dflt.appliedFilters).toMatchObject({ filter: 'all' });
    expect(dflt.limit).toBe(50);
    expect(Number.isNaN(Date.parse(dflt.asOf))).toBe(false);
    const page1 = await list('a1', '?filter=needs_reply&limit=1');
    expect(page1.items).toHaveLength(1);
    expect(page1.truncated).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.count).toStrictEqual({ exact: page1.counts.needs_reply });
    expect(page1.ordering).toMatchObject({ key: 'lastMessageAt', direction: 'asc', tieBreak: 'threadRef' });
    const page2 = await list('a1', `?filter=needs_reply&limit=1&cursor=${page1.nextCursor}`);
    expect(page2.items[0]?.threadRef).not.toBe(page1.items[0]?.threadRef);
    for (const q of ['?filter=bogus', '?limit=0', '?limit=101', '?cursor=%25%25%25', '?extra=1']) {
      expect((await h.call('a1', 'GET', `/v1/messaging/threads${q}`)).statusCode).toBe(400);
    }
    expect((await h.call('a4', 'GET', '/v1/messaging/threads')).statusCode).toBe(403);
  });

  it('marker hygiene: no message body reaches the list, the receipts, the escalations or any log/audit row', async () => {
    const t = await portalOpen(adultP, adult, south.locationRef, `Hygiene body ${MARKER}`);
    await backdate(t, 6);
    const res = await h.call('a1', 'GET', '/v1/messaging/threads?filter=needs_reply&limit=100');
    expect(res.body).not.toContain(MARKER);
    await h.call('a1', 'GET', `/v1/messaging/threads/${t}`);
    const leaks = await db.admin.query(
      `SELECT (SELECT count(*) FROM cuspatlas.thread_read_receipts r WHERE r::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.thread_reply_escalations e WHERE e::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.messaging_reply_policies p WHERE p::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.audit_events a WHERE a::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.outbox_events o WHERE o::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.security_attempt_events s WHERE s::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.command_idempotency c WHERE c::text LIKE $1)
            + (SELECT count(*) FROM cuspatlas.sensitive_read_events x WHERE x::text LIKE $1) AS n`,
      [`%${MARKER}%`],
    );
    expect(Number(leaks.rows[0].n)).toBe(0);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });
});

describe('E10 hardening (R7): one escalation per episode, written only by staff who may reply', () => {
  it('a follow-up portal message neither de-escalates nor restarts the due time', async () => {
    const t = await portalOpen(adultP, adult, south.locationRef, 'Episode start');
    await backdate(t, 6);
    const first = find(await list('a1', '?filter=needs_reply'), t);
    expect(first).toMatchObject({ overdue: true });
    expect(first?.escalatedAt).not.toBeNull();
    await portalPost(adultP, adult, t, 'Any news?');
    const after = find(await list('a1', '?filter=needs_reply'), t);
    // Due is measured from the first unanswered message, so the follow-up keeps it overdue.
    expect(after).toMatchObject({ overdue: true, replyDueAt: first?.replyDueAt });
    expect(after?.escalatedAt).toBe(first?.escalatedAt);
    expect(await escalations(t)).toBe(1);
  });

  it('a read-only reader sees the overdue item without writing an escalation fact', async () => {
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY['messaging.read'] WHERE principal_id = $1`,
      [USER_A4],
    );
    const t = await portalOpen(adultP, adult, south.locationRef, 'Read-only view');
    await backdate(t, 6);
    const seen = h.ok<{ data: List }>(
      await h.call('a4', 'GET', '/v1/messaging/threads?filter=needs_reply'),
    ).data;
    expect(find(seen, t)).toMatchObject({ overdue: true, escalatedAt: null });
    const work = h
      .ok<{ data: { items: { workItemRef: string; owner: { queue: string } }[] } }>(
        await h.call('a4', 'GET', '/v1/messaging/threads/worklist'),
      )
      .data.items.find((i) => i.workItemRef === t);
    // Derived for the reader: the item is shown in the escalation queue, but no fact is recorded.
    expect(work?.owner.queue).toBe('practice_manager');
    expect(await escalations(t)).toBe(0);
    await list('a1', '?filter=needs_reply');
    expect(await escalations(t)).toBe(1);
  });

  it('the scan follows each queue policy instead of a fixed 23-hour window', async () => {
    const policy = await h.call('a1', 'POST', '/v1/messaging/reply-policies', {
      queue: 'billing',
      replyDueBusinessDays: 10,
    });
    expect([200, 201]).toContain(policy.statusCode);
    const t = await portalOpen(adultP, adult, south.locationRef, 'Billing question', 'billing');
    await backdate(t, 6);
    expect(find(await list('a1', '?filter=needs_reply'), t)).toMatchObject({
      overdue: false,
      escalatedAt: null,
    });
    expect(await escalations(t)).toBe(0);
  });
});
