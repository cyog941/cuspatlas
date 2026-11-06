import { randomUUID } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import { type CommandEnvelope, isRefusalError } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  type CommandExecutor,
  createAuthorize,
  createSyntheticTaskService,
  executeDirect,
} from '@cuspatlas/domain';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import {
  ctxFor,
  SVC_B1,
  seedTenancy,
  T_ALPHA,
  T_BETA,
  TASK_A,
  TASK_A_NORTH,
  TASK_A_SOUTH,
  TASK_B,
  USER_A1,
  USER_A3,
  USER_A4,
} from './support/fixtures';
import { MARKER } from './support/marker';
import { createTestTokenIssuer, type TestTokenIssuer } from './support/test-token-issuer';

let db: TestDatabase;
let issuer: TestTokenIssuer;
let app: FastifyInstance;
let logLines: string[];
const tokens: Record<string, string> = {};

function deps(sinkPool: pg.Pool) {
  return {
    env: 'synthetic-test' as const,
    logger: { level: 'info', stream: { write: (l: string) => logLines.push(l) } },
    identity: issuer.verifierConfig,
    membership: createMembershipSource(db.app),
    attempts: createSecurityAttemptSink(sinkPool),
    tenantTransactions: createTenantTransactionRunner(db.app),
  };
}

beforeAll(async () => {
  db = await openTestDatabase('transport_policy');
  await seedTenancy(db.admin);
  issuer = await createTestTokenIssuer();
  logLines = [];
  app = await buildApp(deps(db.sink));
  tokens.a1 = await issuer.issue({ sub: USER_A1, tid: T_ALPHA });
  tokens.a3 = await issuer.issue({ sub: USER_A3, tid: T_ALPHA });
  tokens.a4 = await issuer.issue({ sub: USER_A4, tid: T_ALPHA });
  tokens.svcB1 = await issuer.issue({ sub: SVC_B1, tid: T_BETA });
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

type Who = 'a1' | 'a3' | 'a4' | 'svcB1' | 'none';

function call(
  who: Who,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: {
      ...(who === 'none' ? {} : { authorization: `Bearer ${tokens[who]}` }),
      ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { payload: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

const create = (who: Who, body: unknown, headers?: Record<string, string>) =>
  call(who, 'POST', '/v1/synthetic-tasks', body, headers);

function withoutCorrelation(res: LightMyRequestResponse) {
  const { correlationId, ...rest } = res.json();
  expect(correlationId).toBe(res.headers['x-correlation-id']);
  return rest;
}

async function taskCount(): Promise<number> {
  return (await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.synthetic_tasks')).rows[0].n;
}

async function attempt(correlationId: string) {
  return (
    await db.admin.query(
      'SELECT tenant_id, actor_id, operation, reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
      [correlationId],
    )
  ).rows;
}

describe('create synthetic task', () => {
  it('201 with a CommandResult; tenant comes from the token, never from headers', async () => {
    const res = await create('a1', { label: 'water the plants' }, { 'x-tenant-id': T_BETA });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toStrictEqual(['correlationId', 'data', 'replayed', 'version']);
    expect(body).toMatchObject({ version: 1, replayed: false, data: { label: 'water the plants' } });
    expect(Object.keys(body.data).sort()).toStrictEqual(['label', 'taskRef']);
    const row = (
      await db.admin.query('SELECT tenant_id, created_by FROM cuspatlas.synthetic_tasks WHERE id = $1', [
        body.data.taskRef,
      ])
    ).rows[0];
    expect(row).toStrictEqual({ tenant_id: T_ALPHA, created_by: USER_A1 });
  });

  it('rejects schema violations with 400 and creates nothing', async () => {
    const before = await taskCount();
    for (const body of [
      {},
      { label: 42 },
      { label: null },
      [],
      'null',
      '"text"',
      '{"label":',
      { label: 'ok', locationRef: 'Bad Loc' },
    ]) {
      const res = await create('a1', body);
      expect([JSON.stringify(body), res.statusCode, res.json().code]).toStrictEqual([
        JSON.stringify(body),
        400,
        'invalid_request',
      ]);
    }
    const textPlain = await create('a1', 'label=x', { 'content-type': 'text/plain' });
    expect(textPlain.statusCode).toBe(400);
    expect(await taskCount()).toBe(before);
  });

  it('rejects unknown properties, including a forged tenant, with 400', async () => {
    const before = await taskCount();
    for (const extra of [{ tenantId: T_BETA }, { tenantRef: T_BETA }, { version: 9 }, { [MARKER]: 1 }]) {
      const res = await create('a1', { label: 'x', ...extra });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'invalid_request',
        detail: { violations: [{ rule: 'additionalProperties', pointer: '/' }] },
      });
      expect(res.body).not.toContain(MARKER);
    }
    expect(await taskCount()).toBe(before);
  });

  it('enforces label length 1..120', async () => {
    expect((await create('a1', { label: '' })).statusCode).toBe(400);
    expect((await create('a1', { label: 'x'.repeat(121) })).statusCode).toBe(400);
    expect((await create('a1', { label: 'x' })).statusCode).toBe(201);
    expect((await create('a1', { label: 'y'.repeat(120) })).statusCode).toBe(201);
  });

  it('requires a bounded Idempotency-Key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/synthetic-tasks',
      headers: { authorization: `Bearer ${tokens.a1}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ label: 'x' }),
    });
    expect([res.statusCode, res.json().code]).toStrictEqual([400, 'invalid_request']);
    expect((await create('a1', { label: 'x' }, { 'idempotency-key': 'k'.repeat(129) })).statusCode).toBe(400);
    expect((await create('a1', { label: 'x' }, { 'idempotency-key': 'k'.repeat(128) })).statusCode).toBe(201);
  });

  it('denies a location outside the membership with 403 and records it', async () => {
    const denied = await create('a3', { label: 'x', locationRef: 'loc-south' });
    expect([denied.statusCode, denied.json().code]).toStrictEqual([403, 'forbidden']);
    expect(await attempt(denied.json().correlationId)).toStrictEqual([
      {
        tenant_id: T_ALPHA,
        actor_id: USER_A3,
        operation: 'syntheticTasks.create',
        reason_code: 'location_denied',
      },
    ]);
    expect((await create('a3', { label: 'x' })).statusCode).toBe(403);
    expect((await create('a3', { label: 'x', locationRef: 'loc-north' })).statusCode).toBe(201);
  });

  it('denies a member without the write scope; a service principal with scope may create in its own tenant', async () => {
    const res = await create('a4', { label: 'x' });
    expect(res.statusCode).toBe(403);
    expect((await attempt(res.json().correlationId))[0]).toMatchObject({ reason_code: 'scope_missing' });
    const svc = await create('svcB1', { label: 'from service' });
    expect(svc.statusCode).toBe(201);
    const row = await db.admin.query('SELECT tenant_id FROM cuspatlas.synthetic_tasks WHERE id = $1', [
      svc.json().data.taskRef,
    ]);
    expect(row.rows[0].tenant_id).toBe(T_BETA);
  });

  it('401 without a token on every synthetic-task route', async () => {
    for (const [m, u] of [
      ['POST', '/v1/synthetic-tasks'],
      ['GET', '/v1/synthetic-tasks'],
      ['GET', `/v1/synthetic-tasks/${TASK_A}`],
      ['POST', `/v1/synthetic-tasks/${TASK_A}/relabel`],
    ] as const) {
      const res = await call('none', m, u, m === 'POST' ? { label: 'x', expectedVersion: 1 } : undefined);
      expect([u, res.statusCode]).toStrictEqual([u, 401]);
    }
  });
});

describe('hidden resources, versions and pagination', () => {
  it('a cross-tenant resource is 404 with the same body as a missing one', async () => {
    const hidden = await call('a1', 'GET', `/v1/synthetic-tasks/${TASK_B}`);
    const missing = await call('a1', 'GET', `/v1/synthetic-tasks/${randomUUID()}`);
    const malformed = await call('a1', 'GET', '/v1/synthetic-tasks/not-a-ref');
    const hiddenWrite = await call('a1', 'POST', `/v1/synthetic-tasks/${TASK_B}/relabel`, {
      label: 'mine',
      expectedVersion: 1,
    });
    for (const r of [hidden, missing, malformed, hiddenWrite]) expect(r.statusCode).toBe(404);
    const shape = withoutCorrelation(missing);
    expect(shape).toStrictEqual({ code: 'not_found', retryable: false });
    for (const r of [hidden, malformed, hiddenWrite]) expect(withoutCorrelation(r)).toStrictEqual(shape);
    expect(Object.keys(hidden.headers).sort()).toStrictEqual(Object.keys(missing.headers).sort());
    expect((await attempt(hidden.json().correlationId))[0]).toMatchObject({
      tenant_id: T_ALPHA,
      actor_id: USER_A1,
      reason_code: 'resource_hidden_or_missing',
    });
    const b = await db.admin.query('SELECT label, version FROM cuspatlas.synthetic_tasks WHERE id = $1', [
      TASK_B,
    ]);
    expect(b.rows[0]).toStrictEqual({ label: 'beta task', version: 1 });
  });

  it('reads an own-tenant task', async () => {
    const res = await call('a1', 'GET', `/v1/synthetic-tasks/${TASK_A}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({
      data: { taskRef: TASK_A, label: 'alpha task', locationRef: null, version: 1 },
    });
  });

  it('relabel bumps the version; a stale expectedVersion is 409 with the current version', async () => {
    const made = (await create('a1', { label: 'v1' })).json();
    const ref = made.data.taskRef;
    const ok = await call('a1', 'POST', `/v1/synthetic-tasks/${ref}/relabel`, {
      label: 'v2',
      expectedVersion: 1,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ data: { taskRef: ref, label: 'v2' }, version: 2, replayed: false });
    const stale = await call('a1', 'POST', `/v1/synthetic-tasks/${ref}/relabel`, {
      label: 'v3',
      expectedVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(withoutCorrelation(stale)).toStrictEqual({
      code: 'stale_version',
      retryable: false,
      detail: { currentVersion: 2 },
    });
    const row = await db.admin.query('SELECT label, version FROM cuspatlas.synthetic_tasks WHERE id = $1', [
      ref,
    ]);
    expect(row.rows[0]).toStrictEqual({ label: 'v2', version: 2 });
    for (const body of [
      { label: 'v3' },
      { label: 'v3', expectedVersion: 0 },
      { label: 'v3', expectedVersion: '2' },
    ]) {
      expect((await call('a1', 'POST', `/v1/synthetic-tasks/${ref}/relabel`, body)).statusCode).toBe(400);
    }
  });

  it('lists only the caller tenant with bounded cursor pagination', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const res = await call('a1', 'GET', `/v1/synthetic-tasks${qs}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.length).toBeLessThanOrEqual(2);
      seen.push(...body.data.map((t: { taskRef: string }) => t.taskRef));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 100);
    const alpha = (
      await db.admin.query('SELECT id FROM cuspatlas.synthetic_tasks WHERE tenant_id = $1', [T_ALPHA])
    ).rows.map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toStrictEqual([...alpha].sort());
    expect(seen).not.toContain(TASK_B);
  });

  it('rejects unsafe pagination parameters', async () => {
    for (const qs of [
      '?limit=101',
      '?limit=0',
      '?limit=-1',
      '?limit=abc',
      '?limit=1e9',
      `?cursor=${MARKER}`,
      '?cursor=st1.zz',
      '?other=1',
    ]) {
      const res = await call('a1', 'GET', `/v1/synthetic-tasks${qs}`);
      expect([qs, res.statusCode]).toStrictEqual([qs, 400]);
      expect(res.body).not.toContain(MARKER);
    }
    const dflt = (await call('a1', 'GET', '/v1/synthetic-tasks')).json();
    expect(dflt.data.length).toBeLessThanOrEqual(25);
    const max = await call('a1', 'GET', '/v1/synthetic-tasks?limit=100');
    expect(max.statusCode).toBe(200);
  });

  it('a location-restricted member lists only its locations and tenant-wide tasks, and is denied other locations', async () => {
    const res = await call('a3', 'GET', '/v1/synthetic-tasks?limit=100');
    const refs = res.json().data.map((t: { taskRef: string }) => t.taskRef);
    expect(refs).toContain(TASK_A_NORTH);
    expect(refs).toContain(TASK_A);
    expect(refs).not.toContain(TASK_A_SOUTH);
    expect((await call('a3', 'GET', `/v1/synthetic-tasks/${TASK_A_SOUTH}`)).statusCode).toBe(403);
    expect(
      (
        await call('a3', 'POST', `/v1/synthetic-tasks/${TASK_A_SOUTH}/relabel`, {
          label: 'x',
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('no sensitive echo', () => {
  it('the marker in any caller-controlled input never reaches responses, headers or logs', async () => {
    logLines.length = 0;
    const responses = [
      await create('a1', { label: MARKER.repeat(10) }),
      await create('a1', { label: 'x', locationRef: MARKER }),
      await create('a1', { label: 'x', [MARKER]: MARKER }),
      await create('a1', `{"label": "${MARKER}`),
      await create('a1', { label: 'x' }, { 'idempotency-key': `${MARKER} ${MARKER}` }),
      await call('a1', 'GET', `/v1/synthetic-tasks/${MARKER}`),
      await call('a1', 'GET', `/v1/synthetic-tasks?cursor=${MARKER}&limit=${MARKER}`),
      await call('a1', 'POST', `/v1/synthetic-tasks/${TASK_A}/relabel`, {
        label: MARKER,
        expectedVersion: 999,
      }),
      await call('none', 'GET', '/v1/synthetic-tasks', undefined, { authorization: `Bearer ${MARKER}` }),
    ];
    for (const r of responses) {
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.body).not.toContain(MARKER);
      expect(JSON.stringify(r.headers)).not.toContain(MARKER);
    }
    const viaHeaders = await create(
      'a1',
      { label: 'x' },
      { 'x-forwarded-for': MARKER, 'user-agent': MARKER },
    );
    expect(viaHeaders.statusCode).toBe(201);
    expect(viaHeaders.body + JSON.stringify(viaHeaders.headers)).not.toContain(MARKER);
    const ok = await create('a1', { label: `${MARKER} accepted` });
    expect(ok.statusCode).toBe(201);
    expect(logLines.length).toBeGreaterThan(0);
    for (const l of logLines) expect(l).not.toContain(MARKER);
    const audit = await db.admin.query(
      'SELECT row_to_json(e)::text AS j FROM cuspatlas.security_attempt_events e',
    );
    for (const r of audit.rows) expect(r.j).not.toContain(MARKER);
  });
});

describe('security-attempt sink outage', () => {
  it('keeps the denial closed, returns a safe 503 and logs a safe alert', async () => {
    const deadPool = new pg.Pool({
      host: '127.0.0.1',
      port: 1,
      user: 'cuspatlas_app',
      database: db.name,
      connectionTimeoutMillis: 200,
    });
    deadPool.on('error', () => undefined);
    const outageLog: string[] = [];
    const outage = await buildApp({
      ...deps(deadPool),
      logger: { level: 'info', stream: { write: (l: string) => outageLog.push(l) } },
    });
    try {
      const before = await taskCount();
      const res = await outage.inject({
        method: 'POST',
        url: '/v1/synthetic-tasks',
        headers: {
          authorization: `Bearer ${tokens.a4}`,
          'content-type': 'application/json',
          'idempotency-key': 'k1',
        },
        payload: JSON.stringify({ label: 'x' }),
      });
      expect(res.statusCode).toBe(503);
      expect(withoutCorrelation(res)).toStrictEqual({ code: 'service_unavailable', retryable: true });
      expect(await taskCount()).toBe(before);
      expect(outageLog.some((l) => l.includes('security_attempt_sink_unavailable'))).toBe(true);
    } finally {
      await outage.close();
      await deadPool.end();
    }
  });
});

describe('one domain policy for every transport', () => {
  it('the domain service refuses exactly as REST does, and exposes an executor seam for executeOnce', async () => {
    const calls: CommandEnvelope<unknown>[] = [];
    const spy: CommandExecutor = (ctx, envelope, tx, handler) => {
      calls.push(envelope);
      return executeDirect(ctx, envelope, tx, handler);
    };
    const service = createSyntheticTaskService({
      authorize: createAuthorize(createMembershipSource(db.app)),
      withTenantTransaction: createTenantTransactionRunner(db.app),
      recording: { sink: createSecurityAttemptSink(db.sink), alert: () => undefined },
      execute: spy,
    });
    const a3 = ctxFor(T_ALPHA, USER_A3, 'human', ['syntheticTasks.read', 'syntheticTasks.write']);
    const envelope = {
      operation: 'syntheticTasks.create',
      idempotencyKey: 'k',
      payload: { label: 'x', locationRef: 'loc-south' },
    };
    const err = await service.createSyntheticTask(a3, envelope).catch((e: unknown) => e);
    expect(isRefusalError(err) && err.code).toBe('forbidden');
    const created = await service.createSyntheticTask(a3, {
      ...envelope,
      payload: { label: 'x', locationRef: 'loc-north' },
    });
    expect(created).toMatchObject({ version: 1, replayed: false, correlationId: a3.correlationId });
    expect(calls).toHaveLength(1);
    const forged = await service
      .createSyntheticTask(a3, { ...envelope, payload: { label: 'x', tenantId: T_BETA } })
      .catch((e: unknown) => e);
    expect(isRefusalError(forged) && forged.code).toBe('invalid_request');
  });
});
