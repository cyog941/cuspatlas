import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { buildApp, loadConfiguredIdentity, resolveRuntimeEnv } from '@cuspatlas/api';
import type { CommandResult } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import type { CommandExecutor } from '@cuspatlas/domain';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, seedTenancy, T_ALPHA, T_BETA, TASK_A, USER_A1, USER_A4, USER_B1 } from './support/fixtures';
import {
  createTestTokenIssuer,
  TEST_AUDIENCE,
  TEST_ISSUER,
  type TestTokenIssuer,
} from './support/test-token-issuer';

let db: TestDatabase;
let issuer: TestTokenIssuer;
const apps: FastifyInstance[] = [];
let a1: string;

async function appWith(pool: pg.Pool, extra: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const app = await buildApp({
    env: 'synthetic-test',
    logger: { level: 'silent' },
    identity: issuer.verifierConfig,
    membership: createMembershipSource(pool),
    attempts: createSecurityAttemptSink(db.sink),
    tenantTransactions: createTenantTransactionRunner(pool),
    ...extra,
  });
  apps.push(app);
  return app;
}

async function attemptRows(correlationId: string) {
  return (
    await db.admin.query(
      'SELECT tenant_id, actor_id, reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
      [correlationId],
    )
  ).rows;
}

function post(
  app: FastifyInstance,
  url: string,
  token: string | null,
  payload: string,
  key: string = randomUUID(),
) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    payload,
  });
}

beforeAll(async () => {
  db = await openTestDatabase('review_hardening');
  await seedTenancy(db.admin);
  issuer = await createTestTokenIssuer();
  a1 = await issuer.issue({ sub: USER_A1, tid: T_ALPHA });
});

afterAll(async () => {
  for (const a of apps) await a.close();
  await db?.close();
});

describe('R1 no pool self-deadlock', () => {
  it('2x pool-size concurrent GET-by-id and relabel requests all complete on a 2-connection pool', async () => {
    const pool = db.appPool(2);
    const app = await appWith(pool);
    const made = await post(app, '/v1/synthetic-tasks', a1, JSON.stringify({ label: 'shared' }));
    const ref = made.json().data.taskRef;
    const work: Promise<LightMyRequestResponse>[] = [];
    for (let i = 0; i < 4; i += 1) {
      work.push(
        app.inject({
          method: 'GET',
          url: `/v1/synthetic-tasks/${TASK_A}`,
          headers: { authorization: `Bearer ${a1}` },
        }),
      );
      work.push(
        post(
          app,
          `/v1/synthetic-tasks/${ref}/relabel`,
          a1,
          JSON.stringify({ label: `r${i}`, expectedVersion: 1 }),
        ),
      );
    }
    const timeout = new Promise<'timeout'>((ok) => setTimeout(() => ok('timeout'), 8000));
    const outcome = await Promise.race([Promise.all(work), timeout]);
    expect(outcome).not.toBe('timeout');
    const statuses = (outcome as LightMyRequestResponse[]).map((r) => r.statusCode).sort();
    expect(statuses.filter((s) => s === 200).length).toBe(5); // 4 reads + exactly one relabel winner
    expect(statuses.filter((s) => s === 409).length).toBe(3);
  });
});

