import { randomBytes } from 'node:crypto';
import { buildApp } from '@cuspatlas/api';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  createCursorCodec,
  createSchedulingCursorCodec,
  resolveCursorKeyRing,
  SYNTHETIC_TEST_CURSOR_KEY,
} from '@cuspatlas/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  openAppointmentHarness,
  seedLocation,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';

/**
 * Closeout A item 1: list cursors are keyed by the configured CUSPATLAS_CURSOR_KEY (test-only default
 * under synthetic-test, refused elsewhere), shared by every instance, with a previous-key grace on
 * rotation. Synthetic data only.
 */
const T = '10000000-0000-4000-8000-00000000000a';
const ID = '40000000-0000-4000-8000-0000000000a1';
const K1 = new Uint8Array(randomBytes(32));
const K2 = new Uint8Array(randomBytes(32));

describe('cursor key ring resolution', () => {
  it('uses the test-only key under synthetic-test and refuses it, a missing key or a short key elsewhere', () => {
    expect(resolveCursorKeyRing('synthetic-test', undefined).current).toBe(SYNTHETIC_TEST_CURSOR_KEY);
    expect(() => resolveCursorKeyRing('production', undefined)).toThrow(/CUSPATLAS_CURSOR_KEY/);
    expect(() => resolveCursorKeyRing('development', SYNTHETIC_TEST_CURSOR_KEY)).toThrow(/test-only/);
    expect(() => resolveCursorKeyRing('production', new Uint8Array(16))).toThrow(/32 bytes/);
    expect(() => resolveCursorKeyRing('production', K1, K1)).toThrow(/differ/);
    expect(resolveCursorKeyRing('production', K1, K2)).toStrictEqual({ current: K1, previous: K2 });
  });

  it('a rotated ring still decodes cursors minted with the previous key; an unrelated key refuses them', () => {
    const old = createCursorCodec({ current: K1 }).encode(T, ID);
    expect(createCursorCodec({ current: K2, previous: K1 }).decode(T, old)).toBe(ID);
    expect(() => createCursorCodec({ current: K2 }).decode(T, old)).toThrow();
    const s = createSchedulingCursorCodec({ current: K1 }).encode(T, 'scope', 'pos:1');
    expect(createSchedulingCursorCodec({ current: K2, previous: K1 }).decode(T, 'scope', s)).toBe('pos:1');
    expect(() => createSchedulingCursorCodec({ current: K2 }).decode(T, 'scope', s)).toThrow();
    // New cursors are minted with the current key only.
    const fresh = createCursorCodec({ current: K2, previous: K1 }).encode(T, ID);
    expect(() => createCursorCodec({ current: K1 }).decode(T, fresh)).toThrow();
  });

  it('offset positions (agent and automation lists) round-trip', () => {
    const c = createCursorCodec({ current: K1 });
    expect(c.decode(T, c.encode(T, '25'))).toBe('25');
  });
});

let db: TestDatabase;
let h: AppointmentHarness;
const extra: FastifyInstance[] = [];

const rebuild = async (cursorKey: Uint8Array, cursorPreviousKey?: Uint8Array) => {
  const app = await buildApp({
    env: 'synthetic-test',
    identity: h.issuer.verifierConfig,
    membership: createMembershipSource(db.app),
    attempts: createSecurityAttemptSink(db.sink),
    tenantTransactions: createTenantTransactionRunner(db.app),
    cursorKey,
    ...(cursorPreviousKey ? { cursorPreviousKey } : {}),
  });
  extra.push(app);
  return app;
};
const get = (app: FastifyInstance, url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${h.tokens.a1}` } });

beforeAll(async () => {
  db = await openTestDatabase('cursor_key');
  h = await openAppointmentHarness(db);
  await seedLocation(h, 'loc-north');
  await seedLocation(h, 'loc-south');
});
afterAll(async () => {
  for (const a of extra) await a.close();
  await h?.close();
  await db?.close();
});

describe('cursors survive an app rebuild with the same key', () => {
  for (const [label, path] of [
    ['foundation codec (synthetic tasks)', '/v1/synthetic-tasks'],
    ['scheduling codec (resources)', '/v1/scheduling/resources'],
  ] as const) {
    it(label, async () => {
      const first = await rebuild(K1);
      const page = await get(first, `${path}?limit=1`);
      expect(page.statusCode).toBe(200);
      const cursor = page.json() as { envelope?: { nextCursor: string }; nextCursor?: string };
      const next = cursor.envelope?.nextCursor ?? cursor.nextCursor;
      expect(next).toEqual(expect.any(String));
      const url = `${path}?limit=1&cursor=${encodeURIComponent(next as string)}`;
      expect((await get(await rebuild(K1), url)).statusCode).toBe(200);
      expect((await get(await rebuild(K2), url)).statusCode).toBe(400);
      expect((await get(await rebuild(K2, K1), url)).statusCode).toBe(200);
    });
  }
});
