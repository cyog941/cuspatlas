import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { buildApp } from '@cuspatlas/api';
import type { WithTenantTransaction } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { idempotencyPayloadDigest, SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY } from '@cuspatlas/domain';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { SVC_A1, seedTenancy, T_ALPHA, T_BETA, USER_A1, USER_B1 } from './support/fixtures';
import { MARKER } from './support/marker';
import { createTestTokenIssuer, type TestTokenIssuer } from './support/test-token-issuer';

/** Synthetic member created only for the revocation case so shared fixtures stay untouched. */
const USER_A5 = '20000000-0000-4000-8000-0000000000a5';

let db: TestDatabase;
let issuer: TestTokenIssuer;
const apps: FastifyInstance[] = [];
const tokens = { a1: '', a5: '', b1: '', svcA1: '' };
let app: FastifyInstance;

async function appWith(
  opts: { pool?: pg.Pool; tenantTransactions?: WithTenantTransaction; logLines?: string[] } = {},
): Promise<FastifyInstance> {
  const pool = opts.pool ?? db.app;
  const lines = opts.logLines;
  const a = await buildApp({
    env: 'synthetic-test',
    logger: lines ? { level: 'trace', stream: { write: (l: string) => lines.push(l) } } : { level: 'silent' },
    identity: issuer.verifierConfig,
    membership: createMembershipSource(pool),
    attempts: createSecurityAttemptSink(db.sink),
    tenantTransactions: opts.tenantTransactions ?? createTenantTransactionRunner(pool),
    // No `execute`: the API must use executeOnce by default.
  });
  apps.push(a);
  return a;
}

function post(
  target: FastifyInstance,
  url: string,
  token: string,
  body: unknown,
  key: string,
): Promise<LightMyRequestResponse> {
  return target.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    payload: JSON.stringify(body),
  });
}

/** Independent implementation of the frozen digest rule: SHA-256 over recursively key-sorted JSON. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** The stored payload digest (scheme 2): keyed, tenant-bound (the test-only key under synthetic-test). */
const keyed = (body: unknown, tenant = T_ALPHA) =>
  idempotencyPayloadDigest(SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY, tenant, body);

const count = async (table: string, where = 'true', values: unknown[] = []) =>
  (await db.admin.query(`SELECT count(*)::int AS n FROM cuspatlas.${table} WHERE ${where}`, values)).rows[0]
    .n as number;

async function reservation(principal: string, operation: string, key: string) {
  const { rows } = await db.admin.query(
    `SELECT state, payload_digest, payload_digest_scheme, result, aggregate_version, expires_at - reserved_at AS ttl
     FROM cuspatlas.command_idempotency
     WHERE tenant_id = $1 AND principal_id = $2 AND operation = $3 AND key_digest = $4`,
    [T_ALPHA, principal, operation, sha256(key)],
  );
  return rows[0];
}

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

const sansCorrelation = (r: LightMyRequestResponse) => {
  const { correlationId, ...rest } = r.json();
  expect(correlationId).toBe(r.headers['x-correlation-id']);
  return rest;
};

beforeAll(async () => {
  db = await openTestDatabase('idempotency');
  await seedTenancy(db.admin);
  await db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'human', 'user-a5')`,
    [USER_A5],
  );
  await db.admin.query(
    `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)`,
    [T_ALPHA, USER_A5, ['syntheticTasks.read', 'syntheticTasks.write']],
  );
  issuer = await createTestTokenIssuer();
  tokens.a1 = await issuer.issue({ sub: USER_A1, tid: T_ALPHA });
  tokens.a5 = await issuer.issue({ sub: USER_A5, tid: T_ALPHA });
  tokens.b1 = await issuer.issue({ sub: USER_B1, tid: T_BETA });
  tokens.svcA1 = await issuer.issue({ sub: SVC_A1, tid: T_ALPHA });
  app = await appWith();
});

afterAll(async () => {
  for (const a of apps) await a.close();
  await db?.close();
});

describe('reservation table', () => {
  it('is RLS enabled+forced, tenant and principal scoped, and the runtime role cannot DELETE', async () => {
    const rls = await db.admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE oid = 'cuspatlas.command_idempotency'::regclass`,
    );
    expect(rls.rows[0]).toStrictEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const privs = await db.app.query(
      `SELECT has_table_privilege('cuspatlas.command_idempotency', 'DELETE') AS d,
              has_table_privilege('cuspatlas.command_idempotency', 'TRUNCATE') AS t,
              has_column_privilege('cuspatlas.command_idempotency', 'state', 'UPDATE') AS s,
              has_column_privilege('cuspatlas.command_idempotency', 'tenant_id', 'UPDATE') AS ti,
              has_column_privilege('cuspatlas.command_idempotency', 'key_digest', 'UPDATE') AS k`,
    );
    expect(privs.rows[0]).toStrictEqual({ d: false, t: false, s: true, ti: false, k: false });
  });
});