describe('R2 executor seam and refusal ordering', () => {
  it('a replaying executor can replay a committed relabel even when expectedVersion is now stale', async () => {
    const saved = new Map<string, CommandResult<unknown>>();
    const replaying: CommandExecutor = async <T>(
      ctx: Parameters<CommandExecutor>[0],
      envelope: Parameters<CommandExecutor>[1],
      _tx: Parameters<CommandExecutor>[2],
      handler: () => Promise<{ data: T; version: number }>,
    ) => {
      const prior = saved.get(envelope.idempotencyKey);
      if (prior) return { ...(prior as CommandResult<T>), replayed: true };
      const { data, version } = await handler();
      const result = { data, version, correlationId: ctx.correlationId, replayed: false };
      saved.set(envelope.idempotencyKey, result);
      return result;
    };
    const app = await appWith(db.app, { execute: replaying });
    const ref = (await post(app, '/v1/synthetic-tasks', a1, JSON.stringify({ label: 'v1' }))).json().data
      .taskRef;
    const body = JSON.stringify({ label: 'v2', expectedVersion: 1 });
    const first = await post(app, `/v1/synthetic-tasks/${ref}/relabel`, a1, body, 'relabel-key-1');
    expect(first.statusCode).toBe(200);
    const again = await post(app, `/v1/synthetic-tasks/${ref}/relabel`, a1, body, 'relabel-key-1');
    expect([again.statusCode, again.json().replayed, again.json().version]).toStrictEqual([200, true, 2]);
    const fresh = await post(app, `/v1/synthetic-tasks/${ref}/relabel`, a1, body, 'relabel-key-2');
    expect([fresh.statusCode, fresh.json().code, fresh.json().detail]).toStrictEqual([
      409,
      'stale_version',
      { currentVersion: 2 },
    ]);
  });

  it('authorization is checked before schema validation (auth -> schema -> domain)', async () => {
    const app = await appWith(db.app);
    const a4 = await issuer.issue({ sub: USER_A4, tid: T_ALPHA });
    const res = await post(app, '/v1/synthetic-tasks', a4, JSON.stringify({ label: '', bogus: 1 }));
    expect([res.statusCode, res.json().code]).toStrictEqual([403, 'forbidden']);
    const relabel = await post(app, `/v1/synthetic-tasks/${TASK_A}/relabel`, a4, JSON.stringify({ nope: 1 }));
    expect(relabel.statusCode).toBe(403);
  });
});

describe('R4 authentication precedes body parsing', () => {
  it('malformed or unsupported bodies without a token are 401 with an attempt row', async () => {
    const app = await appWith(db.app);
    for (const [ct, payload] of [
      ['application/json', '{"label":'],
      ['text/plain', 'label=x'],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/synthetic-tasks',
        headers: { 'content-type': ct, 'idempotency-key': 'k' },
        payload,
      });
      expect([ct, res.statusCode]).toStrictEqual([ct, 401]);
      expect(await attemptRows(res.json().correlationId)).toStrictEqual([
        { tenant_id: null, actor_id: null, reason_code: 'token_missing' },
      ]);
    }
  });
});

describe('R5 opaque, tenant-bound cursors', () => {
  it('rejects tampered cursors and cursors minted for another tenant', async () => {
    const app = await appWith(db.app);
    const page = (
      await app.inject({
        method: 'GET',
        url: '/v1/synthetic-tasks?limit=1',
        headers: { authorization: `Bearer ${a1}` },
      })
    ).json();
    const cursor: string = page.nextCursor;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cursor).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    const ok = await app.inject({
      method: 'GET',
      url: `/v1/synthetic-tasks?limit=1&cursor=${cursor}`,
      headers: { authorization: `Bearer ${a1}` },
    });
    expect(ok.statusCode).toBe(200);
    const [body, mac] = cursor.split('.') as [string, string];
    const forgedBody = Buffer.from(
      JSON.stringify({ v: 1, after: '00000000-0000-4000-8000-000000000000' }),
    ).toString('base64url');
    const flipped = `${mac.slice(0, -2)}${mac.endsWith('AA') ? 'BB' : 'AA'}`;
    const b1 = await issuer.issue({ sub: USER_B1, tid: T_BETA });
    for (const [token, c] of [
      [a1, `${forgedBody}.${mac}`],
      [a1, `${body}.${flipped}`],
      [a1, body],
      [b1, cursor],
    ] as const) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/synthetic-tasks?cursor=${c}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect([c, res.statusCode]).toStrictEqual([c, 400]);
    }
  });
});

