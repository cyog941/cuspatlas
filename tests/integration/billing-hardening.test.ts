import { randomUUID } from 'node:crypto';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { BILLING_POST_MERGE_PROBE } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, mergePatients, T_ALPHA } from './support/appointment-fixtures';
import { type BillingHarness, openBillingHarness, postCharge, usd } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, USER_A1 } from './support/fixtures';

/**
 * Hardening of B1/B2 after independent review (synthetic data only; rules pending billing approval):
 * provider capture is recorded before the provider is called and survives a later failure, the
 * database sign rule is race-safe on its own, structural backstops for entry kinds, currency and card
 * payments, provider-key reuse, the transitive post-merge probe, reconciliation after a merge, and a
 * seeded property run of ledger invariants.
 */
let db: TestDatabase;
let h: BillingHarness;
const PAY = '/v1/billing/payments';
const tx = () => createTenantTransactionRunner(db.app);
const ctx = () => ctxFor(T_ALPHA, USER_A1, 'human');
const reason = (res: { statusCode: number; json: () => { code?: string; detail?: { reason?: string } } }) => [
  res.statusCode,
  res.json().code,
  res.json().detail?.reason,
];
type PaymentData = { data: { outcome: string; paymentRef: string | null; attemptRef: string | null } };
const card = (patientRef: string, instrumentRef: string, minor = 1000, key: string = randomUUID()) =>
  h.call('a1', 'POST', PAY, { patientRef, amount: usd(minor), method: 'card_synthetic', instrumentRef }, key);
const attemptsOf = async (patientRef: string) =>
  (
    await db.admin.query(
      'SELECT id, outcome, resolution FROM cuspatlas.billing_payment_attempts WHERE patient_id = $1 ORDER BY created_at',
      [patientRef],
    )
  ).rows;
const paymentsOf = async (patientRef: string) =>
  (
    await db.admin.query('SELECT id, patient_id FROM cuspatlas.billing_payments WHERE patient_id = $1', [
      patientRef,
    ])
  ).rows;
const unknownItems = async () =>
  h.ok<{ data: { subjectRef: string }[] }>(
    await h.call('a1', 'GET', '/v1/billing/worklist?kind=unknown_payment_outcome'),
  ).data;

