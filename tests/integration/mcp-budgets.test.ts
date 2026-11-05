import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentStack, inDays, startAgentStack } from './support/agent-stack';
import { MCP_AUDIENCE } from './support/catalog-stack';
import { patientBody } from './support/patient-fixtures';

/**
 * A9: per-deployment consent (which agent, which operations, granted by which human) and per-call and
 * per-period budgets (calls, records read, PHI fields returned), enforced server-side at the MCP tool
 * boundary with a typed 429 (rate_limited, reason budget_exhausted). Synthetic data only; the remote
 * transport itself stays blocked on A-S1.
 */
let s: AgentStack;
const TASKS = ['syntheticTasks.read', 'syntheticTasks.write'];
const create = (label: string) => ({ label, idempotencyKey: randomUUID() });

beforeAll(async () => {
  s = await startAgentStack('mcp_budgets');
}, 120_000);
afterAll(async () => {
  await s?.close();
});

describe('A9 consent', () => {
  it('an agent without consent is refused every tool; the refusal is recorded', async () => {
    const a = await s.createAgent(TASKS, 'no consent', undefined, { consent: false });
    const r = await s.agentTool(a, 'synthetic_tasks_list', {});
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe('forbidden');
    expect(s.attempts.some((x) => x.actorId === a.agentRef && x.reasonCode === 'consent_missing')).toBe(true);
  });

  it('a tool outside the consented operations is refused; the consented one runs', async () => {
    const a = await s.createAgent(TASKS, 'list only', undefined, { consent: false });
    expect((await s.consent(a, ['syntheticTasks.list'])).status).toBe(201);
    expect((await s.agentTool(a, 'synthetic_tasks_list', {})).isError).toBe(false);
    const w = await s.agentTool(a, 'synthetic_tasks_create', create('outside consent'));
    expect(w.body.code).toBe('forbidden');
  });

  it('consent cannot name an operation outside the agent scope set, a human-only one, or exceed the ceiling', async () => {
    const a = await s.createAgent(['syntheticTasks.read'], 'read only', undefined, { consent: false });
    const write = await s.consent(a, ['syntheticTasks.create']);
    expect(write.status).toBe(422);
    expect((write.body.detail as { reason: string }).reason).toBe('consent_scope_exceeded');
    const human = await s.consent(a, ['agents.principals.create']);
    expect(human.status).toBe(422);
    const ceiling = await s.consent(a, ['syntheticTasks.list'], { callsPerPeriod: 10_000_000 });
    expect(ceiling.status).toBe(400);
    const svc = await s.consent(a, ['syntheticTasks.list'], {}, { sponsor: 'serviceAll' });
    expect(svc.status).toBe(403);
  });

  it('a consent for another deployment does not admit calls on this one', async () => {
    const a = await s.createAgent(TASKS, 'other deployment', undefined, { consent: false });
    expect(
      (await s.consent(a, ['syntheticTasks.list'], {}, { deployment: 'urn:cuspatlas:mcp:elsewhere' })).status,
    ).toBe(201);
    expect((await s.agentTool(a, 'synthetic_tasks_list', {})).body.code).toBe('forbidden');
  });

  it('revoking the consent refuses the next call of an open session', async () => {
    const a = await s.createAgent(TASKS, 'revocable consent', undefined, { consent: false });
    const c = await s.consent(a, ['syntheticTasks.list']);
    const consentRef = (c.body.data as { consentRef: string }).consentRef;
    const client = await s.agentClient(a.agentRef, a.credentialRef);
    expect((await s.agentCall(client, 'synthetic_tasks_list', {})).isError).toBe(false);
    const rev = await s.call('humanAll', 'POST', '/v1/agents/consents/revoke', {
      consentRef,
      expectedVersion: 1,
    });
    expect(rev.status).toBe(200);
    expect((await s.agentCall(client, 'synthetic_tasks_list', {})).body.code).toBe('forbidden');
    const listed = await s.call('humanAll', 'GET', `/v1/agents/consents?agentRef=${a.agentRef}`);
    expect(listed.status).toBe(200);
    expect((listed.body.data as { state: string }[]).map((x) => x.state)).toStrictEqual(['revoked']);
  });

  it('the protected-resource metadata states that agent consent is required', async () => {
    const meta = await fetch(new URL('/.well-known/oauth-protected-resource', s.mcpUrl));
    expect(await meta.json()).toMatchObject({ resource: MCP_AUDIENCE, cuspatlas_agent_consent: 'required' });
  });
});

