import { randomUUID } from 'node:crypto';
import { composeWorker } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, email, openEngagementHarness } from './support/engagement-fixtures';
import { T_ALPHA, T_BETA, USER_A1 } from './support/fixtures';

/**
 * E10 / OR-08: overdue needs-reply episodes escalate without a human read. The worker's sweep runs per
 * served tenant as the worker's service principal through `messaging.threads.escalate` (service only,
 * `communications.deliver`), with each queue's own reply-due policy as the threshold. The escalation
 * fact is keyed by (thread, unanswered portal message), so repeated or concurrent ticks escalate an
 * episode once; it never records a read receipt or changes the thread. Synthetic data only.
 */
const W = '30000000-0000-4000-8000-0000000000d8';
let db: TestDatabase;
let h: EngagementHarness;
let south: { locationRef: string };
let adult: string;
let adultP: string;
let betaPerson: string;
let betaP: string;
let betaLoc: { locationRef: string };

const env = () => ({
  CUSPATLAS_ENV: 'synthetic-test',
  CUSPATLAS_WORKER_PRINCIPAL_ID: W,
  CUSPATLAS_WORKER_TENANT_IDS: T_ALPHA,
});
const pools = () => ({ app: db.app, attempts: db.sink });

const portalOpen = async (p: string, locationRef: string, body: string, topic = 'general', tid = T_ALPHA) =>
  h.ok<{ data: { threadRef: string } }>(
    await h.portal(
      p,
      'POST',
      `/portal/v1/patients/${tid === T_ALPHA ? adult : betaPerson}/message-threads`,
      { topic, locationRef, body },
      randomUUID(),
      tid,
    ),
    201,
  ).data.threadRef;
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
const audits = async (ref: string) =>
  (
    await db.admin.query<{ actor_id: string; tenant_id: string }>(
      `SELECT actor_id, tenant_id FROM cuspatlas.audit_events
       WHERE operation = 'messaging.threads.escalate' AND resource_ref = $1`,
      [ref],
    )
  ).rows;
const threadState = async (ref: string) =>
  (
    await db.admin.query<{ state: string; awaiting: string; version: number; receipts: number }>(
      `SELECT t.state, t.awaiting, t.version,
         (SELECT count(*)::int FROM cuspatlas.thread_read_receipts r WHERE r.thread_id = t.id) AS receipts
       FROM cuspatlas.message_threads t WHERE t.id = $1`,
      [ref],
    )
  ).rows[0];

