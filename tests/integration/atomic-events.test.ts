import { randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import { RefusalError, type SecurityAttemptSink } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { type CommandExecutor, executeDirect } from '@cuspatlas/domain';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { seedTenancy, T_ALPHA, T_BETA, TASK_A, TASK_B, USER_A1, USER_A4, USER_B1 } from './support/fixtures';
import { MARKER } from './support/marker';
import { createTestTokenIssuer, type TestTokenIssuer } from './support/test-token-issuer';

let db: TestDatabase;
let issuer: TestTokenIssuer;
const apps: FastifyInstance[] = [];
const tokens = { a1: '', a4: '', b1: '', a1AsBeta: '' };

interface AppOptions {
  readonly execute?: CommandExecutor;
  readonly attempts?: SecurityAttemptSink;
  readonly logLines?: string[];
  readonly level?: string;
}

async function appWith(o: AppOptions = {}): Promise<FastifyInstance> {
  const lines = o.logLines;
  const app = await buildApp({
    env: 'synthetic-test',
    logger: lines
      ? { level: o.level ?? 'trace', stream: { write: (l: string) => lines.push(l) } }
      : { level: 'silent' },
    identity: issuer.verifierConfig,
    membership: createMembershipSource(db.app),
    attempts: o.attempts ?? createSecurityAttemptSink(db.sink),
    tenantTransactions: createTenantTransactionRunner(db.app),
    ...(o.execute ? { execute: o.execute } : {}),
  });
  apps.push(app);
  return app;
}

function post(
  app: FastifyInstance,
  url: string,
  token: string | null,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      ...headers,
    },
    payload: JSON.stringify(body),
  });
}

const count = async (table: string, where = 'true', values: unknown[] = []) =>
  (await db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${table} WHERE ${where}`, values)).rows[0]
    .n as number;

const byCorrelation = async (table: string, correlationId: string) =>
  (await db.admin.query(`SELECT * FROM cuspatlas.${table} WHERE correlation_id = $1`, [correlationId])).rows;

const attemptsFor = async (correlationId: string) =>
  (
    await db.admin.query(
      `SELECT tenant_id, actor_id, operation, reason_code FROM cuspatlas.security_attempt_events
       WHERE correlation_id = $1`,
      [correlationId],
    )
  ).rows;

/** Runs SQL as the runtime role inside an explicit tenant context (test-only path). */
async function asRuntime<T>(
  tenantId: string,
  actorId: string,
  work: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await db.app.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)`,
      [tenantId, actorId],
    );
    return await work(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.query('DISCARD ALL').catch(() => undefined);
    c.release();
  }
}

async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return String((err as { code?: string }).code);
  }
  return 'ok';
}

beforeAll(async () => {
  db = await openTestDatabase('atomic_events');
  await seedTenancy(db.admin);
  issuer = await createTestTokenIssuer();
  tokens.a1 = await issuer.issue({ sub: USER_A1, tid: T_ALPHA });
  tokens.a4 = await issuer.issue({ sub: USER_A4, tid: T_ALPHA });
  tokens.b1 = await issuer.issue({ sub: USER_B1, tid: T_BETA });
  tokens.a1AsBeta = await issuer.issue({ sub: USER_A1, tid: T_BETA });
});

afterAll(async () => {
  for (const a of apps) await a.close();
  await db?.close();
});