describe('A9 budgets', () => {
  it('the call budget is exhausted with a typed 429 before the handler runs', async () => {
    const a = await s.createAgent(TASKS, 'two calls', undefined, { consent: false });
    await s.consent(a, ['syntheticTasks.list', 'syntheticTasks.create'], { callsPerPeriod: 2 });
    expect((await s.agentTool(a, 'synthetic_tasks_list', {})).isError).toBe(false);
    expect((await s.agentTool(a, 'synthetic_tasks_list', {})).isError).toBe(false);
    const third = await s.agentTool(a, 'synthetic_tasks_create', create('over budget'));
    expect(third.body.code).toBe('rate_limited');
    expect((third.body.detail as { reason: string }).reason).toBe('budget_exhausted');
    const { rowCount } = await s.db.admin.query(
      `SELECT 1 FROM cuspatlas.synthetic_tasks WHERE label = 'over budget'`,
    );
    expect(rowCount).toBe(0);
    const usage = await s.call(
      'humanAll',
      'GET',
      `/v1/agents/budgets?agentRef=${a.agentRef}&deployment=${MCP_AUDIENCE}`,
    );
    expect(usage.status).toBe(200);
    expect((usage.body.data as { calls: number }).calls).toBe(2);
  });

  it('a list over the per-call record budget is truncated with a resume cursor, charging only what was returned', async () => {
    const a = await s.createAgent(TASKS, 'one record per call', undefined, { consent: false });
    await s.consent(a, ['syntheticTasks.list', 'syntheticTasks.create'], { recordsPerCall: 1 });
    await s.agentTool(a, 'synthetic_tasks_create', create('budget row one'));
    await s.agentTool(a, 'synthetic_tasks_create', create('budget row two'));
    const r = await s.agentTool(a, 'synthetic_tasks_list', {});
    expect(r.isError).toBe(false);
    const items = r.body.data as { label: string }[];
    expect(items).toHaveLength(1);
    const t = (r.meta as { truncated?: Record<string, unknown> } | undefined)?.truncated as {
      returned: number;
      omitted: number;
      limit: { name: string; value: number };
      resumeCursor: string;
    };
    expect(t).toMatchObject({ returned: 1, limit: { name: 'recordsPerCall', value: 1 } });
    expect(t.omitted).toBeGreaterThanOrEqual(1);
    expect(typeof t.resumeCursor).toBe('string');
    // Resuming walks the rest one record per call, without repeats, until no cursor is left.
    const seen = [items[0]?.label];
    let cursor: string | undefined = t.resumeCursor;
    while (cursor) {
      const next = await s.agentTool(a, 'synthetic_tasks_list', { resumeCursor: cursor });
      expect(next.isError).toBe(false);
      const page = next.body.data as { label: string }[];
      expect(page).toHaveLength(1);
      seen.push(page[0]?.label);
      cursor = (next.meta as { truncated?: { resumeCursor: string } } | undefined)?.truncated?.resumeCursor;
    }
    expect(seen).toHaveLength(1 + t.omitted);
    expect(new Set(seen).size).toBe(seen.length);
    // Only what was returned is charged: every page logs one record; the last page is not truncated.
    const log = await s.db.admin.query<{ outcome: string; records: number }>(
      'SELECT outcome, records FROM cuspatlas.agent_tool_calls WHERE agent_ref = $1 ORDER BY occurred_at',
      [a.agentRef],
    );
    const pages = log.rows.slice(2);
    expect(pages.every((x) => x.records === 1)).toBe(true);
    expect(pages.map((x) => x.outcome)).toStrictEqual([
      ...Array.from({ length: seen.length - 1 }, () => 'truncated'),
      'ok',
    ]);
    // A cursor for another operation or other arguments is refused, never applied.
    const bad = await s.agentTool(a, 'synthetic_tasks_list', { resumeCursor: 'not-a-cursor' });
    expect(bad.body.code).toBe('invalid_request');
    // Closeout C review: the agent (the only caller ever truncated) is advertised the cursor input and
    // the _meta.truncated schema on every read-only tool, and on no command.
    const { tools } = await (await s.agentClient(a.agentRef, a.credentialRef)).listTools();
    for (const tool of tools) {
      const resumable = tool.annotations?.readOnlyHint === true;
      expect([tool.name, 'resumeCursor' in (tool.inputSchema.properties ?? {})]).toStrictEqual([
        tool.name,
        resumable,
      ]);
      expect([tool.name, tool._meta?.['cuspatlas/truncation'] !== undefined]).toStrictEqual([
        tool.name,
        resumable,
      ]);
    }
  });

  it('the period record budget still refuses once exhausted, even with truncation', async () => {
    const a = await s.createAgent(TASKS, 'period of two', undefined, { consent: false });
    await s.consent(a, ['syntheticTasks.list', 'syntheticTasks.create'], {
      recordsPerCall: 1,
      recordsPerPeriod: 3,
    });
    await s.agentTool(a, 'synthetic_tasks_create', create('period row one'));
    await s.agentTool(a, 'synthetic_tasks_create', create('period row two'));
    const r = await s.agentTool(a, 'synthetic_tasks_list', {});
    expect(r.isError).toBe(false);
    const again = await s.agentTool(a, 'synthetic_tasks_list', {});
    expect(again.body.code).toBe('rate_limited');
    expect((again.body.detail as { limit: { name: string } }).limit.name).toBe('recordsPerPeriod');
  });

  it('PHI fields returned are counted against the per-call and per-period budgets', async () => {
    const scopes = ['patients.read', 'patients.write'];
    const a = await s.createAgent(scopes, 'phi budget', undefined, { consent: false });
    await s.consent(a, ['patients.create', 'patients.read'], { phiFieldsPerCall: 3 });
    const created = await s.agentTool(a, 'patients_create', {
      ...patientBody('Budgetta'),
      idempotencyKey: randomUUID(),
    });
    expect(created.isError).toBe(false);
    const patientRef = (created.body.data as { patientRef: string }).patientRef;
    const r = await s.agentTool(a, 'patients_get', { patientRef });
    expect(r.body.code).toBe('rate_limited');
    expect((r.body.detail as { limit: { name: string } }).limit.name).toBe('phiFieldsPerCall');
    const log = await s.db.admin.query<{ outcome: string }>(
      'SELECT outcome FROM cuspatlas.agent_tool_calls WHERE agent_ref = $1 ORDER BY occurred_at',
      [a.agentRef],
    );
    expect(log.rows.map((x) => x.outcome)).toStrictEqual(['ok', 'budget_exhausted']);
  });

  it('a human on MCP is not subject to agent consent', async () => {
    expect((await s.mcp('humanAll', 'synthetic_tasks_list', {})).isError).toBe(false);
  });

  it('consent expiry is required and cannot outlive the agent', async () => {
    const a = await s.createAgent(TASKS, 'short lived', undefined, { consent: false });
    const r = await s.call('humanAll', 'POST', '/v1/agents/consents', {
      agentRef: a.agentRef,
      deployment: MCP_AUDIENCE,
      operations: ['syntheticTasks.list'],
      budget: {
        periodSeconds: 60,
        callsPerPeriod: 1,
        recordsPerPeriod: 1,
        phiFieldsPerPeriod: 0,
        recordsPerCall: 1,
        phiFieldsPerCall: 0,
      },
      expiresAt: inDays(60),
    });
    expect(r.status).toBe(422);
  });
});
