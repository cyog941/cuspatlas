import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupObjectStore, restoreObjectStore } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA } from './support/fixtures';
import {
  attemptReasons,
  type ImagingStack,
  ingestVia,
  pngBytes,
  sha256,
  startImagingStack,
} from './support/imaging-fixtures';
import { patientBody } from './support/patient-fixtures';
import { SyntheticBridge } from './support/synthetic-bridge';

/**
 * Independent-review fixes for I5-I9 (synthetic data only): acquisition leases never auto-requeue,
 * path prefixes compare literally at the database, device assertions bind the request body,
 * anonymous pairing is throttled, a restore never resurrects tombstoned bytes, hold-subject locks
 * converge, and the small hardening items.
 */
let s: ImagingStack;
let seed = 9100;
const next = () => {
  seed += 1;
  return pngBytes(seed, 5, 5);
};
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
const scratch: string[] = [];
const tmp = (label: string) => {
  const d = mkdtempSync(join(tmpdir(), `cuspatlas-review-${label}-`));
  scratch.push(d);
  return d;
};

async function register(prefixes = ['exports'], kinds = ['import', 'acquire', 'probe']) {
  const r = await s.command('owner', '/v1/imaging/devices', {
    label: 'Review Bridge',
    allowedJobKinds: kinds,
    allowedPathPrefixes: prefixes,
  });
  return data<{ deviceRef: string }>(r).deviceRef;
}
const issueCode = async (deviceRef: string) =>
  data<{ pairingCode: string }>(
    await s.inject('owner', 'POST', `/v1/imaging/devices/${deviceRef}/pairing-codes`, {}),
  ).pairingCode;
async function paired(prefixes?: string[], kinds?: string[]) {
  const deviceRef = await register(prefixes, kinds);
  const b = new SyntheticBridge(s.app);
  expect((await b.pair(await issueCode(deviceRef))).status).toBe(201);
  expect((await b.heartbeat()).status).toBe(200);
  return b;
}
const job = async (jobRef: string) =>
  data<Record<string, unknown>>(await s.inject('owner', 'GET', `/v1/imaging/bridge-jobs/${jobRef}`));
const expireLease = (jobRef: string) =>
  s.db.admin.query(
    `UPDATE cuspatlas.imaging_bridge_jobs SET lease_expires_at = now() - interval '1 second', version = version + 1
     WHERE id = $1`,
    [jobRef],
  );
const readyNow = (jobRef: string) =>
  s.db.admin.query(
    `UPDATE cuspatlas.imaging_bridge_jobs SET next_attempt_at = now(), version = version + 1 WHERE id = $1`,
    [jobRef],
  );
