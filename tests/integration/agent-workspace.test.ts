import { randomUUID } from 'node:crypto';
import { createAuthorize } from '@cuspatlas/domain';
import { composeWorker, createAgentTaskRunner } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentHandle,
  type AgentStack,
  catalog,
  inDays,
  SPONSOR,
  startAgentStack,
} from './support/agent-stack';
import { M_SERVICE_ALL, MCP_AUDIENCE } from './support/catalog-stack';
import { T_ALPHA } from './support/fixtures';
import { patientBody } from './support/patient-fixtures';

/**
 * A23 (OR-13) agent workspace: sessions with tool-call history (references to agent_tool_calls and
 * the agent-audit stream, never copies), tenant-bound scoped memory with a PHI policy (default deny),
 * retention, deletion and audited, budgeted reads, and scheduled tasks bound to a live revocable
 * standing policy, executed by the worker through the same MCP admission and authorization path.
 * Synthetic data only.
 */
let s: AgentStack;
const WS = ['agentWorkspace.read', 'agentWorkspace.write', 'syntheticTasks.read', 'syntheticTasks.write'];
const key = () => randomUUID();

beforeAll(async () => {
  s = await startAgentStack('agent_workspace');
}, 120_000);
afterAll(async () => {
  await s?.close();
});

async function principal(kind: 'human' | 'service', scopes: readonly string[]): Promise<string> {
  const { rows } = await s.db.admin.query<{ id: string }>(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
    [kind, `ws-${kind}-${randomUUID().slice(0, 8)}`],
  );
  const id = rows[0]?.id as string;
  await s.db.admin.query(
    'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)',
    [T_ALPHA, id, scopes],
  );
  return id;
}
// Closeout D5: a non-phi note is a structured kind (here a code); a phi note is free text.
const write = (a: AgentHandle, k: string, value: string, classification = 'operational') =>
  s.agentTool(a, 'agents_memory_write', {
    key: k,
    value,
    classification,
    ...(classification === 'phi' ? {} : { kind: 'code' }),
    idempotencyKey: key(),
  });
const reason = (r: { body: Record<string, unknown> }) => (r.body.detail as { reason?: string })?.reason;