describe('R6 structural test-issuer refusal and server entrypoint', () => {
  it('refuses a non-configured key source outside synthetic-test even when it does not look like the test issuer', async () => {
    const disguised = { ...issuer.verifierConfig, issuer: 'https://idp.invalid', testOnly: false };
    for (const env of ['development', 'production'] as const) {
      await expect(
        buildApp({
          env,
          identity: disguised,
          membership: createMembershipSource(db.app),
          attempts: createSecurityAttemptSink(db.sink),
        }),
      ).rejects.toThrow(/key source/i);
    }
  });

  it('accepts a configured key source loaded from the environment, and refuses unknown environments', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const identity = await loadConfiguredIdentity({
      CUSPATLAS_JWT_ISSUER: 'https://idp.invalid',
      CUSPATLAS_JWT_AUDIENCE: 'urn:cuspatlas:api',
      CUSPATLAS_JWT_PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    const app = await buildApp({
      env: 'development',
      logger: { level: 'silent' },
      identity,
      membership: createMembershipSource(db.app),
      attempts: createSecurityAttemptSink(db.sink),
    });
    apps.push(app);
    await expect(
      loadConfiguredIdentity({
        CUSPATLAS_JWT_ISSUER: TEST_ISSUER,
        CUSPATLAS_JWT_AUDIENCE: 'x',
        CUSPATLAS_JWT_PUBLIC_KEY_PEM: 'x',
      }),
    ).rejects.toThrow();
    await expect(loadConfiguredIdentity({})).rejects.toThrow();
    expect(resolveRuntimeEnv({ CUSPATLAS_ENV: 'development' })).toBe('development');
    expect(() => resolveRuntimeEnv({ CUSPATLAS_ENV: 'prod-ish' })).toThrow(/CUSPATLAS_ENV/);
    expect(() => resolveRuntimeEnv({})).toThrow(/CUSPATLAS_ENV/);
  });
});

describe('R7 algorithm confusion', () => {
  it('HS256 (keyed with the public key bytes) and RS256 tokens are 401', async () => {
    const app = await appWith(db.app);
    const ed = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const spki = await exportSPKI(ed.publicKey);
    const rsa = await generateKeyPair('RS256');
    const claims = { tid: T_ALPHA, sid: randomUUID() };
    const base = (alg: string) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg, typ: 'JWT' })
        .setSubject(USER_A1)
        .setIssuer(TEST_ISSUER)
        .setAudience(TEST_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('5m');
    for (const token of [
      await base('HS256').sign(new TextEncoder().encode(spki)),
      await base('RS256').sign(rsa.privateKey),
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/session',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('R8 attempt tenant attribution and membership visibility', () => {
  it('the runtime role cannot attribute an attempt to a tenant without the sink-scoped setting', async () => {
    const insert = (tenant: string | null) =>
      db.app.query(
        `INSERT INTO cuspatlas.security_attempt_events
           (attempt_ref, correlation_id, tenant_id, actor_id, operation, reason_code, occurred_at)
         VALUES ($1, $2, $3, NULL, 'session.read', 'token_invalid', now())`,
        [randomUUID(), randomUUID(), tenant],
      );
    await expect(insert(T_ALPHA)).rejects.toMatchObject({ code: '42501' });
    await expect(insert(null)).resolves.toBeDefined();
    const sink = createSecurityAttemptSink(db.sink);
    const ev = await sink.record({
      correlationId: randomUUID(),
      tenantId: T_ALPHA,
      actorId: USER_A1,
      operation: 'session.read',
      reasonCode: 'scope_missing',
    });
    expect((await attemptRows(ev.correlationId))[0]).toMatchObject({ tenant_id: T_ALPHA });
  });

  it('a member sees only its own membership row inside its tenant', async () => {
    const tx = createTenantTransactionRunner(db.app);
    const rows = await tx(ctxFor(T_ALPHA, USER_A1, 'human'), async (t) => {
      const m = await t.query<{ principal_id: string }>('SELECT principal_id FROM cuspatlas.memberships');
      return m.rows.map((r) => r.principal_id);
    });
    expect(rows).toStrictEqual([USER_A1]);
  });
});
