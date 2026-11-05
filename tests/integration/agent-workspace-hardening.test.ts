import { randomUUID } from 'node:crypto';
import { createAuthorize } from '@cuspatlas/domain';
import { createAgentTaskRunner } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentHandle, type AgentStack, inDays, SPONSOR, startAgentStack } from './support/agent-stack';
import { M_SERVICE_ALL, MCP_AUDIENCE } from './support/catalog-stack';
import { T_ALPHA } from './support/fixtures';
import { patientBody } from './support/patient-fixtures';

/**
 * A23 hardening after independent review: the PHI policy flip removes phi notes in the same transaction
 * and reads re-check the policy; a concurrent write and flip cannot leave a phi row; memory screening is a
 * best-effort heuristic with a database backstop and one uniform refusal; the workspace tables carry the
 * reach rule in RLS; the worker rechecks the policy owner and stops on a revoked consent; sponsor offers
 * are listed only to the offeree, the sponsor and agent managers. Synthetic data only.
 */
let s: AgentStack;
const WS = ['agentWorkspace.read', 'agentWorkspace.write', 'syntheticTasks.read', 'syntheticTasks.write'];
const key = () => randomUUID();

beforeAll(async () => {
  s = await startAgentStack('agent_workspace_hardening');
}, 120_000);
afterAll(async () => {
  await s?.close();
});

async function principal(kind: 'human' | 'service', scopes: readonly string[]): Promise<string> {
  const { rows } = await s.db.admin.query<{ id: string }>(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
    [kind, `wh-${kind}-${randomUUID().slice(0, 8)}`],
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
const setPolicy = async (phiAllowed: boolean) => {
  const r = await s.call('humanAll', 'POST', '/v1/agents/memory/policy', { phiAllowed });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const phiRows = async (agentRef: string) =>
  (
    await s.db.admin.query(
      "SELECT 1 FROM cuspatlas.agent_memory_entries WHERE agent_ref = $1 AND classification = 'phi'",
      [agentRef],
    )
  ).rowCount ?? 0;
/** Counts rows visible to an actor through the runtime role (RLS applies). */
async function visible(actor: string, table: string, agentRef: string): Promise<number> {
  const c = await s.db.app.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)",
      [T_ALPHA, actor],
    );
    const r = await c.query(`SELECT 1 FROM cuspatlas.${table} WHERE agent_ref = $1`, [agentRef]);
    await c.query('ROLLBACK');
    return r.rowCount ?? 0;
  } finally {
    c.release();
  }
}

