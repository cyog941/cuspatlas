import { randomUUID } from 'node:crypto';
import type { ActorContext } from '@cuspatlas/contracts';
import { recordAccess, recordCommand } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentHandle, type AgentStack, startAgentStack } from './support/agent-stack';
import { T_ALPHA } from './support/fixtures';

/**
 * Clock audit review: audit rows of one transaction keep statement order. Committed-change and access
 * rows are stamped with `clock_timestamp()` (monotonic within a transaction, one clock for both
 * writers), and `audit_events.seq` (a database-assigned sequence) breaks any remaining instant tie in
 * the admin audit search, the agent-audit list and the agent session view, instead of a random UUID.
 */
let s: AgentStack;
const WS = ['agentWorkspace.read', 'agentWorkspace.write', 'syntheticTasks.read', 'syntheticTasks.write'];
const STEPS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

beforeAll(async () => {
  s = await startAgentStack('audit_order');
}, 120_000);
afterAll(async () => {
  await s?.close();
});

/** An agent with one session whose tool call names the correlation the session view reads by. */
async function agentWithSession(): Promise<{ a: AgentHandle; sessionRef: string; correlationId: string }> {
  const a = await s.createAgent(WS, 'audit order');
  const r = await s.agentTool(a, 'synthetic_tasks_list', {});
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
  const { rows } = await s.db.admin.query<{ session_ref: string; correlation_id: string }>(
    'SELECT session_ref, correlation_id FROM cuspatlas.agent_tool_calls WHERE agent_ref = $1',
    [a.agentRef],
  );
  return {
    a,
    sessionRef: rows[0]?.session_ref as string,
    correlationId: rows[0]?.correlation_id as string,
  };
}

const agentCtx = (a: AgentHandle, correlationId: string, sponsorRef: string): ActorContext => ({
  tenantId: T_ALPHA,
  actorId: a.agentRef,
  principal: 'service',
  scopes: WS,
  sessionId: randomUUID(),
  correlationId,
  agent: { agentRef: a.agentRef, sponsorRef },
});

/** The step operations, in the order each of the three readers returns them (oldest first). */
async function readers(a: AgentHandle, sessionRef: string): Promise<Record<string, string[]>> {
  const steps = (ops: string[]) => ops.filter((o) => o.startsWith('clockOrder.'));
  const search = await s.call(
    'humanAll',
    'GET',
    `/v1/admin/audit?source=committed_change&actorRef=${a.agentRef}`,
  );
  expect(search.status, JSON.stringify(search.body)).toBe(200);
  const list = await s.call('humanAll', 'GET', `/v1/agents/audit?agentRef=${a.agentRef}&limit=100`);
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  const session = await s.call('humanAll', 'GET', `/v1/agents/sessions/state?sessionRef=${sessionRef}`);
  expect(session.status, JSON.stringify(session.body)).toBe(200);
  return {
    // Newest first: reversed to compare in statement order.
    adminSearch: steps((search.body.data as { operation: string }[]).map((e) => e.operation).reverse()),
    agentAudit: steps((list.body.data as { operation: string }[]).map((e) => e.operation)),
    sessionView: steps(
      ((session.body.data as { auditEvents: { operation: string }[] }).auditEvents ?? []).map(
        (e) => e.operation,
      ),
    ),
  };
}

const sponsorOf = async (a: AgentHandle) =>
  (
    await s.db.admin.query<{ sponsor_ref: string }>(
      `SELECT s.sponsor_ref FROM cuspatlas.agent_principals a
       JOIN cuspatlas.agent_sponsorships s ON s.id = a.sponsorship_ref WHERE a.principal_id = $1`,
      [a.agentRef],
    )
  ).rows[0]?.sponsor_ref as string;

