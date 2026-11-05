import { randomBytes, randomUUID } from 'node:crypto';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  createAuthorize,
  createBillingService,
  createFakeAttachmentSource,
  createFakeClearinghouse,
  SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY,
  SYNTHETIC_TEST_IMAGING_TOKEN_SECRET,
  SYNTHETIC_TEST_MATCH_KEY_PEPPER,
} from '@cuspatlas/domain';
import { type ComposedWorker, composeWorker, type WorkerMainLogLine } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BILLING_ALL, seedBillingScopes, usd } from './support/billing-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { email, seedEngagementScopes } from './support/engagement-fixtures';
import { FakeMessaging } from './support/fake-messaging';
import { FakeProvider } from './support/fake-provider';
import { ctxFor, SVC_A1, T_ALPHA, USER_A1 } from './support/fixtures';
import { type ImagingStack, startImagingStack } from './support/imaging-fixtures';
import { patientBody } from './support/patient-fixtures';
import { today } from './support/rcm-fixtures';
import { seedSchedulingScopes } from './support/scheduling-fixtures';
import { SyntheticBridge } from './support/synthetic-bridge';

/**
 * The worker entry point (synthetic data only): `composeWorker` builds the real dependencies from the
 * environment the way `start:worker` does, against the test database and a per-run object store, with
 * the test fakes passed as synthetic providers. One tick processes one event of each kind exactly
 * once (F6 synthetic-task delivery, E7 notice through the fake messaging provider, B procedure
 * consumption, B claim workflow timer, I bridge lease sweep); a further tick processes nothing.
 * Boot refuses test-only secrets and fake providers outside synthetic-test, and without providers the
 * consumers that would send stay disabled with a reason and nothing is leased for them.
 */
const W = '30000000-0000-4000-8000-0000000000d1';
const LOC = 'loc-worker-main';
const DAYTIME = () => new Date('2030-07-10T17:00:00Z');
let s: ImagingStack;
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
const ok = <T>(r: { status: number; json: Record<string, unknown> }, status = 201) => {
  expect([r.status, r.json]).toMatchObject([status, {}]);
  return data<T>(r);
};
const env = (operation: string, payload: unknown) => ({ operation, idempotencyKey: randomUUID(), payload });
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const baseEnv = () => ({
  CUSPATLAS_ENV: 'synthetic-test',
  CUSPATLAS_WORKER_PRINCIPAL_ID: W,
  CUSPATLAS_WORKER_TENANT_IDS: T_ALPHA,
  CUSPATLAS_OBJECT_STORE_DIR: s.storeRoot,
});
const pools = () => ({ app: s.db.app, attempts: s.db.sink, maintenance: s.db.admin });