describe('A23 hardening: the PHI policy flip', () => {
  it('turning PHI off removes every phi note in the same transaction; the sponsor then reads no value', async () => {
    const a = await s.createAgent(WS, 'flip removes');
    await setPolicy(true);
    const w = await write(a, 'flip.note', 'A phi note held while allowed.', 'phi');
    expect(w.isError, JSON.stringify(w.body)).toBe(false);
    const q = `/v1/agents/memory/entry?agentRef=${a.agentRef}&key=flip.note`;
    expect((await s.call('humanAll', 'GET', q)).status).toBe(200);
    await setPolicy(false);
    expect(await phiRows(a.agentRef)).toBe(0);
    const after = await s.call('humanAll', 'GET', q);
    expect(after.status).toBe(404);
    expect(JSON.stringify(after.body)).not.toContain('held while allowed');
  });

  it('a phi write racing a flip to off never leaves a phi row (both orders)', async () => {
    const a = await s.createAgent(WS, 'flip race');
    await setPolicy(true);
    const insert = (c: { query: (q: string, p: unknown[]) => Promise<unknown> }, k: string) =>
      c.query(
        `INSERT INTO cuspatlas.agent_memory_entries (tenant_id, agent_ref, key, value, classification, expires_at)
         VALUES ($1, $2, $3, 'race value', 'phi', now() + interval '1 day')`,
        [T_ALPHA, a.agentRef, k],
      );
    // Write first: the flip waits on the write's policy share lock, then removes the committed row.
    const c1 = await s.db.admin.connect();
    try {
      await c1.query('BEGIN');
      await insert(c1, 'race.one');
      const flip = s.db.admin.query(
        'UPDATE cuspatlas.agent_memory_policies SET phi_allowed = false WHERE tenant_id = $1',
        [T_ALPHA],
      );
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      await flip;
    } finally {
      c1.release();
    }
    expect(await phiRows(a.agentRef)).toBe(0);
    // Flip first: the write waits on the flip's row lock and is refused once it commits.
    await setPolicy(true);
    const c2 = await s.db.admin.connect();
    try {
      await c2.query('BEGIN');
      await c2.query('UPDATE cuspatlas.agent_memory_policies SET phi_allowed = false WHERE tenant_id = $1', [
        T_ALPHA,
      ]);
      const late = insert(s.db.admin, 'race.two').then(
        () => 'committed',
        (e: Error) => e.message,
      );
      await new Promise((r) => setTimeout(r, 300));
      await c2.query('COMMIT');
      expect(await late).toMatch(/phi_not_permitted/);
    } finally {
      c2.release();
    }
    expect(await phiRows(a.agentRef)).toBe(0);
  });

  it('reads re-check the policy: a stranded phi note is a typed refusal to the agent and the sponsor, audited', async () => {
    const a = await s.createAgent(WS, 'flip read');
    await setPolicy(true);
    expect((await write(a, 'stranded', 'Stranded phi value.', 'phi')).isError).toBe(false);
    // Strand the row: flip the policy with triggers disabled (a bypass the read path must still catch).
    const c = await s.db.admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('UPDATE cuspatlas.agent_memory_policies SET phi_allowed = false WHERE tenant_id = $1', [
        T_ALPHA,
      ]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const r = await s.agentTool(a, 'agents_memory_get', { key: 'stranded' });
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe('forbidden');
    expect(reason(r)).toBe('phi_not_permitted');
    expect(JSON.stringify(r.body)).not.toContain('Stranded phi value');
    const audit = await s.db.admin.query(
      `SELECT 1 FROM cuspatlas.agent_audit_events WHERE agent_ref = $1 AND operation = 'agents.memory.read'
         AND resource_type = 'agentMemoryReadRefused'`,
      [a.agentRef],
    );
    expect(audit.rowCount).toBe(1);
    const count = await s.db.admin.query<{ read_count: number }>(
      "SELECT read_count FROM cuspatlas.agent_memory_entries WHERE agent_ref = $1 AND key = 'stranded'",
      [a.agentRef],
    );
    expect(count.rows[0]?.read_count).toBe(0);
    const human = await s.call(
      'humanAll',
      'GET',
      `/v1/agents/memory/entry?agentRef=${a.agentRef}&key=stranded`,
    );
    expect(human.status).toBe(403);
    expect(JSON.stringify(human.body)).not.toContain('Stranded phi value');
    await s.db.admin.query('DELETE FROM cuspatlas.agent_memory_entries WHERE agent_ref = $1', [a.agentRef]);
  });
});

describe('A23 hardening: best-effort screening and the database backstop', () => {
  it('every write refusal is one uniform memory_value_refused; the heuristic catches surnames, MRNs, obfuscation', async () => {
    await setPolicy(false);
    const a = await s.createAgent([...WS, 'patients.write'], 'screening');
    const created = await s.agentTool(a, 'patients_create', {
      ...patientBody('Ilsa', { legalName: { known: true, given: 'Ilsa', family: 'Brannock' } }),
      idempotencyKey: key(),
    });
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    for (const [value, cls] of [
      ['anything', 'phi'],
      ['Call back at 555-201-3344', 'operational'],
      ['Ask Brannock about the bridge', 'operational'],
      ['MRN A77310 needs review', 'operational'],
      ['Chart no. 4471-22 pending', 'operational'],
      ['Reach ５５５２０１３３４４ later', 'operational'],
      ['Write to some​one@example.test', 'reference'],
      ['DOB: 1980-02-03', 'operational'],
    ] as const) {
      const r = await write(a, 'k.screen', value, cls);
      expect(r.body.code, value).toBe('validation_failed');
      expect(reason(r), value).toBe('memory_value_refused');
      expect(JSON.stringify(r.body), value).not.toMatch(/phi_detected|phi_not_permitted/);
    }
    // Closeout D5: behind the default-deny allowlist, the heuristic matches every token of a structured
    // value, so a lower-case surname in a code is refused too; other codes pass.
    expect(reason(await write(a, 'k.lower', 'brannock.bridge'))).toBe('memory_value_refused');
    expect((await write(a, 'k.lower', 'bridge.note')).isError).toBe(false);
  });

  it('the database refuses a contact or DOB pattern in a non-phi note, whoever writes it', async () => {
    const a = await s.createAgent(WS, 'backstop');
    for (const value of ['mail x@example.test', 'dob 1980-01-01', 'call 555 201 3344']) {
      await expect(
        s.db.admin.query(
          `INSERT INTO cuspatlas.agent_memory_entries (tenant_id, agent_ref, key, value, classification, expires_at)
           VALUES ($1, $2, 'k.backstop', $3, 'operational', now() + interval '1 day')`,
          [T_ALPHA, a.agentRef, value],
        ),
        value,
      ).rejects.toThrow(/agent_memory_entries_value_screen/);
    }
  });
});

describe('A23 hardening: database reach rule', () => {
  it('RLS limits workspace rows to the agent, its current sponsor and agent managers', async () => {
    const a = await s.createAgent(WS, 'rls reach');
    expect((await write(a, 'rls.note', 'reach.checked')).isError).toBe(false);
    const stranger = await principal('human', ['agentWorkspace.read']);
    const manager = await principal('human', ['agentWorkspace.read', 'agents.manage']);
    for (const table of ['agent_memory_entries', 'agent_sessions']) {
      expect(await visible(stranger, table, a.agentRef), table).toBe(0);
      expect(await visible(SPONSOR, table, a.agentRef), table).toBeGreaterThan(0);
      expect(await visible(manager, table, a.agentRef), table).toBeGreaterThan(0);
      expect(await visible(a.agentRef, table, a.agentRef), table).toBeGreaterThan(0);
    }
  });

  it('a task policy updates only its state columns, only by its owner or a manager; a task binds its own policy', async () => {
    const a = await s.createAgent(WS, 'policy columns');
    const b = await s.createAgent(WS, 'policy other');
    const pr = await s.call('humanAll', 'POST', '/v1/agents/task-policies', {
      agentRef: a.agentRef,
      deployment: MCP_AUDIENCE,
      operations: ['syntheticTasks.list'],
      minIntervalSeconds: 60,
      maxRunsPerDay: 24,
      expiresAt: inDays(5),
    });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    const policyRef = (pr.body.data as { policyRef: string }).policyRef;
    const asActor = async (actor: string, sql: string) => {
      const c = await s.db.app.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          "SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)",
          [T_ALPHA, actor],
        );
        const r = await c.query(sql, [policyRef]);
        await c.query('ROLLBACK');
        return r.rowCount ?? 0;
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    };
    await expect(
      asActor(
        SPONSOR,
        "UPDATE cuspatlas.agent_task_policies SET operations = '{agents.memory.write}' WHERE id = $1",
      ),
    ).rejects.toThrow(/permission denied/);
    const stranger = await principal('human', ['agentWorkspace.read']);
    expect(
      await asActor(stranger, "UPDATE cuspatlas.agent_task_policies SET state = 'active' WHERE id = $1"),
    ).toBe(0);
    expect(
      await asActor(SPONSOR, "UPDATE cuspatlas.agent_task_policies SET state = 'active' WHERE id = $1"),
    ).toBe(1);
    await expect(
      s.db.admin.query(
        `INSERT INTO cuspatlas.agent_scheduled_tasks (tenant_id, agent_ref, policy_ref, operation, arguments,
           interval_seconds, next_run_at) VALUES ($1, $2, $3, 'syntheticTasks.list', '{}', 3600, now())`,
        [T_ALPHA, b.agentRef, policyRef],
      ),
    ).rejects.toThrow(/agent_scheduled_tasks_policy_same_agent/);
  });
});