const pairAttempts = async () =>
  (
    await s.db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.security_attempt_events WHERE operation = 'imaging.bridge.pair'`,
    )
  ).rows[0].n as number;

beforeAll(async () => {
  s = await startImagingStack('imaging_review_fixes');
}, 120_000);
afterAll(async () => {
  await s?.close();
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe('1 acquisition lease expiry is an unknown outcome, never an automatic requeue', () => {
  it('an expired acquire lease becomes outcome_unknown and is never claimed again; import still requeues', async () => {
    const b = await paired();
    const e = await s.command('owner', '/v1/imaging/bridge-jobs', {
      deviceRef: b.deviceRef,
      kind: 'acquire',
    });
    expect(e.status).toBe(201);
    const jobRef = data<{ jobRef: string }>(e).jobRef;
    expect((await b.claim()).job?.jobRef).toBe(jobRef);
    await expireLease(jobRef);
    expect((await b.claim()).job).toBeNull();
    expect(await job(jobRef)).toMatchObject({ state: 'outcome_unknown', attempts: 1 });
    await readyNow(jobRef);
    expect((await b.claim()).job).toBeNull();
    expect((await job(jobRef)).state).toBe('outcome_unknown');
    const w = data<{ items: Record<string, unknown>[] }>(
      await s.inject('owner', 'GET', '/v1/imaging/worklists/bridge'),
    );
    expect(w.items.find((i) => i.workItemRef === jobRef)).toMatchObject({ kind: 'bridge_outcome_unknown' });
    // Only a person resolves it.
    const c = await s.command('owner', `/v1/imaging/bridge-jobs/${jobRef}/reconcile`, {
      action: 'cancel',
      reasonCode: 'patient_not_exposed',
    });
    expect(c.status).toBe(200);

    const i = await s.command('owner', '/v1/imaging/bridge-jobs', {
      deviceRef: b.deviceRef,
      kind: 'import',
      importPath: 'exports/r.png',
    });
    const importRef = data<{ jobRef: string }>(i).jobRef;
    expect((await b.claim()).job?.jobRef).toBe(importRef);
    await expireLease(importRef);
    expect((await b.claim()).job).toBeNull();
    expect((await job(importRef)).state).toBe('queued');
  });
});

describe('2 path prefixes compare literally at the database', () => {
  it('scan_in does not admit scanXin/a.png under the runtime role', async () => {
    const b = await paired(['scan_in'], ['import']);
    const client = await s.db.app.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)`,
        [T_ALPHA, b.deviceRef],
      );
      const ask = async (p: string) =>
        (
          await client.query(`SELECT cuspatlas.imaging_bridge_job_allowed($1, 'import', $2) AS ok`, [
            b.deviceRef,
            p,
          ])
        ).rows[0].ok as boolean;
      expect(await ask('scan_in/a.png')).toBe(true);
      expect(await ask('scan_in')).toBe(true);
      expect(await ask('scanXin/a.png')).toBe(false);
      expect(await ask('scan_inX/a.png')).toBe(false);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('3 device assertions bind the request body', () => {
  it('a body swapped after signing, and an assertion without a body digest, are refused', async () => {
    const b = await paired();
    const path = '/v1/bridge/heartbeat';
    const swapped = await b.raw('POST', path, { extra: 1 }, b.assertion('POST', path, { body: {} }));
    expect([swapped.status, swapped.json.code]).toStrictEqual([401, 'unauthenticated']);
    expect(await attemptReasons(s.db.admin, swapped.json.correlationId)).toStrictEqual([
      'device_assertion_invalid',
    ]);
    const missing = await b.raw('POST', path, {}, b.assertion('POST', path, { omitBody: true }));
    expect(missing.status).toBe(401);
    const ok = await b.raw('POST', path, {}, b.assertion('POST', path, { body: {} }));
    expect(ok.status).toBe(200);

    // The uploaded bytes are bound the same way.
    const e = await s.command('owner', '/v1/imaging/bridge-jobs', {
      deviceRef: b.deviceRef,
      kind: 'import',
      importPath: 'exports/body.png',
    });
    const jobRef = data<{ jobRef: string }>(e).jobRef;
    await b.claim();
    const good = next();
    const evil = next();
    const up = `/v1/bridge/jobs/${jobRef}/content`;
    const swap = await b.raw('POST', up, evil, b.assertion('POST', up, { body: good }));
    expect(swap.status).toBe(401);
    const fine = await b.raw('POST', up, good, b.assertion('POST', up, { body: good }));
    expect(fine.status).toBe(200);
  });
});

describe('4 anonymous pairing is throttled', () => {
  it('bounded failed attempts per pairing code answer 429 without further database writes', async () => {
    const deviceRef = await register();
    const code = await issueCode(deviceRef);
    const wrong = [...code.split('.').slice(0, 4), 'A'.repeat(43)].join('.');
    const b = new SyntheticBridge(s.app);
    const before = await pairAttempts();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) statuses.push((await b.pair(wrong)).status);
    expect(statuses).toStrictEqual([401, 401, 401, 401, 401, 429, 429, 429]);
    const limited = await b.pair(wrong);
    expect(limited.json).toMatchObject({ code: 'rate_limited', retryable: true });
    expect((await pairAttempts()) - before).toBe(5);
    // A fresh code (new pairing id) is not locked out.
    const fresh = await issueCode(deviceRef);
    expect((await new SyntheticBridge(s.app).pair(fresh)).status).toBe(201);
  });
});