describe('same key, same payload', () => {
  it('a sequential retry replays the recorded result with replayed: true and one mutation', async () => {
    const key = randomUUID();
    const first = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'sequential' }, key);
    const second = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'sequential' }, key);
    expect([first.statusCode, second.statusCode]).toStrictEqual([201, 201]);
    expect(first.json().replayed).toBe(false);
    expect(second.json()).toMatchObject({ replayed: true, version: 1, data: first.json().data });
    expect(second.json().correlationId).not.toBe(first.json().correlationId);
    const ref = first.json().data.taskRef;
    expect(await count('synthetic_tasks', 'id = $1', [ref])).toBe(1);
    expect(await count('audit_events', 'resource_ref = $1', [ref])).toBe(1);
    expect(await count('outbox_events', 'aggregate_id = $1', [ref])).toBe(1);
    const row = await reservation(USER_A1, 'syntheticTasks.create', key);
    expect(row).toMatchObject({
      state: 'committed',
      payload_digest: keyed({ label: 'sequential' }),
      payload_digest_scheme: 2,
      aggregate_version: 1,
    });
    expect(row.result).toStrictEqual({ kind: 'success', taskRef: ref });
    expect(row.ttl).toMatchObject({ days: 7 });
  });

  it('the digest ignores key order: a reordered identical body replays', async () => {
    const key = randomUUID();
    const a = await post(
      app,
      '/v1/synthetic-tasks',
      tokens.a1,
      { label: 'ordered', locationRef: 'loc-north' },
      key,
    );
    const b = await app.inject({
      method: 'POST',
      url: '/v1/synthetic-tasks',
      headers: {
        authorization: `Bearer ${tokens.a1}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      payload: '{ "locationRef" : "loc-north", "label" : "ordered" }',
    });
    expect([a.statusCode, b.statusCode, b.json().replayed]).toStrictEqual([201, 201, true]);
    expect(b.json().data.taskRef).toBe(a.json().data.taskRef);
  });

  it('a relabel retry replays without a second version bump', async () => {
    const made = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'r0' }, randomUUID());
    const ref = made.json().data.taskRef;
    const key = randomUUID();
    const body = { label: 'r1', expectedVersion: 1 };
    const first = await post(app, `/v1/synthetic-tasks/${ref}/relabel`, tokens.a1, body, key);
    const second = await post(app, `/v1/synthetic-tasks/${ref}/relabel`, tokens.a1, body, key);
    expect([first.statusCode, second.statusCode]).toStrictEqual([200, 200]);
    expect(sansCorrelation(second)).toStrictEqual({ ...sansCorrelation(first), replayed: true });
    expect(
      (await db.admin.query('SELECT version FROM cuspatlas.synthetic_tasks WHERE id = $1', [ref])).rows[0]
        .version,
    ).toBe(2);
    expect(await count('audit_events', 'resource_ref = $1', [ref])).toBe(2);
  });
});

describe('keyed payload digest (integration hardening)', () => {
  it('the stored digest is not a plain SHA-256 of the payload; it is the tenant-bound HMAC', async () => {
    const key = randomUUID();
    const body = { label: 'synthetic allergen pollen' };
    expect((await post(app, '/v1/synthetic-tasks', tokens.a1, body, key)).statusCode).toBe(201);
    const row = await reservation(USER_A1, 'syntheticTasks.create', key);
    expect(row.payload_digest).not.toBe(sha256(canonical(body)));
    expect(row.payload_digest).toBe(keyed(body));
    expect(row.payload_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.payload_digest_scheme).toBe(2);
    // Tenant-bound: the same payload in another tenant has another digest.
    expect(keyed(body, T_BETA)).not.toBe(keyed(body));
    // Comparison semantics are unchanged: the same body replays, another body conflicts.
    const again = await post(app, '/v1/synthetic-tasks', tokens.a1, body, key);
    expect([again.statusCode, again.json().replayed]).toStrictEqual([201, true]);
    const other = await post(
      app,
      '/v1/synthetic-tasks',
      tokens.a1,
      { label: 'synthetic allergen dust' },
      key,
    );
    expect(other.json().code).toBe('idempotency_conflict');
  });

  it('a legacy scheme 1 row (unkeyed, written before the change) is still compared by its own scheme', async () => {
    const key = randomUUID();
    const body = { label: 'legacy pending' };
    await db.admin.query(
      `INSERT INTO cuspatlas.command_idempotency (tenant_id, principal_id, operation, key_digest,
         payload_digest, payload_digest_scheme, state, correlation_id, reserved_at, expires_at)
       VALUES ($1, $2, 'syntheticTasks.create', $3, $4, 1, 'pending', gen_random_uuid(),
         now() - interval '120 seconds', now() - interval '120 seconds' + interval '7 days')`,
      [T_ALPHA, USER_A1, sha256(key), sha256(canonical(body))],
    );
    // A different body against the legacy digest conflicts; the same body takes the abandoned row over.
    const other = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'legacy other' }, key);
    expect(other.json().code).toBe('idempotency_conflict');
    expect((await post(app, '/v1/synthetic-tasks', tokens.a1, body, key)).statusCode).toBe(201);
    const row = await reservation(USER_A1, 'syntheticTasks.create', key);
    expect([row.state, row.payload_digest_scheme, row.payload_digest]).toStrictEqual([
      'committed',
      2,
      keyed(body),
    ]);
  });
});

describe('same key, different payload', () => {
  it('returns 409 idempotency_conflict and creates nothing', async () => {
    const key = randomUUID();
    const first = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'original' }, key);
    expect(first.statusCode).toBe(201);
    const before = await count('synthetic_tasks');
    const changed = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'altered' }, key);
    expect([changed.statusCode, sansCorrelation(changed)]).toStrictEqual([
      409,
      { code: 'idempotency_conflict', retryable: false },
    ]);
    expect(await count('synthetic_tasks')).toBe(before);
  });

  it('the same key on a different task (relabel target) conflicts', async () => {
    const t1 = (await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 't1' }, randomUUID())).json().data
      .taskRef;
    const t2 = (await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 't2' }, randomUUID())).json().data
      .taskRef;
    const key = randomUUID();
    const body = { label: 'same body', expectedVersion: 1 };
    expect((await post(app, `/v1/synthetic-tasks/${t1}/relabel`, tokens.a1, body, key)).statusCode).toBe(200);
    const other = await post(app, `/v1/synthetic-tasks/${t2}/relabel`, tokens.a1, body, key);
    expect([other.statusCode, other.json().code]).toStrictEqual([409, 'idempotency_conflict']);
    expect(
      (await db.admin.query('SELECT version FROM cuspatlas.synthetic_tasks WHERE id = $1', [t2])).rows[0]
        .version,
    ).toBe(1);
  });
});

describe('scope isolation', () => {
  it("tenant B reusing A's key gets its own fresh reservation and can never see A's", async () => {
    const key = `shared-key-${randomUUID()}`;
    const a = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'same body' }, key);
    const b = await post(app, '/v1/synthetic-tasks', tokens.b1, { label: 'same body' }, key);
    expect([a.statusCode, b.statusCode, b.json().replayed]).toStrictEqual([201, 201, false]);
    expect(b.json().data.taskRef).not.toBe(a.json().data.taskRef);
    const bTask = await db.admin.query('SELECT tenant_id FROM cuspatlas.synthetic_tasks WHERE id = $1', [
      b.json().data.taskRef,
    ]);
    expect(bTask.rows[0].tenant_id).toBe(T_BETA);
    const seenByB = await asRuntime(
      T_BETA,
      USER_B1,
      async (c) => (await c.query('SELECT DISTINCT tenant_id FROM cuspatlas.command_idempotency')).rows,
    );
    expect(seenByB).toStrictEqual([{ tenant_id: T_BETA }]);
    expect(
      (await db.app.query('SELECT count(*)::int AS n FROM cuspatlas.command_idempotency')).rows[0].n,
    ).toBe(0);
  });

  it('another principal in the same tenant has its own scope for the same key', async () => {
    const key = `principal-key-${randomUUID()}`;
    const human = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'p' }, key);
    const service = await post(app, '/v1/synthetic-tasks', tokens.svcA1, { label: 'p' }, key);
    expect([human.statusCode, service.statusCode, service.json().replayed]).toStrictEqual([201, 201, false]);
    expect(service.json().data.taskRef).not.toBe(human.json().data.taskRef);
    const seen = await asRuntime(
      T_ALPHA,
      SVC_A1,
      async (c) => (await c.query('SELECT DISTINCT principal_id FROM cuspatlas.command_idempotency')).rows,
    );
    expect(seen).toStrictEqual([{ principal_id: SVC_A1 }]);
  });

  it('the runtime role cannot insert a reservation for another tenant or principal', async () => {
    const forge = (tenant: string, principal: string) =>
      asRuntime(T_ALPHA, USER_A1, async (c) => {
        try {
          await c.query(
            `INSERT INTO cuspatlas.command_idempotency (tenant_id, principal_id, operation, key_digest,
               payload_digest, state, correlation_id, reserved_at, expires_at)
             VALUES ($1, $2, 'syntheticTasks.create', repeat('a', 64), repeat('b', 64), 'pending',
               gen_random_uuid(), now(), now() + interval '7 days')`,
            [tenant, principal],
          );
          return 'ok';
        } catch (err) {
          return String((err as { code?: string }).code);
        }
      });
    expect(await forge(T_BETA, USER_A1)).toBe('42501');
    expect(await forge(T_ALPHA, SVC_A1)).toBe('42501');
  });
});

describe('optimistic concurrency and recorded refusals', () => {
  it('stale expectedVersion is 409 stale_version, recorded as failed, and the same key replays the same refusal', async () => {
    const ref = (await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 's0' }, randomUUID())).json().data
      .taskRef;
    const ok = await post(
      app,
      `/v1/synthetic-tasks/${ref}/relabel`,
      tokens.a1,
      { label: 's1', expectedVersion: 1 },
      randomUUID(),
    );
    expect(ok.statusCode).toBe(200);
    const staleKey = randomUUID();
    const staleBody = { label: 'stale', expectedVersion: 1 };
    const stale = await post(app, `/v1/synthetic-tasks/${ref}/relabel`, tokens.a1, staleBody, staleKey);
    const refusal = { code: 'stale_version', retryable: false, detail: { currentVersion: 2 } };
    expect([stale.statusCode, sansCorrelation(stale)]).toStrictEqual([409, refusal]);
    const row = await reservation(USER_A1, 'syntheticTasks.relabel', staleKey);
    expect(row).toMatchObject({ state: 'failed', aggregate_version: null });
    expect(row.result).toStrictEqual({ kind: 'refusal', ...refusal });
    expect(await count('audit_events', 'correlation_id = $1', [stale.json().correlationId])).toBe(0);
    // The task moves on; the recorded refusal does not change.
    expect(
      (
        await post(
          app,
          `/v1/synthetic-tasks/${ref}/relabel`,
          tokens.a1,
          { label: 's2', expectedVersion: 2 },
          randomUUID(),
        )
      ).statusCode,
    ).toBe(200);
    const again = await post(app, `/v1/synthetic-tasks/${ref}/relabel`, tokens.a1, staleBody, staleKey);
    expect([again.statusCode, sansCorrelation(again)]).toStrictEqual([409, refusal]);
    expect(
      (await db.admin.query('SELECT version FROM cuspatlas.synthetic_tasks WHERE id = $1', [ref])).rows[0]
        .version,
    ).toBe(3);
  });
});

describe('replay reauthorizes', () => {
  it('a revoked member gets 403 on replay, not the cached result', async () => {
    const key = randomUUID();
    const first = await post(app, '/v1/synthetic-tasks', tokens.a5, { label: 'before revoke' }, key);
    expect(first.statusCode).toBe(201);
    await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1', [
      USER_A5,
    ]);
    try {
      const replay = await post(app, '/v1/synthetic-tasks', tokens.a5, { label: 'before revoke' }, key);
      expect([replay.statusCode, sansCorrelation(replay)]).toStrictEqual([
        403,
        { code: 'forbidden', retryable: false },
      ]);
      expect(replay.body).not.toContain(first.json().data.taskRef);
    } finally {
      await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = NULL WHERE principal_id = $1', [
        USER_A5,
      ]);
    }
    const restored = await post(app, '/v1/synthetic-tasks', tokens.a5, { label: 'before revoke' }, key);
    expect([restored.statusCode, restored.json().replayed]).toStrictEqual([201, true]);
  });
});

describe('crash and in-flight recovery', () => {
  it('a crash after commit but before the response is recovered by replaying the committed result', async () => {
    const real = createTenantTransactionRunner(db.app);
    let crash = true;
    const crashing: WithTenantTransaction = async (ctx, work) => {
      const result = await real(ctx, work);
      if (crash) {
        crash = false;
        throw new Error('connection reset after commit');
      }
      return result;
    };
    const crashApp = await appWith({ tenantTransactions: crashing });
    const key = randomUUID();
    const label = `crash-${key}`;
    const lost = await post(crashApp, '/v1/synthetic-tasks', tokens.a1, { label }, key);
    expect([lost.statusCode, lost.json().code]).toStrictEqual([500, 'internal_error']);
    expect(await count('synthetic_tasks', 'label = $1', [label])).toBe(1);
    const retry = await post(crashApp, '/v1/synthetic-tasks', tokens.a1, { label }, key);
    expect([retry.statusCode, retry.json().replayed]).toStrictEqual([201, true]);
    const ref = retry.json().data.taskRef;
    expect(
      (await db.admin.query('SELECT id FROM cuspatlas.synthetic_tasks WHERE label = $1', [label])).rows[0].id,
    ).toBe(ref);
    expect(await count('synthetic_tasks', 'label = $1', [label])).toBe(1);
    expect(await count('audit_events', 'resource_ref = $1', [ref])).toBe(1);
  });

  it('a pending reservation older than 60 s is taken over; a fresh pending one is refused as in flight', async () => {
    const insertPending = (key: string, body: unknown, ageSeconds: number) =>
      db.admin.query(
        `INSERT INTO cuspatlas.command_idempotency (tenant_id, principal_id, operation, key_digest,
           payload_digest, state, correlation_id, reserved_at, expires_at)
         VALUES ($1, $2, 'syntheticTasks.create', $3, $4, 'pending', gen_random_uuid(),
           now() - make_interval(secs => $5), now() - make_interval(secs => $5) + interval '7 days')`,
        [T_ALPHA, USER_A1, sha256(key), keyed(body), ageSeconds],
      );
    const staleKey = randomUUID();
    await insertPending(staleKey, { label: 'abandoned' }, 61);
    const takeover = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'abandoned' }, staleKey);
    expect([takeover.statusCode, takeover.json().replayed]).toStrictEqual([201, false]);
    expect(await reservation(USER_A1, 'syntheticTasks.create', staleKey)).toMatchObject({
      state: 'committed',
    });

    const freshKey = randomUUID();
    await insertPending(freshKey, { label: 'in flight' }, 5);
    const before = await count('synthetic_tasks');
    const busy = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'in flight' }, freshKey);
    expect([busy.statusCode, sansCorrelation(busy)]).toStrictEqual([
      409,
      { code: 'conflict', retryable: true },
    ]);
    expect(await count('synthetic_tasks')).toBe(before);
  });

  it('an expired reservation is not replayed; maintenance (owner role) purges expired rows only', async () => {
    const key = randomUUID();
    const first = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'expiring' }, key);
    await db.admin.query(
      `UPDATE cuspatlas.command_idempotency SET reserved_at = now() - interval '8 days',
         expires_at = now() - interval '1 day' WHERE key_digest = $1`,
      [sha256(key)],
    );
    const later = await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'expiring' }, key);
    expect([later.statusCode, later.json().replayed]).toStrictEqual([201, false]);
    expect(later.json().data.taskRef).not.toBe(first.json().data.taskRef);

    const oldKey = randomUUID();
    await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'old' }, oldKey);
    await db.admin.query(
      `UPDATE cuspatlas.command_idempotency SET reserved_at = now() - interval '8 days',
         expires_at = now() - interval '1 day' WHERE key_digest = $1`,
      [sha256(oldKey)],
    );
    const runtimeDelete = await asRuntime(T_ALPHA, USER_A1, async (c) => {
      try {
        await c.query('DELETE FROM cuspatlas.command_idempotency WHERE key_digest = $1', [sha256(oldKey)]);
        return 'ok';
      } catch (err) {
        return String((err as { code?: string }).code);
      }
    });
    expect(runtimeDelete).toBe('42501');
    const live = await count('command_idempotency', 'expires_at > now()');
    const { purgeExpiredCommandIdempotency } = await import('@cuspatlas/db');
    const owner = await db.admin.connect();
    try {
      expect(await purgeExpiredCommandIdempotency(owner)).toBeGreaterThanOrEqual(1);
    } finally {
      owner.release();
    }
    expect(await count('command_idempotency', 'expires_at <= now()')).toBe(0);
    expect(await count('command_idempotency', 'expires_at > now()')).toBe(live);
    const runtime = await db.app.connect();
    try {
      await expect(purgeExpiredCommandIdempotency(runtime)).rejects.toThrow();
    } finally {
      runtime.release();
    }
  });
});

describe('privacy', () => {
  it('the marker as a key or label never reaches reservation rows or logs', async () => {
    const lines: string[] = [];
    const logged = await appWith({ logLines: lines });
    const res = await post(logged, '/v1/synthetic-tasks', tokens.a1, { label: `${MARKER} kept` }, MARKER);
    expect(res.statusCode).toBe(201);
    const replay = await post(logged, '/v1/synthetic-tasks', tokens.a1, { label: `${MARKER} kept` }, MARKER);
    expect(replay.json()).toMatchObject({ replayed: true, data: { label: `${MARKER} kept` } });
    const conflict = await post(
      logged,
      '/v1/synthetic-tasks',
      tokens.a1,
      { label: `${MARKER} other` },
      MARKER,
    );
    expect(conflict.body).not.toContain(MARKER);
    const { rows } = await db.admin.query(
      'SELECT row_to_json(r)::text AS j FROM cuspatlas.command_idempotency r',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.j).not.toContain(MARKER);
    for (const l of lines) expect(l).not.toContain(MARKER);
  });
});

describe('concurrent duplicates', () => {
  const ITERATIONS = 5;
  const PARALLEL = 10;

  async function assertOneMutation(
    label: string,
    statuses: number[],
    bodies: { replayed: boolean; data: { taskRef: string } }[],
  ) {
    expect(statuses).toStrictEqual(Array(PARALLEL).fill(201));
    expect(bodies.filter((b) => !b.replayed)).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.data.taskRef)).size).toBe(1);
    const ref = bodies[0]?.data.taskRef;
    expect(await count('synthetic_tasks', 'label = $1', [label])).toBe(1);
    expect(await count('audit_events', 'resource_ref = $1', [ref])).toBe(1);
    expect(await count('outbox_events', 'aggregate_id = $1', [ref])).toBe(1);
  }

  it(`${PARALLEL} identical app.inject requests x${ITERATIONS}: exactly one task, audit and outbox row`, async () => {
    const pool = db.appPool(12);
    const target = await appWith({ pool });
    for (let i = 0; i < ITERATIONS; i += 1) {
      const key = randomUUID();
      const label = `inject-${i}-${key}`;
      const res = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          post(target, '/v1/synthetic-tasks', tokens.a1, { label }, key),
        ),
      );
      await assertOneMutation(
        label,
        res.map((r) => r.statusCode),
        res.map((r) => r.json()),
      );
    }
  });

  it(`${PARALLEL} identical requests over a real listening server x${ITERATIONS}`, async () => {
    const pool = db.appPool(12);
    const target = await appWith({ pool });
    await target.listen({ port: 0, host: '127.0.0.1' });
    const { port } = target.server.address() as AddressInfo;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const key = randomUUID();
      const label = `http-${i}-${key}`;
      const res = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          fetch(`http://127.0.0.1:${port}/v1/synthetic-tasks`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${tokens.a1}`,
              'content-type': 'application/json',
              'idempotency-key': key,
            },
            body: JSON.stringify({ label }),
          }),
        ),
      );
      const bodies = (await Promise.all(res.map((r) => r.json()))) as {
        replayed: boolean;
        data: { taskRef: string };
      }[];
      await assertOneMutation(
        label,
        res.map((r) => r.status),
        bodies,
      );
    }
  });

  it('concurrent identical relabels bump the version once; concurrent altered bodies conflict', async () => {
    const pool = db.appPool(12);
    const target = await appWith({ pool });
    for (let i = 0; i < ITERATIONS; i += 1) {
      const ref = (
        await post(target, '/v1/synthetic-tasks', tokens.a1, { label: `rl-${i}` }, randomUUID())
      ).json().data.taskRef;
      const key = randomUUID();
      const res = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          post(
            target,
            `/v1/synthetic-tasks/${ref}/relabel`,
            tokens.a1,
            { label: `rl-${i}-b`, expectedVersion: 1 },
            key,
          ),
        ),
      );
      expect(res.map((r) => r.statusCode)).toStrictEqual(Array(PARALLEL).fill(200));
      expect(res.filter((r) => !r.json().replayed)).toHaveLength(1);
      expect(new Set(res.map((r) => r.json().version))).toStrictEqual(new Set([2]));
      expect(await count('audit_events', 'resource_ref = $1', [ref])).toBe(2);

      const altKey = randomUUID();
      const alt = await Promise.all(
        Array.from({ length: 5 }, (_, j) =>
          post(target, '/v1/synthetic-tasks', tokens.a1, { label: `alt-${i}-${j}-${altKey}` }, altKey),
        ),
      );
      const codes = alt.map((r) => r.statusCode).sort();
      expect(codes).toStrictEqual([201, 409, 409, 409, 409]);
      for (const r of alt.filter((x) => x.statusCode === 409))
        expect(r.json().code).toBe('idempotency_conflict');
      expect(await count('synthetic_tasks', 'label LIKE $1', [`alt-${i}-%-${altKey}`])).toBe(1);
    }
  });
});