describe('committed-change audit and outbox commit atomically with the domain change', () => {
  it('a successful create records task, audit and outbox with matching correlation and version', async () => {
    const app = await appWith();
    const res = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'sort the shelf' });
    expect(res.statusCode).toBe(201);
    const { correlationId, data, version } = res.json();
    const [audit] = await byCorrelation('audit_events', correlationId);
    const [outbox] = await byCorrelation('outbox_events', correlationId);
    expect(audit).toMatchObject({
      event_version: 1,
      tenant_id: T_ALPHA,
      actor_id: USER_A1,
      principal: 'human',
      operation: 'syntheticTasks.create',
      resource_type: 'syntheticTask',
      resource_ref: data.taskRef,
      resource_version: version,
    });
    expect(audit.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(outbox).toMatchObject({
      event_version: 1,
      tenant_id: T_ALPHA,
      actor_id: USER_A1,
      operation: 'syntheticTasks.create',
      aggregate_type: 'syntheticTask',
      aggregate_id: data.taskRef,
      aggregate_version: version,
      payload_class: 'field-names-only',
      state: 'pending',
      attempt: 0,
      max_attempts: 5,
      leased_until: null,
    });
    expect(outbox.trace_id).toBe(audit.trace_id);
    expect(outbox.payload).toStrictEqual({ changedFields: ['label', 'locationRef'] });
    expect(await count('audit_events', 'correlation_id = $1', [correlationId])).toBe(1);
    expect(await count('outbox_events', 'correlation_id = $1', [correlationId])).toBe(1);
  });

  it('a successful relabel records one audit and one outbox row at the new aggregate version', async () => {
    const app = await appWith();
    const made = (await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'v1' })).json();
    const res = await post(app, `/v1/synthetic-tasks/${made.data.taskRef}/relabel`, tokens.a1, {
      label: 'v2',
      expectedVersion: 1,
    });
    expect(res.statusCode).toBe(200);
    const { correlationId } = res.json();
    const [audit] = await byCorrelation('audit_events', correlationId);
    const [outbox] = await byCorrelation('outbox_events', correlationId);
    expect([audit.operation, audit.resource_version]).toStrictEqual(['syntheticTasks.relabel', 2]);
    expect([outbox.aggregate_id, outbox.aggregate_version]).toStrictEqual([made.data.taskRef, 2]);
    expect(outbox.payload).toStrictEqual({ changedFields: ['label'] });
  });

  it('a failure after the domain write rolls back task, audit and outbox together', async () => {
    const failing: CommandExecutor = async (ctx, envelope, tx, handler) => {
      await executeDirect(ctx, envelope, tx, handler);
      throw new Error('simulated fault after the domain write');
    };
    const app = await appWith({ execute: failing });
    const before = await Promise.all(
      ['synthetic_tasks', 'audit_events', 'outbox_events'].map((t) => count(t)),
    );
    const res = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'never kept' });
    expect([res.statusCode, res.json().code]).toStrictEqual([500, 'internal_error']);
    const after = await Promise.all(
      ['synthetic_tasks', 'audit_events', 'outbox_events'].map((t) => count(t)),
    );
    expect(after).toStrictEqual(before);
    const relabel = await post(app, `/v1/synthetic-tasks/${TASK_A}/relabel`, tokens.a1, {
      label: 'never kept',
      expectedVersion: 1,
    });
    expect(relabel.statusCode).toBe(500);
    const task = (
      await db.admin.query('SELECT label, version FROM cuspatlas.synthetic_tasks WHERE id = $1', [TASK_A])
    ).rows[0];
    expect(task).toStrictEqual({ label: 'alpha task', version: 1 });
  });

  it('if the audit insert fails, the domain change does not commit', async () => {
    const app = await appWith();
    const before = await Promise.all(
      ['synthetic_tasks', 'audit_events', 'outbox_events'].map((t) => count(t)),
    );
    await db.admin.query('REVOKE INSERT ON cuspatlas.audit_events FROM cuspatlas_app');
    try {
      const res = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'unaudited' });
      expect([res.statusCode, res.json().code]).toStrictEqual([500, 'internal_error']);
    } finally {
      await db.admin.query('GRANT INSERT ON cuspatlas.audit_events TO cuspatlas_app');
    }
    const after = await Promise.all(
      ['synthetic_tasks', 'audit_events', 'outbox_events'].map((t) => count(t)),
    );
    expect(after).toStrictEqual(before);
    const ok = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'audited again' });
    expect(ok.statusCode).toBe(201);
  });

  it('if the outbox insert fails, the domain change and its audit do not commit', async () => {
    const app = await appWith();
    const before = await Promise.all(
      ['synthetic_tasks', 'audit_events', 'outbox_events'].map((t) => count(t)),
    );
    await db.admin.query('REVOKE INSERT ON cuspatlas.outbox_events FROM cuspatlas_app');
    try {
      const res = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'no outbox' });
      expect(res.statusCode).toBe(500);
    } finally {
      await db.admin.query('GRANT INSERT ON cuspatlas.outbox_events TO cuspatlas_app');
    }
    const after = await Promise.all(
      ['synthetic_tasks', 'audit_events', 'outbox_events'].map((t) => count(t)),
    );
    expect(after).toStrictEqual(before);
  });
});