beforeAll(async () => {
  db = await openTestDatabase('worker_reply_escalation');
  h = await openEngagementHarness(db);
  await db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'svc-worker-escalation') ON CONFLICT DO NOTHING`,
    [W],
  );
  await db.admin.query(
    'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [T_ALPHA, W, ['outbox.deliver', 'communications.deliver']],
  );
  south = await seedLocation(h, 'loc-south');
  adult = await h.person('Synthetic Escalation Adult', [email('e10w.adult')]);
  adultP = await h.enroll(adult, { channel: 'email', value: 'e10w.adult@example.invalid' });
  betaLoc = await seedLocation(h, 'loc-beta-esc', { who: 'b1' });
  betaPerson = await h.person('Synthetic Escalation Beta', [email('e10w.beta')], {}, 'b1');
  betaP = h.ok<{ data: { principalRef: string } }>(
    await h.call('b1', 'POST', '/v1/portal/principals', {
      personRef: betaPerson,
      contact: { channel: 'email', value: 'e10w.beta@example.invalid' },
    }),
    201,
  ).data.principalRef;
  h.ok(
    await h.call('b1', 'POST', `/v1/portal/principals/${betaP}/verify`, {
      expectedVersion: 1,
      method: 'synthetic_attested',
    }),
  );
}, 180_000);

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('E10 worker escalation sweep', () => {
  it('an overdue episode escalates once across two ticks, audited as the worker, never marked read; a fresh one is not escalated', async () => {
    const overdue = await portalOpen(adultP, south.locationRef, 'Synthetic overdue question');
    const fresh = await portalOpen(adultP, south.locationRef, 'Synthetic fresh question');
    await backdate(overdue, 5);
    const before = await threadState(overdue);
    const w = await composeWorker(env(), { pools: pools() });
    const first = await w.tick();
    expect(first.errors).toStrictEqual([]);
    expect(first.replyEscalations).toBe(1);
    expect(await escalations(overdue)).toBe(1);
    expect(await escalations(fresh)).toBe(0);
    const second = await w.tick();
    expect(second.replyEscalations).toBe(0);
    expect(await escalations(overdue)).toBe(1);
    expect(await audits(overdue)).toStrictEqual([{ actor_id: W, tenant_id: T_ALPHA }]);
    // Escalation is not a read and not a reply: no receipt, the thread unchanged and still awaiting.
    expect(await threadState(overdue)).toStrictEqual({ ...before, receipts: 0 });
    expect(before).toMatchObject({ state: 'open', awaiting: 'practice' });
    // A staff reader then sees it escalated and still unread and needing a reply.
    const l = h.ok<{
      data: {
        items: { threadRef: string; unread: boolean; needsReply: boolean; escalatedAt: string | null }[];
      };
    }>(await h.call('a1', 'GET', '/v1/messaging/threads?filter=needs_reply')).data;
    expect(l.items.find((i) => i.threadRef === overdue)).toMatchObject({ unread: true, needsReply: true });
    expect(l.items.find((i) => i.threadRef === overdue)?.escalatedAt).not.toBeNull();
    expect(await escalations(overdue)).toBe(1);
  });

  it("each queue's own threshold applies: a longer billing policy holds back an episode the front desk would escalate", async () => {
    h.ok(
      await h.call('a1', 'POST', '/v1/messaging/reply-policies', {
        queue: 'billing',
        replyDueBusinessDays: 10,
      }),
      200,
    );
    const billing = await portalOpen(adultP, south.locationRef, 'Synthetic billing question', 'billing');
    const general = await portalOpen(adultP, south.locationRef, 'Synthetic general question');
    await backdate(billing, 6);
    await backdate(general, 6);
    const w = await composeWorker(env(), { pools: pools() });
    await w.tick();
    expect(await escalations(general)).toBe(1);
    expect(await escalations(billing)).toBe(0);
    await backdate(billing, 14);
    await w.tick();
    expect(await escalations(billing)).toBe(1);
  });

  it('concurrent workers escalate an episode once', async () => {
    const t = await portalOpen(adultP, south.locationRef, 'Synthetic concurrent question');
    await backdate(t, 5);
    const [a, b] = await Promise.all([
      composeWorker(env(), { pools: pools() }),
      composeWorker(env(), { pools: pools() }),
    ]);
    const reports = await Promise.all([a.tick(), b.tick()]);
    expect(reports.flatMap((r) => r.errors)).toStrictEqual([]);
    expect(await escalations(t)).toBe(1);
    expect(await audits(t)).toHaveLength(1);
  });

  it("a worker serving tenant A never escalates tenant B's overdue episode", async () => {
    const beta = await portalOpen(betaP, betaLoc.locationRef, 'Synthetic beta question', 'general', T_BETA);
    await backdate(beta, 5);
    const w = await composeWorker(env(), { pools: pools() });
    await w.tick();
    expect(await escalations(beta)).toBe(0);
    expect(await audits(beta)).toStrictEqual([]);
  });

  it('without communications.deliver the sweep is a recorded denial, never a bypass', async () => {
    const t = await portalOpen(adultP, south.locationRef, 'Synthetic revoked question');
    await backdate(t, 5);
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = array_remove(scopes, 'communications.deliver')
       WHERE principal_id = $1 AND tenant_id = $2`,
      [W, T_ALPHA],
    );
    try {
      const w = await composeWorker(env(), { pools: pools() });
      const r = await w.tick();
      expect(r.errors.map((e) => e.stage)).toContain('reply_escalation');
      expect(await escalations(t)).toBe(0);
    } finally {
      await db.admin.query(
        `UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY['communications.deliver']
         WHERE principal_id = $1 AND tenant_id = $2`,
        [W, T_ALPHA],
      );
    }
  });

  it('a revoked worker membership and a human principal configured as the worker are refused', async () => {
    const t = await portalOpen(adultP, south.locationRef, 'Synthetic revoked membership question');
    await backdate(t, 5);
    await db.admin.query(
      'UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1 AND tenant_id = $2',
      [W, T_ALPHA],
    );
    try {
      const w = await composeWorker(env(), { pools: pools() });
      const r = await w.tick();
      expect(r.errors.map((e) => e.stage)).toContain('reply_escalation');
      expect(await escalations(t)).toBe(0);
    } finally {
      await db.admin.query(
        'UPDATE cuspatlas.memberships SET revoked_at = NULL WHERE principal_id = $1 AND tenant_id = $2',
        [W, T_ALPHA],
      );
    }
    const human = await composeWorker(
      { ...env(), CUSPATLAS_WORKER_PRINCIPAL_ID: USER_A1 },
      { pools: pools() },
    );
    const r = await human.tick();
    expect(r.errors.map((e) => e.stage)).toContain('reply_escalation');
    expect(await escalations(t)).toBe(0);
    expect(await audits(t)).toStrictEqual([]);
  });
});
