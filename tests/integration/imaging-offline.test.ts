import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attemptReasons,
  type ImagingStack,
  pngBytes,
  sha256,
  startImagingStack,
  type Who,
} from './support/imaging-fixtures';
import { patientBody } from './support/patient-fixtures';
import { SyntheticBridge } from './support/synthetic-bridge';

/**
 * I7 offline device, bridge failure and recovery worklist (synthetic; device-specific operator guidance
 * stays blocked on I-S1). Availability is derived from heartbeats; an acquisition for a device that is
 * not available is a visible deferred item (owner, reason, due, next action), bounded per tenant and
 * released exactly once; failed attempts retry with bounded backoff; an unknown outcome is reconciled,
 * never re-run; recovery after reconnect deduplicates by digest and never repeats a completed job.
 */
const BOUND = 5;
let s: ImagingStack;
let pOne: string;
let seed = 7000;
const next = () => {
  seed += 1;
  return pngBytes(seed, 5, 5);
};
const reason = (r: { json: Record<string, unknown> }) =>
  (r.json.detail as { reason?: string } | undefined)?.reason;
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;

async function paired(o: { heartbeat?: boolean } = {}) {
  const reg = await s.command('owner', '/v1/imaging/devices', {
    label: 'Offline Bridge',
    allowedJobKinds: ['import', 'acquire'],
    allowedPathPrefixes: ['exports'],
  });
  const deviceRef = data<{ deviceRef: string }>(reg).deviceRef;
  const code = data<{ pairingCode: string }>(
    await s.inject('owner', 'POST', `/v1/imaging/devices/${deviceRef}/pairing-codes`, {}),
  ).pairingCode;
  const b = new SyntheticBridge(s.app);
  expect((await b.pair(code)).status).toBe(201);
  if (o.heartbeat !== false) expect((await b.heartbeat()).status).toBe(200);
  return b;
}
const acquire = (deviceRef: string, extra: Record<string, unknown> = {}, who: Who = 'owner') =>
  s.command(who, '/v1/imaging/acquisitions', {
    deviceRef,
    kind: 'import',
    importPath: 'exports/a.png',
    ...extra,
  });
const resolve = (deferralRef: string, body: Record<string, unknown>, who: Who = 'owner') =>
  s.command(who, `/v1/imaging/acquisitions/${deferralRef}/resolve`, body);
const worklist = async () =>
  data<{ coverage: { status: string; unavailableDevices: string[] }; items: Record<string, unknown>[] }>(
    await s.inject('owner', 'GET', '/v1/imaging/worklists/bridge'),
  );
const job = async (jobRef: string) =>
  data<Record<string, unknown>>(await s.inject('owner', 'GET', `/v1/imaging/bridge-jobs/${jobRef}`));
const availability = async (deviceRef: string) =>
  data<{ availability: { state: string; jobsVisible: string; lastHeartbeatAt: string | null } }>(
    await s.inject('owner', 'GET', `/v1/imaging/devices/${deviceRef}`),
  ).availability;
/** Test-only fixture paths: move device and job clocks relative to the database clock. */
const heartbeatAgo = (deviceRef: string, seconds: number) =>
  s.db.admin.query(
    `UPDATE cuspatlas.imaging_devices SET last_heartbeat_at = now() - make_interval(secs => $2) WHERE id = $1`,
    [deviceRef, seconds],
  );
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

beforeAll(async () => {
  s = await startImagingStack('imaging_offline', { limits: { maxDeferredAcquisitions: BOUND } });
  pOne = data<{ patientRef: string }>(
    await s.command('owner', '/v1/patients', patientBody('Offline One')),
  ).patientRef;
});
afterAll(async () => {
  await s?.close();
});