describe('A23 sessions', () => {
  it('tool calls open one session per consent; the session references its calls and audit events', async () => {
    const a = await s.createAgent(WS, 'session history');
    const client = await s.agentClient(a.agentRef, a.credentialRef);
    await s.agentCall(client, 'synthetic_tasks_create', { label: 'in session', idempotencyKey: key() });
    await s.agentCall(client, 'synthetic_tasks_list', {});
    const mine = await s.agentCall(client, 'agents_sessions_list', {});
    expect(mine.isError, JSON.stringify(mine.body)).toBe(false);
    const items = mine.body.data as { sessionRef: string; state: string; callCount: number }[];
    expect(items).toHaveLength(1);
    expect(items[0]?.state).toBe('open');
    expect(mine.body).toMatchObject({ envelope: { ordering: { key: 'startedAt' }, count: { exact: 1 } } });
    const read = await s.call(
      'humanAll',
      'GET',
      `/v1/agents/sessions/state?sessionRef=${items[0]?.sessionRef}`,
    );
    expect(read.status).toBe(200);
    const d = read.body.data as {
      toolCalls: { callRef: string; operation: string }[];
      auditEvents: { eventRef: string; operation: string }[];
    };
    expect(d.toolCalls.map((c) => c.operation)).toStrictEqual([
      'syntheticTasks.create',
      'syntheticTasks.list',
      'agents.sessions.list',
    ]);
    const calls = await s.db.admin.query<{ id: string }>(
      'SELECT id FROM cuspatlas.agent_tool_calls WHERE session_ref = $1 ORDER BY occurred_at',
      [items[0]?.sessionRef],
    );
    expect(d.toolCalls.map((c) => c.callRef)).toStrictEqual(calls.rows.map((r) => r.id));
    expect(d.auditEvents.map((e) => e.operation)).toContain('syntheticTasks.create');
    const audit = await s.db.admin.query('SELECT 1 FROM cuspatlas.agent_audit_events WHERE event_ref = $1', [
      d.auditEvents[0]?.eventRef,
    ]);
    expect(audit.rowCount).toBe(1);
  });

  it('an agent ends its session; the next call opens a new one; a revoked consent ends the session', async () => {
    const a = await s.createAgent(WS, 'session end');
    await s.agentTool(a, 'synthetic_tasks_list', {});
    const first = (await s.agentTool(a, 'agents_sessions_list', {})).body.data as { sessionRef: string }[];
    const end = await s.agentTool(a, 'agents_sessions_end', {
      sessionRef: first[0]?.sessionRef,
      idempotencyKey: key(),
    });
    expect(end.isError, JSON.stringify(end.body)).toBe(false);
    expect(end.body.data).toMatchObject({ state: 'ended', endReason: 'ended_by_agent' });
    await s.agentTool(a, 'synthetic_tasks_list', {});
    const listed = await s.call('humanAll', 'GET', `/v1/agents/sessions?agentRef=${a.agentRef}`);
    expect((listed.body.data as { state: string }[]).map((x) => x.state).sort()).toStrictEqual([
      'ended',
      'open',
    ]);
    const consent = await s.db.admin.query<{ id: string }>(
      'SELECT id FROM cuspatlas.agent_consents WHERE agent_ref = $1',
      [a.agentRef],
    );
    await s.call('humanAll', 'POST', '/v1/agents/consents/revoke', {
      consentRef: consent.rows[0]?.id,
      expectedVersion: 1,
    });
    const after = await s.call('humanAll', 'GET', `/v1/agents/sessions?agentRef=${a.agentRef}`);
    expect((after.body.data as { endReason: string }[]).map((x) => x.endReason).sort()).toStrictEqual([
      'consent_ended',
      'ended_by_agent',
    ]);
  });

  it('another agent, a non-sponsor, another tenant and a display principal cannot read a session', async () => {
    const a = await s.createAgent(WS, 'session owner');
    const b = await s.createAgent(WS, 'session other');
    await s.agentTool(a, 'synthetic_tasks_list', {});
    const sessionRef = (
      await s.db.admin.query<{ id: string }>('SELECT id FROM cuspatlas.agent_sessions WHERE agent_ref = $1', [
        a.agentRef,
      ])
    ).rows[0]?.id as string;
    expect((await s.agentTool(b, 'agents_sessions_get', { sessionRef })).body.code).toBe('not_found');
    const bList = await s.agentTool(b, 'agents_sessions_list', { agentRef: a.agentRef });
    expect(bList.body.code).toBe('not_found');
    const stranger = await principal('human', ['agentWorkspace.read']);
    const q = `/v1/agents/sessions/state?sessionRef=${sessionRef}`;
    expect((await s.call(stranger, 'GET', q)).status).toBe(404);
    expect((await s.call('humanBeta', 'GET', q)).status).toBe(404);
    const display = await principal('service', ['display.shared', 'agentWorkspace.read']);
    const r = await s.call(display, 'GET', `/v1/agents/sessions?agentRef=${a.agentRef}`);
    expect(r.status).toBe(403);
  });
});

