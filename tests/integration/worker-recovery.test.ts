import { randomUUID } from 'node:crypto';
import type { ActorContext, WithTenantTransaction } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAuthorize, createSyntheticTaskService } from '@cuspatlas/domain';
import {
  createWorker,
  type DispatchResult,
  leaseReady,
  listDeadLetters,
  type WorkerDeps,
} from '@cuspatlas/worker';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase, type TestDatabase } from './support/db';
import { FakeProvider, gate } from './support/fake-provider';
import { ctxFor, seedTenancy, T_ALPHA, T_BETA, USER_A1, USER_B1 } from './support/fixtures';
import { MARKER } from './support/marker';

/** Synthetic principals created only for this file. */
const USER_A5 = '20000000-0000-4000-8000-0000000000a5'; // human, alpha, read/write; revoked in one case
const SVC_WORKER = '30000000-0000-4000-8000-0000000000c1'; // service, alpha only, outbox.deliver
const RACE_ITERATIONS = 5;
const QUIET_MS = 150; // > the 0.1 s deliver timeout used as quiet period by workerWith()
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let db: TestDatabase;
let pool: pg.Pool;
let tasks: ReturnType<typeof createSyntheticTaskService>;

const sink = () => createSecurityAttemptSink(db.sink);

function workerWith(overrides: Partial<WorkerDeps> = {}) {
  return createWorker({
    workerPrincipalId: SVC_WORKER,
    withTenantTransaction: createTenantTransactionRunner(pool),
    authorize: createAuthorize(createMembershipSource(pool)),
    memberships: createMembershipSource(pool),
    attempts: sink(),
    backoffSeconds: () => 0,
    // Short deliver timeout (and therefore quiet period) so recovery cases run in test time.
    deliverTimeoutSeconds: 0.1,
    ...overrides,
  });
}

async function enqueue(tenantId: string, actorId: string): Promise<string> {
  const res = await tasks.createSyntheticTask(ctxFor(tenantId, actorId, 'human'), {
    operation: 'syntheticTasks.create',
    idempotencyKey: randomUUID(),
    payload: { label: `worker-${randomUUID()}` },
  });
  const { rows } = await db.admin.query('SELECT id FROM cuspatlas.outbox_events WHERE aggregate_id = $1', [
    res.data.taskRef,
  ]);
  return rows[0].id as string;
}

async function event(id: string) {
  const { rows } = await db.admin.query(
    `SELECT state, attempt, last_outcome, dead_letter_reason, leased_until, next_attempt_at > now() AS deferred
     FROM cuspatlas.outbox_events WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function receipts(id: string) {
  const { rows } = await db.admin.query(
    'SELECT provider_receipt_id, outcome, attempt FROM cuspatlas.delivery_receipts WHERE event_id = $1',
    [id],
  );
  return rows;
}

async function until(cond: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function workerCtx(tenantId: string): ActorContext {
  return {
    tenantId,
    actorId: SVC_WORKER,
    principal: 'service',
    sessionId: randomUUID(),
    scopes: ['outbox.deliver'],
    correlationId: randomUUID(),
  };
}

/** Lets the Nth tenant transaction die before it runs: a worker crash at that point. */
function crashingRunner(base: WithTenantTransaction, crashOnCall: number): WithTenantTransaction {
  let calls = 0;
  return (ctx, work) => {
    calls += 1;
    if (calls === crashOnCall) return Promise.reject(new Error('simulated worker crash'));
    return base(ctx, work);
  };
}

beforeAll(async () => {
  db = await openTestDatabase('worker');
  await seedTenancy(db.admin);
  await db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'human', 'user-a5'), ($2, 'service', 'svc-worker')`,
    [USER_A5, SVC_WORKER],
  );
  await db.admin.query(
    `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3), ($1, $4, $5)`,
    [T_ALPHA, USER_A5, ['syntheticTasks.read', 'syntheticTasks.write'], SVC_WORKER, ['outbox.deliver']],
  );
  pool = db.appPool(10);
  tasks = createSyntheticTaskService({
    authorize: createAuthorize(createMembershipSource(pool)),
    withTenantTransaction: createTenantTransactionRunner(pool),
    recording: { sink: sink(), alert: () => undefined },
  });
});

