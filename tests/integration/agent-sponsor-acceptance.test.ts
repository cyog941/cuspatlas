import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentHandle, type AgentStack, SPONSOR, startAgentStack } from './support/agent-stack';
import { T_ALPHA } from './support/fixtures';

/**
 * H3 item 3c: a sponsor change is an offer the named human must accept. Until acceptance the old
 * sponsor stays in force; a declined, superseded or expired offer changes nothing; the database refuses
 * any sponsorship change that is not backed by an accepted offer. Synthetic data only.
 */
let s: AgentStack;
const SCOPES = ['syntheticTasks.read', 'syntheticTasks.write'];

beforeAll(async () => {
  s = await startAgentStack('agent_sponsor_offer');
}, 120_000);
afterAll(async () => {
  await s?.close();
});

async function human(handle: string, scopes: readonly string[] = SCOPES): Promise<string> {
  const { rows } = await s.db.admin.query<{ id: string }>(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES (gen_random_uuid(), 'human', $1) RETURNING id`,
    [`${handle}-${randomUUID().slice(0, 8)}`],
  );
  const id = rows[0]?.id as string;
  await s.db.admin.query(
    'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)',
    [T_ALPHA, id, scopes],
  );
  return id;
}
const sponsorOf = async (a: AgentHandle) =>
  (
    await s.db.admin.query<{ sponsor_ref: string }>(
      `SELECT s.sponsor_ref FROM cuspatlas.agent_principals a
       JOIN cuspatlas.agent_sponsorships s ON s.id = a.sponsorship_ref WHERE a.principal_id = $1`,
      [a.agentRef],
    )
  ).rows[0]?.sponsor_ref;
const offer = (a: AgentHandle, sponsorRef: string) =>
  s.call('humanAll', 'POST', '/v1/agents/sponsors/change', {
    agentRef: a.agentRef,
    sponsorRef,
    expectedVersion: a.version,
  });
const offerRefOf = (r: { body: Record<string, unknown> }) => (r.body.data as { offerRef: string }).offerRef;
const decide = (who: string, verb: 'accept' | 'decline', offerRef: string) =>
  s.call(who, 'POST', `/v1/agents/sponsors/${verb}`, { offerRef });

describe('3c sponsor change requires acceptance', () => {
  it('a change creates a pending offer; the old sponsor stays until the named human accepts', async () => {
    const a = await s.createAgent(SCOPES, 'offer then accept');
    const next = await human('offer-accept');
    const r = await offer(a, next);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ offerState: 'pending', sponsorRef: SPONSOR });
    expect(await sponsorOf(a)).toBe(SPONSOR);
    await s.agentTool(a, 'synthetic_tasks_create', { label: 'old sponsor', idempotencyKey: randomUUID() });
    // Only the named human can accept: the manager who made the offer cannot.
    expect((await decide('humanAll', 'accept', offerRefOf(r))).status).toBe(404);
    const ok = await decide(next, 'accept', offerRefOf(r));
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ offerState: 'accepted', sponsorRef: next });
    expect(ok.body.version).toBe(a.version + 1);
    expect(await sponsorOf(a)).toBe(next);
    await s.agentTool(a, 'synthetic_tasks_create', { label: 'new sponsor', idempotencyKey: randomUUID() });
    const { rows } = await s.db.admin.query<{ sponsor_ref: string }>(
      `SELECT sponsor_ref FROM cuspatlas.agent_audit_events
       WHERE agent_ref = $1 AND operation = 'syntheticTasks.create' ORDER BY occurred_at`,
      [a.agentRef],
    );
    expect(rows.map((x) => x.sponsor_ref)).toStrictEqual([SPONSOR, next]);
    expect((await decide(next, 'decline', offerRefOf(r))).status).toBe(409);
  });

  it('a declined offer changes nothing and cannot be accepted later', async () => {
    const a = await s.createAgent(SCOPES, 'offer then decline');
    const next = await human('offer-decline');
    const r = await offer(a, next);
    const d = await decide(next, 'decline', offerRefOf(r));
    expect(d.status).toBe(200);
    expect(d.body.data).toMatchObject({ offerState: 'declined', sponsorRef: SPONSOR });
    expect(await sponsorOf(a)).toBe(SPONSOR);
    expect((await decide(next, 'accept', offerRefOf(r))).status).toBe(409);
  });

  it('an expired offer cannot be accepted', async () => {
    const a = await s.createAgent(SCOPES, 'offer expires');
    const next = await human('offer-expire');
    const r = await offer(a, next);
    await s.db.admin.query(
      `UPDATE cuspatlas.agent_sponsor_offers SET offered_at = now() - interval '9 days',
         expires_at = now() - interval '1 second' WHERE id = $1`,
      [offerRefOf(r)],
    );
    const late = await decide(next, 'accept', offerRefOf(r));
    expect(late.status).toBe(409);
    expect((late.body.detail as { reason: string }).reason).toBe('offer_expired');
    expect(await sponsorOf(a)).toBe(SPONSOR);
  });

  it('a newer offer supersedes the pending one', async () => {
    const a = await s.createAgent(SCOPES, 'offer superseded');
    const first = await human('offer-first');
    const second = await human('offer-second');
    const r1 = await offer(a, first);
    const r2 = await offer(a, second);
    expect(r2.status).toBe(200);
    expect((await decide(first, 'accept', offerRefOf(r1))).status).toBe(409);
    expect((await decide(second, 'accept', offerRefOf(r2))).status).toBe(200);
    expect(await sponsorOf(a)).toBe(second);
  });

  it('the offered human must still qualify at acceptance; an agent or another tenant cannot accept', async () => {
    const a = await s.createAgent(SCOPES, 'offer to unqualified');
    const next = await human('offer-unqualified');
    const r = await offer(a, next);
    await s.db.admin.query('UPDATE cuspatlas.memberships SET scopes = $2 WHERE principal_id = $1', [
      next,
      ['syntheticTasks.read'],
    ]);
    expect((await decide(next, 'accept', offerRefOf(r))).status).toBe(422);
    expect(await sponsorOf(a)).toBe(SPONSOR);
    const viaAgent = await s.agentTool(a, 'agents_sponsors_accept', {
      offerRef: offerRefOf(r),
      idempotencyKey: randomUUID(),
    });
    expect(viaAgent.isError).toBe(true);
    expect((await decide('humanBeta', 'accept', offerRefOf(r))).status).toBe(404);
  });

  it('the database refuses a sponsorship change without an accepted offer', async () => {
    const a = await s.createAgent(SCOPES, 'db guard');
    const next = await human('db-guard');
    const { rows } = await s.db.admin.query<{ id: string }>(
      `INSERT INTO cuspatlas.agent_sponsorships (tenant_id, agent_ref, sponsor_ref, recorded_by)
       VALUES ($1, $2, $3, $3) RETURNING id`,
      [T_ALPHA, a.agentRef, next],
    );
    await expect(
      s.db.admin.query('UPDATE cuspatlas.agent_principals SET sponsorship_ref = $2 WHERE principal_id = $1', [
        a.agentRef,
        rows[0]?.id,
      ]),
    ).rejects.toThrow(/accepted sponsor offer/);
    expect(await sponsorOf(a)).toBe(SPONSOR);
  });
});
