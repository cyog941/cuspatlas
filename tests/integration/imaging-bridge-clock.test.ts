import { setTimeout as sleep } from 'node:timers/promises';
import type { ObjectStorePort } from '@cuspatlas/contracts';
import { bridgeBackoffSeconds } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA, USER_A1 } from './support/fixtures';
import { type ImagingStack, pngBytes, putFixtureObject, startImagingStack } from './support/imaging-fixtures';
import { SyntheticBridge } from './support/synthetic-bridge';

/**
 * Clock audit review: a backoff written late in a long transaction. `imaging.storage.reconcile`
 * digest-verifies up to 500 objects before its bridge lease sweep runs; a backoff computed from the
 * transaction start (`now()`) could already be in the past when that transaction commits. The sweep
 * stamps `next_attempt_at` from the statement wall clock instead.
 */
const SLOW_MS = 1500;
let s: ImagingStack;
let slow = false;
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;

beforeAll(async () => {
  s = await startImagingStack('imaging_bridge_clock', {
    // A slow digest-verification phase (the integrity read) while `slow` is set.
    wrapStore: (store: ObjectStorePort): ObjectStorePort =>
      new Proxy(store, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          if (prop !== 'read' || typeof v !== 'function') return typeof v === 'function' ? v.bind(target) : v;
          return async (...args: unknown[]) => {
            if (slow) await sleep(SLOW_MS);
            return v.apply(target, args);
          };
        },
      }),
  });
});
afterAll(async () => {
  await s?.close();
});

describe('bridge backoff after a slow phase of the same transaction (clock audit review)', () => {
  it('a requeue backoff written after slow integrity reads is still in the future at commit', async () => {
    await putFixtureObject(s.db.admin, s.store, {
      tenantId: T_ALPHA,
      createdBy: USER_A1,
      bytes: pngBytes(7, 4, 4),
    });
    const reg = await s.command('owner', '/v1/imaging/devices', {
      label: 'Synthetic Bridge',
      allowedJobKinds: ['import', 'probe'],
      allowedPathPrefixes: ['exports'],
    });
    const deviceRef = data<{ deviceRef: string }>(reg).deviceRef;
    const code = data<{ pairingCode: string }>(
      await s.inject('owner', 'POST', `/v1/imaging/devices/${deviceRef}/pairing-codes`, {}),
    ).pairingCode;
    const b = new SyntheticBridge(s.app);
    expect((await b.pair(code)).status).toBe(201);
    const e = await s.command('owner', '/v1/imaging/bridge-jobs', {
      kind: 'import',
      importPath: 'exports/2026/a.png',
      deviceRef,
    });
    expect(e.status).toBe(201);
    const { job: env } = await b.claim();
    const jobRef = (env as NonNullable<typeof env>).jobRef;
    // The lease ran out without bytes: the next sweep requeues the import with backoff.
    await s.db.admin.query(
      `UPDATE cuspatlas.imaging_bridge_jobs SET lease_expires_at = now() - interval '1 second', version = version + 1
       WHERE id = $1`,
      [jobRef],
    );
    const clock = async () =>
      (await s.db.admin.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]?.at as Date;
    const before = await clock();
    slow = true;
    let r: Awaited<ReturnType<ImagingStack['command']>>;
    try {
      r = await s.command('owner', '/v1/imaging/storage/reconcile', {});
    } finally {
      slow = false;
    }
    expect(r.status).toBe(200);
    const committed = await clock();
    const { rows } = await s.db.admin.query<{ state: string; attempts: number; next_attempt_at: Date }>(
      'SELECT state, attempts, next_attempt_at FROM cuspatlas.imaging_bridge_jobs WHERE id = $1',
      [jobRef],
    );
    expect(rows[0]).toMatchObject({ state: 'queued', attempts: 1 });
    const next = rows[0]?.next_attempt_at as Date;
    const from = next.getTime() - bridgeBackoffSeconds(1) * 1000;
    // The backoff runs from the sweep's own statement, after the slow phase (not from the transaction
    // start, which precedes it), so the whole backoff lies ahead of the commit.
    expect(from - before.getTime()).toBeGreaterThanOrEqual(SLOW_MS - 50);
    expect(from).toBeLessThanOrEqual(committed.getTime());
  });
});