describe('audit statement order within one transaction (clock audit review)', () => {
  it('interleaved recordCommand and recordAccess rows come back in statement order from every reader', async () => {
    const { a, sessionRef, correlationId } = await agentWithSession();
    const ctx = agentCtx(a, correlationId, await sponsorOf(a));
    const ref = randomUUID();
    await s.tenantTransactions(ctx, async (tx) => {
      for (const [i, step] of STEPS.entries()) {
        if (i % 2 === 0)
          await recordCommand(
            tx,
            {
              operation: `clockOrder.step${step}`,
              resourceType: 'clockOrder',
              resourceRef: ref,
              resourceVersion: i + 1,
            },
            { changedFields: ['state'] },
          );
        else await recordAccess(tx, `clockOrder.step${step}`, 'clockOrder', ref, i + 1);
      }
    });
    const expected = STEPS.map((x) => `clockOrder.step${x}`);
    expect(await readers(a, sessionRef)).toStrictEqual({
      adminSearch: expected,
      agentAudit: expected,
      sessionView: expected,
    });
  });

  it('rows with the same instant keep insertion order (the sequence, never the event reference)', async () => {
    const { a, sessionRef, correlationId } = await agentWithSession();
    const ref = randomUUID();
    // Event references descending, so a UUID tie-breaker would return the reverse of insertion order.
    const refs = STEPS.map((_, i) => `ffffffff-0000-4000-8000-${String(99 - i).padStart(12, '0')}`);
    const at = (
      await s.db.admin.query<{ at: Date }>(`SELECT date_trunc('milliseconds', clock_timestamp()) AS at`)
    ).rows[0]?.at;
    for (const [i, step] of STEPS.entries()) {
      await s.db.admin.query(
        `INSERT INTO cuspatlas.audit_events (event_ref, event_version, tenant_id, actor_id, principal, operation,
           resource_type, resource_ref, resource_version, correlation_id, trace_id, span_id, occurred_at)
         VALUES ($1, 1, $2, $3, 'service', $4, 'clockOrder', $5, $6, $7, $8, $9, $10)`,
        [
          refs[i],
          T_ALPHA,
          a.agentRef,
          `clockOrder.step${step}`,
          ref,
          i + 1,
          correlationId,
          correlationId.replaceAll('-', ''),
          '0123456789abcdef',
          at,
        ],
      );
    }
    const expected = STEPS.map((x) => `clockOrder.step${x}`);
    expect(await readers(a, sessionRef)).toStrictEqual({
      adminSearch: expected,
      agentAudit: expected,
      sessionView: expected,
    });
  });

  it('the sequence is assigned by the database and never changes', async () => {
    const { a, correlationId } = await agentWithSession();
    const ctx = agentCtx(a, correlationId, await sponsorOf(a));
    const ref = randomUUID();
    await s.tenantTransactions(ctx, (tx) =>
      recordCommand(
        tx,
        { operation: 'clockOrder.stepa', resourceType: 'clockOrder', resourceRef: ref, resourceVersion: 1 },
        { changedFields: ['state'] },
      ),
    );
    const row = await s.db.admin.query<{ seq: string; copied: string }>(
      `SELECT a.seq::text, g.seq::text AS copied FROM cuspatlas.audit_events a
       JOIN cuspatlas.agent_audit_events g ON g.event_ref = a.event_ref WHERE a.resource_ref = $1`,
      [ref],
    );
    expect(row.rows[0]?.seq).toMatch(/^\d+$/);
    expect(row.rows[0]?.copied).toBe(row.rows[0]?.seq);
    const code = (sql: string, v: unknown[]) =>
      s.db.admin.query(sql, v).then(
        () => 'ok',
        (e: { code?: string }) => e.code,
      );
    expect(
      await code('UPDATE cuspatlas.audit_events SET seq = seq + 1000 WHERE resource_ref = $1', [ref]),
    ).toBe('42501');
    expect(
      await code('UPDATE cuspatlas.agent_audit_events SET seq = seq + 1000 WHERE resource_ref = $1', [ref]),
    ).toBe('42501');
    // A caller-chosen sequence is ignored, even with the restore-load flag set (the runtime role does
    // not bypass RLS): the database assigns the next value.
    const forged = randomUUID();
    // A raw runtime-role connection (the domain runner refuses set_config), tenant context as the runner sets it.
    const c = await s.db.app.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true),
           set_config('cuspatlas.restore_load', 'on', true)`,
        [T_ALPHA, a.agentRef],
      );
      await c.query(
        `INSERT INTO cuspatlas.audit_events (event_ref, event_version, tenant_id, actor_id, principal, operation,
           resource_type, resource_ref, resource_version, correlation_id, trace_id, span_id, occurred_at, seq)
         VALUES (gen_random_uuid(), 1, cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), 'service',
           'clockOrder.stepb', 'clockOrder', $1, 1, $2, $3, '0123456789abcdef', clock_timestamp(), 1)`,
        [forged, correlationId, correlationId.replaceAll('-', '')],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const f = await s.db.admin.query<{ later: boolean }>(
      `SELECT (SELECT seq FROM cuspatlas.audit_events WHERE resource_ref = $1)
         > (SELECT seq FROM cuspatlas.audit_events WHERE resource_ref = $2) AS later`,
      [forged, ref],
    );
    expect(f.rows[0]?.later).toBe(true);
  });
});
