import { randomUUID } from 'node:crypto';
import { memoryRegistryRows } from '@cuspatlas/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentHandle, type AgentStack, startAgentStack } from './support/agent-stack';
import { T_ALPHA } from './support/fixtures';

/**
 * Closeout D review fixes (S1): agent memory is a genuine positive allowlist. A key is a registered
 * namespace prefix plus a registered suffix (a registered code, a catalog operation or a UUID
 * reference); a `code` value is a registered code (state vocabularies plus a small declared set); an
 * `operation` value is a catalog operation id, checked in the database against a registry the migrator
 * seeds from the catalog; a `counter` is at most 4 digits; an `instant` is not earlier than the tenant's
 * creation (so a birth date before it cannot be stored). The domain and the database refuse each
 * bypass independently. Synthetic data only.
 */
let s: AgentStack;
const WS = ['agentWorkspace.read', 'agentWorkspace.write', 'syntheticTasks.read', 'syntheticTasks.write'];
const write = (a: AgentHandle, body: Record<string, unknown>) =>
  s.agentTool(a, 'agents_memory_write', {
    classification: 'operational',
    ...body,
    idempotencyKey: randomUUID(),
  });
const refused = (r: { body: Record<string, unknown> }, label: string) => {
  expect(r.body.code, `${label}: ${JSON.stringify(r.body)}`).toBe('validation_failed');
  expect((r.body.detail as { reason?: string })?.reason, label).toBe('memory_value_refused');
};
const setPolicy = async (phiAllowed: boolean) => {
  const r = await s.call('humanAll', 'POST', '/v1/agents/memory/policy', { phiAllowed });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
/** A raw insert under the runtime role, as the agent itself (RLS admits its own rows). */
async function rawInsert(
  agentRef: string,
  key: string,
  value: string,
  kind: string | null,
  cls = 'operational',
) {
  const c = await s.db.app.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)",
      [T_ALPHA, agentRef],
    );
    await c.query(
      `INSERT INTO cuspatlas.agent_memory_entries (tenant_id, agent_ref, key, value, value_kind, classification,
         expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 day')`,
      [T_ALPHA, agentRef, key, value, kind, cls],
    );
    await c.query('ROLLBACK');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
const nowInstant = () => new Date().toISOString();

beforeAll(async () => {
  s = await startAgentStack('agent_memory_allowlist');
}, 120_000);
afterAll(async () => {
  await s?.close();
});

