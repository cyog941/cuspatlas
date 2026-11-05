import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentHandle, type AgentStack, startAgentStack } from './support/agent-stack';
import { T_ALPHA } from './support/fixtures';
import { patientBody } from './support/patient-fixtures';

/**
 * Closeout D5: agent memory writes are default-deny. A non-phi note is accepted only when its value
 * passes a positive allowlist classification: a declared structured kind (code, counter, flag, instant,
 * duration, operation, reference) whose value matches that kind's grammar. Free text (kind `text`) is
 * accepted only classified `phi` under the tenant's explicit PHI policy. The earlier PHI heuristic stays
 * as an extra refusal layer, and the database enforces the same allowlist independently. Every refusal
 * is the one uniform `memory_value_refused`. Synthetic data only.
 */
let s: AgentStack;
const WS = ['agentWorkspace.read', 'agentWorkspace.write', 'syntheticTasks.read', 'syntheticTasks.write'];
const key = () => randomUUID();
const write = (a: AgentHandle, body: Record<string, unknown>) =>
  s.agentTool(a, 'agents_memory_write', { classification: 'operational', ...body, idempotencyKey: key() });
const reason = (r: { body: Record<string, unknown> }) => (r.body.detail as { reason?: string })?.reason;
const refused = (r: { isError?: boolean; body: Record<string, unknown> }, label: string) => {
  expect(r.body.code, label).toBe('validation_failed');
  expect(reason(r), label).toBe('memory_value_refused');
};
const setPolicy = async (phiAllowed: boolean) => {
  const r = await s.call('humanAll', 'POST', '/v1/agents/memory/policy', { phiAllowed });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};

beforeAll(async () => {
  s = await startAgentStack('agent_memory_default_deny');
}, 120_000);
afterAll(async () => {
  await s?.close();
});

describe('Closeout D5: agent memory default-deny', () => {
  it('refuses by default: free text and an undeclared kind are refused even when nothing looks like PHI', async () => {
    await setPolicy(false);
    const a = await s.createAgent(WS, 'deny by default');
    refused(await write(a, { key: 'pref.recall', value: 'Prefer the morning recall batch.' }), 'no kind');
    refused(
      await write(a, { key: 'pref.reminder', value: 'Prefer the morning batch.', kind: 'text' }),
      'text',
    );
    refused(
      await write(a, { key: 'pref.summary', value: 'ok', kind: 'text', classification: 'reference' }),
      'text as reference',
    );
    const rows = await s.db.admin.query('SELECT 1 FROM cuspatlas.agent_memory_entries WHERE agent_ref = $1', [
      a.agentRef,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('accepts each allowlisted structured kind whose value matches its grammar, and refuses a mismatch', async () => {
    const a = await s.createAgent(WS, 'structured kinds');
    const ok: [string, string][] = [
      ['code', 'morning'],
      ['counter', '42'],
      ['flag', 'true'],
      ['instant', new Date().toISOString()],
      ['duration', 'PT15M'],
      ['operation', 'syntheticTasks.list'],
      ['reference', randomUUID()],
    ];
    for (const [kind, value] of ok) {
      const r = await write(a, {
        key: `state.${kind === 'counter' ? 'summary' : kind === 'code' ? 'recall' : randomUUID()}`,
        value,
        kind,
      });
      expect(r.isError, `${kind}: ${JSON.stringify(r.body)}`).toBe(false);
      expect(r.body.data, kind).toMatchObject({ kind, classification: 'operational' });
    }
    const read = await s.agentTool(a, 'agents_memory_get', { key: 'state.summary' });
    expect(read.body.data).toMatchObject({ value: '42', kind: 'counter' });
    const bad: [string, string][] = [
      ['code', 'Recall Batch'],
      ['counter', '12a'],
      ['counter', '12345678'],
      ['counter', '12345'],
      ['code', 'recall.batch.morning'],
      ['flag', 'yes'],
      ['instant', 'next tuesday'],
      ['duration', 'fifteen minutes'],
      ['operation', 'not.a.catalogOperation'],
      ['reference', 'see the chart'],
    ];
    for (const [kind, value] of bad)
      refused(await write(a, { key: 'state.review', value, kind }), `${kind} ${value}`);
  });

  it('keeps the heuristic as an extra layer: a registered value or key suffix naming a patient, or a patient ref, is refused', async () => {
    const a = await s.createAgent([...WS, 'patients.write'], 'extra layer');
    // A surname that coincides with a registered code: the allowlist admits the code, the heuristic refuses it.
    const created = await s.agentTool(a, 'patients_create', {
      ...patientBody('Ilsa', { legalName: { known: true, given: 'Ilsa', family: 'Low' } }),
      idempotencyKey: key(),
    });
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    const patientRef = (created.body.data as { patientRef: string }).patientRef;
    refused(await write(a, { key: 'pref.recall', value: 'low', kind: 'code' }), 'surname code');
    refused(await write(a, { key: 'pref.low', value: 'true', kind: 'flag' }), 'surname key');
    refused(await write(a, { key: 'task.batch', value: patientRef, kind: 'reference' }), 'patient ref');
    refused(await write(a, { key: `task.${patientRef}`, value: 'true', kind: 'flag' }), 'patient ref key');
    expect((await write(a, { key: 'pref.window', value: 'high', kind: 'code' })).isError).toBe(false);
  });

  it('free text is accepted only classified phi under the explicit tenant PHI policy', async () => {
    const a = await s.createAgent(WS, 'policy path');
    await setPolicy(false);
    refused(
      await write(a, { key: 'pref.followup', value: 'Prefer mornings.', classification: 'phi' }),
      'policy off',
    );
    await setPolicy(true);
    try {
      refused(await write(a, { key: 'pref.followup', value: 'Prefer mornings.' }), 'unlabelled free text');
      const ok = await write(a, { key: 'pref.followup', value: 'Prefer mornings.', classification: 'phi' });
      expect(ok.isError, JSON.stringify(ok.body)).toBe(false);
      expect(ok.body.data).toMatchObject({ classification: 'phi', kind: 'text' });
    } finally {
      await setPolicy(false);
    }
  });

  it('the database enforces the allowlist independently of the domain, whoever writes', async () => {
    const a = await s.createAgent(WS, 'database allowlist');
    for (const [value, kind] of [
      ['free text', null],
      ['free text', 'text'],
      ['Recall Batch', 'code'],
      ['12a', 'counter'],
    ] as const)
      await expect(
        s.db.admin.query(
          `INSERT INTO cuspatlas.agent_memory_entries (tenant_id, agent_ref, key, value, value_kind, classification,
             expires_at)
           VALUES ($1, $2, 'pref.recall', $3, $4, 'operational', now() + interval '1 day')`,
          [T_ALPHA, a.agentRef, value, kind],
        ),
        `${kind} ${value}`,
      ).rejects.toThrow(/agent_memory_entries_value_structured/);
    await s.db.admin.query(
      `INSERT INTO cuspatlas.agent_memory_entries (tenant_id, agent_ref, key, value, value_kind, classification,
         expires_at)
       VALUES ($1, $2, 'pref.recall', 'morning', 'code', 'operational', now() + interval '1 day')`,
      [T_ALPHA, a.agentRef],
    );
  });
});
