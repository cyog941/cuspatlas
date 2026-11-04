import { buildApp } from '@cuspatlas/api';
import { type ActorContext, isRefusalError, type RefusalError } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAuthorize, withAttemptRecording } from '@cuspatlas/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import {
  ctxFor,
  SVC_A1,
  SVC_B1,
  seedTenancy,
  T_ALPHA,
  T_BETA,
  TASK_A,
  TASK_B,
  USER_A1,
  USER_A2,
  USER_A3,
  USER_B1,
  USER_NONE,
} from './support/fixtures';
import { MARKER } from './support/marker';
import {
  createTestTokenIssuer,
  TEST_AUDIENCE,
  TEST_ISSUER,
  type TestTokenIssuer,
} from './support/test-token-issuer';

let db: TestDatabase;
let issuer: TestTokenIssuer;
let app: FastifyInstance;
let logLines: string[];

async function refusalOf(p: Promise<unknown>): Promise<RefusalError> {
  try {
    await p;
  } catch (err) {
    if (isRefusalError(err)) return err;
    throw err;
  }
  throw new Error('expected a refusal but the operation succeeded');
}

async function attempts(correlationId: string) {
  const { rows } = await db.admin.query(
    `SELECT tenant_id, actor_id, operation, reason_code FROM cuspatlas.security_attempt_events
     WHERE correlation_id = $1`,
    [correlationId],
  );
  return rows;
}