describe('A23 hardening: worker rechecks', () => {
  const runner = () =>
    createAgentTaskRunner({
      workerPrincipalId: M_SERVICE_ALL,
      authorize: createAuthorize(s.membership),
      memberships: s.membership,
      agents: s.agents,
      invoker: s.agentToolInvoker,
    });
  const schedule = async (a: AgentHandle, owner: string) => {
    const pr = await s.call(owner, 'POST', '/v1/agents/task-policies', {
      agentRef: a.agentRef,
      deployment: MCP_AUDIENCE,
      operations: ['syntheticTasks.list'],
      minIntervalSeconds: 60,
      maxRunsPerDay: 24,
      expiresAt: inDays(5),
    });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    const t = await s.agentTool(a, 'agents_tasks_schedule', {
      policyRef: (pr.body.data as { policyRef: string }).policyRef,
      operation: 'syntheticTasks.list',
      arguments: {},
      intervalSeconds: 3600,
      idempotencyKey: key(),
    });
    expect(t.isError, JSON.stringify(t.body)).toBe(false);
    const taskRef = (t.body.data as { taskRef: string }).taskRef;
    await s.db.admin.query(
      "UPDATE cuspatlas.agent_scheduled_tasks SET next_run_at = now() - interval '1 second' WHERE id = $1",
      [taskRef],
    );
    return taskRef;
  };

  it('a policy owner who left the tenant or lost agents.manage stops the task', async () => {
    const a = await s.createAgent(WS, 'owner left');
    const owner = await principal('human', [...WS, 'agents.manage']);
    const t = await schedule(a, owner);
    await s.db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1', [
      owner,
    ]);
    expect(await runner().runDue(T_ALPHA)).toStrictEqual([{ taskRef: t, outcome: 'policy_owner_inactive' }]);

    const b = await s.createAgent(WS, 'owner demoted');
    const owner2 = await principal('human', [...WS, 'agents.manage']);
    const t2 = await schedule(b, owner2);
    await s.db.admin.query('UPDATE cuspatlas.memberships SET scopes = $2 WHERE principal_id = $1', [
      owner2,
      WS,
    ]);
    expect(await runner().runDue(T_ALPHA)).toStrictEqual([{ taskRef: t2, outcome: 'policy_owner_inactive' }]);
  });

  it('a revoked consent stops the task instead of refusing it every interval', async () => {
    const a = await s.createAgent(WS, 'consent revoked');
    const t = await schedule(a, 'humanAll');
    await s.db.admin.query(
      "UPDATE cuspatlas.agent_consents SET state = 'revoked', revoked_at = now(), revoked_by = $2 WHERE agent_ref = $1",
      [a.agentRef, SPONSOR],
    );
    expect(await runner().runDue(T_ALPHA)).toStrictEqual([{ taskRef: t, outcome: 'consent_revoked' }]);
    const state = await s.db.admin.query<{ state: string; stop_reason: string }>(
      'SELECT state, stop_reason FROM cuspatlas.agent_scheduled_tasks WHERE id = $1',
      [t],
    );
    expect(state.rows[0]).toStrictEqual({ state: 'stopped', stop_reason: 'consent_revoked' });
  });
});