describe('Closeout D review S1: agent memory positive allowlist', () => {
  it('refuses a free-text key, a name-shaped code or operation, an MRN-sized counter and a birth-date instant', async () => {
    await setPolicy(false);
    const a = await s.createAgent(WS, 'allowlist bypasses');
    const bypasses: [string, Record<string, unknown>][] = [
      ['free-text key', { key: 'jane.doe.prefers.morning.calls', value: 'true', kind: 'flag' }],
      ['unregistered key prefix', { key: 'jane.morning', value: 'true', kind: 'flag' }],
      ['name-shaped key suffix', { key: 'pref.jane', value: 'true', kind: 'flag' }],
      ['multi-word key suffix', { key: 'pref.jane.doe', value: 'true', kind: 'flag' }],
      ['name-shaped code', { key: 'pref.recall', value: 'maria.garcia', kind: 'code' }],
      ['name-shaped code (2)', { key: 'pref.recall', value: 'john.smith', kind: 'code' }],
      ['name-shaped operation', { key: 'op.recall', value: 'john.smith', kind: 'operation' }],
      ['MRN-sized counter', { key: 'state.recall', value: '1234567', kind: 'counter' }],
      ['five-digit counter', { key: 'state.recall', value: '12345', kind: 'counter' }],
      ['birth-date instant', { key: 'cursor.recall', value: '1980-02-03T00:00:00Z', kind: 'instant' }],
      ['instant before the tenant', { key: 'cursor.recall', value: '2001-05-05T00:00:00Z', kind: 'instant' }],
    ];
    for (const [label, body] of bypasses) refused(await write(a, body), label);
    const rows = await s.db.admin.query('SELECT 1 FROM cuspatlas.agent_memory_entries WHERE agent_ref = $1', [
      a.agentRef,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('a phi note under the tenant policy still needs a namespaced, registered key', async () => {
    const a = await s.createAgent(WS, 'allowlist phi key');
    await setPolicy(true);
    try {
      refused(
        await write(a, {
          key: 'jane.doe.prefers.morning.calls',
          value: 'Prefers mornings.',
          classification: 'phi',
        }),
        'phi free-text key',
      );
      const ok = await write(a, { key: 'pref.recall', value: 'Prefers mornings.', classification: 'phi' });
      expect(ok.isError, JSON.stringify(ok.body)).toBe(false);
    } finally {
      await setPolicy(false);
    }
  });

  it('valid structured uses still pass', async () => {
    const a = await s.createAgent(WS, 'allowlist valid');
    const ok: [string, string, string][] = [
      ['pref.recall', 'code', 'morning'],
      ['state.recall', 'code', 'pending'],
      ['task.summary', 'counter', '9999'],
      ['task.batch', 'counter', '-12'],
      ['pref.reminder', 'flag', 'false'],
      ['cursor.syntheticTasks.list', 'instant', nowInstant()],
      ['op.syntheticTasks.list', 'operation', 'syntheticTasks.list'],
      [`task.${randomUUID()}`, 'reference', randomUUID()],
      ['pref.window', 'duration', 'PT15M'],
    ];
    for (const [key, kind, value] of ok) {
      const r = await write(a, { key, kind, value });
      expect(r.isError, `${key} ${kind}: ${JSON.stringify(r.body)}`).toBe(false);
    }
  });

  it('the database refuses a raw insert of each bypass under the runtime role', async () => {
    const a = await s.createAgent(WS, 'allowlist database');
    const bypasses: [string, string, string | null, RegExp][] = [
      ['jane.doe.prefers.morning.calls', 'true', 'flag', /agent_memory_entries_key_registered/],
      ['pref.jane', 'true', 'flag', /agent_memory_entries_key_registered/],
      ['pref.recall', 'maria.garcia', 'code', /agent_memory_entries_value_registered/],
      ['pref.recall', 'john.smith', 'operation', /agent_memory_entries_value_registered/],
      ['pref.recall', '1234567', 'counter', /agent_memory_entries_value_structured/],
      ['pref.recall', '12345', 'counter', /agent_memory_entries_value_structured/],
      ['pref.recall', '1980-02-03T00:00:00Z', 'instant', /agent_memory_entries_instant_floor/],
      ['pref.recall', '2001-05-05T00:00:00Z', 'instant', /agent_memory_entries_instant_floor/],
    ];
    for (const [key, value, kind, err] of bypasses)
      await expect(rawInsert(a.agentRef, key, value, kind), `${key} ${kind} ${value}`).rejects.toThrow(err);
    // The structured uses pass the same raw path.
    await rawInsert(a.agentRef, 'pref.recall', 'morning', 'code');
    await rawInsert(a.agentRef, 'op.syntheticTasks.list', 'syntheticTasks.list', 'operation');
    await rawInsert(a.agentRef, 'cursor.recall', nowInstant(), 'instant');
  });

  it('the database registry matches the catalog, the vocabularies and the declared sets', async () => {
    const { rows } = await s.db.admin.query<{ kind: string; value: string }>(
      'SELECT kind, value FROM cuspatlas.agent_memory_registry ORDER BY kind COLLATE "C", value COLLATE "C"',
    );
    expect(rows).toStrictEqual(memoryRegistryRows());
    // The runtime role reads the registry but cannot change it.
    await expect(
      s.db.app.query("INSERT INTO cuspatlas.agent_memory_registry (kind, value) VALUES ('code', 'jane')"),
    ).rejects.toThrow(/permission denied/);
  });
});