beforeAll(async () => {
  s = await startImagingStack('worker_main');
  await seedSchedulingScopes(s.db.admin);
  await seedClinicalScopes(s.db.admin);
  await seedEngagementScopes(s.db.admin);
  await seedBillingScopes(s.db.admin);
  await s.db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'svc-worker-main') ON CONFLICT DO NOTHING`,
    [W],
  );
  await s.db.admin.query(
    'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [
      T_ALPHA,
      W,
      ['outbox.deliver', 'exports.build', 'billing.write', 'communications.deliver', 'admin.configure'],
    ],
  );
  ok(
    await s.command('owner', '/v1/scheduling/locations', {
      locationRef: LOC,
      displayLabel: 'Synthetic worker main',
      timeZone: 'America/New_York',
    }),
  );
}, 180_000);

afterAll(async () => {
  await s?.close();
});

async function resource(kind: string, label: string): Promise<string> {
  const ref = ok<{ resourceRef: string }>(
    await s.command('owner', '/v1/scheduling/resources', { kind, locationRef: LOC, displayLabel: label }),
  ).resourceRef;
  ok(
    await s.command('owner', `/v1/scheduling/resources/${ref}/availability`, {
      effectiveFrom: '2030-01-01',
      weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '08:00', end: '17:00' })),
    }),
  );
  return ref;
}

async function patient(given: string, points: unknown[] = []): Promise<string> {
  return ok<{ patientRef: string }>(
    await s.command(
      'owner',
      '/v1/patients',
      patientBody(given, points.length ? { contact: { known: true, points } } : {}),
    ),
  ).patientRef;
}

async function outboxOf(aggregateId: string) {
  const { rows } = await s.db.admin.query(
    'SELECT id, state, attempt FROM cuspatlas.outbox_events WHERE aggregate_id = $1 ORDER BY id',
    [aggregateId],
  );
  return rows as { id: string; state: string; attempt: number }[];
}

describe('worker boot refuses unsafe configuration', () => {
  const dev = (over: Record<string, string>) => ({
    CUSPATLAS_ENV: 'development',
    CUSPATLAS_WORKER_PRINCIPAL_ID: W,
    CUSPATLAS_WORKER_TENANT_IDS: T_ALPHA,
    CUSPATLAS_MATCH_KEY_PEPPER: b64(randomBytes(32)),
    CUSPATLAS_IDEMPOTENCY_DIGEST_KEY: b64(randomBytes(32)),
    ...over,
  });

  it('refuses each test-only secret, a missing secret and an unknown environment under CUSPATLAS_ENV=development', async () => {
    await expect(
      composeWorker(dev({ CUSPATLAS_MATCH_KEY_PEPPER: b64(SYNTHETIC_TEST_MATCH_KEY_PEPPER) })),
    ).rejects.toThrow(/test-only match-key pepper/);
    await expect(
      composeWorker(dev({ CUSPATLAS_IDEMPOTENCY_DIGEST_KEY: b64(SYNTHETIC_TEST_IDEMPOTENCY_DIGEST_KEY) })),
    ).rejects.toThrow(/test-only idempotency digest key/);
    await expect(
      composeWorker(dev({ CUSPATLAS_IMAGING_TOKEN_SECRET: b64(SYNTHETIC_TEST_IMAGING_TOKEN_SECRET) })),
    ).rejects.toThrow(/test-only imaging token secret/);
    const { CUSPATLAS_MATCH_KEY_PEPPER: _p, ...noPepper } = dev({});
    await expect(composeWorker(noPepper)).rejects.toThrow(/CUSPATLAS_MATCH_KEY_PEPPER must be configured/);
    await expect(composeWorker(dev({ CUSPATLAS_ENV: 'staging' }))).rejects.toThrow(
      /CUSPATLAS_ENV must be one of/,
    );
  });

  it('refuses fake providers outside synthetic-test, before any connection', async () => {
    await expect(
      composeWorker(dev({}), { syntheticProviders: { delivery: new FakeProvider() } }),
    ).rejects.toThrow(/synthetic providers are permitted only in synthetic-test/);
    await expect(
      composeWorker(dev({}), { syntheticProviders: { clearinghouse: createFakeClearinghouse() } }),
    ).rejects.toThrow(/synthetic providers are permitted only in synthetic-test/);
  });

  it('refuses a missing principal, a malformed tenant list and a database name that is not synthetic', async () => {
    const { CUSPATLAS_WORKER_PRINCIPAL_ID: _w, ...noPrincipal } = baseEnv();
    await expect(composeWorker(noPrincipal, { pools: pools() })).rejects.toThrow(
      /CUSPATLAS_WORKER_PRINCIPAL_ID/,
    );
    await expect(
      composeWorker({ ...baseEnv(), CUSPATLAS_WORKER_TENANT_IDS: 'alpha' }, { pools: pools() }),
    ).rejects.toThrow(/CUSPATLAS_WORKER_TENANT_IDS/);
    await expect(
      composeWorker({ ...baseEnv(), CUSPATLAS_DATABASE_URL: 'postgres://u@127.0.0.1:1/clinic' }),
    ).rejects.toThrow(/synthetic/i);
  });
});

describe('worker composition against the test database', () => {
  it('without providers the sending consumers stay disabled with a reason and nothing is leased for them', async () => {
    const lines: WorkerMainLogLine[] = [];
    const w = await composeWorker(baseEnv(), { pools: pools(), log: (l) => lines.push(l) });
    try {
      expect(w.disabled.map((d) => d.consumer).sort()).toStrictEqual([
        'agentTasks',
        'backupVerification',
        'claimWorkflowTimers',
        'outboundMessages',
        'outboxDelivery',
      ]);
      expect(lines.filter((l) => l.msg === 'worker_consumer_disabled')).toHaveLength(4);
      const task = ok<{ taskRef: string }>(
        await s.command('owner', '/v1/synthetic-tasks', { label: 'worker-main-undelivered' }),
      ).taskRef;
      const report = await w.tick();
      expect(report.errors).toStrictEqual([]);
      expect((await outboxOf(task)).map((e) => [e.state, e.attempt])).toStrictEqual([['pending', 0]]);
      // Leave it for the delivering composition below.
    } finally {
      await w.close();
    }
  });

  it('one tick processes one event of each kind exactly once; another tick processes nothing', {
    timeout: 180_000,
  }, async () => {
    const delivery = new FakeProvider();
    const messaging = new FakeMessaging();
    const clearinghouse = createFakeClearinghouse();
    const svc = createBillingService({
      authorize: createAuthorize(createMembershipSource(s.db.app)),
      withTenantTransaction: createTenantTransactionRunner(s.db.app),
      recording: { sink: createSecurityAttemptSink(s.db.sink), alert: () => {} },
      claims: clearinghouse,
      attachments: createFakeAttachmentSource(),
    });
    const a1 = ctxFor(T_ALPHA, USER_A1, 'human', [...BILLING_ALL, 'patients.read', 'patients.write']);
    const engine = ctxFor(T_ALPHA, SVC_A1, 'service', BILLING_ALL);
    const provider = await resource('provider', 'Synthetic worker provider');
    const operatory = await resource('operatory', 'Synthetic worker operatory');

    // F6: a synthetic task (delivered through the outbox adapter).
    const task = ok<{ taskRef: string }>(
      await s.command('owner', '/v1/synthetic-tasks', { label: 'worker-main-task' }),
    ).taskRef;

    // E7: an allowed reminder for a consenting patient with a verified synthetic address.
    ok(
      await s.command('owner', '/v1/communications/templates', {
        templateRef: 'worker-main-reminder',
        purpose: 'reminder',
        channel: 'email',
        body: 'There is an update about your visit. Sign in to the patient portal for details.',
      }),
    );
    ok(
      await s.command('owner', '/v1/communications/channel-policies', {
        purpose: 'reminder',
        channel: 'email',
        templateRef: 'worker-main-reminder',
        quietHours: { start: '21:00', end: '08:00' },
        reminderLeadMinutes: 1440,
      }),
    );
    const notified = await patient('Worker Notice', [email('worker.main')]);
    ok(
      await s.command('owner', `/v1/patients/${notified}/consents`, {
        channel: 'email',
        purpose: 'reminders',
        state: 'granted',
        source: 'staff_recorded',
        consentVersion: 'synthetic-consent-1',
      }),
    );
    ok(
      await s.command('owner', `/v1/patients/${notified}/contact-verifications`, {
        channel: 'email',
        value: 'worker.main@example.invalid',
        method: 'synthetic_attested',
      }),
    );
    const at = (hh: number) => new Date(Date.UTC(2030, 8, 3, hh)).toISOString();
    const appointment = ok<{ appointmentRef: string }>(
      await s.command('owner', '/v1/scheduling/appointments', {
        patientRef: notified,
        locationRef: LOC,
        startsAt: at(14),
        endsAt: at(15),
        timeZone: 'America/New_York',
        provider: { kind: 'provider', resourceRef: provider },
        operatory: { kind: 'operatory', resourceRef: operatory },
      }),
    ).appointmentRef;

    // B: a rendered procedure (consumed by billing) and a claim whose workflow timers come due.
    ok(
      await s.command('owner', '/v1/billing/fee-schedules/versions', {
        scheduleRef: 'syn-fee-worker-main',
        purpose: 'practice',
        effectiveFrom: '2026-01-01',
        items: [{ codeRef: 'SYN-WM-100', fee: usd(20000) }],
      }),
    );
    const billed = await patient('Worker Billing');
    const coverageRef = ok<{ coverageRef: string }>(
      await s.command('owner', '/v1/rcm/coverages', {
        patientRef: billed,
        payerRef: 'syn-payer-noresponse-wm',
        rank: 'primary',
        relationshipToSubscriber: 'self',
        memberRef: 'syn-member-worker-main',
        effectiveFrom: '2026-01-01',
      }),
    ).coverageRef;
    ok(
      await s.command('owner', `/v1/rcm/coverages/${coverageRef}/eligibility`, {
        source: 'fake_adapter',
        serviceDate: today(),
      }),
    );
    const enc = ok<{ encounter: { encounterRef: string; version: number } }>(
      await s.command('owner', '/v1/clinical/encounters', { patientRef: billed, locationRef: LOC }),
    ).encounter;
    ok(
      await s.command('owner', `/v1/clinical/encounters/${enc.encounterRef}/assignments`, {
        expectedVersion: enc.version,
        role: 'treating_provider',
        assignee: { kind: 'provider', resourceRef: provider },
      }),
    );
    const proc = ok<{ procedureRef: string }>(
      await s.command('owner', `/v1/clinical/encounters/${enc.encounterRef}/procedures`, {
        sequence: 1,
        dateOfService: today(),
        renderingProviderRef: provider,
        codeRef: 'SYN-WM-100',
      }),
    ).procedureRef;

    // I: a claimed bridge job whose lease ran out.
    const reg = ok<{ deviceRef: string }>(
      await s.command('owner', '/v1/imaging/devices', {
        label: 'Worker Bridge',
        allowedJobKinds: ['import'],
        allowedPathPrefixes: ['exports'],
      }),
    );
    const code = data<{ pairingCode: string }>(
      await s.inject('owner', 'POST', `/v1/imaging/devices/${reg.deviceRef}/pairing-codes`, {}),
    ).pairingCode;
    const bridge = new SyntheticBridge(s.app);
    expect((await bridge.pair(code)).status).toBe(201);
    expect((await bridge.heartbeat()).status).toBe(200);
    const jobRef = ok<{ jobRef: string }>(
      await s.command('owner', '/v1/imaging/bridge-jobs', {
        deviceRef: bridge.deviceRef,
        kind: 'import',
        importPath: 'exports/worker.png',
        expiresInSeconds: 600,
      }),
    ).jobRef;
    expect((await bridge.claim()).job).not.toBeNull();
    await s.db.admin.query(
      `UPDATE cuspatlas.imaging_bridge_jobs SET lease_expires_at = now() - interval '1 second', version = version + 1
       WHERE id = $1`,
      [jobRef],
    );

    const lines: WorkerMainLogLine[] = [];
    const w: ComposedWorker = await composeWorker(baseEnv(), {
      pools: pools(),
      syntheticProviders: { delivery, messaging, clearinghouse },
      clock: DAYTIME,
      tuning: { backoffSeconds: () => 0 },
      log: (l) => lines.push(l),
    });
    try {
      // Only the A23 scheduled-task consumer (no MCP tool path in this composition) and M9 backup
      // verification (no backup location; worker-backup-verification.test.ts covers it).
      expect(w.disabled.map((d) => d.consumer)).toStrictEqual(['agentTasks', 'backupVerification']);
      const first = await w.tick();
      expect(first.errors).toStrictEqual([]);
      // B: the first tick consumed the procedure into a charge, so the claim can be prepared now.
      // It reaches `transmitted` through the same fake clearinghouse the worker holds.
      const claimRef = (
        await svc.prepareClaim(
          a1,
          env('rcm.claims.prepare', { patientRef: billed, coverageRef, procedureRefs: [proc] }),
        )
      ).data.claimRef;
      const workflowPolicyRef = (
        await svc.publishWorkflowPolicy(
          a1,
          env('rcm.workflowPolicies.publish', {
            payerRef: 'syn-payer-noresponse-wm',
            acknowledgementDueMinutes: 0,
            followUpMinutes: 0,
            exceptionDueMinutes: 0,
            maxEscalations: 1,
            writeOffLimit: usd(0),
          }),
        )
      ).data.policyRef;
      const submissionPolicyRef = (
        await svc.createSubmissionPolicy(a1, env('rcm.submissionPolicies.create', { maxBilled: usd(100000) }))
      ).data.policyRef;
      const wf = (
        await svc.startClaimWorkflow(
          a1,
          env('rcm.workflows.start', { claimRef, workflowPolicyRef, submissionPolicyRef }),
        )
      ).data.workflowRef;
      await svc.advanceClaimWorkflow(engine, wf);
      await svc.advanceClaimWorkflow(engine, wf);
      expect((await svc.getClaimWorkflow(a1, wf)).claims[0]?.state).toBe('transmitted');

      // E7: the first tick enqueued the reminder; synthetic elapsed time makes it due.
      await s.db.admin.query(
        `UPDATE cuspatlas.outbound_messages m SET next_attempt_at = now() - interval '1 second', version = version + 1
         FROM cuspatlas.notification_intents i WHERE i.id = m.intent_id AND m.state = 'queued' AND i.subject_id = $1`,
        [appointment],
      );
      const second = await w.tick();
      expect(second.errors).toStrictEqual([]);

      // F6 synthetic task: delivered once through the adapter.
      const [taskEvent] = await outboxOf(task);
      expect([taskEvent?.state, delivery.effectsFor(taskEvent?.id ?? '')]).toStrictEqual(['delivered', 1]);
      // E7 notice: one send through the fake messaging provider.
      expect(messaging.effects.filter((e) => e.deliveryKey === `reminder:${appointment}`)).toHaveLength(1);
      // B procedure: one consumption, by the worker principal, and its event delivered.
      const consumed = await s.db.admin.query(
        `SELECT consumed_by FROM cuspatlas.billing_procedure_events WHERE procedure_id = $1`,
        [proc],
      );
      expect(consumed.rows).toStrictEqual([{ consumed_by: W }]);
      // B workflow timer: the payer follow-up fired once.
      const timers = (await svc.getClaimWorkflow(a1, wf)).timers;
      expect(timers.filter((t) => t.kind === 'payer_follow_up').map((t) => t.firedOutcome)).toStrictEqual([
        'fired',
      ]);
      // I bridge sweep: the job is requeued once.
      const job = await s.db.admin.query(
        'SELECT state, claim_nonce, version FROM cuspatlas.imaging_bridge_jobs WHERE id = $1',
        [jobRef],
      );
      expect(job.rows[0]).toMatchObject({ state: 'queued', claim_nonce: null });
      expect(first.imagingReconciled + second.imagingReconciled).toBeGreaterThanOrEqual(1);
      // A-D4: the worker sweeps as its own service-only command, never the human admin reconcile.
      const sweeps = await s.db.admin.query<{ operation: string }>(
        `SELECT DISTINCT operation FROM cuspatlas.audit_events
          WHERE operation IN ('imaging.storage.sweep', 'imaging.storage.reconcile')`,
      );
      expect(sweeps.rows.map((r) => r.operation)).toStrictEqual(['imaging.storage.sweep']);
      expect(first.maintenance).toMatchObject({
        idempotencyPurged: expect.any(Number),
        agentMemoryPurged: expect.any(Number),
      });

      // Exactly once: later ticks only settle events the earlier ones created (never one already
      // settled), until a tick leases nothing and changes nothing.
      const ticks = [first, second];
      for (let i = 0; i < 5; i += 1) {
        const next = await w.tick();
        expect(next.errors).toStrictEqual([]);
        ticks.push(next);
        if (next.outbox.length === 0 && next.outbound.length === 0) break;
      }
      const last = ticks[ticks.length - 1];
      expect([last?.outbox, last?.outbound]).toStrictEqual([[], []]);
      const eventIds = ticks.flatMap((t) => t.outbox.map((e) => e.eventId));
      expect(new Set(eventIds).size).toBe(eventIds.length);
      const messageRefs = ticks.flatMap((t) => t.outbound.map((m) => m.messageRef));
      expect(new Set(messageRefs).size).toBe(messageRefs.length);
      expect(delivery.effectsFor(taskEvent?.id ?? '')).toBe(1);
      expect(messaging.effects.filter((e) => e.deliveryKey === `reminder:${appointment}`)).toHaveLength(1);
      const again = await s.db.admin.query(
        'SELECT version FROM cuspatlas.imaging_bridge_jobs WHERE id = $1',
        [jobRef],
      );
      expect(again.rows[0]?.version).toBe(job.rows[0]?.version);
      // Log lines carry fixed codes only.
      expect(JSON.stringify(lines)).not.toMatch(/example\.invalid|Worker Notice|Worker Billing/);
    } finally {
      await w.close();
    }
  });

  it('run() ticks until the signal aborts and then returns (graceful shutdown)', async () => {
    const w = await composeWorker(baseEnv(), { pools: pools() });
    const stop = new AbortController();
    let ticks = 0;
    const running = w.run(stop.signal, {
      intervalMs: 10,
      onTick: () => {
        ticks += 1;
        if (ticks === 2) stop.abort();
      },
    });
    await running;
    expect(ticks).toBe(2);
    await w.close();
  });
});