describe('protected access to audit and outbox (runtime role)', () => {
  it('RLS is enabled and forced; the runtime role has no UPDATE/DELETE/TRUNCATE on audit', async () => {
    const { rows } = await db.admin.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relnamespace = 'cuspatlas'::regnamespace AND relname IN ('audit_events', 'outbox_events')
       ORDER BY relname`,
    );
    expect(rows).toStrictEqual([
      { relname: 'audit_events', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'outbox_events', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const privs = await db.app.query(
      `SELECT has_table_privilege('cuspatlas.audit_events', 'UPDATE') AS au,
              has_table_privilege('cuspatlas.audit_events', 'DELETE') AS ad,
              has_table_privilege('cuspatlas.audit_events', 'TRUNCATE') AS at,
              has_table_privilege('cuspatlas.outbox_events', 'DELETE') AS od,
              has_table_privilege('cuspatlas.outbox_events', 'TRUNCATE') AS ot,
              has_column_privilege('cuspatlas.outbox_events', 'state', 'UPDATE') AS os,
              has_column_privilege('cuspatlas.outbox_events', 'payload', 'UPDATE') AS op,
              has_column_privilege('cuspatlas.outbox_events', 'tenant_id', 'UPDATE') AS ott`,
    );
    expect(privs.rows[0]).toStrictEqual({
      au: false,
      ad: false,
      at: false,
      od: false,
      ot: false,
      os: true,
      op: false,
      ott: false,
    });
  });

  it('the runtime role cannot update or delete audit rows, even its own tenant', async () => {
    const app = await appWith();
    const res = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'immutable' });
    const { correlationId } = res.json();
    await asRuntime(T_ALPHA, USER_A1, async (c) => {
      expect(
        await sqlState(
          c.query(`UPDATE cuspatlas.audit_events SET operation = 'x.y' WHERE correlation_id = $1`, [
            correlationId,
          ]),
        ),
      ).toBe('42501');
    });
    await asRuntime(T_ALPHA, USER_A1, async (c) => {
      expect(
        await sqlState(
          c.query('DELETE FROM cuspatlas.audit_events WHERE correlation_id = $1', [correlationId]),
        ),
      ).toBe('42501');
    });
    await asRuntime(T_ALPHA, USER_A1, async (c) => {
      expect(await sqlState(c.query('TRUNCATE cuspatlas.audit_events'))).toBe('42501');
    });
    await asRuntime(T_ALPHA, USER_A1, async (c) => {
      expect(
        await sqlState(
          c.query('DELETE FROM cuspatlas.outbox_events WHERE correlation_id = $1', [correlationId]),
        ),
      ).toBe('42501');
    });
    await asRuntime(T_ALPHA, USER_A1, async (c) => {
      expect(
        await sqlState(
          c.query(`UPDATE cuspatlas.outbox_events SET payload = '{}' WHERE correlation_id = $1`, [
            correlationId,
          ]),
        ),
      ).toBe('42501');
    });
    // Append-only also binds the owner: a trigger refuses UPDATE/DELETE on audit rows.
    expect(
      await sqlState(
        db.admin.query(`UPDATE cuspatlas.audit_events SET operation = 'x.y' WHERE correlation_id = $1`, [
          correlationId,
        ]),
      ),
    ).not.toBe('ok');
    expect(await count('audit_events', 'correlation_id = $1', [correlationId])).toBe(1);
  });

  it('the runtime role sees only its tenant and cannot forge tenant or actor on insert', async () => {
    const app = await appWith();
    await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'alpha change' });
    await post(app, '/v1/synthetic-tasks', tokens.b1, { label: 'beta change' });
    // A batch 3 hardening: the runtime role reads no audit row at all (only the definer audit search does).
    const seen = await asRuntime(T_BETA, USER_B1, async (c) => {
      const outbox = (await c.query('SELECT DISTINCT tenant_id FROM cuspatlas.outbox_events')).rows;
      return {
        audit: await sqlState(c.query('SELECT DISTINCT tenant_id FROM cuspatlas.audit_events')),
        outbox,
      };
    });
    expect(seen).toStrictEqual({ audit: '42501', outbox: [{ tenant_id: T_BETA }] });
    expect(await sqlState(db.app.query('SELECT count(*)::int AS n FROM cuspatlas.audit_events'))).toBe(
      '42501',
    );

    const forge = (tenant: string, actor: string) =>
      asRuntime(T_BETA, USER_B1, (c) =>
        sqlState(
          c.query(
            `INSERT INTO cuspatlas.audit_events (event_ref, tenant_id, actor_id, principal, operation,
               resource_type, resource_ref, resource_version, correlation_id, trace_id, span_id, occurred_at)
             VALUES (gen_random_uuid(), $1, $2, 'human', 'syntheticTasks.create', 'syntheticTask',
               $3, 1, gen_random_uuid(), repeat('a', 32), repeat('b', 16), now())`,
            [tenant, actor, TASK_B],
          ),
        ),
      );
    expect(await forge(T_ALPHA, USER_B1)).toBe('42501');
    expect(await forge(T_BETA, USER_A1)).toBe('42501');
  });
});

describe('payload minimization and log privacy', () => {
  it('captured logs at trace level exclude payloads and the marker; audit/outbox rows never carry it', async () => {
    const lines: string[] = [];
    const app = await appWith({ logLines: lines, level: 'trace' });
    const made = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: `${MARKER} label` });
    expect(made.statusCode).toBe(201);
    const relabel = await post(app, `/v1/synthetic-tasks/${made.json().data.taskRef}/relabel`, tokens.a1, {
      label: `${MARKER} again`,
      expectedVersion: 1,
    });
    expect(relabel.statusCode).toBe(200);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).not.toContain(MARKER);
      expect(l).not.toContain('changedFields');
      expect(l).not.toContain('"payload"');
    }
    for (const table of ['audit_events', 'outbox_events']) {
      const { rows } = await db.admin.query(`SELECT row_to_json(e)::text AS j FROM cuspatlas.${table} e`);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.j).not.toContain(MARKER);
    }
  });
});

describe('independent security-attempt path', () => {
  it('a denial raised after a domain write rolls the write back but its attempt row survives', async () => {
    const denyAfterWrite: CommandExecutor = async (ctx, envelope, tx, handler) => {
      await executeDirect(ctx, envelope, tx, handler);
      throw new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });
    };
    const app = await appWith({ execute: denyAfterWrite });
    const before = await Promise.all(
      ['synthetic_tasks', 'audit_events', 'outbox_events'].map((t) => count(t)),
    );
    const res = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'rolled back' });
    expect(res.statusCode).toBe(403);
    const { correlationId } = res.json();
    const after = await Promise.all(
      ['synthetic_tasks', 'audit_events', 'outbox_events'].map((t) => count(t)),
    );
    expect(after).toStrictEqual(before);
    expect(await attemptsFor(correlationId)).toStrictEqual([
      {
        tenant_id: T_ALPHA,
        actor_id: USER_A1,
        operation: 'syntheticTasks.create',
        reason_code: 'location_denied',
      },
    ]);
  });

  it('a policy denial writes an attempt row and no audit or outbox row', async () => {
    const app = await appWith();
    const res = await post(app, '/v1/synthetic-tasks', tokens.a4, { label: 'read-only member' });
    expect(res.statusCode).toBe(403);
    const { correlationId } = res.json();
    expect(await attemptsFor(correlationId)).toStrictEqual([
      {
        tenant_id: T_ALPHA,
        actor_id: USER_A4,
        operation: 'syntheticTasks.create',
        reason_code: 'scope_missing',
      },
    ]);
    expect(await byCorrelation('audit_events', correlationId)).toStrictEqual([]);
    expect(await byCorrelation('outbox_events', correlationId)).toStrictEqual([]);
  });

  it('an unauthenticated attempt has null tenant and actor', async () => {
    const app = await appWith();
    const res = await post(
      app,
      '/v1/synthetic-tasks',
      null,
      { label: 'anonymous' },
      { 'x-tenant-id': T_ALPHA },
    );
    expect(res.statusCode).toBe(401);
    const { correlationId } = res.json();
    expect(await attemptsFor(correlationId)).toStrictEqual([
      { tenant_id: null, actor_id: null, operation: 'syntheticTasks.create', reason_code: 'token_missing' },
    ]);
    expect(await byCorrelation('audit_events', correlationId)).toStrictEqual([]);
  });

  it('a forged tenant is never recorded: the attempt carries the authenticated tenant or none', async () => {
    const app = await appWith();
    const res = await post(
      app,
      `/v1/synthetic-tasks/${TASK_B}/relabel`,
      tokens.a1,
      { label: 'cross tenant', expectedVersion: 1 },
      { 'x-tenant-id': T_BETA },
    );
    expect(res.statusCode).toBe(404);
    expect(await attemptsFor(res.json().correlationId)).toStrictEqual([
      {
        tenant_id: T_ALPHA,
        actor_id: USER_A1,
        operation: 'syntheticTasks.relabel',
        reason_code: 'resource_hidden_or_missing',
      },
    ]);
    // A signed token naming a tenant where the principal has no membership row: tenant stays null.
    const claim = await post(app, '/v1/synthetic-tasks', tokens.a1AsBeta, { label: 'claim beta' });
    expect(claim.statusCode).toBe(403);
    expect(await attemptsFor(claim.json().correlationId)).toStrictEqual([
      {
        tenant_id: null,
        actor_id: USER_A1,
        operation: 'syntheticTasks.create',
        reason_code: 'membership_inactive',
      },
    ]);
    const b = (
      await db.admin.query('SELECT label, version FROM cuspatlas.synthetic_tasks WHERE id = $1', [TASK_B])
    ).rows[0];
    expect(b).toStrictEqual({ label: 'beta task', version: 1 });
    expect(await count('audit_events', 'tenant_id = $1 AND actor_id = $2', [T_BETA, USER_A1])).toBe(0);
  });

  it('a duplicate attemptRef is rejected; separate retries produce separate attempt rows', async () => {
    const ref = randomUUID();
    const insert = async () => {
      const c = await db.sink.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('cuspatlas.attempt_tenant_id', '', true)`);
        await c.query(
          `INSERT INTO cuspatlas.security_attempt_events
             (attempt_ref, correlation_id, tenant_id, actor_id, operation, reason_code, occurred_at)
           VALUES ($1, gen_random_uuid(), NULL, NULL, 'syntheticTasks.create', 'token_missing', now())`,
          [ref],
        );
        await c.query('COMMIT');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.query('DISCARD ALL').catch(() => undefined);
        c.release();
      }
    };
    expect(await sqlState(insert())).toBe('ok');
    expect(await sqlState(insert())).toBe('23505');
    expect(await count('security_attempt_events', 'attempt_ref = $1', [ref])).toBe(1);

    const app = await appWith();
    const key = { 'idempotency-key': 'same-business-key' };
    const first = await post(app, '/v1/synthetic-tasks', tokens.a4, { label: 'retry' }, key);
    const second = await post(app, '/v1/synthetic-tasks', tokens.a4, { label: 'retry' }, key);
    expect([first.statusCode, second.statusCode]).toStrictEqual([403, 403]);
    const rows = await db.admin.query(
      `SELECT attempt_ref FROM cuspatlas.security_attempt_events WHERE correlation_id = ANY ($1::uuid[])`,
      [[first.json().correlationId, second.json().correlationId]],
    );
    expect(rows.rowCount).toBe(2);
    expect(new Set(rows.rows.map((r) => r.attempt_ref)).size).toBe(2);
  });

  it('sink outage keeps the denial closed with a safe 503 and alert; recovery records again', async () => {
    const real = createSecurityAttemptSink(db.sink);
    let down = true;
    const flaky: SecurityAttemptSink = {
      record: (a) => (down ? Promise.reject(new Error(`sink unreachable ${MARKER}`)) : real.record(a)),
    };
    const lines: string[] = [];
    const app = await appWith({ attempts: flaky, logLines: lines, level: 'info' });
    const before = await count('synthetic_tasks');
    const outage = await post(app, '/v1/synthetic-tasks', tokens.a4, { label: 'during outage' });
    expect(outage.statusCode).toBe(503);
    const { correlationId, ...rest } = outage.json();
    expect(rest).toStrictEqual({ code: 'service_unavailable', retryable: true });
    expect(await attemptsFor(correlationId)).toStrictEqual([]);
    expect(lines.some((l) => l.includes('security_attempt_sink_unavailable'))).toBe(true);
    for (const l of lines) expect(l).not.toContain(MARKER);

    down = false;
    const recovered = await post(app, '/v1/synthetic-tasks', tokens.a4, { label: 'after outage' });
    expect(recovered.statusCode).toBe(403);
    expect(await attemptsFor(recovered.json().correlationId)).toHaveLength(1);
    expect(await count('synthetic_tasks')).toBe(before);
    expect(
      await count('audit_events', 'correlation_id = ANY ($1::uuid[])', [
        [correlationId, recovered.json().correlationId],
      ]),
    ).toBe(0);
  });
});