describe('I7 heartbeat-derived availability and deferred acquisitions', () => {
  it('an acquisition for an offline device is a visible deferred item; release after reconnect yields one job and one object', async () => {
    const b = await paired({ heartbeat: false });
    expect(await availability(b.deviceRef)).toMatchObject({
      state: 'offline',
      lastHeartbeatAt: null,
      jobsVisible: 'unknown_since_last_heartbeat',
    });
    const r = await acquire(b.deviceRef);
    expect([r.status, r.json.data]).toMatchObject([
      201,
      { state: 'deferred', jobRef: null, deferReason: 'device_offline' },
    ]);
    const deferralRef = data<{ deferralRef: string }>(r).deferralRef;
    const w = await worklist();
    expect(w.coverage.status).toBe('partial');
    expect(w.coverage.unavailableDevices).toContain(b.deviceRef);
    expect(w.items.find((i) => i.workItemRef === deferralRef)).toMatchObject({
      kind: 'acquisition_deferred',
      reasonCode: 'device_offline',
      owner: { queue: 'imaging' },
      nextActionOwedBy: 'practice',
      suggestedNextAction: 'restore_device_or_manual_import',
    });
    // Not releasable while the device is still away.
    const early = await resolve(deferralRef, { action: 'release' });
    expect([early.status, reason(early)]).toStrictEqual([409, 'device_offline']);
    await b.heartbeat();
    expect((await availability(b.deviceRef)).state).toBe('available');
    const rel = await resolve(deferralRef, { action: 'release' });
    expect(rel.status).toBe(200);
    const jobRef = data<{ jobRef: string }>(rel).jobRef;
    const twice = await resolve(deferralRef, { action: 'release' });
    expect([twice.status, reason(twice)]).toStrictEqual([409, 'duplicate_release']);
    const { job: env } = await b.claim();
    expect(env?.jobRef).toBe(jobRef);
    const bytes = next();
    await b.upload(jobRef, bytes);
    const done = await b.report(
      jobRef,
      b.resultToken(env as NonNullable<typeof env>, { outcome: 'completed', bytes }),
    );
    expect(done.status).toBe(200);
    const jobs = await s.db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.imaging_bridge_jobs WHERE deferral_id = $1',
      [deferralRef],
    );
    expect(jobs.rows[0].n).toBe(1);
  });

  it('a stale heartbeat is not available; an available device queues directly', async () => {
    const b = await paired();
    const direct = await acquire(b.deviceRef);
    expect(data<{ state: string; jobRef: string }>(direct)).toMatchObject({ state: 'queued' });
    await heartbeatAgo(b.deviceRef, 300);
    expect((await availability(b.deviceRef)).state).toBe('stale');
    const r = await acquire(b.deviceRef);
    expect(r.json.data).toMatchObject({ state: 'deferred', deferReason: 'device_stale' });
    await heartbeatAgo(b.deviceRef, 3600);
    expect((await availability(b.deviceRef)).state).toBe('offline');
    const w = await worklist();
    expect(w.items.some((i) => i.kind === 'device_unavailable' && i.workItemRef === b.deviceRef)).toBe(true);
  });

  it('the deferred queue is bounded with a typed refusal; cancellation needs a reason and records the actor', async () => {
    const b = await paired({ heartbeat: false });
    const open = await s.db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.imaging_acquisition_deferrals WHERE state = 'deferred'`,
    );
    const refs: string[] = [];
    for (let i = open.rows[0].n as number; i < BOUND; i += 1)
      refs.push(data<{ deferralRef: string }>(await acquire(b.deviceRef)).deferralRef);
    const over = await acquire(b.deviceRef);
    expect([over.status, reason(over)]).toStrictEqual([409, 'queue_bound_reached']);
    expect((over.json.detail as { limit: unknown }).limit).toStrictEqual({
      name: 'maxDeferredAcquisitions',
      value: BOUND,
    });
    const ref = refs[0] as string;
    const noReason = await resolve(ref, { action: 'cancel' });
    expect([noReason.status, reason(noReason)]).toStrictEqual([422, 'missing_reason']);
    expect((await resolve(ref, { action: 'cancel', reasonCode: 'manual_import' }, 'service')).status).toBe(
      403,
    );
    const c = await resolve(ref, { action: 'cancel', reasonCode: 'manual_import' });
    expect([c.status, c.json.data]).toMatchObject([
      200,
      { state: 'cancelled', resolutionReason: 'manual_import' },
    ]);
    const row = await s.db.admin.query(
      'SELECT resolved_by FROM cuspatlas.imaging_acquisition_deferrals WHERE id = $1',
      [ref],
    );
    expect(row.rows[0].resolved_by).toBe('20000000-0000-4000-8000-0000000000a1');
    expect([(await resolve(ref, { action: 'release' })).status]).toStrictEqual([409]);
    for (const x of refs.slice(1)) await resolve(x, { action: 'cancel', reasonCode: 'test_cleanup' });
  });

  it('a deferred item whose patient record changed needs re-confirmation before release', async () => {
    const b = await paired({ heartbeat: false });
    const r = await acquire(b.deviceRef, { intendedPatientRef: pOne });
    const deferralRef = data<{ deferralRef: string }>(r).deferralRef;
    const pt = data<{ version: number }>(await s.inject('owner', 'GET', `/v1/patients/${pOne}`));
    const upd = await s.command('owner', `/v1/patients/${pOne}/demographics`, {
      expectedVersion: pt.version,
      preferredName: { known: true, value: 'Changed' },
    });
    expect(upd.status).toBe(200);
    await b.heartbeat();
    const blocked = await resolve(deferralRef, { action: 'release' });
    expect([blocked.status, reason(blocked)]).toStrictEqual([409, 'patient_reconfirmation_required']);
    const ok = await resolve(deferralRef, { action: 'release', patientReconfirmed: true });
    expect([ok.status, ok.json.data]).toMatchObject([200, { state: 'released' }]);
  });
});

describe('I7 bridge failure, bounded retry and reconciliation', () => {
  it('a retryable failure backs off and retries; attempts are bounded, then the job fails visibly', async () => {
    const b = await paired();
    const e = await s.command('owner', '/v1/imaging/bridge-jobs', {
      deviceRef: b.deviceRef,
      kind: 'import',
      importPath: 'exports/r.png',
    });
    const jobRef = data<{ jobRef: string }>(e).jobRef;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await readyNow(jobRef);
      const { job: env } = await b.claim();
      expect([attempt, env?.attempt]).toStrictEqual([attempt, attempt]);
      const r = await b.report(
        jobRef,
        b.resultToken(env as NonNullable<typeof env>, {
          outcome: 'failed',
          failureReason: 'device_busy',
          retryable: true,
        }),
      );
      expect(r.status).toBe(200);
      const j = await job(jobRef);
      if (attempt < 3) {
        expect(j.state).toBe('queued');
        // Backoff: not claimable at once (30 s, then 60 s).
        const wait = Date.parse(j.nextAttemptAt as string) - Date.now();
        expect(wait).toBeGreaterThan(attempt * 30_000 - 5_000);
        expect((await b.claim()).job).toBeNull();
      } else {
        expect(j).toMatchObject({ state: 'failed', failureReason: 'device_busy', attempts: 3 });
      }
    }
    const w = await worklist();
    expect(w.items.find((i) => i.workItemRef === jobRef)).toMatchObject({
      kind: 'bridge_job_failed',
      reasonCode: 'device_busy',
    });
  });

  it('a lease that runs out without bytes is retried; with bytes staged the outcome is unknown and never re-run', async () => {
    const b = await paired();
    const e = await s.command('owner', '/v1/imaging/bridge-jobs', {
      deviceRef: b.deviceRef,
      kind: 'import',
      importPath: 'exports/l.png',
    });
    const jobRef = data<{ jobRef: string }>(e).jobRef;
    const first = await b.claim();
    await expireLease(jobRef);
    // The next claim sweeps the lease first: requeued with backoff, not claimed again at once.
    expect((await b.claim()).job).toBeNull();
    expect(await job(jobRef)).toMatchObject({ state: 'queued', attempts: 1 });
    expect(first.job?.attempt).toBe(1);
    await readyNow(jobRef);
    const { job: env } = await b.claim();
    const j = env as NonNullable<typeof env>;
    const bytes = next();
    await b.upload(jobRef, bytes);
    await expireLease(jobRef);
    const w0 = await worklist();
    expect(w0.items.find((i) => i.workItemRef === jobRef)).toMatchObject({ kind: 'bridge_outcome_unknown' });
    expect((await b.claim()).job).toBeNull();
    expect((await job(jobRef)).state).toBe('outcome_unknown');
    // The device reconnects and delivers its signed result late: completed once, no re-run.
    const late = await b.report(jobRef, b.resultToken(j, { outcome: 'completed', bytes }));
    expect([late.status, late.json.data]).toMatchObject([200, { state: 'completed' }]);
    expect((await b.claim()).job).toBeNull();
  });

  it('recovery after reconnect: a requeued unknown job re-imports the same bytes into the same object', async () => {
    const b = await paired();
    const bytes = next();
    // A first, completed import of these bytes for the patient.
    const e1 = await s.command('owner', '/v1/imaging/bridge-jobs', {
      deviceRef: b.deviceRef,
      kind: 'import',
      importPath: 'exports/d.png',
      intendedPatientRef: pOne,
    });
    const j1 = data<{ jobRef: string }>(e1).jobRef;
    const c1 = (await b.claim()).job as NonNullable<Awaited<ReturnType<SyntheticBridge['claim']>>['job']>;
    await b.upload(j1, bytes);
    const r1 = await b.report(j1, b.resultToken(c1, { outcome: 'completed', bytes }));
    const objectRef = data<{ objectRef: string }>(r1).objectRef;
    // A second job for the same file disappears mid-transfer; a person requeues it with a reason.
    const e2 = await s.command('owner', '/v1/imaging/bridge-jobs', {
      deviceRef: b.deviceRef,
      kind: 'import',
      importPath: 'exports/d.png',
      intendedPatientRef: pOne,
    });
    const j2 = data<{ jobRef: string }>(e2).jobRef;
    await b.claim();
    await b.upload(j2, bytes);
    await expireLease(j2);
    expect((await b.claim()).job).toBeNull();
    const noReason = await s.command('owner', `/v1/imaging/bridge-jobs/${j2}/reconcile`, {
      action: 'requeue',
    });
    expect(noReason.status).toBe(400);
    expect(
      (
        await s.command('service', `/v1/imaging/bridge-jobs/${j2}/reconcile`, {
          action: 'requeue',
          reasonCode: 'device_reconnected',
        })
      ).status,
    ).toBe(403);
    const rq = await s.command('owner', `/v1/imaging/bridge-jobs/${j2}/reconcile`, {
      action: 'requeue',
      reasonCode: 'device_reconnected',
    });
    expect([rq.status, rq.json.data]).toMatchObject([200, { state: 'queued' }]);
    const c2 = (await b.claim()).job as NonNullable<Awaited<ReturnType<SyntheticBridge['claim']>>['job']>;
    expect(c2.jobRef).toBe(j2);
    await b.upload(j2, bytes);
    const r2 = await b.report(j2, b.resultToken(c2, { outcome: 'completed', bytes }));
    expect(r2.json.data).toMatchObject({ state: 'completed', objectRef, deduplicated: true });
    const n = await s.db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.imaging_objects WHERE digest_sha256 = $1',
      [sha256(bytes)],
    );
    expect(n.rows[0].n).toBe(1);
    // A completed job is never handed out again after a bridge restart.
    expect((await b.claim()).job).toBeNull();
    // The imported object stays visible as unmatched until a person confirms the association.
    const um = data<{ items: { objectRef: string }[] }>(
      await s.inject('owner', 'GET', '/v1/imaging/worklists/unmatched'),
    );
    expect(JSON.stringify(um)).toContain(objectRef);
  });

  it('a result after expiry is refused and surfaced; reconciliation is a human imaging decision; another tenant is hidden', async () => {
    const b = await paired();
    const e = await s.command('owner', '/v1/imaging/bridge-jobs', {
      deviceRef: b.deviceRef,
      kind: 'import',
      importPath: 'exports/x.png',
      expiresInSeconds: 60,
    });
    const jobRef = data<{ jobRef: string }>(e).jobRef;
    const { job: env } = await b.claim();
    await s.db.admin.query(
      `UPDATE cuspatlas.imaging_bridge_jobs SET state = 'expired', claim_nonce = NULL, lease_expires_at = NULL,
         failure_reason = 'job_expired', version = version + 1 WHERE id = $1`,
      [jobRef],
    );
    const late = await b.report(
      jobRef,
      b.resultToken(env as NonNullable<typeof env>, { outcome: 'failed', failureReason: 'device_error' }),
    );
    expect([late.status, reason(late)]).toStrictEqual([409, 'late_result']);
    expect(await attemptReasons(s.db.admin, late.json.correlationId)).toStrictEqual(['imaging_refused']);
    const w = await worklist();
    expect(w.items.find((i) => i.workItemRef === jobRef)).toMatchObject({ kind: 'bridge_late_result' });
    expect(
      (
        await s.command('crossTenant', `/v1/imaging/bridge-jobs/${jobRef}/reconcile`, {
          action: 'cancel',
          reasonCode: 'x',
        })
      ).status,
    ).toBe(404);
    expect((await s.inject('crossTenant', 'GET', '/v1/imaging/worklists/bridge')).json.data).toMatchObject({
      items: [],
    });
    const m = await s.mcp('owner', 'imaging_bridge_worklist', {});
    expect(JSON.stringify(m.body)).toContain(jobRef);
    const cancel = await s.mcp('owner', 'imaging_bridge_jobs_reconcile', {
      jobRef,
      action: 'cancel',
      reasonCode: 'late_result_reviewed',
      idempotencyKey: 'mcp-reconcile-1',
    });
    expect([cancel.isError, (cancel.body.data as { state: string }).state]).toStrictEqual([
      false,
      'cancelled',
    ]);
  });
});