beforeEach(async () => {
  // Each case starts with an empty queue: earlier events are settled out of band (fixture path).
  await db.admin.query(
    `UPDATE cuspatlas.outbox_events SET state = 'delivered', last_outcome = 'test_reset', leased_until = NULL
     WHERE state NOT IN ('delivered', 'dead_letter')`,
  );
  await db.admin.query(
    `UPDATE cuspatlas.memberships SET revoked_at = NULL, scopes = $2 WHERE principal_id = $1`,
    [USER_A5, ['syntheticTasks.read', 'syntheticTasks.write']],
  );
});

afterAll(async () => {
  await db?.close();
});

describe('schema and grants', () => {
  it('receipts are RLS forced and append-only for the runtime role; only delivery-state columns are updatable', async () => {
    const rls = await db.admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'cuspatlas.delivery_receipts'::regclass`,
    );
    expect(rls.rows[0]).toStrictEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const privs = await db.app.query(
      `SELECT has_table_privilege('cuspatlas.delivery_receipts', 'UPDATE') AS ru,
              has_table_privilege('cuspatlas.delivery_receipts', 'DELETE') AS rd,
              has_table_privilege('cuspatlas.delivery_receipts', 'TRUNCATE') AS rt,
              has_table_privilege('cuspatlas.delivery_receipts', 'INSERT') AS ri,
              has_column_privilege('cuspatlas.outbox_events', 'dead_letter_reason', 'UPDATE') AS dl,
              has_column_privilege('cuspatlas.outbox_events', 'payload', 'UPDATE') AS op,
              has_column_privilege('cuspatlas.outbox_events', 'tenant_id', 'UPDATE') AS ot,
              has_column_privilege('cuspatlas.outbox_events', 'actor_id', 'UPDATE') AS oa,
              has_column_privilege('cuspatlas.outbox_events', 'max_attempts', 'UPDATE') AS om`,
    );
    expect(privs.rows[0]).toStrictEqual({
      ru: false,
      rd: false,
      rt: false,
      ri: true,
      dl: true,
      op: false,
      ot: false,
      oa: false,
      om: false,
    });
    const comment = await db.admin.query(
      `SELECT obj_description(t.oid, 'pg_trigger') AS c FROM pg_trigger t WHERE t.tgname = 'audit_events_append_only'`,
    );
    expect(comment.rows[0].c).toMatch(/owner and superusers can still/);
  });
});

describe('delivery', () => {
  it('delivers once with a receipt; a delivered event is never leased again', async () => {
    const provider = new FakeProvider({ idempotent: false });
    const id = await enqueue(T_ALPHA, USER_A1);
    const worker = workerWith();
    expect(await worker.runOnce(T_ALPHA, provider)).toStrictEqual([{ eventId: id, result: 'delivered' }]);
    expect(await worker.runOnce(T_ALPHA, provider)).toStrictEqual([]);
    expect(provider.effectsFor(id)).toBe(1);
    expect(await event(id)).toMatchObject({ state: 'delivered', attempt: 1, last_outcome: 'delivered' });
    expect(await receipts(id)).toStrictEqual([
      { provider_receipt_id: provider.effects[0]?.receiptId, outcome: 'delivered', attempt: 1 },
    ]);
  });

  it('a duplicate answer from the provider finalizes delivered with one receipt and one effect', async () => {
    const provider = new FakeProvider();
    const id = await enqueue(T_ALPHA, USER_A1);
    const earlier = provider.preAccept(id);
    expect(await workerWith().runOnce(T_ALPHA, provider)).toStrictEqual([
      { eventId: id, result: 'delivered' },
    ]);
    expect(provider.effectsFor(id)).toBe(1);
    expect(await event(id)).toMatchObject({ state: 'delivered', last_outcome: 'duplicate' });
    expect(await receipts(id)).toStrictEqual([
      { provider_receipt_id: earlier, outcome: 'duplicate', attempt: 1 },
    ]);
  });
});

describe('crash and lease recovery', () => {
  it(`worker dies after provider success, before acknowledgement: the next lease reconciles, no resend (x${RACE_ITERATIONS})`, async () => {
    for (let i = 0; i < RACE_ITERATIONS; i += 1) {
      // Non-idempotent provider: any resend would show up as a second effect.
      const provider = new FakeProvider({ idempotent: false });
      const id = await enqueue(T_ALPHA, USER_A1);
      const doomed = workerWith({
        // Transactions: 1 lease, 2 lease-remaining check, 3 finalize (dies).
        withTenantTransaction: crashingRunner(createTenantTransactionRunner(pool), 3),
      });
      await expect(doomed.runOnce(T_ALPHA, provider)).rejects.toThrow('simulated worker crash');
      expect(provider.effectsFor(id)).toBe(1);
      expect(await event(id)).toMatchObject({ state: 'leased', attempt: 1 });
      expect(await receipts(id)).toStrictEqual([]);
      // The crashed process's lease runs out, quiet period included (fixture path shortens it).
      await db.admin.query(
        `UPDATE cuspatlas.outbox_events SET leased_until = now() - interval '1 hour' WHERE id = $1`,
        [id],
      );
      expect(await workerWith().runOnce(T_ALPHA, provider)).toStrictEqual([
        { eventId: id, result: 'delivered' },
      ]);
      expect([provider.callsFor(id), provider.effectsFor(id)]).toStrictEqual([1, 1]);
      expect(await event(id)).toMatchObject({ state: 'delivered', attempt: 2, last_outcome: 'reconciled' });
      expect(await receipts(id)).toStrictEqual([
        { provider_receipt_id: provider.effects[0]?.receiptId, outcome: 'reconciled', attempt: 2 },
      ]);
    }
  });

  it(`accepted, but the response never returns: the deliver timeout ends the attempt inside its lease; the successor reconciles after the quiet period (x${RACE_ITERATIONS})`, async () => {
    for (let i = 0; i < RACE_ITERATIONS; i += 1) {
      const response = gate();
      const provider = new FakeProvider(
        { idempotent: false },
        { afterAccept: async (req) => (req.attempt === 1 ? response.wait.then(() => undefined) : undefined) },
      );
      const id = await enqueue(T_ALPHA, USER_A1);
      const slow = workerWith({ leaseSeconds: 0.3, deliverTimeoutSeconds: 0.2 }).runOnce(T_ALPHA, provider);
      expect(await slow).toStrictEqual([{ eventId: id, result: 'reconciliation' }]);
      expect(provider.effectsFor(id)).toBe(1);
      // Still inside the quiet period: nobody may look the key up or resend yet.
      expect(await workerWith().runOnce(T_ALPHA, provider)).toStrictEqual([]);
      await pause(250);
      expect(await workerWith().runOnce(T_ALPHA, provider)).toStrictEqual([
        { eventId: id, result: 'delivered' },
      ]);
      response.open();
      expect([provider.callsFor(id), provider.effectsFor(id)]).toStrictEqual([1, 1]);
      expect(await event(id)).toMatchObject({ state: 'delivered', attempt: 2, last_outcome: 'reconciled' });
      expect(await receipts(id)).toHaveLength(1);
    }
  });

  it(`two workers racing on the same ready event: one lease, one delivery (x${RACE_ITERATIONS * 2})`, async () => {
    for (let i = 0; i < RACE_ITERATIONS * 2; i += 1) {
      const provider = new FakeProvider({ idempotent: false });
      const id = await enqueue(T_ALPHA, USER_A1);
      const [a, b] = await Promise.all([
        workerWith().runOnce(T_ALPHA, provider),
        workerWith().runOnce(T_ALPHA, provider),
      ]);
      const results = [...a, ...b];
      expect(results).toStrictEqual([{ eventId: id, result: 'delivered' }]);
      expect([provider.callsFor(id), provider.effectsFor(id)]).toStrictEqual([1, 1]);
      expect(await event(id)).toMatchObject({ state: 'delivered', attempt: 1 });
      expect(await receipts(id)).toHaveLength(1);
    }
  });

  it(`out-of-order receipts: attempt 2's receipt lands before attempt 1's; one action, no corruption (x${RACE_ITERATIONS})`, async () => {
    for (let i = 0; i < RACE_ITERATIONS; i += 1) {
      const held = gate();
      const provider = new FakeProvider(
        { idempotent: true },
        { beforeAccept: async (req) => (req.attempt === 1 ? held.wait : undefined) },
      );
      const id = await enqueue(T_ALPHA, USER_A1);
      // Residual window, documented: attempt 1 stays in flight beyond its deliver timeout AND the
      // quiet period. The worker then has no way to know it is still coming; only the provider's
      // deduplication by delivery key (required of every adapter) keeps this to one action.
      const first = await workerWith({ leaseSeconds: 0.3, deliverTimeoutSeconds: 0.2 }).runOnce(
        T_ALPHA,
        provider,
      );
      expect(first).toStrictEqual([{ eventId: id, result: 'reconciliation' }]);
      await pause(250);
      // Attempt 2 reconciles (not_found: attempt 1 has not been accepted), then sends.
      expect(await workerWith().runOnce(T_ALPHA, provider)).toStrictEqual([
        { eventId: id, result: 'delivered' },
      ]);
      const settled = await event(id);
      held.open();
      // Attempt 1 now reaches the provider and gets `duplicate`; the worker already stopped listening.
      await until(() => provider.callsFor(id) === 2);
      expect(provider.callsFor(id)).toBe(2);
      expect(provider.effectsFor(id)).toBe(1);
      expect(await event(id)).toStrictEqual(settled);
      expect(settled).toMatchObject({ state: 'delivered', attempt: 2, last_outcome: 'delivered' });
      expect(await receipts(id)).toStrictEqual([
        { provider_receipt_id: provider.effects[0]?.receiptId, outcome: 'delivered', attempt: 2 },
      ]);
    }
  });
});

describe('unknown outcomes', () => {
  it('a timeout after acceptance goes to reconciliation and finalizes from the receipt without resending', async () => {
    let timeouts = 1;
    let lookupDown = false;
    const provider = new FakeProvider(
      { idempotent: false },
      {
        afterAccept: () => {
          if (timeouts > 0) {
            timeouts -= 1;
            return 'timeout';
          }
          return undefined;
        },
        lookupUnavailable: () => lookupDown,
      },
    );
    const id = await enqueue(T_ALPHA, USER_A1);
    const worker = workerWith();
    expect(await worker.runOnce(T_ALPHA, provider)).toStrictEqual([
      { eventId: id, result: 'reconciliation' },
    ]);
    expect(await event(id)).toMatchObject({ state: 'reconciliation', last_outcome: 'unknown' });
    expect(await receipts(id)).toStrictEqual([]);
    // Provider cannot answer: stay in reconciliation, still no resend.
    lookupDown = true;
    await pause(QUIET_MS);
    expect(await worker.runOnce(T_ALPHA, provider)).toStrictEqual([
      { eventId: id, result: 'reconciliation' },
    ]);
    expect(await event(id)).toMatchObject({ state: 'reconciliation', last_outcome: 'lookup_unavailable' });
    lookupDown = false;
    expect(await worker.runOnce(T_ALPHA, provider)).toStrictEqual([{ eventId: id, result: 'delivered' }]);
    expect([provider.callsFor(id), provider.effectsFor(id)]).toStrictEqual([1, 1]);
    expect(await event(id)).toMatchObject({ state: 'delivered', attempt: 3, last_outcome: 'reconciled' });
    expect(await receipts(id)).toMatchObject([{ outcome: 'reconciled', attempt: 3 }]);
  });

  it('an adapter that throws after acceptance is treated as unknown, never as not sent', async () => {
    const provider = new FakeProvider(
      { idempotent: false },
      {
        afterAccept: (req) => {
          if (req.attempt === 1) throw new Error('synthetic socket reset');
          return undefined;
        },
      },
    );
    const id = await enqueue(T_ALPHA, USER_A1);
    const worker = workerWith();
    expect(await worker.runOnce(T_ALPHA, provider)).toStrictEqual([
      { eventId: id, result: 'reconciliation' },
    ]);
    await pause(QUIET_MS);
    expect(await worker.runOnce(T_ALPHA, provider)).toStrictEqual([{ eventId: id, result: 'delivered' }]);
    expect([provider.callsFor(id), provider.effectsFor(id)]).toStrictEqual([1, 1]);
  });
});

describe('fresh policy', () => {
  it('membership revoked after enqueue: denied, no provider call, dead-lettered, attempt recorded', async () => {
    const provider = new FakeProvider();
    const id = await enqueue(T_ALPHA, USER_A5);
    await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1', [
      USER_A5,
    ]);
    expect(await workerWith().runOnce(T_ALPHA, provider)).toStrictEqual([{ eventId: id, result: 'denied' }]);
    expect(provider.callsFor(id)).toBe(0);
    expect(await event(id)).toMatchObject({
      state: 'dead_letter',
      dead_letter_reason: 'membership_revoked',
      last_outcome: 'denied',
    });
    const corr = (
      await db.admin.query('SELECT correlation_id FROM cuspatlas.outbox_events WHERE id = $1', [id])
    ).rows[0].correlation_id;
    const attempts = await db.admin.query(
      `SELECT tenant_id, actor_id, operation, reason_code FROM cuspatlas.security_attempt_events
       WHERE correlation_id = $1`,
      [corr],
    );
    expect(attempts.rows).toStrictEqual([
      {
        tenant_id: T_ALPHA,
        actor_id: USER_A5,
        operation: 'syntheticTasks.create',
        reason_code: 'membership_inactive',
      },
    ]);
    // Dead-lettered events are not leased again.
    expect(await workerWith().runOnce(T_ALPHA, provider)).toStrictEqual([]);
  });

  it('scope downgraded after enqueue: denied as authorization_denied with no provider call', async () => {
    const provider = new FakeProvider();
    const id = await enqueue(T_ALPHA, USER_A5);
    await db.admin.query('UPDATE cuspatlas.memberships SET scopes = $2 WHERE principal_id = $1', [
      USER_A5,
      ['syntheticTasks.read'],
    ]);
    expect(await workerWith().runOnce(T_ALPHA, provider)).toStrictEqual([{ eventId: id, result: 'denied' }]);
    expect(provider.callsFor(id)).toBe(0);
    expect(await event(id)).toMatchObject({
      state: 'dead_letter',
      dead_letter_reason: 'authorization_denied',
    });
  });

  it('a revoked worker principal cannot lease; the event stays pending', async () => {
    const provider = new FakeProvider();
    const id = await enqueue(T_ALPHA, USER_A1);
    await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1', [
      SVC_WORKER,
    ]);
    try {
      await expect(workerWith().runOnce(T_ALPHA, provider)).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = NULL WHERE principal_id = $1', [
        SVC_WORKER,
      ]);
    }
    expect(provider.callsFor(id)).toBe(0);
    expect(await event(id)).toMatchObject({ state: 'pending', attempt: 0 });
  });
});

describe('retries and dead letters', () => {
  it('max attempts: retryable failures back off, then dead-letter with a reason and visible recoverable state', async () => {
    const provider = new FakeProvider({}, { fail: () => ({ retryable: true }) });
    const id = await enqueue(T_ALPHA, USER_A1);
    const worker = workerWith();
    const results: DispatchResult[] = [];
    for (let i = 0; i < 5; i += 1)
      results.push(...(await worker.runOnce(T_ALPHA, provider)).map((r) => r.result));
    expect(results).toStrictEqual(['retry', 'retry', 'retry', 'retry', 'dead-letter']);
    expect(await worker.runOnce(T_ALPHA, provider)).toStrictEqual([]);
    expect(provider.callsFor(id)).toBe(5);
    expect(provider.effectsFor(id)).toBe(0);
    expect(await event(id)).toMatchObject({
      state: 'dead_letter',
      attempt: 5,
      dead_letter_reason: 'max_attempts_exhausted',
      last_outcome: 'failed',
    });
    // Review under the runtime role in the worker's tenant context: reason, attempts, payload kept.
    const review = await createTenantTransactionRunner(pool)(workerCtx(T_ALPHA), (tx) => listDeadLetters(tx));
    expect(review.find((d) => d.id === id)).toMatchObject({
      reason: 'max_attempts_exhausted',
      attempt: 5,
      lastOutcome: 'failed',
      receipts: 0,
    });
    const payload = (await db.admin.query('SELECT payload FROM cuspatlas.outbox_events WHERE id = $1', [id]))
      .rows[0].payload;
    expect(payload).toStrictEqual({ changedFields: ['label', 'locationRef'] });
  });

  it('default backoff defers the retry; a non-retryable failure dead-letters as provider_rejected', async () => {
    let retryable = true;
    const provider = new FakeProvider({}, { fail: () => ({ retryable }) });
    const id = await enqueue(T_ALPHA, USER_A1);
    const worker = createWorker({
      workerPrincipalId: SVC_WORKER,
      withTenantTransaction: createTenantTransactionRunner(pool),
      authorize: createAuthorize(createMembershipSource(pool)),
      memberships: createMembershipSource(pool),
      attempts: sink(),
    });
    expect(await worker.runOnce(T_ALPHA, provider)).toStrictEqual([{ eventId: id, result: 'retry' }]);
    expect(await event(id)).toMatchObject({ state: 'retry', deferred: true });
    expect(await worker.runOnce(T_ALPHA, provider)).toStrictEqual([]);
    await db.admin.query('UPDATE cuspatlas.outbox_events SET next_attempt_at = now() WHERE id = $1', [id]);
    retryable = false;
    expect(await worker.runOnce(T_ALPHA, provider)).toStrictEqual([{ eventId: id, result: 'dead-letter' }]);
    expect(await event(id)).toMatchObject({ state: 'dead_letter', dead_letter_reason: 'provider_rejected' });
  });
});

describe('tenant isolation (runtime role)', () => {
  it("a worker leasing under tenant A's context cannot see, lease or touch tenant B's events or receipts", async () => {
    const betaId = await enqueue(T_BETA, USER_B1);
    const alphaId = await enqueue(T_ALPHA, USER_A1);
    const runner = createTenantTransactionRunner(pool);
    const leased = await runner(workerCtx(T_ALPHA), (tx) => leaseReady(tx, { limit: 100, leaseSeconds: 30 }));
    expect(leased.map((e) => e.id)).toStrictEqual([alphaId]);
    expect(leased.every((e) => e.tenantId === T_ALPHA)).toBe(true);
    const touched = await runner(workerCtx(T_ALPHA), async (tx) => {
      const seen = await tx.query('SELECT id FROM cuspatlas.outbox_events WHERE id = $1', [betaId]);
      const updated = await tx.query(
        `UPDATE cuspatlas.outbox_events SET state = 'delivered', last_outcome = 'delivered' WHERE id = $1`,
        [betaId],
      );
      const receiptsSeen = await tx.query(
        'SELECT count(*)::int AS n FROM cuspatlas.delivery_receipts WHERE tenant_id = $1',
        [T_BETA],
      );
      return { seen: seen.rowCount, updated: updated.rowCount, receipts: receiptsSeen.rows[0]?.n };
    });
    expect(touched).toStrictEqual({ seen: 0, updated: 0, receipts: 0 });
    await expect(
      runner(workerCtx(T_ALPHA), (tx) =>
        tx.query(
          `INSERT INTO cuspatlas.delivery_receipts (event_id, tenant_id, provider_receipt_id, outcome, attempt)
           VALUES ($1, $2, 'forged-rcpt', 'delivered', 1)`,
          [betaId, T_BETA],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // An alpha-tenant receipt cannot point at a beta event either (tenant-consistent foreign key).
    await expect(
      runner(workerCtx(T_ALPHA), (tx) =>
        tx.query(
          `INSERT INTO cuspatlas.delivery_receipts (event_id, tenant_id, provider_receipt_id, outcome, attempt)
           VALUES ($1, cuspatlas.current_tenant_id(), 'forged-rcpt', 'delivered', 1)`,
          [betaId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    expect(await event(betaId)).toMatchObject({ state: 'pending', attempt: 0 });
    expect(await receipts(betaId)).toStrictEqual([]);
  });

  it('the alpha worker principal cannot open a beta context at all; the attempt carries no fabricated tenant', async () => {
    const betaId = await enqueue(T_BETA, USER_B1);
    const provider = new FakeProvider();
    await expect(workerWith().runOnce(T_BETA, provider)).rejects.toMatchObject({ code: 'forbidden' });
    expect(provider.deliverCalls).toHaveLength(0);
    expect(await event(betaId)).toMatchObject({ state: 'pending', attempt: 0 });
    const attempts = await db.admin.query(
      `SELECT tenant_id, reason_code FROM cuspatlas.security_attempt_events
       WHERE actor_id = $1 AND operation = 'outbox.deliver'`,
      [SVC_WORKER],
    );
    expect(attempts.rows).toContainEqual({ tenant_id: null, reason_code: 'membership_inactive' });
  });
});

describe('privacy', () => {
  it('a marker in payload field names reaches the provider but never worker logs, receipts or attempts', async () => {
    const lines: string[] = [];
    const provider = new FakeProvider();
    const id = randomUUID();
    await db.admin.query(
      `INSERT INTO cuspatlas.outbox_events (id, event_version, tenant_id, actor_id, operation, aggregate_type,
         aggregate_id, aggregate_version, correlation_id, trace_id, span_id, occurred_at, payload_class, payload)
       VALUES ($1, 1, $2, $3, 'syntheticTasks.create', 'syntheticTask', gen_random_uuid(), 1, gen_random_uuid(),
         replace(gen_random_uuid()::text, '-', ''), substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
         now(), 'field-names-only', $4::jsonb)`,
      [id, T_ALPHA, USER_A1, JSON.stringify({ changedFields: [MARKER] })],
    );
    const worker = workerWith({ log: (l) => lines.push(JSON.stringify(l)) });
    expect(await worker.runOnce(T_ALPHA, provider)).toStrictEqual([{ eventId: id, result: 'delivered' }]);
    expect(JSON.stringify(provider.effects.map((e) => e.payload))).toContain(MARKER);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toContain(MARKER);
    for (const table of ['delivery_receipts', 'security_attempt_events']) {
      const { rows } = await db.admin.query(`SELECT row_to_json(r)::text AS j FROM cuspatlas.${table} r`);
      for (const r of rows) expect(r.j).not.toContain(MARKER);
    }
    const state = await db.admin.query(
      'SELECT state, last_outcome, dead_letter_reason FROM cuspatlas.outbox_events WHERE id = $1',
      [id],
    );
    expect(JSON.stringify(state.rows)).not.toContain(MARKER);
  });
});

describe('pre-acceptance lease window (E4/E5 hardening)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it(`a slow provider that lands after the lease expired, within deliver timeout + quiet period: one effect (x${RACE_ITERATIONS})`, async () => {
    // Lease 1.2 s, deliver timeout 0.8 s. Attempt 1 reaches the NON-idempotent provider only after
    // 1.4 s: later than the lease, earlier than deliver timeout + quiet period (1.6 s). A successor
    // that polls the whole time must not send while attempt 1 is still in flight.
    for (let i = 0; i < RACE_ITERATIONS; i += 1) {
      const provider = new FakeProvider(
        { idempotent: false },
        {
          beforeAccept: async (req) => {
            if (req.attempt === 1) await sleep(1400);
          },
        },
      );
      const id = await enqueue(T_ALPHA, USER_A1);
      const opts = { leaseSeconds: 1.2, deliverTimeoutSeconds: 0.8 };
      const a = workerWith(opts).runOnce(T_ALPHA, provider);
      await until(() => provider.callsFor(id) === 1);
      const successor = workerWith(opts);
      const seen: DispatchResult[] = [];
      await until(async () => {
        for (const r of await successor.runOnce(T_ALPHA, provider)) if (r.eventId === id) seen.push(r.result);
        return (await event(id)).state === 'delivered';
      }, 8_000);
      await a;
      await sleep(300); // let any straggler land
      expect([provider.callsFor(id), provider.effectsFor(id)]).toStrictEqual([1, 1]);
      expect(seen).toStrictEqual(['delivered']);
      expect(await event(id)).toMatchObject({ state: 'delivered', last_outcome: 'reconciled' });
    }
  });

  it('a deliver call is bounded by the deliver timeout and ends in reconciliation after a quiet period', async () => {
    const held = gate();
    const provider = new FakeProvider(
      { idempotent: false },
      { afterAccept: () => held.wait.then(() => undefined) },
    );
    const id = await enqueue(T_ALPHA, USER_A1);
    const started = Date.now();
    expect(
      await workerWith({ leaseSeconds: 2, deliverTimeoutSeconds: 0.5 }).runOnce(T_ALPHA, provider),
    ).toStrictEqual([{ eventId: id, result: 'reconciliation' }]);
    expect(Date.now() - started).toBeLessThan(1_900);
    const { rows } = await db.admin.query(
      `SELECT state, last_outcome, next_attempt_at - now() >= interval '400 milliseconds' AS quiet
       FROM cuspatlas.outbox_events WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toStrictEqual({ state: 'reconciliation', last_outcome: 'unknown', quiet: true });
    held.open();
  });

  it('runOnce never sends an event whose remaining lease is shorter than the deliver timeout', async () => {
    const provider = new FakeProvider(
      { idempotent: false },
      {
        beforeAccept: async (req) => {
          if (req.attempt === 1) await sleep(600);
        },
      },
    );
    const first = await enqueue(T_ALPHA, USER_A1);
    const second = await enqueue(T_ALPHA, USER_A1);
    const results = await workerWith({ leaseSeconds: 1, deliverTimeoutSeconds: 0.7 }).runOnce(
      T_ALPHA,
      provider,
    );
    // The first delivery takes 0.6 s of the 1 s lease; the next one has 0.4 s left and is not sent.
    expect(results.map((r) => r.result)).toStrictEqual(['delivered', 'lease-lost']);
    expect(new Set(results.map((r) => r.eventId))).toStrictEqual(new Set([first, second]));
    const skipped = results[1]?.eventId as string;
    expect(provider.callsFor(skipped)).toBe(0);
    await until(async () => {
      await workerWith({ leaseSeconds: 1, deliverTimeoutSeconds: 0.7 }).runOnce(T_ALPHA, provider);
      return (await event(skipped)).state === 'delivered';
    }, 6_000);
    expect([provider.callsFor(skipped), provider.effectsFor(skipped)]).toStrictEqual([1, 1]);
  });

  it('refuses a deliver timeout that is not shorter than the lease', () => {
    expect(() => workerWith({ leaseSeconds: 1, deliverTimeoutSeconds: 1 })).toThrow(/deliverTimeoutSeconds/);
  });

  it('the attempt counter (lease fence) is monotonic for the runtime role', async () => {
    const id = await enqueue(T_ALPHA, USER_A1);
    const tx = createTenantTransactionRunner(pool);
    await workerWith().leaseBatch(T_ALPHA);
    await expect(
      tx(workerCtx(T_ALPHA), (t) =>
        t.query('UPDATE cuspatlas.outbox_events SET attempt = attempt - 1 WHERE id = $1', [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      tx(workerCtx(T_ALPHA), (t) =>
        t.query('UPDATE cuspatlas.outbox_events SET attempt = 0 WHERE id = $1', [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect((await event(id)).attempt).toBe(1);
  });
});