beforeAll(async () => {
  db = await openTestDatabase('billing_hardening');
  h = await openBillingHarness(db, { pool: 10 });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('capture is recorded before the provider and never erased', () => {
  it('1. a provider that throws is an unknown attempt with a reconciliation item, resolved only by lookup', async () => {
    const patient = await createPatient(h, 'Synthetic Provider Throws');
    const r = h.ok<PaymentData>(await card(patient, 'syn-card-throw-captured'), 201);
    expect([r.data.outcome, r.data.paymentRef]).toStrictEqual(['unknown', null]);
    expect((await unknownItems()).map((i) => i.subjectRef)).toContain(r.data.attemptRef);
    const rec = h.ok<{ data: { outcome: string; paymentRef: string } }>(
      await h.call('a1', 'POST', `/v1/billing/payment-attempts/${r.data.attemptRef}/reconcile`, {}),
    );
    expect(rec.data.outcome).toBe('confirmed');
    expect(await paymentsOf(patient)).toHaveLength(1);
    expect(await attemptsOf(patient)).toHaveLength(1);
  });

  it('2. a failure after the capture leaves the attempt as a reconciliation item; reconciling posts once', async () => {
    const patient = await createPatient(h, 'Synthetic Capture Then Fault');
    await db.admin.query('REVOKE INSERT ON cuspatlas.outbox_events FROM cuspatlas_app');
    let res: Awaited<ReturnType<typeof card>>;
    try {
      res = await card(patient, 'syn-card-ok');
    } finally {
      await db.admin.query('GRANT INSERT ON cuspatlas.outbox_events TO cuspatlas_app');
    }
    expect(res.statusCode).toBe(500);
    const attempts = await attemptsOf(patient);
    expect(attempts).toHaveLength(1);
    expect(await paymentsOf(patient)).toStrictEqual([]);
    const attemptRef = attempts[0]?.id as string;
    // B3-B5 review M1: inside its in-flight lease the attempt is neither a work item nor
    // reconcilable; once the lease has passed (simulated) it is both.
    expect((await unknownItems()).map((i) => i.subjectRef)).not.toContain(attemptRef);
    const early = await h.call('a1', 'POST', `/v1/billing/payment-attempts/${attemptRef}/reconcile`, {});
    expect([early.statusCode, early.json().detail?.reason]).toStrictEqual([409, 'attempt_in_flight']);
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
    expect((await unknownItems()).map((i) => i.subjectRef)).toContain(attemptRef);
    const rec = h.ok<{ data: { outcome: string } }>(
      await h.call('a1', 'POST', `/v1/billing/payment-attempts/${attemptRef}/reconcile`, {}),
    );
    expect(rec.data.outcome).toBe('confirmed');
    expect(await paymentsOf(patient)).toHaveLength(1);
    expect(await attemptsOf(patient)).toHaveLength(1);
  });

  it('3. reusing a provider key after the idempotency record expired is a typed 409, never a second capture', async () => {
    const patient = await createPatient(h, 'Synthetic Key Reuse');
    const key = randomUUID();
    h.ok(await card(patient, 'syn-card-ok', 700, key), 201);
    await db.admin.query(
      `UPDATE cuspatlas.command_idempotency SET reserved_at = now() - interval '8 days',
         expires_at = now() - interval '1 day'
       WHERE operation = 'billing.payments.record' AND key_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
      [key],
    );
    expect(reason(await card(patient, 'syn-card-ok', 700, key))).toStrictEqual([
      409,
      'conflict',
      'duplicate_attempt',
    ]);
    expect(await paymentsOf(patient)).toHaveLength(1);
    expect(await attemptsOf(patient)).toHaveLength(1);
  });

  it('4. a plan installment whose provider throws blocks the plan as unknown', async () => {
    const patient = await createPatient(h, 'Synthetic Plan Throws');
    const plan = h.ok<{ data: { planRef: string } }>(
      await h.call('a1', 'POST', '/v1/billing/payment-plans', {
        patientRef: patient,
        contractTotal: usd(900),
        installmentCount: 3,
        firstDueOn: '2026-08-01',
        timeZone: 'America/New_York',
      }),
      201,
    ).data.planRef;
    const v = async () =>
      h.ok<{ data: { version: number; autoPayState: string } }>(
        await h.call('a1', 'GET', `/v1/billing/payment-plans/${plan}`),
      ).data;
    h.ok(
      await h.call('a1', 'POST', `/v1/billing/payment-plans/${plan}/authorizations`, {
        expectedVersion: (await v()).version,
        authorizationRef: 'syn-auth-throws',
        evidenceRef: 'syn-evidence-throws',
      }),
      201,
    );
    h.ok(
      await h.call('a1', 'POST', `/v1/billing/payment-plans/${plan}/autopay`, {
        expectedVersion: (await v()).version,
        state: 'active',
        instrumentRef: 'syn-card-throw-pending',
        cardExpiry: '2099-12',
        authorizationRef: 'syn-auth-throws-card',
      }),
      201,
    );
    const r = h.ok<{ data: { outcome: string } }>(
      await h.call('a1', 'POST', `/v1/billing/payment-plans/${plan}/collections`, { periodNo: 1 }),
      201,
    );
    expect(r.data.outcome).toBe('unknown');
    expect((await v()).autoPayState).toBe('blocked');
    expect(await paymentsOf(patient)).toStrictEqual([]);
  });
});

describe('database backstops under the runtime role', () => {
  const rawEntry = async (
    t: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { id: string }[] }> },
    o: { kind: string; currency?: string; chargeId?: string | null; paymentId?: string | null },
    lines: {
      account: string;
      minor: number;
      patient: string;
      charge?: string | null;
      payment?: string | null;
    }[],
  ) => {
    const { rows } = await t.query(
      `INSERT INTO cuspatlas.billing_journal_entries (tenant_id, kind, currency, line_count, charge_id, payment_id,
         posted_by, correlation_id)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, cuspatlas.current_actor_id(), $6) RETURNING id`,
      [o.kind, o.currency ?? 'USD', lines.length, o.chargeId ?? null, o.paymentId ?? null, randomUUID()],
    );
    const entry = rows[0]?.id;
    for (const [i, l] of lines.entries()) {
      await t.query(
        `INSERT INTO cuspatlas.billing_journal_lines (tenant_id, entry_id, line_no, account, amount_minor, currency,
           patient_id, charge_id, payment_id)
         VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry,
          i + 1,
          l.account,
          l.minor,
          o.currency ?? 'USD',
          l.patient,
          l.charge ?? null,
          l.payment ?? null,
        ],
      );
    }
  };

  it('5. two raw transactions over-allocating one charge at once: the sign rule locks, one fails', async () => {
    const patient = await createPatient(h, 'Synthetic Raw Race');
    const c = await postCharge(h, patient, 1000);
    const pay = async () =>
      h.ok<PaymentData>(
        await h.call('a1', 'POST', PAY, { patientRef: patient, amount: usd(800), method: 'cash' }),
        201,
      ).data.paymentRef as string;
    const [p1, p2] = [await pay(), await pay()];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let ready = 0;
    const both = new Promise<void>((r) => {
      const tick = setInterval(() => {
        if (ready === 2) {
          clearInterval(tick);
          r();
        }
      }, 5);
    });
    const allocate = (p: string) =>
      tx()(ctx(), async (t) => {
        await rawEntry(t, { kind: 'allocation', chargeId: c.chargeRef, paymentId: p }, [
          { account: 'unapplied_credit', minor: 800, patient, payment: p },
          { account: 'patient_receivable', minor: -800, patient, charge: c.chargeRef, payment: p },
        ]);
        ready += 1;
        await gate;
      });
    const runs = [allocate(p1), allocate(p2)];
    await both;
    release();
    const settled = await Promise.allSettled(runs);
    expect(settled.map((s) => s.status).sort()).toStrictEqual(['fulfilled', 'rejected']);
    const failure = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect((failure.reason as { code?: string }).code).toBe('23514');
    const { rows } = await db.admin.query(
      `SELECT sum(amount_minor)::int AS s FROM cuspatlas.billing_journal_lines
       WHERE charge_id = $1 AND account = 'patient_receivable'`,
      [c.chargeRef],
    );
    expect(rows[0].s).toBe(200);
  });

  it('6. entry kind, tenant currency, one received entry per payment and card capture are checked at commit', async () => {
    const patient = await createPatient(h, 'Synthetic Backstops');
    const c = await postCharge(h, patient, 1000);
    const cash = h.ok<PaymentData>(
      await h.call('a1', 'POST', PAY, { patientRef: patient, amount: usd(500), method: 'cash' }),
      201,
    ).data.paymentRef as string;
    // A charge entry may not move cash.
    await expect(
      tx()(ctx(), (t) =>
        rawEntry(t, { kind: 'charge', chargeId: c.chargeRef, paymentId: cash }, [
          { account: 'undeposited_funds', minor: 100, patient, payment: cash },
          { account: 'unapplied_credit', minor: -100, patient, payment: cash },
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // An entry in another currency than the tenant's.
    await expect(
      tx()(ctx(), (t) =>
        rawEntry(t, { kind: 'transfer', currency: 'EUR', paymentId: cash }, [
          { account: 'unapplied_credit', minor: 100, patient, payment: cash },
          { account: 'unapplied_credit', minor: -100, patient, payment: cash },
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // A second received entry for the same payment.
    await expect(
      tx()(ctx(), (t) =>
        rawEntry(t, { kind: 'patientPayment', paymentId: cash }, [
          { account: 'undeposited_funds', minor: 500, patient, payment: cash },
          { account: 'unapplied_credit', minor: -500, patient, payment: cash },
        ]),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // A card payment backed by a declined attempt.
    const declined = h.ok<PaymentData>(await card(patient, 'syn-card-decline', 300), 201).data
      .attemptRef as string;
    await expect(
      tx()(ctx(), async (t) => {
        const { rows } = await t.query(
          `INSERT INTO cuspatlas.billing_payments (tenant_id, patient_id, method, amount_minor, currency, external_ref,
             attempt_id, received_at, created_by)
           VALUES (cuspatlas.current_tenant_id(), $1, 'card_synthetic', 300, 'USD', 'syn-rcpt-forged', $2, now(),
             cuspatlas.current_actor_id()) RETURNING id`,
          [patient, declined],
        );
        const p = rows[0]?.id as string;
        await rawEntry(t, { kind: 'patientPayment', paymentId: p }, [
          { account: 'undeposited_funds', minor: 300, patient, payment: p },
          { account: 'unapplied_credit', minor: -300, patient, payment: p },
        ]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await paymentsOf(patient)).map((x) => x.id)).toStrictEqual([cash]);
  });
});

describe('merge handling', () => {
  it('7. the post-merge probe counts facts across the whole merge chain', async () => {
    const x = await createPatient(h, 'Synthetic Chain');
    const y = await createPatient(h, 'Synthetic Chain');
    const z = await createPatient(h, 'Synthetic Chain');
    await mergePatients(h, y, x);
    const { rows } = await db.admin.query(
      'SELECT merged_at FROM cuspatlas.patient_merges WHERE merged_patient_id = $1',
      [x],
    );
    const mergedAt = rows[0].merged_at as Date;
    await mergePatients(h, z, y);
    await postCharge(h, z, 100);
    const n = await tx()(ctx(), (t) => BILLING_POST_MERGE_PROBE.count(t, y, mergedAt));
    expect(n).toBe(1);
  });

  it('8. reconciling a capture after the payer was merged posts the payment to the survivor', async () => {
    const survivor = await createPatient(h, 'Synthetic Reconcile Merge');
    const merged = await createPatient(h, 'Synthetic Reconcile Merge');
    const r = h.ok<PaymentData>(await card(merged, 'syn-card-timeout-captured', 400), 201);
    await mergePatients(h, survivor, merged);
    const rec = h.ok<{ data: { paymentRef: string } }>(
      await h.call('a1', 'POST', `/v1/billing/payment-attempts/${r.data.attemptRef}/reconcile`, {}),
    );
    const view = h.ok<{ data: { patientRef: string } }>(
      await h.call('a1', 'GET', `${PAY}/${rec.data.paymentRef}`),
    ).data;
    expect(view.patientRef).toBe(survivor);
  });
});

describe('ledger invariants under a seeded random sequence', () => {
  it('9. post, pay, allocate, refund and reverse keep every entry balanced and every sign rule', async () => {
    let seed = 20261109;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const patients = [
      await createPatient(h, 'Synthetic Property A'),
      await createPatient(h, 'Synthetic Property B'),
    ];
    const charges: { ref: string; entry: string; patient: string }[] = [];
    const payments: { ref: string; patient: string }[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      const op = rnd(5);
      const patient = patients[rnd(2)] as string;
      if (op === 0 || charges.length === 0) {
        const c = await postCharge(h, patient, 100 + rnd(900));
        charges.push({ ref: c.chargeRef, entry: c.entryRef, patient });
      } else if (op === 1 || payments.length === 0) {
        const r = await h.call('a1', 'POST', PAY, {
          patientRef: patient,
          amount: usd(50 + rnd(700)),
          method: 'cash',
        });
        statuses.push(r.statusCode);
        if (r.statusCode === 201) payments.push({ ref: r.json().data.paymentRef, patient });
      } else if (op === 2) {
        const p = payments[rnd(payments.length)] as { ref: string; patient: string };
        const c = charges[rnd(charges.length)] as { ref: string };
        const r = await h.call('a1', 'POST', `${PAY}/${p.ref}/allocations`, {
          allocations: [{ chargeRef: c.ref, amount: usd(1 + rnd(400)) }],
        });
        statuses.push(r.statusCode);
      } else if (op === 3) {
        const p = payments[rnd(payments.length)] as { ref: string };
        const r = await h.call('a1', 'POST', `${PAY}/${p.ref}/refunds`, {
          amount: usd(1 + rnd(300)),
          reasonCode: 'overpayment',
        });
        statuses.push(r.statusCode);
      } else {
        const c = charges[rnd(charges.length)] as { entry: string };
        const r = await h.call('a1', 'POST', `/v1/billing/entries/${c.entry}/reverse`, {
          reasonCode: 'posted_in_error',
        });
        statuses.push(r.statusCode);
      }
    }
    // Refusals are typed (never a fault), and the run exercised both outcomes.
    expect(statuses.every((s) => s === 201 || s === 409 || s === 422)).toBe(true);
    expect(statuses.some((s) => s === 201) && statuses.some((s) => s === 409)).toBe(true);
    const unbalanced = await db.admin.query(
      'SELECT entry_id FROM cuspatlas.billing_journal_lines GROUP BY entry_id HAVING sum(amount_minor) <> 0',
    );
    expect(unbalanced.rows).toStrictEqual([]);
    const broken = await db.admin.query(
      `SELECT account FROM (
         SELECT account, sum(amount_minor) AS s FROM cuspatlas.billing_journal_lines
         WHERE account IN ('patient_receivable', 'production_revenue') GROUP BY account, charge_id
         UNION ALL
         SELECT account, sum(amount_minor) FROM cuspatlas.billing_journal_lines
         WHERE account = 'unapplied_credit' GROUP BY account, payment_id, patient_id
         UNION ALL
         SELECT account, sum(amount_minor) FROM cuspatlas.billing_journal_lines
         WHERE account IN ('undeposited_funds', 'settled_cash') GROUP BY account, payment_id) d
       WHERE (account IN ('patient_receivable', 'undeposited_funds', 'settled_cash') AND s < 0)
          OR (account IN ('production_revenue', 'unapplied_credit') AND s > 0)`,
    );
    expect(broken.rows).toStrictEqual([]);
    for (const patient of patients) {
      const bal = h.ok<{ data: { balance: { minor: number } } }>(
        await h.call('a1', 'GET', `/v1/billing/patients/${patient}/balance`),
      ).data.balance.minor;
      const { rows } = await db.admin.query(
        `SELECT coalesce(sum(amount_minor), 0)::int AS s FROM cuspatlas.billing_journal_lines
         WHERE patient_id = $1 AND account IN ('patient_receivable', 'unapplied_credit')`,
        [patient],
      );
      expect(bal).toBe(rows[0].s);
    }
  });
});