describe('5 restoring an object store never resurrects tombstoned bytes', () => {
  it('skips content named by a tombstone unless the live store still holds it', async () => {
    const gone = Buffer.from('review-gone-bytes');
    const shared = Buffer.from('review-shared-bytes');
    const dg = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const put = (root: string, area: string, rel: string, body: Buffer | string) => {
      const abs = join(root, area, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, body);
    };
    const content = (b: Buffer) => `${T_ALPHA}/sha256/${dg(b).slice(0, 2)}/${dg(b)}`;
    const tomb = (b: Buffer, ref: string) =>
      JSON.stringify({ objectRef: ref, digestSha256: dg(b), deletedAt: new Date().toISOString() });
    const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'] as const;
    // The backup holds both contents; afterwards both objects were deleted, but only `gone` lost its bytes.
    const old = tmp('old');
    put(old, 't', content(gone), gone);
    put(old, 't', content(shared), shared);
    const backup = tmp('backup');
    await backupObjectStore(old, backup);
    const live = tmp('live');
    put(live, 'tombstones', `${T_ALPHA}/${ids[0]}`, tomb(gone, ids[0]));
    put(live, 'tombstones', `${T_ALPHA}/${ids[1]}`, tomb(shared, ids[1]));
    put(live, 't', content(shared), shared);
    const target = tmp('target');
    const r = await restoreObjectStore(backup, target, { tombstonesFrom: live });
    expect(existsSync(join(target, 't', content(gone)))).toBe(false);
    expect(existsSync(join(target, 't', content(shared)))).toBe(true);
    expect(existsSync(join(target, 'tombstones', T_ALPHA, ids[0]))).toBe(true);
    expect(r).toMatchObject({ skippedTombstoned: 1 });
  });
});