describe('E3 hardening (independent review)', () => {
  it('the purge refuses, loudly, a role that cannot see the rows under FORCE RLS (never a silent 0)', async () => {
    const { purgeExpiredCommandIdempotency } = await import('@cuspatlas/db');
    const key = randomUUID();
    await post(app, '/v1/synthetic-tasks', tokens.a1, { label: 'purge-visibility' }, key);
    await db.admin.query(
      `UPDATE cuspatlas.command_idempotency SET reserved_at = now() - interval '8 days',
         expires_at = now() - interval '1 day' WHERE key_digest = $1`,
      [sha256(key)],
    );
    // Owner-like maintenance role: table privileges for the purge, but no SUPERUSER or BYPASSRLS.
    const role = `cuspatlas_maint_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const owner = await db.admin.connect();
    try {
      await owner.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await owner.query(`GRANT USAGE ON SCHEMA cuspatlas TO ${role}`);
      await owner.query(`GRANT SELECT, DELETE ON cuspatlas.command_idempotency TO ${role}`);
      await owner.query(`SET ROLE ${role}`);
      await expect(purgeExpiredCommandIdempotency(owner)).rejects.toThrow(/row level security/);
      await owner.query('RESET ROLE');
      expect(await count('command_idempotency', 'key_digest = $1', [sha256(key)])).toBe(1);
      expect(await purgeExpiredCommandIdempotency(owner)).toBeGreaterThanOrEqual(1);
      expect(await count('command_idempotency', 'key_digest = $1', [sha256(key)])).toBe(0);
    } finally {
      await owner.query('RESET ROLE').catch(() => undefined);
      await owner.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await owner.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      owner.release();
    }
  });

  it('tenant transactions run with a transaction-local 10 s lock_timeout by default', async () => {
    const runner = createTenantTransactionRunner(db.app);
    const ctx = {
      tenantId: T_ALPHA,
      actorId: USER_A1,
      principal: 'human' as const,
      sessionId: randomUUID(),
      scopes: ['syntheticTasks.read'],
      correlationId: randomUUID(),
    };
    const inside = await runner(ctx, async (tx) => {
      const { rows } = await tx.query<{ t: string }>(`SELECT current_setting('lock_timeout') AS t`);
      return rows[0]?.t;
    });
    expect(inside).toBe('10s');
    const outside = await db.app.query<{ t: string }>(`SELECT current_setting('lock_timeout') AS t`);
    expect(outside.rows[0]?.t).toBe('0');
  });

  it('a duplicate blocked on an uncommitted reservation gets a retryable 409 conflict within the bound', async () => {
    const key = randomUUID();
    const body = { label: 'held open' };
    const target = await appWith({
      tenantTransactions: createTenantTransactionRunner(db.app, { lockTimeoutMs: 400 }),
    });
    const holder = await db.admin.connect();
    const before = await count('synthetic_tasks');
    try {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO cuspatlas.command_idempotency (tenant_id, principal_id, operation, key_digest,
           payload_digest, state, correlation_id, reserved_at, expires_at)
         VALUES ($1, $2, 'syntheticTasks.create', $3, $4, 'pending', gen_random_uuid(), now(),
           now() + interval '7 days')`,
        [T_ALPHA, USER_A1, sha256(key), keyed(body)],
      );
      const started = Date.now();
      const res = await post(target, '/v1/synthetic-tasks', tokens.a1, body, key);
      const elapsed = Date.now() - started;
      expect([res.statusCode, sansCorrelation(res)]).toStrictEqual([
        409,
        { code: 'conflict', retryable: true },
      ]);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await count('synthetic_tasks')).toBe(before);
    // Once the holder is gone the same key proceeds normally.
    const after = await post(target, '/v1/synthetic-tasks', tokens.a1, body, key);
    expect([after.statusCode, after.json().replayed]).toStrictEqual([201, false]);
  });

  it('two different keys with the same expectedVersion race: one 200, one 409 stale_version (x5)', async () => {
    const pool = db.appPool(6);
    const target = await appWith({ pool });
    for (let i = 0; i < 5; i += 1) {
      const ref = (
        await post(target, '/v1/synthetic-tasks', tokens.a1, { label: `race-${i}` }, randomUUID())
      ).json().data.taskRef;
      const res = await Promise.all(
        ['a', 'b'].map((s) =>
          post(
            target,
            `/v1/synthetic-tasks/${ref}/relabel`,
            tokens.a1,
            { label: `race-${i}-${s}`, expectedVersion: 1 },
            randomUUID(),
          ),
        ),
      );
      expect(res.map((r) => r.statusCode).sort()).toStrictEqual([200, 409]);
      const loser = res.find((r) => r.statusCode === 409);
      expect(loser?.json()).toMatchObject({ code: 'stale_version', detail: { currentVersion: 2 } });
      expect(
        (await db.admin.query('SELECT version FROM cuspatlas.synthetic_tasks WHERE id = $1', [ref])).rows[0]
          .version,
      ).toBe(2);
      expect(
        await count('audit_events', `resource_ref = $1 AND operation = 'syntheticTasks.relabel'`, [ref]),
      ).toBe(1);
    }
  });
});
