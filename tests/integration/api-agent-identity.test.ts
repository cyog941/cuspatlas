import { randomUUID } from 'node:crypto';
import { AGENT_SCOPE_CEILING } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAuthorize } from '@cuspatlas/domain';
import { createWorker } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentStack, inDays, SPONSOR, startAgentStack } from './support/agent-stack';
import { M_HUMAN_ALL, M_SERVICE_ALL } from './support/catalog-stack';
import { FakeProvider } from './support/fake-provider';
import { ctxFor, T_ALPHA } from './support/fixtures';

/**
 * A8: agent principals (a service-principal subtype) with a named human sponsor, purpose, scope set,
 * expiry, credential rotation and immediate revocation; every agent action lands in the separate
 * agent-audit stream naming the agent as actor and the sponsor of record. Synthetic data only.
 */
let s: AgentStack;
const TASK_SCOPES = ['syntheticTasks.read', 'syntheticTasks.write'];
const create = (label: string) => ({ label, idempotencyKey: randomUUID() });

beforeAll(async () => {
  s = await startAgentStack('agent_identity');
}, 120_000);
afterAll(async () => {
  await s?.close();
});

describe('A8 agent principal lifecycle', () => {
  it('an agent needs a purpose and an expiry; the sponsor is the creating human', async () => {
    const noPurpose = await s.call('humanAll', 'POST', '/v1/agents/principals', {
      scopes: TASK_SCOPES,
      expiresAt: inDays(5),
    });
    expect(noPurpose.status).toBe(400);
    const noExpiry = await s.call('humanAll', 'POST', '/v1/agents/principals', {
      purpose: 'x',
      scopes: TASK_SCOPES,
    });
    expect(noExpiry.status).toBe(400);
    const past = await s.call('humanAll', 'POST', '/v1/agents/principals', {
      purpose: 'x',
      scopes: TASK_SCOPES,
      expiresAt: inDays(-1),
    });
    expect(past.status).toBe(422);
    const tooLong = await s.call('humanAll', 'POST', '/v1/agents/principals', {
      purpose: 'x',
      scopes: TASK_SCOPES,
      expiresAt: inDays(400),
    });
    expect(tooLong.status).toBe(422);
    const a = await s.createAgent(TASK_SCOPES);
    const read = await s.call('humanAll', 'GET', `/v1/agents/principals/state?agentRef=${a.agentRef}`);
    expect(read.status).toBe(200);
    const d = read.body.data as Record<string, unknown>;
    expect(d.sponsorRef).toBe(SPONSOR);
    expect(d.state).toBe('active');
    expect(d.scopes).toStrictEqual(TASK_SCOPES);
    expect(JSON.stringify(d)).not.toContain(a.credentialRef);
  });

  it('a human-only scope, or one the sponsor does not hold, cannot be granted to an agent', async () => {
    for (const scope of ['clinical.sign', 'agents.manage', 'actions.approve', 'syntheticTasks.approve']) {
      const r = await s.call('humanAll', 'POST', '/v1/agents/principals', {
        purpose: 'x',
        scopes: ['syntheticTasks.read', scope],
        expiresAt: inDays(5),
      });
      expect(r.status, scope).toBe(422);
      expect((r.body.detail as { reason: string }).reason).toBe('human_only_scope');
    }
    const unknown = await s.call('humanAll', 'POST', '/v1/agents/principals', {
      purpose: 'x',
      scopes: ['nothing.real'],
      expiresAt: inDays(5),
    });
    expect(unknown.status).toBe(422);
  });

  it('an agent or a service cannot create or sponsor another agent', async () => {
    const svc = await s.call('serviceAll', 'POST', '/v1/agents/principals', {
      purpose: 'x',
      scopes: TASK_SCOPES,
      expiresAt: inDays(5),
    });
    expect(svc.status).toBe(403);
    const a = await s.createAgent([...TASK_SCOPES, 'agents.read']);
    const viaMcp = await s.agentTool(a, 'agents_principals_create', {
      purpose: 'x',
      scopes: TASK_SCOPES,
      expiresAt: inDays(5),
      idempotencyKey: randomUUID(),
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.body.code).toBe('forbidden');
  });

  it('agents reach the system only through MCP; the REST surface refuses their credential', async () => {
    const a = await s.createAgent(TASK_SCOPES);
    const tok = await s.issuer.issue({ sub: a.agentRef, tid: T_ALPHA, sid: a.credentialRef });
    const r = await s.rest(tok, 'GET', '/v1/synthetic-tasks');
    expect(r.statusCode).toBe(403);
  });
});

describe('A8 separated agent audit', () => {
  it('names the agent as actor and the sponsor as sponsor; two agents stay distinguishable', async () => {
    const a = await s.createAgent(TASK_SCOPES, 'agent one');
    const b = await s.createAgent(TASK_SCOPES, 'agent two');
    const ra = await s.agentTool(a, 'synthetic_tasks_create', create('from agent a'));
    const rb = await s.agentTool(b, 'synthetic_tasks_create', create('from agent b'));
    expect(ra.isError).toBe(false);
    expect(rb.isError).toBe(false);
    const { rows } = await s.db.admin.query<{ agent_ref: string; sponsor_ref: string; actor_id: string }>(
      `SELECT g.agent_ref, g.sponsor_ref, e.actor_id FROM cuspatlas.agent_audit_events g
       JOIN cuspatlas.audit_events e ON e.event_ref = g.event_ref
       WHERE g.agent_ref = ANY($1) ORDER BY g.occurred_at`,
      [[a.agentRef, b.agentRef]],
    );
    expect(rows.map((r) => r.agent_ref)).toStrictEqual([a.agentRef, b.agentRef]);
    for (const r of rows) {
      expect(r.actor_id).toBe(r.agent_ref);
      expect(r.sponsor_ref).toBe(SPONSOR);
      expect(r.actor_id).not.toBe(SPONSOR);
    }
    const listed = await s.call('humanAll', 'GET', `/v1/agents/audit?agentRef=${a.agentRef}`);
    expect(listed.status).toBe(200);
    const items = listed.body.items as Record<string, unknown>[];
    expect(items.length).toBe(1);
    expect(items[0]?.sponsorRef).toBe(SPONSOR);
    expect(listed.body.count).toStrictEqual({ exact: 1 });
    expect(listed.body.nextCursor).toBeNull();
  });

  it('a sponsor change is a new sponsorship; earlier actions keep the sponsor of record', async () => {
    const a = await s.createAgent(TASK_SCOPES);
    await s.agentTool(a, 'synthetic_tasks_create', create('before'));
    const other = await s.db.admin.query<{ id: string }>(
      `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES (gen_random_uuid(), 'human', 'agent-sponsor-two')
       RETURNING id`,
    );
    const sponsor2 = other.rows[0]?.id as string;
    await s.db.admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)`,
      [T_ALPHA, sponsor2, TASK_SCOPES],
    );
    const changed = await s.call('humanAll', 'POST', '/v1/agents/sponsors/change', {
      agentRef: a.agentRef,
      sponsorRef: sponsor2,
      expectedVersion: a.version,
    });
    expect(changed.status).toBe(200);
    await s.agentTool(a, 'synthetic_tasks_create', create('after'));
    const { rows } = await s.db.admin.query<{ sponsor_ref: string }>(
      'SELECT sponsor_ref FROM cuspatlas.agent_audit_events WHERE agent_ref = $1 ORDER BY occurred_at',
      [a.agentRef],
    );
    expect(rows.map((r) => r.sponsor_ref)).toStrictEqual([SPONSOR, sponsor2]);
    const sponsorships = await s.db.admin.query(
      'SELECT 1 FROM cuspatlas.agent_sponsorships WHERE agent_ref = $1',
      [a.agentRef],
    );
    expect(sponsorships.rowCount).toBe(2);
  });
});

describe('A8 suspension, rotation and revocation', () => {
  it('a suspended agent keeps its reads and loses its mutations', async () => {
    const a = await s.createAgent(TASK_SCOPES);
    const sus = await s.call('humanAll', 'POST', '/v1/agents/principals/suspend', {
      agentRef: a.agentRef,
      expectedVersion: a.version,
    });
    expect(sus.status).toBe(200);
    expect((await s.agentTool(a, 'synthetic_tasks_list', {})).isError).toBe(false);
    const w = await s.agentTool(a, 'synthetic_tasks_create', create('blocked'));
    expect(w.body.code).toBe('forbidden');
    const res = await s.call('humanAll', 'POST', '/v1/agents/principals/resume', {
      agentRef: a.agentRef,
      expectedVersion: sus.body.version,
    });
    expect(res.status).toBe(200);
    expect((await s.agentTool(a, 'synthetic_tasks_create', create('again'))).isError).toBe(false);
  });

  it('a rotated credential is unauthenticated; the new one works', async () => {
    const a = await s.createAgent(TASK_SCOPES);
    const rot = await s.call('humanAll', 'POST', '/v1/agents/credentials/rotate', {
      agentRef: a.agentRef,
      expectedVersion: a.version,
    });
    expect(rot.status).toBe(200);
    const fresh = (rot.body.data as { credentialRef: string }).credentialRef;
    expect(fresh).not.toBe(a.credentialRef);
    const old = await s.agentTool(a, 'synthetic_tasks_list', {});
    expect(old.body.code).toBe('unauthenticated');
    const ok = await s.agentTool({ ...a, credentialRef: fresh }, 'synthetic_tasks_list', {});
    expect(ok.isError).toBe(false);
  });

  it('revocation applies on the next call of an open session; the sponsor keeps working', async () => {
    const a = await s.createAgent(TASK_SCOPES);
    const client = await s.agentClient(a.agentRef, a.credentialRef);
    expect((await s.agentCall(client, 'synthetic_tasks_list', {})).isError).toBe(false);
    const rev = await s.call('humanAll', 'POST', '/v1/agents/principals/revoke', {
      agentRef: a.agentRef,
      expectedVersion: a.version,
      reason: 'synthetic_test',
    });
    expect(rev.status).toBe(200);
    const after = await s.agentCall(client, 'synthetic_tasks_list', {});
    expect(after.isError).toBe(true);
    expect(after.body.code).toBe('forbidden');
    expect((await s.call('humanAll', 'GET', '/v1/synthetic-tasks')).status).toBe(200);
    // Revocation is terminal.
    const resume = await s.call('humanAll', 'POST', '/v1/agents/principals/resume', {
      agentRef: a.agentRef,
      expectedVersion: rev.body.version,
    });
    expect(resume.status).toBe(409);
  });

  it('a stale expected version is refused and changes nothing', async () => {
    const a = await s.createAgent(TASK_SCOPES);
    const r = await s.call('humanAll', 'POST', '/v1/agents/principals/suspend', {
      agentRef: a.agentRef,
      expectedVersion: a.version + 5,
    });
    expect(r.status).toBe(409);
    expect((await s.agentTool(a, 'synthetic_tasks_create', create('still active'))).isError).toBe(false);
  });

  it('an expired agent is refused', async () => {
    const a = await s.createAgent(TASK_SCOPES);
    await s.db.admin.query(
      `UPDATE cuspatlas.agent_principals SET expires_at = now() - interval '1 minute' WHERE principal_id = $1`,
      [a.agentRef],
    );
    expect((await s.agentTool(a, 'synthetic_tasks_list', {})).body.code).toBe('forbidden');
  });

  it("a sponsor whose membership is revoked takes the sponsor's agents down with it", async () => {
    const sp = await s.db.admin.query<{ id: string }>(
      `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES (gen_random_uuid(), 'human', 'agent-sponsor-three')
       RETURNING id`,
    );
    const sponsor = sp.rows[0]?.id as string;
    await s.db.admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)`,
      [T_ALPHA, sponsor, [...TASK_SCOPES, 'agents.manage', 'agents.read']],
    );
    const a = await s.createAgent(TASK_SCOPES, 'sponsored by three', sponsor);
    expect((await s.agentTool(a, 'synthetic_tasks_list', {})).isError).toBe(false);
    await s.db.admin.query(
      'UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1 AND tenant_id = $2',
      [sponsor, T_ALPHA],
    );
    expect((await s.agentTool(a, 'synthetic_tasks_list', {})).body.code).toBe('forbidden');
  });

  it('work an agent queued before revocation is refused when the worker executes it', async () => {
    const a = await s.createAgent(TASK_SCOPES);
    const created = await s.agentTool(a, 'synthetic_tasks_create', create('queued by agent'));
    expect(created.isError).toBe(false);
    await s.call('humanAll', 'POST', '/v1/agents/principals/revoke', {
      agentRef: a.agentRef,
      expectedVersion: a.version,
      reason: 'synthetic_test',
    });
    const WORKER = randomUUID();
    await s.db.admin.query(`INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', $2)`, [
      WORKER,
      `agent-test-worker-${WORKER.slice(0, 8)}`,
    ]);
    await s.db.admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)`,
      [T_ALPHA, WORKER, ['outbox.deliver', ...TASK_SCOPES]],
    );
    const memberships = createMembershipSource(s.db.app);
    const worker = createWorker({
      workerPrincipalId: WORKER,
      withTenantTransaction: createTenantTransactionRunner(s.db.app),
      authorize: createAuthorize(memberships),
      memberships,
      attempts: createSecurityAttemptSink(s.db.sink),
      backoffSeconds: () => 0,
    });
    const provider = new FakeProvider();
    // Earlier tests queued events too: drain until the agent's event has been leased and decided.
    for (let i = 0; i < 40; i++) {
      await worker.runOnce(T_ALPHA, provider);
      const left = await s.db.admin.query(
        `SELECT 1 FROM cuspatlas.outbox_events WHERE actor_id = $1 AND state IN ('pending', 'leased')`,
        [a.agentRef],
      );
      if (left.rowCount === 0) break;
    }
    const { rows } = await s.db.admin.query<{ state: string }>(
      `SELECT state FROM cuspatlas.outbox_events WHERE actor_id = $1`,
      [a.agentRef],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.state === 'dead_letter' || r.state === 'pending' || r.state === 'retry')).toBe(
      true,
    );
    expect(rows.some((r) => r.state === 'delivered')).toBe(false);
    const denied = await s.db.admin.query(
      `SELECT 1 FROM cuspatlas.security_attempt_events WHERE actor_id = $1 AND reason_code = 'membership_inactive'`,
      [a.agentRef],
    );
    expect(denied.rowCount).toBeGreaterThan(0);
  });

  it('queued agent work whose consent was withdrawn is refused and dead-lettered by the worker', async () => {
    const a = await s.createAgent(TASK_SCOPES, 'consent withdrawn before delivery');
    const created = await s.agentTool(a, 'synthetic_tasks_create', create('queued under consent'));
    expect(created.isError).toBe(false);
    const c = await s.db.admin.query<{ id: string; version: number }>(
      `SELECT id, version FROM cuspatlas.agent_consents WHERE agent_ref = $1 AND state = 'active'`,
      [a.agentRef],
    );
    for (const row of c.rows) {
      const r = await s.call('humanAll', 'POST', '/v1/agents/consents/revoke', {
        consentRef: row.id,
        expectedVersion: row.version,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const WORKER = randomUUID();
    await s.db.admin.query(`INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', $2)`, [
      WORKER,
      `agent-test-worker-${WORKER.slice(0, 8)}`,
    ]);
    await s.db.admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)`,
      [T_ALPHA, WORKER, ['outbox.deliver', ...TASK_SCOPES]],
    );
    const memberships = createMembershipSource(s.db.app);
    const worker = createWorker({
      workerPrincipalId: WORKER,
      withTenantTransaction: createTenantTransactionRunner(s.db.app),
      authorize: createAuthorize(memberships),
      memberships,
      attempts: createSecurityAttemptSink(s.db.sink),
      backoffSeconds: () => 0,
    });
    const provider = new FakeProvider();
    for (let i = 0; i < 40; i++) {
      await worker.runOnce(T_ALPHA, provider);
      const left = await s.db.admin.query(
        `SELECT 1 FROM cuspatlas.outbox_events WHERE actor_id = $1 AND state IN ('pending', 'leased', 'retry')`,
        [a.agentRef],
      );
      if (left.rowCount === 0) break;
    }
    const { rows } = await s.db.admin.query<{ state: string }>(
      'SELECT state FROM cuspatlas.outbox_events WHERE actor_id = $1',
      [a.agentRef],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.state === 'dead_letter')).toBe(true);
    const denied = await s.db.admin.query(
      `SELECT 1 FROM cuspatlas.security_attempt_events WHERE actor_id = $1 AND reason_code = 'consent_missing'`,
      [a.agentRef],
    );
    expect(denied.rowCount).toBeGreaterThan(0);
  });

  it('agent lifecycle commands are human-only and need agents.manage', async () => {
    expect(M_SERVICE_ALL).not.toBe(M_HUMAN_ALL);
    const a = await s.createAgent(TASK_SCOPES);
    const svc = await s.call('serviceAll', 'POST', '/v1/agents/principals/revoke', {
      agentRef: a.agentRef,
      expectedVersion: a.version,
      reason: 'x',
    });
    expect(svc.status).toBe(403);
    const none = await s.call('humanNone', 'POST', '/v1/agents/principals/revoke', {
      agentRef: a.agentRef,
      expectedVersion: a.version,
      reason: 'x',
    });
    expect(none.status).toBe(403);
    const beta = await s.call('humanBeta', 'GET', `/v1/agents/principals/state?agentRef=${a.agentRef}`);
    expect(beta.status).toBe(404);
  });
});
describe('H3 agent credential and sponsor hardening', () => {
  it('the stored idempotency result of create and rotate never holds the credential reference', async () => {
    const key = randomUUID();
    const body = { purpose: 'replayed create', scopes: TASK_SCOPES, expiresAt: inDays(5) };
    const first = await s.call('humanAll', 'POST', '/v1/agents/principals', body, key);
    expect(first.status).toBe(201);
    const credential = (first.body.data as { credentialRef: string }).credentialRef;
    expect(credential).toMatch(/^agc-/);
    const replay = await s.call('humanAll', 'POST', '/v1/agents/principals', body, key);
    expect(replay.body.data).not.toHaveProperty('credentialRef');
    const agentRef = (first.body.data as { agentRef: string }).agentRef;
    const rotated = await s.call('humanAll', 'POST', '/v1/agents/credentials/rotate', {
      agentRef,
      expectedVersion: 1,
      reason: 'synthetic_test',
    });
    expect(rotated.status).toBe(200);
    const stored = await s.db.admin.query<{ result: unknown }>(
      `SELECT result FROM cuspatlas.command_idempotency
       WHERE operation IN ('agents.principals.create', 'agents.credentials.rotate')`,
    );
    expect(JSON.stringify(stored.rows)).not.toMatch(/agc-/);
  });

  it("a sponsor's lost scope leaves the agent at once (effective scopes = scope set ∩ sponsor's live scopes)", async () => {
    const sp = await s.db.admin.query<{ id: string }>(
      `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES (gen_random_uuid(), 'human', 'agent-sponsor-four')
       RETURNING id`,
    );
    const sponsor = sp.rows[0]?.id as string;
    await s.db.admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)`,
      [T_ALPHA, sponsor, [...TASK_SCOPES, 'agents.manage', 'agents.read']],
    );
    const a = await s.createAgent(TASK_SCOPES, 'sponsored by four', sponsor);
    expect((await s.agentTool(a, 'synthetic_tasks_create', create('before downgrade'))).isError).toBe(false);
    await s.db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = array_remove(scopes, 'syntheticTasks.write')
       WHERE principal_id = $1 AND tenant_id = $2`,
      [sponsor, T_ALPHA],
    );
    expect((await s.agentTool(a, 'synthetic_tasks_create', create('after downgrade'))).body.code).toBe(
      'forbidden',
    );
    expect((await s.agentTool(a, 'synthetic_tasks_list', {})).isError).toBe(false);
  });

  it('the database refuses a non-delegable or human-only scope for an agent whatever the caller sends', async () => {
    const ceiling = await s.db.admin.query<{ scope: string }>(
      'SELECT scope FROM cuspatlas.agent_scope_ceiling',
    );
    expect(new Set(ceiling.rows.map((r) => r.scope))).toStrictEqual(new Set(AGENT_SCOPE_CEILING));
    const run = createTenantTransactionRunner(s.db.app);
    const ctx = ctxFor(T_ALPHA, M_HUMAN_ALL, 'human', ['agents.manage']);
    for (const scope of ['agents.manage', 'clinical.sign', 'ai.review']) {
      await expect(
        run(ctx, (tx) =>
          tx.query('SELECT cuspatlas.agent_create($1, $2, $3, $4)', [
            'direct',
            [scope],
            inDays(2),
            'agc-direct',
          ]),
        ),
      ).rejects.toMatchObject({ code: 'P0422' });
    }
  });
});