describe('6 hold-subject locks converge when associations change', () => {
  it('recomputes the governing subjects after taking locks, so an association made while waiting is covered', async () => {
    const p2 = data<{ patientRef: string }>(
      await s.command('owner', '/v1/patients', patientBody('Lock Race Two')),
    ).patientRef;
    const { objectRef } = await ingestVia(s, next());
    const holder = await s.db.admin.connect();
    const locker = await s.db.admin.connect();
    let pending: Promise<{ rows: { subjects: string[] }[] }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT cuspatlas.imaging_lock_subjects($1, ARRAY[$2::uuid])', [T_ALPHA, objectRef]);
      await locker.query('BEGIN');
      const pid = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      pending = locker.query('SELECT cuspatlas.imaging_lock_hold_subjects($1, $2) AS subjects', [
        T_ALPHA,
        objectRef,
      ]) as Promise<{ rows: { subjects: string[] }[] }>;
      // Wait until the locker is blocked on the object's lock (it has computed its first subject set).
      for (let i = 0; i < 100; i += 1) {
        const w = await holder.query(
          `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`,
          [pid],
        );
        if (w.rowCount === 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const assoc = await s.command('owner', `/v1/imaging/objects/${objectRef}/association`, {
        patientRef: p2,
        basis: 'operatorSelected',
      });
      expect(assoc.status).toBe(201);
      await holder.query('COMMIT');
      const res = await pending;
      expect(res?.rows[0]?.subjects).toContain(p2);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await pending?.catch(() => undefined);
      await locker.query('ROLLBACK').catch(() => undefined);
      holder.release();
      locker.release();
    }
  }, 60_000);
});

describe('nits', () => {
  it('a pending device is reported as device_unpaired, not revoked', async () => {
    const b = await paired();
    // Fixture only: a pending device that still holds an active key (cannot arise through the API).
    const admin = await s.db.admin.connect();
    try {
      await admin.query('BEGIN');
      await admin.query('ALTER TABLE cuspatlas.imaging_devices DISABLE TRIGGER USER');
      await admin.query(`UPDATE cuspatlas.imaging_devices SET state = 'pending' WHERE id = $1`, [
        b.deviceRef,
      ]);
      await admin.query('ALTER TABLE cuspatlas.imaging_devices ENABLE TRIGGER USER');
      await admin.query('COMMIT');
    } finally {
      admin.release();
    }
    const r = await b.heartbeat();
    expect(r.status).toBe(403);
    expect(await attemptReasons(s.db.admin, r.json.correlationId)).toStrictEqual(['device_unpaired']);
  });

  it('imaging_devices insert needs a principal of kind device', async () => {
    const client = await s.db.app.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)`,
        [T_ALPHA, '20000000-0000-4000-8000-0000000000a1'],
      );
      await expect(
        client.query(
          `INSERT INTO cuspatlas.imaging_devices (id, tenant_id, label, state, allowed_job_kinds, allowed_path_prefixes, created_by)
           VALUES ('20000000-0000-4000-8000-0000000000a1', $1, 'x', 'pending', '{import}', '{exports}',
             '20000000-0000-4000-8000-0000000000a1')`,
          [T_ALPHA],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('reconcile purges expired device nonces and keeps live ones', async () => {
    const b = await paired();
    await s.db.admin.query(
      `INSERT INTO cuspatlas.imaging_device_nonces (tenant_id, device_id, nonce, expires_at, used_at)
       VALUES ($1, $2, gen_random_uuid(), now() - interval '2 days', now() - interval '2 days')`,
      [T_ALPHA, b.deviceRef],
    );
    const count = async () =>
      (
        await s.db.admin.query(
          'SELECT count(*)::int AS n FROM cuspatlas.imaging_device_nonces WHERE device_id = $1',
          [b.deviceRef],
        )
      ).rows[0].n as number;
    const before = await count();
    expect((await s.command('owner', '/v1/imaging/storage/reconcile', {})).status).toBe(200);
    expect(before - (await count())).toBe(1);
    expect(await count()).toBeGreaterThan(0);
  });

  it('the staging sweep removes orphaned staged bytes of rolled-back uploads and keeps referenced ones', async () => {
    // A staged file no session or job names (its database transaction rolled back).
    const orphan = await s.store.stage(T_ALPHA, next());
    // A staged file a live session names.
    const bytes = next();
    const ing = await s.command('owner', '/v1/imaging/ingress', {
      contentType: 'image/png',
      byteLength: bytes.byteLength,
      declaredDigest: sha256(bytes),
      provenance: { source: 'operatorUpload' },
    });
    const ingressRef = data<{ ingressRef: string }>(ing).ingressRef;
    expect((await s.command('owner', `/v1/imaging/ingress/${ingressRef}/content`, bytes)).status).toBe(200);
    const named = await s.db.admin.query(
      'SELECT staging_key FROM cuspatlas.imaging_ingress_sessions WHERE id = $1',
      [ingressRef],
    );
    const namedKey = named.rows[0].staging_key as string;
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    for (const k of [orphan.stagingKey, namedKey]) utimesSync(join(s.storeRoot, k), old, old);
    const fresh = await s.store.stage(T_ALPHA, next());
    expect((await s.command('owner', '/v1/imaging/storage/reconcile', {})).status).toBe(200);
    expect(existsSync(join(s.storeRoot, orphan.stagingKey))).toBe(false);
    expect(existsSync(join(s.storeRoot, namedKey))).toBe(true);
    expect(existsSync(join(s.storeRoot, fresh.stagingKey))).toBe(true);
  });
});

// Last: it exhausts the per-source failure bound of the shared test client address.
describe('4b anonymous pairing source bound', () => {
  it('bounds failures per source even when every body is garbage', async () => {
    const b = new SyntheticBridge(s.app);
    const before = await pairAttempts();
    let limited = 0;
    let refused = 0;
    for (let i = 0; i < 60; i += 1) {
      const r = await b.raw('POST', '/v1/bridge/pair', { pairingCode: `junk${i}` }, null);
      if (r.status === 429) limited += 1;
      else refused += 1;
    }
    expect(limited).toBeGreaterThan(0);
    expect((await pairAttempts()) - before).toBe(refused);
  });
});