describe('A23 hardening: sponsor offers', () => {
  it('agents.sponsors.offers.list shows an offer to the offeree, the sponsor and managers only', async () => {
    const a = await s.createAgent(WS, 'offer list');
    const offeree = await principal('human', WS);
    const stranger = await principal('human', WS);
    const change = await s.call('humanAll', 'POST', '/v1/agents/sponsors/change', {
      agentRef: a.agentRef,
      sponsorRef: offeree,
      expectedVersion: a.version,
    });
    expect(change.status, JSON.stringify(change.body)).toBe(200);
    const mine = await s.call(offeree, 'GET', '/v1/agents/sponsors/offers');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const items = mine.body.data as { agentRef: string; sponsorRef: string; state: string }[];
    expect(items).toContainEqual(
      expect.objectContaining({ agentRef: a.agentRef, sponsorRef: offeree, state: 'pending' }),
    );
    expect(mine.body).toMatchObject({
      envelope: { ordering: { key: 'offeredAt', direction: 'asc', tieBreak: 'offerRef' } },
    });
    const sponsor = await s.call('humanAll', 'GET', `/v1/agents/sponsors/offers?agentRef=${a.agentRef}`);
    expect((sponsor.body.data as unknown[]).length).toBe(1);
    const other = await s.call(stranger, 'GET', '/v1/agents/sponsors/offers');
    expect(JSON.stringify(other.body.data)).not.toContain(a.agentRef);
    expect((await s.agentTool(a, 'agents_sponsors_offers_list', {})).body.code).toBe('forbidden');
    // RLS: an ordinary member cannot read another human's offer directly.
    const c = await s.db.app.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        "SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)",
        [T_ALPHA, stranger],
      );
      const r = await c.query('SELECT 1 FROM cuspatlas.agent_sponsor_offers WHERE agent_ref = $1', [
        a.agentRef,
      ]);
      await c.query('ROLLBACK');
      expect(r.rowCount).toBe(0);
    } finally {
      c.release();
    }
  });
});