describe('A23 scoped memory', () => {
  it('an agent writes and reads its own note; both are audited in the agent stream and charged', async () => {
    const a = await s.createAgent(WS, 'memory basics');
    const w = await write(a, 'recall.window', 'morning.batch');
    expect(w.isError, JSON.stringify(w.body)).toBe(false);
    expect(w.body.data).toMatchObject({ key: 'recall.window', classification: 'operational' });
    const exp = Date.parse((w.body.data as { expiresAt: string }).expiresAt);
    expect(Math.round((exp - Date.now()) / 86_400_000)).toBe(30);
    const r = await s.agentTool(a, 'agents_memory_get', { key: 'recall.window' });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect((r.body.data as { value: string }).value).toBe('morning.batch');
    const audit = await s.db.admin.query<{ operation: string }>(
      `SELECT operation FROM cuspatlas.agent_audit_events WHERE agent_ref = $1 AND operation LIKE 'agents.memory.%'
       ORDER BY occurred_at`,
      [a.agentRef],
    );
    expect(audit.rows.map((x) => x.operation)).toStrictEqual(['agents.memory.write', 'agents.memory.read']);
    const calls = await s.db.admin.query<{ records: number }>(
      "SELECT records FROM cuspatlas.agent_tool_calls WHERE agent_ref = $1 AND operation = 'agents.memory.read'",
      [a.agentRef],
    );
    expect(calls.rows[0]?.records).toBeGreaterThanOrEqual(1);
    const listed = await s.agentTool(a, 'agents_memory_list', {});
    expect(listed.body).toMatchObject({
      envelope: { count: { exact: 1 } },
      phiPolicy: { phiAllowed: false },
    });
    expect(JSON.stringify(listed.body.data)).not.toContain('morning.batch');
  });

  it('PHI is refused (one uniform refusal): a phi classification, contacts, DOB phrases, patient refs and names', async () => {
    const a = await s.createAgent([...WS, 'patients.write'], 'memory phi');
    const created = await s.agentTool(a, 'patients_create', {
      ...patientBody('Quillon'),
      idempotencyKey: key(),
    });
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    const patientRef = (created.body.data as { patientRef: string }).patientRef;
    const phi = await write(a, 'k.phi', 'anything', 'phi');
    expect(phi.body.code).toBe('validation_failed');
    expect(reason(phi)).toBe('memory_value_refused');
    const legal = patientBody('Quillon').legalName as { given: string; family: string };
    for (const value of [
      'Call back at 555-201-3344 tomorrow',
      'Send to someone@example.test',
      'DOB: 1980-02-03',
      `About patient ${patientRef}`,
      `Follow up with ${legal.given} ${legal.family} next week`,
    ]) {
      const r = await write(a, 'k.detect', value);
      expect(r.body.code, value).toBe('validation_failed');
      expect(reason(r), value).toBe('memory_value_refused');
    }
    // An explicit per-tenant policy admits PHI only when classified as phi.
    const set = await s.call('humanAll', 'POST', '/v1/agents/memory/policy', { phiAllowed: true });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const unlabelled = await write(a, 'k.name', `Follow up with ${legal.given} ${legal.family}`);
    expect(reason(unlabelled)).toBe('memory_value_refused');
    const labelled = await write(a, 'k.name', `Follow up with ${legal.given} ${legal.family}`, 'phi');
    expect(labelled.isError, JSON.stringify(labelled.body)).toBe(false);
    const read = await s.agentTool(a, 'agents_memory_get', { key: 'k.name' });
    expect(read.isError).toBe(false);
    const charged = await s.db.admin.query<{ phi_fields: number }>(
      `SELECT phi_fields FROM cuspatlas.agent_tool_calls WHERE agent_ref = $1 AND operation = 'agents.memory.read'`,
      [a.agentRef],
    );
    expect(charged.rows[0]?.phi_fields).toBeGreaterThanOrEqual(1);
    expect((await s.call('humanAll', 'POST', '/v1/agents/memory/policy', { phiAllowed: false })).status).toBe(
      200,
    );
    // The database refuses a phi row while the tenant policy denies PHI, whoever writes it.
    await expect(
      s.db.admin.query(
        `INSERT INTO cuspatlas.agent_memory_entries (tenant_id, agent_ref, key, value, classification, expires_at)
         VALUES ($1, $2, 'k.direct', 'x', 'phi', now() + interval '1 day')`,
        [T_ALPHA, a.agentRef],
      ),
    ).rejects.toThrow(/phi_not_permitted/);
  });

  it('other agents, non-sponsors, another tenant and a display principal cannot reach the memory', async () => {
    const a = await s.createAgent(WS, 'memory owner');
    const b = await s.createAgent(WS, 'memory other');
    await write(a, 'private.note', 'owner.only');
    expect(
      (await s.agentTool(b, 'agents_memory_get', { agentRef: a.agentRef, key: 'private.note' })).body.code,
    ).toBe('not_found');
    expect((await s.agentTool(b, 'agents_memory_list', { agentRef: a.agentRef })).body.code).toBe(
      'not_found',
    );
    expect(((await s.agentTool(b, 'agents_memory_list', {})).body.data as unknown[]).length).toBe(0);
    const q = `/v1/agents/memory/entry?agentRef=${a.agentRef}&key=private.note`;
    const sponsor = await s.call('humanAll', 'GET', q);
    expect(sponsor.status).toBe(200);
    expect((sponsor.body.data as { value: string }).value).toBe('owner.only');
    const stranger = await principal('human', ['agentWorkspace.read']);
    expect((await s.call(stranger, 'GET', q)).status).toBe(404);
    expect((await s.call('humanBeta', 'GET', q)).status).toBe(404);
    const display = await principal('service', ['display.shared', 'agentWorkspace.read']);
    expect((await s.call(display, 'GET', q)).status).toBe(403);
    // A human sponsor read is a sensitive read; never an agent-stream row.
    const sr = await s.db.admin.query(
      `SELECT 1 FROM cuspatlas.sensitive_read_events WHERE actor_id = $1 AND operation = 'agents.memory.read'`,
      [SPONSOR],
    );
    expect(sr.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('the sponsor or an agent manager deletes a note; an agent and a stranger cannot; expired notes vanish', async () => {
    const a = await s.createAgent(WS, 'memory delete');
    await write(a, 'to.delete', 'short.lived');
    await write(a, 'to.expire', 'expires');
    const del = { agentRef: a.agentRef, key: 'to.delete' };
    const stranger = await principal('human', ['agentWorkspace.read']);
    expect((await s.call(stranger, 'POST', '/v1/agents/memory/delete', del)).status).toBe(404);
    const viaAgent = await s.agentTool(a, 'agents_memory_delete', { ...del, idempotencyKey: key() });
    expect(viaAgent.body.code).toBe('forbidden');
    const ok = await s.call('humanAll', 'POST', '/v1/agents/memory/delete', del);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await s.agentTool(a, 'agents_memory_get', { key: 'to.delete' })).body.code).toBe('not_found');
    await s.db.admin.query(
      `UPDATE cuspatlas.agent_memory_entries SET created_at = now() - interval '20 days',
         updated_at = now() - interval '20 days', expires_at = now() - interval '1 minute'
       WHERE agent_ref = $1 AND key = 'to.expire'`,
      [a.agentRef],
    );
    expect((await s.agentTool(a, 'agents_memory_get', { key: 'to.expire' })).body.code).toBe('not_found');
    await s.agentTool(a, 'agents_memory_list', {});
    const left = await s.db.admin.query('SELECT 1 FROM cuspatlas.agent_memory_entries WHERE agent_ref = $1', [
      a.agentRef,
    ]);
    expect(left.rowCount).toBe(0);
    const audit = await s.db.admin.query(
      `SELECT 1 FROM cuspatlas.audit_events WHERE operation = 'agents.memory.delete' AND actor_id = $1`,
      [SPONSOR],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('memory reads count toward the record budget', async () => {
    const a = await s.createAgent(WS, 'memory budget', undefined, { consent: false });
    await s.consent(a, ['agents.memory.write', 'agents.memory.read'], { recordsPerPeriod: 3 });
    await write(a, 'b.one', 'one');
    expect((await s.agentTool(a, 'agents_memory_get', { key: 'b.one' })).isError).toBe(false);
    expect((await s.agentTool(a, 'agents_memory_get', { key: 'b.one' })).isError).toBe(false);
    const third = await s.agentTool(a, 'agents_memory_get', { key: 'b.one' });
    expect(third.body.code).toBe('rate_limited');
  });
});

describe('A23 scheduled tasks', () => {
  it('the dispatch action is the worker principal only, never an MCP or REST operation', () => {
    const dispatch = catalog.find((o) => o.operation === 'agents.tasks.dispatch');
    expect(dispatch).toMatchObject({
      principals: ['service'],
      transports: ['worker'],
      scope: 'outbox.deliver',
    });
  });

  const runner = () =>
    createAgentTaskRunner({
      workerPrincipalId: M_SERVICE_ALL,
      authorize: createAuthorize(s.membership),
      memberships: s.membership,
      agents: s.agents,
      invoker: s.agentToolInvoker,
    });
  const policy = (a: AgentHandle, operations: string[], extra: Record<string, unknown> = {}) =>
    s.call('humanAll', 'POST', '/v1/agents/task-policies', {
      agentRef: a.agentRef,
      deployment: MCP_AUDIENCE,
      operations,
      minIntervalSeconds: 60,
      maxRunsPerDay: 24,
      expiresAt: inDays(5),
      ...extra,
    });
  const schedule = (
    a: AgentHandle,
    policyRef: string,
    operation: string,
    args: Record<string, unknown> = {},
  ) =>
    s.agentTool(a, 'agents_tasks_schedule', {
      policyRef,
      operation,
      arguments: args,
      intervalSeconds: 3600,
      idempotencyKey: key(),
    });
  const due = (taskRef: string) =>
    s.db.admin.query(
      "UPDATE cuspatlas.agent_scheduled_tasks SET next_run_at = now() - interval '1 second' WHERE id = $1",
      [taskRef],
    );
  const runsOf = async (taskRef: string) =>
    (
      await s.db.admin.query<{ outcome: string; correlation_id: string }>(
        'SELECT outcome, correlation_id FROM cuspatlas.agent_task_runs WHERE task_ref = $1 ORDER BY started_at',
        [taskRef],
      )
    ).rows;
  const taskOf = (r: { body: Record<string, unknown> }) => (r.body.data as { taskRef: string }).taskRef;
  const policyOf = (r: { body: Record<string, unknown> }) => (r.body.data as { policyRef: string }).policyRef;

  it('a standing policy admits only reads and proposal preparation, never direct or human-only commands', async () => {
    const a = await s.createAgent([...WS, 'actions.prepare'], 'task policy rules');
    expect((await policy(a, ['syntheticTasks.list', 'actions.proposals.prepare'])).status).toBe(201);
    const direct = await policy(a, ['syntheticTasks.create']);
    expect(direct.status).toBe(422);
    expect(reason(direct)).toBe('task_operation_not_permitted');
    const human = await policy(a, ['agents.principals.create']);
    expect(human.status).toBe(422);
    const viaAgent = await s.agentTool(a, 'agents_task_policies_record', {
      agentRef: a.agentRef,
      deployment: MCP_AUDIENCE,
      operations: ['syntheticTasks.list'],
      minIntervalSeconds: 60,
      maxRunsPerDay: 24,
      expiresAt: inDays(5),
      idempotencyKey: key(),
    });
    expect(viaAgent.body.code).toBe('forbidden');
  });

  it('an agent schedules only operations its live policy names; a human-only operation is refused', async () => {
    const a = await s.createAgent(WS, 'task schedule rules');
    const p = policyOf(await policy(a, ['syntheticTasks.list']));
    const ok = await schedule(a, p, 'syntheticTasks.list');
    expect(ok.isError, JSON.stringify(ok.body)).toBe(false);
    const human = await schedule(a, p, 'agents.principals.create');
    expect(human.body.code).toBe('forbidden');
    const outside = await schedule(a, p, 'syntheticTasks.create');
    expect(reason(outside)).toBe('task_operation_not_in_policy');
    const b = await s.createAgent(WS, 'task other agent');
    expect((await schedule(b, p, 'syntheticTasks.list')).body.code).toBe('not_found');
    const listed = await s.call('humanAll', 'GET', `/v1/agents/tasks?agentRef=${a.agentRef}`);
    expect(listed.status).toBe(200);
    expect((listed.body.envelope as { count: unknown }).count).toStrictEqual({ exact: 1 });
  });

  it('the worker runs a due task through MCP admission and records the outcome', async () => {
    const a = await s.createAgent(WS, 'task runs');
    const p = policyOf(await policy(a, ['syntheticTasks.list']));
    const t = taskOf(await schedule(a, p, 'syntheticTasks.list'));
    expect(await runner().runDue(T_ALPHA)).toStrictEqual([]);
    await due(t);
    const report = await runner().runDue(T_ALPHA);
    expect(report).toStrictEqual([{ taskRef: t, outcome: 'ok' }]);
    const runs = await runsOf(t);
    expect(runs.map((r) => r.outcome)).toStrictEqual(['ok']);
    const call = await s.db.admin.query<{ outcome: string }>(
      'SELECT outcome FROM cuspatlas.agent_tool_calls WHERE correlation_id = $1 AND agent_ref = $2',
      [runs[0]?.correlation_id, a.agentRef],
    );
    expect(call.rows.map((r) => r.outcome)).toStrictEqual(['ok']);
    const listed = await s.agentTool(a, 'agents_task_runs_list', { taskRef: t });
    expect((listed.body.data as { outcome: string }[]).map((r) => r.outcome)).toStrictEqual(['ok']);
    // Not due again until its interval passes.
    expect(await runner().runDue(T_ALPHA)).toStrictEqual([]);
  });

  it('the composed worker runs due tasks on its tick and purges expired memory', async () => {
    const a = await s.createAgent(WS, 'task composed worker');
    const t = taskOf(
      await schedule(a, policyOf(await policy(a, ['syntheticTasks.list'])), 'syntheticTasks.list'),
    );
    await write(a, 'purge.me', 'old');
    await s.db.admin.query(
      `UPDATE cuspatlas.agent_memory_entries SET created_at = now() - interval '20 days',
         updated_at = now() - interval '20 days', expires_at = now() - interval '1 minute' WHERE agent_ref = $1`,
      [a.agentRef],
    );
    await due(t);
    const w = await composeWorker(
      {
        CUSPATLAS_ENV: 'synthetic-test',
        CUSPATLAS_WORKER_PRINCIPAL_ID: M_SERVICE_ALL,
        CUSPATLAS_WORKER_TENANT_IDS: T_ALPHA,
      },
      {
        pools: { app: s.db.app, attempts: s.db.sink, maintenance: s.db.admin },
        agentTools: s.agentToolInvoker,
      },
    );
    try {
      expect(w.disabled.map((d) => d.consumer)).not.toContain('agentTasks');
      const report = await w.tick();
      expect(report.agentTasks).toContainEqual({ taskRef: t, outcome: 'ok' });
      expect(report.maintenance?.agentMemoryPurged).toBeGreaterThanOrEqual(1);
    } finally {
      await w.close();
    }
  });

  it('revoking or expiring the policy stops the task at execution', async () => {
    const a = await s.createAgent(WS, 'task revoked');
    const pr = await policy(a, ['syntheticTasks.list']);
    const t = taskOf(await schedule(a, policyOf(pr), 'syntheticTasks.list'));
    const rev = await s.call('humanAll', 'POST', '/v1/agents/task-policies/revoke', {
      policyRef: policyOf(pr),
      expectedVersion: 1,
    });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    await due(t);
    expect(await runner().runDue(T_ALPHA)).toStrictEqual([{ taskRef: t, outcome: 'policy_revoked' }]);
    const state = await s.db.admin.query<{ state: string }>(
      'SELECT state FROM cuspatlas.agent_scheduled_tasks WHERE id = $1',
      [t],
    );
    expect(state.rows[0]?.state).toBe('stopped');
    const calls = await s.db.admin.query(
      "SELECT 1 FROM cuspatlas.agent_tool_calls WHERE agent_ref = $1 AND operation = 'syntheticTasks.list'",
      [a.agentRef],
    );
    expect(calls.rowCount).toBe(0);
    await due(t);
    expect(await runner().runDue(T_ALPHA)).toStrictEqual([]);

    const b = await s.createAgent(WS, 'task policy expired');
    const pb = policyOf(await policy(b, ['syntheticTasks.list']));
    const tb = taskOf(await schedule(b, pb, 'syntheticTasks.list'));
    await s.db.admin.query(
      `UPDATE cuspatlas.agent_task_policies SET created_at = now() - interval '2 days',
         expires_at = now() - interval '1 second' WHERE id = $1`,
      [pb],
    );
    await due(tb);
    expect(await runner().runDue(T_ALPHA)).toStrictEqual([{ taskRef: tb, outcome: 'policy_expired' }]);
  });

  it('an expired consent and an exhausted budget refuse the run through the MCP gate', async () => {
    const a = await s.createAgent(WS, 'task consent expired');
    const t = taskOf(
      await schedule(a, policyOf(await policy(a, ['syntheticTasks.list'])), 'syntheticTasks.list'),
    );
    await s.db.admin.query(
      `UPDATE cuspatlas.agent_consents SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 second'
       WHERE agent_ref = $1`,
      [a.agentRef],
    );
    await due(t);
    expect(await runner().runDue(T_ALPHA)).toStrictEqual([{ taskRef: t, outcome: 'forbidden' }]);
    expect(s.attempts.some((x) => x.actorId === a.agentRef && x.reasonCode === 'consent_missing')).toBe(true);

    const b = await s.createAgent(WS, 'task budget', undefined, { consent: false });
    await s.consent(b, ['agents.tasks.schedule', 'syntheticTasks.list'], { callsPerPeriod: 1 });
    const tb = taskOf(
      await schedule(b, policyOf(await policy(b, ['syntheticTasks.list'])), 'syntheticTasks.list'),
    );
    await due(tb);
    expect(await runner().runDue(T_ALPHA)).toStrictEqual([{ taskRef: tb, outcome: 'rate_limited' }]);
    expect((await runsOf(tb)).map((r) => r.outcome)).toStrictEqual(['rate_limited']);
  });

  it('the sponsor cancels a task; a revoked agent is never executed', async () => {
    const a = await s.createAgent(WS, 'task cancel');
    const p = policyOf(await policy(a, ['syntheticTasks.list']));
    const t1 = taskOf(await schedule(a, p, 'syntheticTasks.list'));
    const t2 = taskOf(await schedule(a, p, 'syntheticTasks.list'));
    const c = await s.call('humanAll', 'POST', '/v1/agents/tasks/cancel', {
      taskRef: t1,
      expectedVersion: 1,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const rev = await s.call('humanAll', 'POST', '/v1/agents/principals/revoke', {
      agentRef: a.agentRef,
      expectedVersion: a.version,
    });
    expect(rev.status).toBe(200);
    await due(t1);
    await due(t2);
    expect(await runner().runDue(T_ALPHA)).toStrictEqual([{ taskRef: t2, outcome: 'agent_inactive' }]);
  });
});