beforeAll(async () => {
  db = await openTestDatabase('tenant_isolation');
  await seedTenancy(db.admin);
  issuer = await createTestTokenIssuer();
  logLines = [];
  app = await buildApp({
    env: 'synthetic-test',
    logger: { level: 'info', stream: { write: (l: string) => logLines.push(l) } },
    identity: issuer.verifierConfig,
    membership: createMembershipSource(db.app),
    attempts: createSecurityAttemptSink(db.sink),
  });
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('runtime database role', () => {
  it('application connections run as cuspatlas_app, which is NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB', async () => {
    const { rows } = await db.app.query(
      `SELECT current_user AS who, r.rolsuper, r.rolbypassrls, r.rolinherit, r.rolcreatedb, r.rolcreaterole
       FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows).toStrictEqual([
      {
        who: 'cuspatlas_app',
        rolsuper: false,
        rolbypassrls: false,
        rolinherit: false,
        rolcreatedb: false,
        rolcreaterole: false,
      },
    ]);
  });

  it('RLS is enabled and forced on every application table', async () => {
    const { rows } = await db.app.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'cuspatlas' AND c.relkind = 'r'
       ORDER BY c.relname`,
    );
    expect(rows.map((r) => r.relname)).toStrictEqual([
      'action_proposal_provenance',
      'action_proposals',
      'appointment_attendance_transitions',
      'appointment_lifecycle_events',
      'appointment_overrides',
      'appointment_request_transitions',
      'appointment_requests',
      'appointments',
      'audit_events',
      'billing_charges',
      'billing_journal_entries',
      'billing_journal_lines',
      'billing_settings',
      'command_idempotency',
      'delivery_receipts',
      'memberships',
      'outbox_events',
      'patient_merge_moves',
      'patient_merge_reversals',
      'patient_merges',
      'patient_policy_settings',
      'patient_relationships',
      'patient_status_history',
      'patients',
      'principals',
      'scheduling_attendance_reasons',
      'scheduling_availability_versions',
      'scheduling_holds',
      'scheduling_locations',
      'scheduling_occupancy',
      'scheduling_policy_settings',
      'scheduling_resources',
      'scheduling_time_blocks',
      'security_attempt_events',
      'sensitive_read_events',
      'synthetic_tasks',
      'tenants',
    ]);
    for (const r of rows)
      expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toStrictEqual([r.relname, true, true]);
  });

  it('without tenant context the runtime role sees nothing (default deny)', async () => {
    for (const t of [
      'tenants',
      'principals',
      'memberships',
      'synthetic_tasks',
      'audit_events',
      'outbox_events',
      'command_idempotency',
      'delivery_receipts',
      'action_proposals',
      'action_proposal_provenance',
      'patients',
      'patient_status_history',
      'sensitive_read_events',
      'patient_policy_settings',
      'patient_relationships',
      'patient_merges',
      'patient_merge_moves',
      'patient_merge_reversals',
      'scheduling_locations',
      'scheduling_resources',
      'scheduling_availability_versions',
      'scheduling_time_blocks',
      'scheduling_occupancy',
      'scheduling_busy',
      'scheduling_policy_settings',
      'appointment_requests',
      'appointment_request_transitions',
      'appointments',
      'scheduling_holds',
      'appointment_overrides',
      'appointment_lifecycle_events',
      'appointment_attendance_transitions',
      'scheduling_attendance_reasons',
      // B1 journal.
      'billing_settings',
      'billing_charges',
      'billing_journal_entries',
      'billing_journal_lines',
    ]) {
      const { rows } = await db.app.query(`SELECT count(*)::int AS n FROM cuspatlas.${t}`);
      expect([t, rows[0].n]).toStrictEqual([t, 0]);
    }
  });

  it('the runtime role cannot delete tasks, write memberships or read security attempts', async () => {
    const tx = createTenantTransactionRunner(db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    for (const sql of [
      `DELETE FROM cuspatlas.synthetic_tasks WHERE id = '${TASK_A}'`,
      `UPDATE cuspatlas.memberships SET revoked_at = NULL`,
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ('${T_BETA}', '${USER_A1}', '{}')`,
      'SELECT count(*) FROM cuspatlas.security_attempt_events',
    ]) {
      await expect(tx(ctx, (t) => t.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('tenant isolation under the runtime role', () => {
  it('tenant A cannot read tenant B rows', async () => {
    const tx = createTenantTransactionRunner(db.app);
    const rows = await tx(ctxFor(T_ALPHA, USER_A1, 'human'), async (t) => {
      const byId = await t.query('SELECT id FROM cuspatlas.synthetic_tasks WHERE id = $1', [TASK_B]);
      const all = await t.query<{ tenant_id: string }>('SELECT tenant_id FROM cuspatlas.synthetic_tasks');
      return { byId: byId.rowCount, tenants: [...new Set(all.rows.map((r) => r.tenant_id))] };
    });
    expect(rows).toStrictEqual({ byId: 0, tenants: [T_ALPHA] });
  });

  it('tenant A cannot update, re-home or insert into tenant B', async () => {
    const tx = createTenantTransactionRunner(db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    const updated = await tx(ctx, (t) =>
      t.query(`UPDATE cuspatlas.synthetic_tasks SET label = 'taken' WHERE id = $1`, [TASK_B]),
    );
    expect(updated.rowCount).toBe(0);
    await expect(
      tx(ctx, (t) =>
        t.query(`INSERT INTO cuspatlas.synthetic_tasks (tenant_id, label, created_by) VALUES ($1, 'x', $2)`, [
          T_BETA,
          USER_A1,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      tx(ctx, (t) =>
        t.query('UPDATE cuspatlas.synthetic_tasks SET tenant_id = $1 WHERE id = $2', [T_BETA, TASK_A]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const { rows } = await db.admin.query(
      'SELECT label, tenant_id FROM cuspatlas.synthetic_tasks WHERE id = ANY($1)',
      [[TASK_A, TASK_B]],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { label: 'beta task', tenant_id: T_BETA },
        { label: 'alpha task', tenant_id: T_ALPHA },
      ]),
    );
  });

  it('a forged resource tenant is denied by policy and the denial is recorded without fabricated identity', async () => {
    const authorize = createAuthorize(createMembershipSource(db.app));
    const sink = createSecurityAttemptSink(db.sink);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    const err = await refusalOf(
      withAttemptRecording(
        { sink, alert: () => undefined },
        {
          correlationId: ctx.correlationId,
          tenantId: ctx.tenantId,
          actorId: ctx.actorId,
          operation: 'syntheticTasks.read',
        },
        () => authorize(ctx, 'syntheticTasks.read', { tenantId: T_BETA, id: TASK_B }),
      ),
    );
    expect(err.code).toBe('forbidden');
    expect(await attempts(ctx.correlationId)).toStrictEqual([
      {
        tenant_id: T_ALPHA,
        actor_id: USER_A1,
        operation: 'syntheticTasks.read',
        reason_code: 'tenant_mismatch',
      },
    ]);
  });

  it('a forged actor context (A1 claiming tenant B) is denied by authorize and by the transaction recheck', async () => {
    const authorize = createAuthorize(createMembershipSource(db.app));
    const forged = ctxFor(T_BETA, USER_A1, 'human');
    expect(
      (await refusalOf(authorize(forged, 'syntheticTasks.read', { tenantId: T_BETA, id: TASK_B }))).code,
    ).toBe('forbidden');
    const tx = createTenantTransactionRunner(db.app);
    let ran = false;
    const err = await refusalOf(
      tx(forged, async () => {
        ran = true;
      }),
    );
    expect([err.code, ran]).toStrictEqual(['forbidden', false]);
  });

  it('a revoked membership is denied even though the context was valid when built', async () => {
    const authorize = createAuthorize(createMembershipSource(db.app));
    expect(
      (
        await refusalOf(
          authorize(ctxFor(T_ALPHA, USER_A2, 'human'), 'syntheticTasks.read', {
            tenantId: T_ALPHA,
            id: TASK_A,
          }),
        )
      ).reasonCode,
    ).toBe('membership_inactive');

    const ctx = ctxFor(T_ALPHA, USER_A3, 'human', ['syntheticTasks.read', 'syntheticTasks.write']);
    await authorize(ctx, 'syntheticTasks.read', { tenantId: T_ALPHA, id: TASK_A });
    await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1', [
      USER_A3,
    ]);
    try {
      const err = await refusalOf(authorize(ctx, 'syntheticTasks.read', { tenantId: T_ALPHA, id: TASK_A }));
      expect([err.code, err.reasonCode]).toStrictEqual(['forbidden', 'membership_inactive']);
      const tx = createTenantTransactionRunner(db.app);
      expect((await refusalOf(tx(ctx, async () => undefined))).code).toBe('forbidden');
    } finally {
      await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = NULL WHERE principal_id = $1', [
        USER_A3,
      ]);
    }
  });

  it('a service principal cannot satisfy a human-only policy, even with the scope or a forged kind', async () => {
    const authorize = createAuthorize(createMembershipSource(db.app));
    const res = { tenantId: T_ALPHA, id: TASK_A };
    const svc = ctxFor(T_ALPHA, SVC_A1, 'service');
    expect((await refusalOf(authorize(svc, 'syntheticTasks.approve', res))).reasonCode).toBe(
      'principal_kind_denied',
    );
    const posingAsHuman: ActorContext = { ...svc, principal: 'human' };
    expect((await refusalOf(authorize(posingAsHuman, 'syntheticTasks.approve', res))).reasonCode).toBe(
      'principal_kind_denied',
    );
    await expect(
      authorize(ctxFor(T_ALPHA, USER_A1, 'human'), 'syntheticTasks.approve', res),
    ).resolves.toBeDefined();
    await expect(authorize(svc, 'syntheticTasks.read', res)).resolves.toBeDefined();
  });

  it('missing scope is denied using live membership scopes, not the context claim', async () => {
    const authorize = createAuthorize(createMembershipSource(db.app));
    const inflated = ctxFor(T_ALPHA, USER_A3, 'human', [
      'syntheticTasks.read',
      'syntheticTasks.write',
      'syntheticTasks.approve',
    ]);
    expect(
      (await refusalOf(authorize(inflated, 'syntheticTasks.approve', { tenantId: T_ALPHA, id: TASK_A })))
        .reasonCode,
    ).toBe('scope_missing');
  });
});

describe('pooled connections never carry tenant context', () => {
  const probe = `SELECT coalesce(current_setting('cuspatlas.tenant_id', true), '') AS tenant,
                        coalesce(current_setting('cuspatlas.actor_id', true), '') AS actor,
                        (SELECT count(*)::int FROM cuspatlas.synthetic_tasks) AS visible,
                        pg_backend_pid() AS pid`;

  it('sequential reuse of the same physical connection starts clean, even after a session-level smuggle', async () => {
    const pool = db.appPool(1);
    const tx = createTenantTransactionRunner(pool);
    const pidBefore = (await pool.query(probe)).rows[0].pid;
    await tx(ctxFor(T_ALPHA, USER_A1, 'human'), async (t) => {
      // Direct context manipulation is refused by the statement guard...
      await expect(
        t.query(`SELECT set_config('cuspatlas.tenant_id', $1, false)`, [T_ALPHA]),
      ).rejects.toThrow();
      // ...and session-lived state that slips through is discarded on release (DISCARD ALL).
      await t.query(
        `CREATE TEMP TABLE smuggled AS SELECT current_setting('cuspatlas.tenant_id', true) AS tenant`,
      );
    });
    const after = (await pool.query(`${probe}, to_regclass('pg_temp.smuggled')::text AS smuggled`)).rows[0];
    expect(after).toStrictEqual({ tenant: '', actor: '', visible: 0, pid: pidBefore, smuggled: null });

    const seenByB = await tx(ctxFor(T_BETA, USER_B1, 'human'), async (t) => {
      const r = await t.query<{ tenant_id: string }>(
        'SELECT DISTINCT tenant_id FROM cuspatlas.synthetic_tasks',
      );
      return r.rows.map((x) => x.tenant_id);
    });
    expect(seenByB).toStrictEqual([T_BETA]);
    expect((await pool.query(probe)).rows[0]).toMatchObject({ tenant: '', actor: '', visible: 0 });
  });

  it('a failed transaction also leaves the connection clean', async () => {
    const pool = db.appPool(1);
    const tx = createTenantTransactionRunner(pool);
    await expect(
      tx(ctxFor(T_ALPHA, USER_A1, 'human'), async (t) => {
        await t.query('SELECT 1/0');
      }),
    ).rejects.toBeDefined();
    expect((await pool.query(probe)).rows[0]).toMatchObject({ tenant: '', actor: '', visible: 0 });
  });

  it('concurrent interleaved transactions for A and B each see only their own tenant', async () => {
    const pool = db.appPool(3);
    const tx = createTenantTransactionRunner(pool);
    const jobs = Array.from({ length: 40 }, (_, i) => {
      const alpha = i % 2 === 0;
      const ctx = alpha ? ctxFor(T_ALPHA, USER_A1, 'human') : ctxFor(T_BETA, SVC_B1, 'service');
      return tx(ctx, async (t) => {
        await t.query('SELECT count(*) FROM generate_series(1, $1::int)', [(((i * 7) % 5) + 1) * 20000]);
        const r = await t.query<{ tenant: string; actor: string; tenants: string[] }>(
          `SELECT current_setting('cuspatlas.tenant_id', true) AS tenant,
                  current_setting('cuspatlas.actor_id', true) AS actor,
                  array(SELECT DISTINCT tenant_id::text FROM cuspatlas.synthetic_tasks) AS tenants`,
        );
        return { expected: ctx, seen: r.rows[0] };
      });
    });
    const results = await Promise.all(jobs);
    for (const { expected, seen } of results) {
      expect(seen).toStrictEqual({
        tenant: expected.tenantId,
        actor: expected.actorId,
        tenants: [expected.tenantId],
      });
    }
    for (let i = 0; i < 3; i += 1) {
      expect((await pool.query(probe)).rows[0]).toMatchObject({ tenant: '', actor: '', visible: 0 });
    }
  });
});

describe('token verification and live membership at the HTTP boundary', () => {
  const session = (token?: string, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: '/v1/session',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    });

  it('a valid token yields a server-derived context; caller tenant headers are ignored', async () => {
    const res = await session(await issuer.issue({ sub: USER_A1, tid: T_ALPHA }), {
      'x-tenant-id': T_BETA,
      'x-cuspatlas-tenant': T_BETA,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({
      tenantRef: T_ALPHA,
      principalRef: USER_A1,
      principal: 'human',
      scopes: ['syntheticTasks.read', 'syntheticTasks.write', 'syntheticTasks.approve'],
    });
  });

  it('expired, not-yet-valid, wrong-audience, wrong-issuer, bad-signature, malformed and missing tokens are 401', async () => {
    const bad = [
      await issuer.issue({ sub: USER_A1, tid: T_ALPHA, expiresInSec: -120 }),
      await issuer.issue({ sub: USER_A1, tid: T_ALPHA, notBeforeSec: 600 }),
      await issuer.issue({ sub: USER_A1, tid: T_ALPHA, audience: 'urn:cuspatlas:api:other' }),
      await issuer.issue({ sub: USER_A1, tid: T_ALPHA, issuer: 'urn:cuspatlas:someone-else' }),
      await issuer.issue({ sub: USER_A1, tid: T_ALPHA, foreignKey: true }),
      `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: USER_A1, tid: T_ALPHA, iss: TEST_ISSUER, aud: TEST_AUDIENCE })).toString('base64url')}.`,
      MARKER,
      undefined,
    ];
    for (const token of bad) {
      const res = await session(token);
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(Object.keys(body).sort()).toStrictEqual(['code', 'correlationId', 'retryable']);
      expect(body.code).toBe('unauthenticated');
      expect(res.body).not.toContain(MARKER);
      const recorded = await attempts(body.correlationId);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ tenant_id: null, actor_id: null, operation: 'session.read' });
    }
    for (const l of logLines) expect(l).not.toContain(MARKER);
  });

  it('a revoked membership is 403 despite a valid unexpired token, and is recorded against the verified actor', async () => {
    const res = await session(await issuer.issue({ sub: USER_A2, tid: T_ALPHA }));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('forbidden');
    expect(await attempts(res.json().correlationId)).toStrictEqual([
      {
        tenant_id: T_ALPHA,
        actor_id: USER_A2,
        operation: 'session.read',
        reason_code: 'membership_inactive',
      },
    ]);
  });

  it('a token naming a tenant without membership, or an unknown principal, is 403 with no fabricated tenant', async () => {
    for (const [sub, tid] of [
      [USER_A1, T_BETA],
      [USER_NONE, T_ALPHA],
    ] as const) {
      const res = await session(await issuer.issue({ sub, tid }));
      expect(res.statusCode).toBe(403);
      const recorded = await attempts(res.json().correlationId);
      expect(recorded).toStrictEqual([
        { tenant_id: null, actor_id: sub, operation: 'session.read', reason_code: 'membership_inactive' },
      ]);
    }
  });
});

describe('test issuer containment', () => {
  it('the test issuer cannot be created outside CUSPATLAS_ENV=synthetic-test', async () => {
    await expect(createTestTokenIssuer({ CUSPATLAS_ENV: 'development' })).rejects.toThrow(/synthetic-test/);
    await expect(createTestTokenIssuer({})).rejects.toThrow(/synthetic-test/);
  });

  it('the server refuses to boot with the test issuer in any other environment', async () => {
    for (const env of ['development', 'production'] as const) {
      await expect(
        buildApp({
          env,
          identity: issuer.verifierConfig,
          membership: createMembershipSource(db.app),
          attempts: createSecurityAttemptSink(db.sink),
        }),
      ).rejects.toThrow(/test issuer/i);
      await expect(
        buildApp({
          env,
          identity: { ...issuer.verifierConfig, testOnly: false },
          membership: createMembershipSource(db.app),
          attempts: createSecurityAttemptSink(db.sink),
        }),
      ).rejects.toThrow(/test issuer/i);
    }
  });
});
