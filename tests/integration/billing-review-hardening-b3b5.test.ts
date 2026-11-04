import { createHash, randomUUID } from 'node:crypto';
import { RefusalError } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import {
  type BillingDeps,
  type CaptureRequest,
  createAuthorize,
  createBillingService,
  type EligibilityPort,
  type PaymentProviderPort,
  type ProviderAnswer,
} from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, mergePatients, T_ALPHA } from './support/appointment-fixtures';
import {
  BILLING_ALL,
  type BillingHarness,
  openBillingHarness,
  postCharge,
  recordCoverage,
  usd,
} from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, USER_A1 } from './support/fixtures';

/**
 * Hardening of B3-B5 after the independent review of 74f3232 (synthetic data only; rules pending
 * billing approval): in-flight provider leases and late captures (M1), eligibility outside the locked
 * transaction with a timeout (M2), statement staleness for late-committed pre-cutoff entries (S1),
 * plan collection after a merge (S2), eligibility freshness and inactive status (S3), attempt and
 * payment forgery (S4), reversal of pre-B5 insurer lines (S5) and tenant-wide authorization
 * references (S6).
 */
let db: TestDatabase;
let h: BillingHarness;
const ctx = () => ctxFor(T_ALPHA, USER_A1, 'human', [...BILLING_ALL, 'patients.read', 'patients.write']);
const reason = (res: { statusCode: number; json: () => { code?: string; detail?: { reason?: string } } }) => [
  res.statusCode,
  res.json().code,
  res.json().detail?.reason,
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const receipt = (key: string) =>
  `syn-rcpt-${createHash('sha256').update(`late:${key}`).digest('hex').slice(0, 32)}`;

/** A provider whose capture waits on a gate and whose lookup reports only what it has captured. */
function gatedProvider() {
  const captured = new Map<string, string>();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered: () => void = () => {};
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const port: PaymentProviderPort = {
    async capture(req: CaptureRequest): Promise<ProviderAnswer> {
      entered();
      await gate;
      captured.set(req.providerKey, receipt(req.providerKey));
      return { outcome: 'confirmed', receiptId: receipt(req.providerKey) };
    },
    async lookup(req): Promise<ProviderAnswer> {
      const r = captured.get(req.providerKey);
      return r ? { outcome: 'confirmed', receiptId: r } : { outcome: 'declined' };
    },
  };
  return { port, release, started, captured };
}

function service(over: Partial<BillingDeps> = {}) {
  return createBillingService({
    authorize: createAuthorize(createMembershipSource(db.app)),
    withTenantTransaction: createTenantTransactionRunner(db.app),
    recording: { sink: createSecurityAttemptSink(db.sink), alert: () => {} },
    ...over,
  });
}
const cardEnvelope = (patientRef: string, minor = 1000) => ({
  operation: 'billing.payments.record',
  idempotencyKey: randomUUID(),
  payload: { patientRef, amount: usd(minor), method: 'card_synthetic', instrumentRef: 'syn-card-gated' },
});
const attemptOf = async (patientRef: string) =>
  (
    await db.admin.query(
      `SELECT id, outcome, resolution, superseded_resolution, call_deadline > created_at AS leased
       FROM cuspatlas.billing_payment_attempts WHERE patient_id = $1 ORDER BY created_at`,
      [patientRef],
    )
  ).rows;
const paymentsOf = async (patientRef: string) =>
  (
    await db.admin.query('SELECT id, patient_id FROM cuspatlas.billing_payments WHERE patient_id = $1', [
      patientRef,
    ])
  ).rows;
/** Reconciles through a service that uses the given provider (REST uses the synthetic default). */
async function reconcileWith(port: PaymentProviderPort, attemptRef: string) {
  try {
    const r = await service({ payments: port }).reconcileAttempt(ctx(), attemptRef, {
      operation: 'billing.payments.reconcile',
      idempotencyKey: randomUUID(),
      payload: {},
    });
    return { status: 200, code: undefined, reason: undefined, data: r.data };
  } catch (err) {
    if (!(err instanceof RefusalError)) throw err;
    return {
      status: err.code === 'conflict' ? 409 : 0,
      code: err.code as string,
      reason: (err.detail as { reason?: string } | undefined)?.reason,
      data: null,
    };
  }
}
const refused = (r: { status: number; code?: string | undefined; reason?: string | undefined }) => [
  r.status,
  r.code,
  r.reason,
];
const unknownItems = async () =>
  h
    .ok<{ data: { subjectRef: string }[] }>(
      await h.call('a1', 'GET', '/v1/billing/worklist?kind=unknown_payment_outcome&limit=100'),
    )
    .data.map((i) => i.subjectRef);
/** Simulates a stalled request: its lease expires while the provider call is still open. */
async function expireLease(attemptRef: string) {
  const c = await db.admin.connect();
  try {
    await c.query('SET session_replication_role = replica');
    await c.query(
      `UPDATE cuspatlas.billing_payment_attempts SET call_deadline = now() - interval '1 second' WHERE id = $1`,
      [attemptRef],
    );
  } finally {
    await c.query('SET session_replication_role = origin');
    c.release();
  }
}

const PLANS = '/v1/billing/payment-plans';
let authSeq = 0;
const authRef = () => {
  authSeq += 1;
  return `syn-auth-hb-${Date.now().toString(36)}-${authSeq}`;
};
async function planVersion(planRef: string): Promise<number> {
  return h.ok<{ data: { version: number } }>(await h.call('a1', 'GET', `${PLANS}/${planRef}`)).data.version;
}
async function readyPlan(patientRef: string): Promise<string> {
  const plan = h.ok<{ data: { planRef: string } }>(
    await h.call('a1', 'POST', PLANS, {
      patientRef,
      contractTotal: usd(900),
      installmentCount: 3,
      firstDueOn: '2026-08-01',
      timeZone: 'America/New_York',
    }),
    201,
  ).data.planRef;
  h.ok(
    await h.call('a1', 'POST', `${PLANS}/${plan}/authorizations`, {
      expectedVersion: await planVersion(plan),
      authorizationRef: authRef(),
      evidenceRef: 'syn-evidence-signed-agreement',
    }),
    201,
  );
  h.ok(
    await h.call('a1', 'POST', `${PLANS}/${plan}/autopay`, {
      expectedVersion: await planVersion(plan),
      state: 'active',
      instrumentRef: 'syn-card-gated',
      cardExpiry: '2099-12',
      authorizationRef: authRef(),
    }),
    201,
  );
  return plan;
}

beforeAll(async () => {
  db = await openTestDatabase('billing_review_hardening_b3b5');
  h = await openBillingHarness(db, { pool: 10 });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('M1: an in-flight capture is never resolved under it, and a late capture still posts once', () => {
  it('1. a pending attempt inside its lease cannot be reconciled and is not a work item', async () => {
    const patient = await createPatient(h, 'Synthetic In Flight');
    const g = gatedProvider();
    const a = service({ payments: g.port }).recordPayment(ctx(), cardEnvelope(patient));
    await g.started;
    const [attempt] = await attemptOf(patient);
    expect(attempt.leased).toBe(true);
    expect(refused(await reconcileWith(g.port, attempt.id))).toStrictEqual([
      409,
      'conflict',
      'attempt_in_flight',
    ]);
    expect(await unknownItems()).not.toContain(attempt.id);
    g.release();
    const r = await a;
    expect(r.data.outcome).toBe('confirmed');
    expect(await paymentsOf(patient)).toHaveLength(1);
  });

  it('2. a reconcile after the lease (stalled request) then a capture: the finalize posts once', async () => {
    const patient = await createPatient(h, 'Synthetic Premature Reconcile');
    const g = gatedProvider();
    const a = service({ payments: g.port }).recordPayment(ctx(), cardEnvelope(patient));
    await g.started;
    const [attempt] = await attemptOf(patient);
    await expireLease(attempt.id);
    expect(await unknownItems()).toContain(attempt.id);
    const rec = await reconcileWith(g.port, attempt.id);
    expect([rec.data?.outcome, rec.data?.paymentRef]).toStrictEqual(['declined', null]);
    g.release();
    const r = await a;
    expect(r.data.outcome).toBe('confirmed');
    expect(r.data.paymentRef).not.toBeNull();
    expect(await paymentsOf(patient)).toHaveLength(1);
    const [after] = await attemptOf(patient);
    expect([after.resolution, after.superseded_resolution]).toStrictEqual(['captured', 'not_captured']);
    expect(refused(await reconcileWith(g.port, attempt.id))).toStrictEqual([
      409,
      'conflict',
      'already_resolved',
    ]);
    expect(await paymentsOf(patient)).toHaveLength(1);
  });

  it('3. a lost finalize after a premature not-captured resolution is recovered by one more lookup', async () => {
    const patient = await createPatient(h, 'Synthetic Timeout Late');
    const g = gatedProvider();
    const r = await service({ payments: g.port, providerTimeoutMs: 150 }).recordPayment(
      ctx(),
      cardEnvelope(patient),
    );
    expect(r.data.outcome).toBe('unknown');
    const attemptRef = r.data.attemptRef as string;
    const first = await reconcileWith(g.port, attemptRef);
    expect(first.data?.outcome).toBe('declined');
    g.release();
    await sleep(20);
    expect(g.captured.size).toBe(1);
    const second = await reconcileWith(g.port, attemptRef);
    expect(second.data?.outcome).toBe('confirmed');
    expect(await paymentsOf(patient)).toHaveLength(1);
    expect(refused(await reconcileWith(g.port, attemptRef))).toStrictEqual([
      409,
      'conflict',
      'already_resolved',
    ]);
    expect(await paymentsOf(patient)).toHaveLength(1);
  });

  it('4. a plan installment: in flight is refused, a premature resolution then capture posts once', async () => {
    const patient = await createPatient(h, 'Synthetic Plan In Flight');
    const plan = await readyPlan(patient);
    const g = gatedProvider();
    const a = service({ payments: g.port }).collectInstallment(ctx(), plan, {
      operation: 'billing.plans.collect',
      idempotencyKey: randomUUID(),
      payload: { periodNo: 1 },
    });
    await g.started;
    const [attempt] = await attemptOf(patient);
    expect(refused(await reconcileWith(g.port, attempt.id))).toStrictEqual([
      409,
      'conflict',
      'attempt_in_flight',
    ]);
    await expireLease(attempt.id);
    expect((await reconcileWith(g.port, attempt.id)).data?.outcome).toBe('declined');
    g.release();
    const r = await a;
    expect(r.data.outcome).toBe('confirmed');
    expect(r.data.paymentRef).not.toBeNull();
    expect(await paymentsOf(patient)).toHaveLength(1);
  });
});

describe('M2: the eligibility source is called outside the locked transaction, with a timeout', () => {
  it('5. a throwing source records an unknown result (never a 500)', async () => {
    const patient = await createPatient(h, 'Synthetic Elig Throws');
    const cov = await recordCoverage(h, patient);
    const port: EligibilityPort = {
      async check() {
        throw new Error('synthetic eligibility failure');
      },
    };
    const r = await service({ eligibility: port }).recordEligibility(ctx(), cov, {
      operation: 'rcm.eligibility.record',
      idempotencyKey: randomUUID(),
      payload: { source: 'fake_adapter', serviceDate: '2026-10-01' },
    });
    expect(r.data.state).toBe('unknown');
  });

  it('6. a hanging source times out to unknown and holds no coverage lock while waiting', async () => {
    const patient = await createPatient(h, 'Synthetic Elig Hangs');
    const cov = await recordCoverage(h, patient);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered: () => void = () => {};
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const port: EligibilityPort = {
      async check() {
        entered();
        await gate;
        return { outcome: 'unknown' };
      },
    };
    let settled = false;
    const e = service({ eligibility: port, providerTimeoutMs: 2500 })
      .recordEligibility(ctx(), cov, {
        operation: 'rcm.eligibility.record',
        idempotencyKey: randomUUID(),
        payload: { source: 'fake_adapter', serviceDate: '2026-10-01' },
      })
      .finally(() => {
        settled = true;
      });
    await started;
    const amend = h.call('a1', 'POST', `/v1/rcm/coverages/${cov}/versions`, {
      expectedVersion: 1,
      rank: 'primary',
      relationshipToSubscriber: 'self',
      memberRef: 'syn-member-hang-2',
      effectiveFrom: '2026-01-01',
      reasonCode: 'member_corrected',
    });
    const first = await Promise.race([amend.then(() => 'amend'), sleep(1500).then(() => 'timeout')]);
    expect(first).toBe('amend');
    expect(settled).toBe(false);
    const r = await e;
    expect(r.data.state).toBe('unknown');
    release();
    expect((await amend).statusCode).toBe(201);
  });
});

describe('S1: a pre-cutoff entry committed after the statement makes it stale', () => {
  it('7. late-committed pre-cutoff money is a stale reason', async () => {
    // Every service path locks the account the statement locks, so the late commit is staged as a
    // raw runtime-role entry (a path that does not take that lock): posted before the cutoff,
    // committed after the statement.
    const patient = await createPatient(h, 'Synthetic Late Commit');
    const other = await createPatient(h, 'Synthetic Late Commit Other');
    const cash = await service().recordPayment(ctx(), {
      operation: 'billing.payments.record',
      idempotencyKey: randomUUID(),
      payload: { patientRef: patient, amount: usd(500), method: 'cash' },
    });
    const paymentRef = cash.data.paymentRef as string;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reached: () => void = () => {};
    const posted = new Promise<void>((r) => {
      reached = r;
    });
    const late = createTenantTransactionRunner(db.app)(ctx(), async (t) => {
      const { rows } = await t.query<{ id: string }>(
        `INSERT INTO cuspatlas.billing_journal_entries (tenant_id, kind, currency, line_count, payment_id, reason_code,
           posted_by, correlation_id)
         VALUES (cuspatlas.current_tenant_id(), 'transfer', 'USD', 2, $1, 'synthetic_late', cuspatlas.current_actor_id(), $2)
         RETURNING id`,
        [paymentRef, randomUUID()],
      );
      await t.query(
        `INSERT INTO cuspatlas.billing_journal_lines (tenant_id, entry_id, line_no, account, amount_minor, currency,
           patient_id, payment_id)
         VALUES (cuspatlas.current_tenant_id(), $1, 1, 'unapplied_credit', 200, 'USD', $2, $4),
                (cuspatlas.current_tenant_id(), $1, 2, 'unapplied_credit', -200, 'USD', $3, $4)`,
        [rows[0]?.id, patient, other, paymentRef],
      );
      reached();
      await gate;
    });
    await posted;
    await sleep(5);
    const st = h.ok<{ data: { statementRef: string } }>(
      await h.call('a1', 'POST', '/v1/billing/statements', {
        guarantorRef: patient,
        cutoffAt: new Date().toISOString(),
        basis: 'posted_through_cutoff',
      }),
      201,
    ).data.statementRef;
    release();
    await late;
    const view = h.ok<{ data: { freshness: { state: string; reasons: string[] } } }>(
      await h.call('a1', 'GET', `/v1/billing/statements/${st}`),
    ).data;
    expect(view.freshness.state).toBe('stale');
    expect(view.freshness.reasons).toContain('pre_cutoff_changed');
  });
});

describe('S2: a plan of a merged-away patient stays collectable for the survivor', () => {
  it('8. collection after a merge posts to the merge root', async () => {
    const survivor = await createPatient(h, 'Synthetic Plan Merge');
    const merged = await createPatient(h, 'Synthetic Plan Merge');
    const plan = await readyPlan(merged);
    await mergePatients(h, survivor, merged);
    const r = h.ok<{ data: { outcome: string; paymentRef: string } }>(
      await h.call('a1', 'POST', `${PLANS}/${plan}/collections`, { periodNo: 1 }),
      201,
    );
    expect(r.data.outcome).toBe('confirmed');
    const { rows } = await db.admin.query('SELECT patient_id FROM cuspatlas.billing_payments WHERE id = $1', [
      r.data.paymentRef,
    ]);
    expect(rows[0].patient_id).toBe(survivor);
  });
});

describe('S3: eligibility freshness is per service date and coverage version; inactive reads inactive', () => {
  const resolve = async (patientRef: string, serviceDate: string) =>
    h.ok<{ data: { coverages: { coverageRef: string; coverageStatus: string }[] } }>(
      await h.call('a1', 'GET', `/v1/rcm/patients/${patientRef}/coverage?serviceDate=${serviceDate}`),
    ).data.coverages;
  const today = () => new Date().toISOString().slice(0, 10);
  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  it('9. a record checked for another service date is not current for this one', async () => {
    const patient = await createPatient(h, 'Synthetic Elig Date');
    const cov = await recordCoverage(h, patient);
    h.ok(
      await h.call('a1', 'POST', `/v1/rcm/coverages/${cov}/eligibility`, {
        source: 'fake_adapter',
        serviceDate: today(),
      }),
      201,
    );
    expect((await resolve(patient, today()))[0]?.coverageStatus).toBe('entered');
    expect((await resolve(patient, tomorrow()))[0]?.coverageStatus).toBe('stale');
  });

  it('10. a record of an earlier coverage version is stale after an amendment', async () => {
    const patient = await createPatient(h, 'Synthetic Elig Version');
    const cov = await recordCoverage(h, patient);
    h.ok(
      await h.call('a1', 'POST', `/v1/rcm/coverages/${cov}/eligibility`, {
        source: 'fake_adapter',
        serviceDate: today(),
      }),
      201,
    );
    h.ok(
      await h.call('a1', 'POST', `/v1/rcm/coverages/${cov}/versions`, {
        expectedVersion: 1,
        rank: 'primary',
        relationshipToSubscriber: 'self',
        memberRef: 'syn-member-amended',
        effectiveFrom: '2026-01-01',
        reasonCode: 'member_corrected',
      }),
      201,
    );
    expect((await resolve(patient, today()))[0]?.coverageStatus).toBe('stale');
  });

  it('11. a verified inactive member reads inactive, never entered', async () => {
    const patient = await createPatient(h, 'Synthetic Elig Inactive');
    const cov = await recordCoverage(h, patient, { payerRef: 'syn-payer-inactive-hb' });
    h.ok(
      await h.call('a1', 'POST', `/v1/rcm/coverages/${cov}/eligibility`, {
        source: 'fake_adapter',
        serviceDate: today(),
      }),
      201,
    );
    expect((await resolve(patient, today()))[0]?.coverageStatus).toBe('inactive');
  });
});

describe('S4: the runtime role cannot forge a confirmed attempt or a payment of the wrong amount', () => {
  it('12. a raw confirmed attempt and a payment that does not match its attempt are refused', async () => {
    const patient = await createPatient(h, 'Synthetic Attempt Forgery');
    const run = createTenantTransactionRunner(db.app);
    await expect(
      run(ctx(), (t) =>
        t.query(
          `INSERT INTO cuspatlas.billing_payment_attempts (tenant_id, patient_id, method, instrument_ref, provider_key,
             amount_minor, currency, outcome, provider_receipt, created_by)
           VALUES (cuspatlas.current_tenant_id(), $1, 'card_synthetic', 'syn-card-ok', $2, 100, 'USD', 'confirmed',
             'syn-rcpt-forged', cuspatlas.current_actor_id())`,
          [patient, createHash('sha256').update(randomUUID()).digest('hex')],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const ok = await service().recordPayment(ctx(), {
      operation: 'billing.payments.record',
      idempotencyKey: randomUUID(),
      payload: {
        patientRef: patient,
        amount: usd(300),
        method: 'card_synthetic',
        instrumentRef: 'syn-card-ok',
      },
    });
    const pending = await run(ctx(), async (t) => {
      const { rows } = await t.query<{ id: string }>(
        `INSERT INTO cuspatlas.billing_payment_attempts (tenant_id, patient_id, method, instrument_ref, provider_key,
           amount_minor, currency, outcome, call_deadline, created_by)
         VALUES (cuspatlas.current_tenant_id(), $1, 'card_synthetic', 'syn-card-ok', $2, 100, 'USD', 'pending', now(),
           cuspatlas.current_actor_id()) RETURNING id`,
        [patient, createHash('sha256').update(randomUUID()).digest('hex')],
      );
      return rows[0]?.id as string;
    });
    const forgePayment = (attemptId: string, minor: number, ref: string) =>
      run(ctx(), async (t) => {
        const { rows } = await t.query<{ id: string }>(
          `INSERT INTO cuspatlas.billing_payments (tenant_id, patient_id, method, amount_minor, currency, external_ref,
             attempt_id, created_by)
           VALUES (cuspatlas.current_tenant_id(), $1, 'card_synthetic', $2, 'USD', $3, $4, cuspatlas.current_actor_id())
           RETURNING id`,
          [patient, minor, ref, attemptId],
        );
        return rows[0]?.id;
      });
    await expect(forgePayment(pending, 100, 'syn-rcpt-forged-pending')).rejects.toMatchObject({
      code: '23514',
    });
    // A second payment for an attempt that already has one is refused by its unique key; a wrong
    // amount is refused before that.
    await expect(
      forgePayment(ok.data.attemptRef as string, 999, 'syn-rcpt-forged-amount'),
    ).rejects.toMatchObject({
      code: '23514',
    });
  });
});

describe('S5: a pre-B5 insurer line (payer only, no coverage) can still be reversed', () => {
  it('13. reversing a legacy insurer responsibility entry posts the exact negation', async () => {
    const patient = await createPatient(h, 'Synthetic Legacy Insurer');
    const cov = await recordCoverage(h, patient, { payerRef: 'syn-payer-legacy' });
    const charge = await postCharge(h, patient, 1000);
    const moved = h.ok<{ data: { entryRef: string } }>(
      await h.call('a1', 'POST', `/v1/billing/charges/${charge.chargeRef}/responsibility`, {
        direction: 'to_insurer',
        coverageRef: cov,
        amount: usd(400),
        reasonCode: 'coverage_expected',
      }),
      201,
    ).data.entryRef;
    const c = await db.admin.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query(
        `UPDATE cuspatlas.billing_journal_lines SET coverage_id = NULL WHERE entry_id = $1 AND account = 'insurer_receivable'`,
        [moved],
      );
    } finally {
      await c.query('SET session_replication_role = origin');
      c.release();
    }
    const rev = await h.call('a1', 'POST', `/v1/billing/entries/${moved}/reverse`, {
      reasonCode: 'posted_in_error',
    });
    expect(rev.statusCode).toBe(201);
    const { rows } = await db.admin.query(
      `SELECT payer_ref, coverage_id, amount_minor::text AS m FROM cuspatlas.billing_journal_lines l
       JOIN cuspatlas.billing_journal_entries e ON e.id = l.entry_id
       WHERE e.reverses_entry_id = $1 AND l.account = 'insurer_receivable'`,
      [moved],
    );
    expect(rows).toStrictEqual([{ payer_ref: 'syn-payer-legacy', coverage_id: null, m: '-400' }]);
  });

  it('14. a new insurer line must name a coverage whose payer it carries', async () => {
    const patient = await createPatient(h, 'Synthetic Payer Mismatch');
    const cov = await recordCoverage(h, patient, { payerRef: 'syn-payer-right' });
    const charge = await postCharge(h, patient, 1000);
    const run = createTenantTransactionRunner(db.app);
    await expect(
      run(ctx(), async (t) => {
        const { rows } = await t.query<{ id: string }>(
          `INSERT INTO cuspatlas.billing_journal_entries (tenant_id, kind, currency, line_count, charge_id, reason_code,
             posted_by, correlation_id)
           VALUES (cuspatlas.current_tenant_id(), 'responsibility', 'USD', 2, $1, 'coverage_expected',
             cuspatlas.current_actor_id(), $2) RETURNING id`,
          [charge.chargeRef, randomUUID()],
        );
        const e = rows[0]?.id;
        await t.query(
          `INSERT INTO cuspatlas.billing_journal_lines (tenant_id, entry_id, line_no, account, amount_minor, currency,
             patient_id, charge_id, payer_ref, coverage_id)
           VALUES (cuspatlas.current_tenant_id(), $1, 1, 'insurer_receivable', 100, 'USD', $2, $3, 'syn-payer-wrong', $4),
                  (cuspatlas.current_tenant_id(), $1, 2, 'patient_receivable', -100, 'USD', $2, $3, NULL, NULL)`,
          [e, patient, charge.chargeRef, cov],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('S6: an authorization reference is single-use across the tenant', () => {
  it('15. the same authorization reference on a second plan is a typed 409', async () => {
    const p1 = await createPatient(h, 'Synthetic Auth One');
    const p2 = await createPatient(h, 'Synthetic Auth Two');
    const plan = async (patientRef: string) =>
      h.ok<{ data: { planRef: string } }>(
        await h.call('a1', 'POST', PLANS, {
          patientRef,
          contractTotal: usd(600),
          installmentCount: 2,
          firstDueOn: '2026-08-01',
          timeZone: 'America/New_York',
        }),
        201,
      ).data.planRef;
    const a = await plan(p1);
    const b = await plan(p2);
    const ref = authRef();
    const sign = async (planRef: string) =>
      h.call('a1', 'POST', `${PLANS}/${planRef}/authorizations`, {
        expectedVersion: await planVersion(planRef),
        authorizationRef: ref,
        evidenceRef: 'syn-evidence-signed-agreement',
      });
    expect((await sign(a)).statusCode).toBe(201);
    expect(reason(await sign(b))).toStrictEqual([409, 'conflict', 'authorization_reused']);
  });
});
