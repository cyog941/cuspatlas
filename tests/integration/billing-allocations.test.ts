import { randomUUID } from 'node:crypto';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, createPatient, mergePatients, T_ALPHA } from './support/appointment-fixtures';
import {
  type BillingHarness,
  balanceOf,
  billingDigest,
  billingLeakSurface,
  openBillingHarness,
  postCharge,
  recordCoverage,
  usd,
} from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, USER_A1 } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * B2: payments, allocations, refunds, transfers and undistributed funds (synthetic data only;
 * financial rules recommended-pending-billing-approval, ADR 0008; the payment provider is the
 * synthetic in-process port, B-S1 blocked-on-discovery). REST and MCP under the runtime role.
 */
let db: TestDatabase;
let h: BillingHarness;

const PAY = '/v1/billing/payments';
type PaymentData = {
  outcome: string;
  paymentRef: string | null;
  attemptRef: string | null;
  entryRef: string | null;
};

async function pay(
  patientRef: string,
  minor: number,
  extra: Record<string, unknown> = {},
  key = randomUUID(),
) {
  return h.call('a1', 'POST', PAY, { patientRef, amount: usd(minor), method: 'cash', ...extra }, key);
}
async function cash(patientRef: string, minor: number, extra: Record<string, unknown> = {}): Promise<string> {
  const r = h.ok<{ data: PaymentData }>(await pay(patientRef, minor, extra), 201);
  expect(r.data.outcome).toBe('confirmed');
  return r.data.paymentRef as string;
}
const allocate = (paymentRef: string, allocations: { chargeRef: string; minor: number }[], who = 'a1') =>
  h.call(who, 'POST', `${PAY}/${paymentRef}/allocations`, {
    allocations: allocations.map((a) => ({ chargeRef: a.chargeRef, amount: usd(a.minor) })),
  });
const payment = async (paymentRef: string) =>
  h.ok<{ data: Record<string, unknown> & { allocations: { allocationRef: string }[] } }>(
    await h.call('a1', 'GET', `${PAY}/${paymentRef}`),
  ).data;
const charge = async (chargeRef: string) =>
  h.ok<{ data: Record<string, unknown> }>(await h.call('a1', 'GET', `/v1/billing/charges/${chargeRef}`)).data;
const worklist = async (query = '') =>
  h.ok<{ data: Record<string, unknown>[]; totalCount: number; truncated: boolean }>(
    await h.call('a1', 'GET', `/v1/billing/worklist${query}`),
  );
const reason = (res: { statusCode: number; json: () => { code?: string; detail?: { reason?: string } } }) => [
  res.statusCode,
  res.json().code,
  res.json().detail?.reason,
];

beforeAll(async () => {
  db = await openTestDatabase('billing_allocations');
  h = await openBillingHarness(db, { pool: 10, mcp: true });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('B2 completion: charge, payment, allocation and partial refund reconcile exactly', () => {
  it('1. a charge plus a payment plus a partial refund leaves an exact balance and zero undistributed funds', async () => {
    const patient = await createPatient(h, 'Synthetic Completion');
    const c = await postCharge(h, patient, 10000);
    const p = await cash(patient, 8000, { externalRef: 'syn-receipt-completion' });
    expect((await balanceOf(h, patient)).balance).toStrictEqual(usd(2000));
    const alloc = h.ok<{ data: { allocationRefs: string[] }; version: number }>(
      await allocate(p, [{ chargeRef: c.chargeRef, minor: 5000 }]),
      201,
    );
    expect(alloc.data.allocationRefs).toHaveLength(1);
    const refund = h.ok<{ data: { entryRef: string } }>(
      await h.call('a1', 'POST', `${PAY}/${p}/refunds`, {
        amount: usd(3000),
        reasonCode: 'overpayment',
        refundRef: 'syn-refund-1',
      }),
      201,
    );
    expect(refund.data.entryRef).toMatch(/^[0-9a-f-]{36}$/);
    const view = await payment(p);
    expect(view).toMatchObject({
      amount: usd(8000),
      method: 'cash',
      state: 'received',
      allocated: usd(5000),
      refunded: usd(3000),
      unapplied: usd(0),
      unappliedByPatient: [],
    });
    expect(view.allocations).toMatchObject([
      {
        allocationRef: alloc.data.allocationRefs[0],
        chargeRef: c.chargeRef,
        amount: usd(5000),
        reversedByEntryRef: null,
      },
    ]);
    expect(await charge(c.chargeRef)).toMatchObject({
      patientResponsibility: usd(5000),
      allocated: usd(5000),
    });
    const bal = await balanceOf(h, patient);
    expect(bal).toMatchObject({
      patientResponsibility: usd(5000),
      unappliedCredit: usd(0),
      balance: usd(5000),
    });
    const items = (await worklist()).data.filter((i) => i.patientRef === patient);
    expect(items).toStrictEqual([]);
  });
});

describe('B2 allocation rules', () => {
  it('2. an allocation beyond available funds or beyond what a charge owes is refused and writes nothing', async () => {
    const patient = await createPatient(h, 'Synthetic Limits');
    const small = await postCharge(h, patient, 300);
    const big = await postCharge(h, patient, 50000);
    const p = await cash(patient, 1000);
    const before = await billingDigest(db);
    expect(reason(await allocate(p, [{ chargeRef: big.chargeRef, minor: 1001 }]))).toStrictEqual([
      409,
      'conflict',
      'insufficient_funds',
    ]);
    expect(reason(await allocate(p, [{ chargeRef: small.chargeRef, minor: 301 }]))).toStrictEqual([
      409,
      'conflict',
      'charge_overallocated',
    ]);
    expect(
      reason(
        await allocate(p, [
          { chargeRef: small.chargeRef, minor: 100 },
          { chargeRef: small.chargeRef, minor: 100 },
        ]),
      ),
    ).toStrictEqual([422, 'validation_failed', 'duplicate_charge']);
    const eur = await h.call('a1', 'POST', `${PAY}/${p}/allocations`, {
      allocations: [{ chargeRef: small.chargeRef, amount: { currency: 'EUR', minor: 1 } }],
    });
    expect(reason(eur)).toStrictEqual([422, 'validation_failed', 'currency_mismatch']);
    expect(await billingDigest(db)).toBe(before);
  });

  it('3. allocations across two charges commit together or not at all', async () => {
    const patient = await createPatient(h, 'Synthetic Atomic');
    const c1 = await postCharge(h, patient, 1000);
    const c2 = await postCharge(h, patient, 1000);
    const p = await cash(patient, 1500);
    const before = await billingDigest(db);
    const refused = await allocate(p, [
      { chargeRef: c1.chargeRef, minor: 1000 },
      { chargeRef: c2.chargeRef, minor: 1000 },
    ]);
    expect(reason(refused)).toStrictEqual([409, 'conflict', 'insufficient_funds']);
    expect(await billingDigest(db)).toBe(before);
    expect((await charge(c1.chargeRef)).allocated).toStrictEqual(usd(0));
    const ok = h.ok<{ data: { allocationRefs: string[] } }>(
      await allocate(p, [
        { chargeRef: c1.chargeRef, minor: 1000 },
        { chargeRef: c2.chargeRef, minor: 500 },
      ]),
      201,
    );
    expect(ok.data.allocationRefs).toHaveLength(2);
    expect((await payment(p)).unapplied).toStrictEqual(usd(0));
  });

  it('4. concurrent allocations against one payment: exactly one wins, the others get a typed conflict', async () => {
    const patient = await createPatient(h, 'Synthetic Race');
    const charges = await Promise.all([1, 2, 3, 4].map(() => postCharge(h, patient, 1000)));
    const p = await cash(patient, 1000);
    const results = await Promise.all(
      charges.map((c) => allocate(p, [{ chargeRef: c.chargeRef, minor: 600 }])),
    );
    expect(results.map((r) => r.statusCode).sort()).toStrictEqual([201, 409, 409, 409]);
    for (const r of results.filter((x) => x.statusCode === 409)) {
      expect(r.json().detail?.reason).toBe('insufficient_funds');
    }
    const view = await payment(p);
    expect([view.allocated, view.unapplied]).toStrictEqual([usd(600), usd(400)]);
    // Two payments racing for one charge: the charge can never be over-allocated.
    const target = await postCharge(h, patient, 1000);
    const [p1, p2] = [await cash(patient, 800), await cash(patient, 800)];
    const race = await Promise.all(
      [p1, p2].map((x) => allocate(x as string, [{ chargeRef: target.chargeRef, minor: 800 }])),
    );
    expect(race.map((r) => r.statusCode).sort()).toStrictEqual([201, 409]);
    expect(race.find((r) => r.statusCode === 409)?.json().detail?.reason).toBe('charge_overallocated');
    expect((await charge(target.chargeRef)).patientResponsibility).toStrictEqual(usd(200));
  });

  it('5. funds of one account cannot pay an unrelated patient; the merge set is one account', async () => {
    const a = await createPatient(h, 'Synthetic Account A');
    const b = await createPatient(h, 'Synthetic Account B');
    const cb = await postCharge(h, b, 500);
    const pa = await cash(a, 500);
    expect(reason(await allocate(pa, [{ chargeRef: cb.chargeRef, minor: 500 }]))).toStrictEqual([
      422,
      'validation_failed',
      'patient_mismatch',
    ]);
    // A merged identity's money belongs to the survivor's account: allocation across the pair works.
    const survivor = await createPatient(h, 'Synthetic Merge Money');
    const merged = await createPatient(h, 'Synthetic Merge Money');
    const pm = await cash(merged, 700);
    await mergePatients(h, survivor, merged);
    const cs = await postCharge(h, survivor, 700);
    h.ok(await allocate(pm, [{ chargeRef: cs.chargeRef, minor: 700 }]), 201);
    expect((await balanceOf(h, survivor)).balance).toStrictEqual(usd(0));
    expect(reason(await pay(merged, 100))).toStrictEqual([409, 'conflict', 'patient_merged']);
  });
});

describe('B2 undistributed funds as an owned, aged work item', () => {
  it('6. unapplied money is a first-class worklist item with age basis, owner, reason and due time', async () => {
    const patient = await createPatient(h, 'Synthetic Unapplied');
    const c = await postCharge(h, patient, 400);
    const fresh = await cash(patient, 1000);
    const old = await cash(patient, 250, { receivedAt: '2026-01-02T15:00:00Z' });
    h.ok(await allocate(fresh, [{ chargeRef: c.chargeRef, minor: 400 }]), 201);
    const list = await worklist('?kind=unapplied_funds');
    const mine = list.data.filter((i) => i.patientRef === patient);
    expect(mine).toHaveLength(2);
    const byPayment = Object.fromEntries(mine.map((i) => [i.subjectRef as string, i]));
    expect(byPayment[fresh]).toMatchObject({
      kind: 'unapplied_funds',
      amount: usd(600),
      owner: 'practice',
      queue: 'billing',
      reasonCode: 'unapplied_funds',
      suggestedAction: 'allocate_or_refund',
      overdue: false,
    });
    expect(byPayment[old]).toMatchObject({
      amount: usd(250),
      ageBasis: '2026-01-02T15:00:00.000Z',
      dueAt: '2026-01-09T15:00:00.000Z',
      overdue: true,
    });
    // Ordered by due time (the overdue item first) and never silently truncated.
    expect(list.data.findIndex((i) => i.subjectRef === old)).toBeLessThan(
      list.data.findIndex((i) => i.subjectRef === fresh),
    );
    expect([list.truncated, list.totalCount >= 2]).toStrictEqual([false, true]);
    const limited = await worklist('?kind=unapplied_funds&limit=1');
    expect([limited.data.length, limited.truncated]).toStrictEqual([1, true]);
    // The derived figure equals the balance's unapplied credit; nothing is stored as a balance.
    expect((await balanceOf(h, patient)).unappliedCredit).toStrictEqual(usd(850));
    const cols = await db.admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'cuspatlas'
         AND table_name LIKE 'billing\\_%' AND table_name <> 'billing_settings' AND column_name ~ '(balance|unapplied|remaining)'`,
    );
    expect(cols.rows).toStrictEqual([]);
  });

  it('7. moving funds between patients needs a human, a reason and an audit row; the recipient can then use them', async () => {
    const from = await createPatient(h, 'Synthetic Funds From');
    const to = await createPatient(h, 'Synthetic Funds To');
    const cTo = await postCharge(h, to, 300);
    const p = await cash(from, 1000);
    const url = `${PAY}/${p}/transfers`;
    expect((await h.call('a1', 'POST', url, { toPatientRef: to, amount: usd(300) })).statusCode).toBe(400);
    const svc = await h.call('svcA1', 'POST', url, {
      toPatientRef: to,
      amount: usd(300),
      reasonCode: 'family_account',
    });
    expect(svc.statusCode).toBe(403);
    expect(
      reason(await h.call('a1', 'POST', url, { toPatientRef: from, amount: usd(1), reasonCode: 'x' })),
    ).toStrictEqual([422, 'validation_failed', 'same_patient']);
    expect(
      reason(
        await h.call('a1', 'POST', url, {
          toPatientRef: to,
          amount: usd(1001),
          reasonCode: 'family_account',
        }),
      ),
    ).toStrictEqual([409, 'conflict', 'insufficient_funds']);
    const moved = h.ok<{ data: { entryRef: string }; version: number }>(
      await h.call('a1', 'POST', url, { toPatientRef: to, amount: usd(300), reasonCode: 'family_account' }),
      201,
    );
    const audit = await db.admin.query(
      `SELECT operation, resource_type FROM cuspatlas.audit_events WHERE resource_ref = $1 AND operation = 'billing.funds.transfer'`,
      [p],
    );
    expect(audit.rows).toStrictEqual([
      { operation: 'billing.funds.transfer', resource_type: 'billingPayment' },
    ]);
    const e = h.ok<{
      data: {
        reasonCode: string;
        lines: { account: string; patientRef: string; amount: { minor: number } }[];
      };
    }>(await h.call('a1', 'GET', `/v1/billing/entries/${moved.data.entryRef}`)).data;
    expect(e.reasonCode).toBe('family_account');
    expect(e.lines.map((l) => [l.account, l.patientRef, l.amount.minor])).toStrictEqual([
      ['unapplied_credit', from, 300],
      ['unapplied_credit', to, -300],
    ]);
    h.ok(await allocate(p, [{ chargeRef: cTo.chargeRef, minor: 300 }]), 201);
    expect((await balanceOf(h, to)).balance).toStrictEqual(usd(0));
    // The original payer cannot refund money that now belongs to another account.
    expect(
      reason(
        await h.call('a1', 'POST', `${PAY}/${p}/refunds`, { amount: usd(701), reasonCode: 'overpayment' }),
      ),
    ).toStrictEqual([409, 'conflict', 'refund_exceeds_funds']);
    expect((await payment(p)).unappliedByPatient).toStrictEqual([{ patientRef: from, amount: usd(700) }]);
  });

  it('8. a refund larger than collected and unapplied funds is refused; refunds are human-only', async () => {
    const patient = await createPatient(h, 'Synthetic Refund');
    const c = await postCharge(h, patient, 600);
    const p = await cash(patient, 1000);
    h.ok(await allocate(p, [{ chargeRef: c.chargeRef, minor: 600 }]), 201);
    const url = `${PAY}/${p}/refunds`;
    expect(
      reason(await h.call('a1', 'POST', url, { amount: usd(401), reasonCode: 'overpayment' })),
    ).toStrictEqual([409, 'conflict', 'refund_exceeds_funds']);
    expect(
      (await h.call('svcA1', 'POST', url, { amount: usd(1), reasonCode: 'overpayment' })).statusCode,
    ).toBe(403);
    expect((await h.call('a3', 'POST', url, { amount: usd(1), reasonCode: 'overpayment' })).statusCode).toBe(
      403,
    );
    h.ok(await h.call('a1', 'POST', url, { amount: usd(400), reasonCode: 'overpayment' }), 201);
    expect((await payment(p)).unapplied).toStrictEqual(usd(0));
  });
});

describe('B2 payment facts, provider outcomes and settlement', () => {
  it('9. a duplicate receipt never creates a second payment; a replay returns the first', async () => {
    const patient = await createPatient(h, 'Synthetic Duplicate');
    const before = await count(db, 'billing_payments');
    const key = randomUUID();
    const first = h.ok<{ data: PaymentData }>(
      await pay(patient, 900, { method: 'check', externalRef: 'syn-check-1001' }, key),
      201,
    );
    const replay = h.ok<{ data: PaymentData; replayed: boolean }>(
      await pay(patient, 900, { method: 'check', externalRef: 'syn-check-1001' }, key),
      201,
    );
    expect([replay.replayed, replay.data.paymentRef]).toStrictEqual([true, first.data.paymentRef]);
    const dup = await pay(patient, 900, { method: 'check', externalRef: 'syn-check-1001' });
    expect(reason(dup)).toStrictEqual([409, 'conflict', 'duplicate_receipt']);
    expect(dup.json().detail.blockingRefs).toStrictEqual([
      { kind: 'billingPayment', ref: first.data.paymentRef },
    ]);
    const cardKey = randomUUID();
    const card = { method: 'card_synthetic', instrumentRef: 'syn-card-visa-ok' };
    const c1 = h.ok<{ data: PaymentData }>(await pay(patient, 450, card, cardKey), 201);
    const c2 = h.ok<{ data: PaymentData; replayed: boolean }>(await pay(patient, 450, card, cardKey), 201);
    expect([c1.data.outcome, c2.replayed, c2.data.paymentRef]).toStrictEqual([
      'confirmed',
      true,
      c1.data.paymentRef,
    ]);
    expect(await count(db, 'billing_payments')).toBe(before + 2);
    expect(await count(db, 'billing_payment_attempts')).toBeGreaterThanOrEqual(1);
    // Method rules: a card needs a synthetic instrument; cash and check never carry one.
    expect(reason(await pay(patient, 1, { method: 'card_synthetic' }))).toStrictEqual([
      422,
      'validation_failed',
      'instrument_required',
    ]);
    expect(reason(await pay(patient, 1, { instrumentRef: 'syn-card-visa-ok' }))).toStrictEqual([
      422,
      'validation_failed',
      'instrument_not_allowed',
    ]);
  });

  it('10. a provider timeout is an unknown outcome with a reconciliation item, never posted or retried', async () => {
    const patient = await createPatient(h, 'Synthetic Unknown');
    const record = async (instrumentRef: string) =>
      h.ok<{ data: PaymentData }>(await pay(patient, 1200, { method: 'card_synthetic', instrumentRef }), 201);
    const declined = (await record('syn-card-decline')).data;
    expect(declined).toMatchObject({ outcome: 'declined', paymentRef: null, entryRef: null });
    const entriesBefore = await count(db, 'billing_journal_entries');
    const pending = (await record('syn-card-timeout-pending')).data;
    const captured = (await record('syn-card-timeout-captured')).data;
    const absent = (await record('syn-card-timeout-absent')).data;
    for (const u of [pending, captured, absent]) {
      expect(u).toMatchObject({ outcome: 'unknown', paymentRef: null, entryRef: null });
    }
    expect(await count(db, 'billing_journal_entries')).toBe(entriesBefore);
    expect((await balanceOf(h, patient)).unappliedCredit).toStrictEqual(usd(0));
    const items = (await worklist('?kind=unknown_payment_outcome')).data.filter(
      (i) => i.patientRef === patient,
    );
    expect(items.map((i) => i.subjectRef).sort()).toStrictEqual(
      [pending.attemptRef, captured.attemptRef, absent.attemptRef].sort(),
    );
    expect(items[0]).toMatchObject({
      kind: 'unknown_payment_outcome',
      reasonCode: 'provider_outcome_unknown',
      suggestedAction: 'reconcile_attempt',
      amount: usd(1200),
    });
    const reconcile = (attemptRef: string | null) =>
      h.call('a1', 'POST', `/v1/billing/payment-attempts/${attemptRef}/reconcile`, {});
    const still = await reconcile(pending.attemptRef);
    expect([...reason(still), still.json().retryable]).toStrictEqual([
      409,
      'conflict',
      'outcome_still_unknown',
      true,
    ]);
    const ok = h.ok<{ data: { outcome: string; paymentRef: string; entryRef: string } }>(
      await reconcile(captured.attemptRef),
    );
    expect(ok.data.outcome).toBe('confirmed');
    expect((await payment(ok.data.paymentRef)).amount).toStrictEqual(usd(1200));
    expect(reason(await reconcile(captured.attemptRef))).toStrictEqual([409, 'conflict', 'already_resolved']);
    const gone = h.ok<{ data: { outcome: string; paymentRef: string | null } }>(
      await reconcile(absent.attemptRef),
    );
    expect(gone.data).toMatchObject({ outcome: 'declined', paymentRef: null });
    expect(reason(await reconcile(declined.attemptRef))).toStrictEqual([409, 'conflict', 'not_reconcilable']);
    const left = (await worklist('?kind=unknown_payment_outcome')).data.filter(
      (i) => i.patientRef === patient,
    );
    expect(left.map((i) => i.subjectRef)).toStrictEqual([pending.attemptRef]);
    // One attempt per instrument: nothing was retried automatically.
    const { rows } = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.billing_payment_attempts WHERE patient_id = $1',
      [patient],
    );
    expect(rows[0].n).toBe(4);
    expect((await balanceOf(h, patient)).unappliedCredit).toStrictEqual(usd(1200));
  });

  it('11. received is not settled: settlement is its own entry and a payment reversal needs dependents reversed first', async () => {
    const patient = await createPatient(h, 'Synthetic Settlement');
    const c = await postCharge(h, patient, 500);
    const p = await cash(patient, 900);
    expect((await payment(p)).settlement).toStrictEqual({
      state: 'received',
      settled: usd(0),
      unsettled: usd(900),
    });
    const alloc = h.ok<{ data: { allocationRefs: string[] } }>(
      await allocate(p, [{ chargeRef: c.chargeRef, minor: 500 }]),
      201,
    );
    const settle = (ref: string) => h.call('a1', 'POST', `${PAY}/${p}/settle`, { settlementRef: ref });
    const s1 = h.ok<{ data: { entryRef: string } }>(await settle('syn-deposit-1'), 201);
    expect((await payment(p)).settlement).toStrictEqual({
      state: 'settled',
      settled: usd(900),
      unsettled: usd(0),
    });
    expect(reason(await settle('syn-deposit-2'))).toStrictEqual([409, 'conflict', 'nothing_to_settle']);
    const paymentEntry = (await payment(p)).entryRef as string;
    const rev = (entryRef: string) =>
      h.call('a1', 'POST', `/v1/billing/entries/${entryRef}/reverse`, { reasonCode: 'returned_item' });
    const blocked = await rev(paymentEntry);
    expect(reason(blocked)).toStrictEqual([409, 'conflict', 'allocation_reversal_required']);
    expect(blocked.json().detail.blockingRefs).toContainEqual({
      kind: 'journalEntry',
      ref: alloc.data.allocationRefs[0],
    });
    h.ok(await rev(alloc.data.allocationRefs[0] as string), 201);
    expect(reason(await rev(paymentEntry))).toStrictEqual([409, 'conflict', 'settlement_reversal_required']);
    h.ok(await rev(s1.data.entryRef), 201);
    h.ok(await rev(paymentEntry), 201);
    const view = await payment(p);
    expect([view.state, view.unapplied, view.allocated]).toStrictEqual(['reversed', usd(0), usd(0)]);
    expect(view.allocations).toMatchObject([{ reversedByEntryRef: expect.any(String) }]);
    expect(reason(await allocate(p, [{ chargeRef: c.chargeRef, minor: 1 }]))).toStrictEqual([
      409,
      'conflict',
      'payment_reversed',
    ]);
    expect((await balanceOf(h, patient)).balance).toStrictEqual(usd(500));
  });

  it('12. responsibility moves between patient and insurer without over-transfer; a charge with dependents cannot be reversed', async () => {
    const patient = await createPatient(h, 'Synthetic Responsibility');
    const coverageRef = await recordCoverage(h, patient, { payerRef: 'syn-payer-alpha' });
    const c = await postCharge(h, patient, 10000);
    const url = `/v1/billing/charges/${c.chargeRef}/responsibility`;
    const body = (direction: string, minor: number) => ({
      direction,
      coverageRef,
      amount: usd(minor),
      reasonCode: 'coverage_expected',
    });
    h.ok(await h.call('a1', 'POST', url, body('to_insurer', 4000)), 201);
    expect(await charge(c.chargeRef)).toMatchObject({
      patientResponsibility: usd(6000),
      insurerResponsibility: [{ coverageRef, payerRef: 'syn-payer-alpha', amount: usd(4000) }],
    });
    expect(reason(await h.call('a1', 'POST', url, body('to_insurer', 6001)))).toStrictEqual([
      409,
      'conflict',
      'responsibility_exceeded',
    ]);
    expect(reason(await h.call('a1', 'POST', url, body('to_patient', 4001)))).toStrictEqual([
      409,
      'conflict',
      'responsibility_exceeded',
    ]);
    h.ok(await h.call('svcA1', 'POST', url, body('to_patient', 1000)), 201);
    const bal = await balanceOf(h, patient);
    expect([bal.patientResponsibility, bal.insurerResponsibility, bal.balance]).toStrictEqual([
      usd(7000),
      usd(3000),
      usd(7000),
    ]);
    const blocked = await h.call('a1', 'POST', `/v1/billing/entries/${c.entryRef}/reverse`, {
      reasonCode: 'posted_in_error',
    });
    expect(reason(blocked)).toStrictEqual([409, 'conflict', 'dependent_reversal_required']);
    expect(blocked.json().detail.blockingRefs.length).toBe(2);
  });
});

describe('B2 references, guarantors, privacy and parity', () => {
  it('13. another tenant payment, charge, guarantor or attempt is the same 404 as a missing one', async () => {
    const patient = await createPatient(h, 'Synthetic Tenant Payment');
    const p = await cash(patient, 500);
    const betaPatient = await createPatient(h, 'Synthetic Beta Payer', 'b1');
    const betaCharge = await postCharge(h, betaPatient, 500, {}, 'b1');
    const before = await billingDigest(db);
    const missing = (await h.call('a1', 'GET', `${PAY}/${randomUUID()}`)).json();
    const strip = (b: Record<string, unknown>) => ({ ...b, correlationId: null });
    // An alpha payment allocated to a beta charge: the beta charge is invisible, so 404.
    const cross = await allocate(p, [{ chargeRef: betaCharge.chargeRef, minor: 100 }]);
    expect([cross.statusCode, strip(cross.json())]).toStrictEqual([404, strip(missing)]);
    for (const [method, url, body] of [
      ['GET', `${PAY}/${p}`, undefined],
      ['POST', `${PAY}/${p}/settle`, { settlementRef: 'syn-deposit-x' }],
      [
        'POST',
        `${PAY}/${p}/allocations`,
        { allocations: [{ chargeRef: betaCharge.chargeRef, amount: usd(1) }] },
      ],
      ['POST', `${PAY}/${p}/refunds`, { amount: usd(1), reasonCode: 'overpayment' }],
      ['POST', `${PAY}/${p}/transfers`, { toPatientRef: betaPatient, amount: usd(1), reasonCode: 'x' }],
      ['POST', PAY, { patientRef: patient, amount: usd(1), method: 'cash' }],
    ] as const) {
      const res = await h.call('b1', method, url, body);
      expect([url, res.statusCode, strip(res.json())]).toStrictEqual([url, 404, strip(missing)]);
    }
    const forged = await pay(patient, 100, { guarantorRef: betaPatient });
    expect(forged.statusCode).toBe(404);
    const toBeta = await h.call('a1', 'POST', `${PAY}/${p}/transfers`, {
      toPatientRef: betaPatient,
      amount: usd(1),
      reasonCode: 'family_account',
    });
    expect(toBeta.statusCode).toBe(404);
    expect(await billingDigest(db)).toBe(before);
  });

  it("14. a guarantor must be the patient's recorded guarantor", async () => {
    const patient = await createPatient(h, 'Synthetic Dependent');
    const guarantor = await createPatient(h, 'Synthetic Guarantor');
    const stranger = await createPatient(h, 'Synthetic Stranger');
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${patient}/relationships`, {
        counterpartyRef: guarantor,
        kind: 'guarantor',
        scopes: ['financial'],
      }),
      201,
    );
    expect(reason(await pay(patient, 100, { guarantorRef: stranger }))).toStrictEqual([
      422,
      'validation_failed',
      'guarantor_unresolved',
    ]);
    const p = await cash(patient, 100, { guarantorRef: guarantor });
    expect((await payment(p)).guarantorRef).toBe(guarantor);
  });

  it('15. caller text never reaches storage or logs; every synthetic reference is a closed pattern', async () => {
    const patient = await createPatient(h, 'Synthetic Privacy');
    const p = await cash(patient, 100);
    for (const [url, body] of [
      [PAY, { patientRef: patient, amount: usd(1), method: 'check', externalRef: `syn-${MARKER}` }],
      [PAY, { patientRef: patient, amount: usd(1), method: 'card_synthetic', instrumentRef: MARKER }],
      [`${PAY}/${p}/refunds`, { amount: usd(1), reasonCode: MARKER }],
      [`${PAY}/${p}/refunds`, { amount: usd(1), reasonCode: 'overpayment', refundRef: MARKER }],
      [`${PAY}/${p}/settle`, { settlementRef: MARKER }],
      [`${PAY}/${p}/transfers`, { toPatientRef: patient, amount: usd(1), reasonCode: MARKER }],
      [`${PAY}/${p}/allocations`, { allocations: [{ chargeRef: MARKER, amount: usd(1) }] }],
    ] as const) {
      const res = await h.call('a1', 'POST', url, body);
      expect([url, res.statusCode]).toStrictEqual([url, 400]);
      expect(res.body).not.toContain(MARKER);
    }
    expect(await billingLeakSurface(db)).not.toContain(MARKER);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });

  it('16. MCP gives the same allocation, conflict and worklist outcomes as REST', async () => {
    const patient = await createPatient(h, 'Synthetic Mcp Money');
    const c = await postCharge(h, patient, 1000);
    const rec = await h.mcp(
      'a1',
      'billing_payments_record',
      { patientRef: patient, amount: usd(600), method: 'cash', idempotencyKey: randomUUID() },
      201,
    );
    const p = (rec.body.data as PaymentData).paymentRef as string;
    const over = await h.mcp('a1', 'billing_payments_allocate', {
      paymentRef: p,
      allocations: [{ chargeRef: c.chargeRef, amount: usd(601) }],
      idempotencyKey: randomUUID(),
    });
    expect([over.status, over.code, (over.body.detail as { reason: string }).reason]).toStrictEqual([
      409,
      'conflict',
      'insufficient_funds',
    ]);
    const ok = await h.mcp(
      'a1',
      'billing_payments_allocate',
      {
        paymentRef: p,
        allocations: [{ chargeRef: c.chargeRef, amount: usd(200) }],
        idempotencyKey: randomUUID(),
      },
      201,
    );
    expect(ok.code).toBeNull();
    const wl = await h.mcp('a4', 'billing_worklist_list', { kind: 'unapplied_funds' });
    expect(
      (wl.body.data as { subjectRef: string; amount: unknown }[]).find((i) => i.subjectRef === p)?.amount,
    ).toStrictEqual(usd(400));
    const read = await h.mcp('a4', 'billing_payments_get', { paymentRef: p });
    expect((read.body.data as { unapplied: unknown }).unapplied).toStrictEqual(usd(400));
    const hidden = await h.mcp('b1', 'billing_payments_get', { paymentRef: p });
    expect([hidden.status, hidden.code]).toStrictEqual([404, 'not_found']);
    expect((await h.call(h.a5, 'GET', '/v1/billing/worklist')).statusCode).toBe(403);
  });

  it('17. the database refuses over-spending unapplied credit and editing payment facts under the runtime role', async () => {
    const patient = await createPatient(h, 'Synthetic Payment Constraint');
    const c = await postCharge(h, patient, 5000);
    const p = await cash(patient, 100);
    const tx = createTenantTransactionRunner(db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    const before = await billingDigest(db);
    await expect(
      tx(ctx, async (t) => {
        const { rows } = await t.query<{ id: string }>(
          `INSERT INTO cuspatlas.billing_journal_entries (tenant_id, kind, currency, line_count, charge_id, payment_id,
             posted_by, correlation_id)
           VALUES (cuspatlas.current_tenant_id(), 'allocation', 'USD', 2, $1, $2, cuspatlas.current_actor_id(), $3)
           RETURNING id`,
          [c.chargeRef, p, randomUUID()],
        );
        const e = rows[0]?.id;
        await t.query(
          `INSERT INTO cuspatlas.billing_journal_lines (tenant_id, entry_id, line_no, account, amount_minor, currency,
             patient_id, charge_id, payment_id)
           VALUES (cuspatlas.current_tenant_id(), $1, 1, 'unapplied_credit', 500, 'USD', $2, NULL, $3),
                  (cuspatlas.current_tenant_id(), $1, 2, 'patient_receivable', -500, 'USD', $2, $4, $3)`,
          [e, patient, p, c.chargeRef],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    for (const sql of [
      `UPDATE cuspatlas.billing_payments SET amount_minor = 1 WHERE id = '${p}'`,
      `DELETE FROM cuspatlas.billing_payments WHERE id = '${p}'`,
      `UPDATE cuspatlas.billing_payment_attempts SET outcome = 'confirmed'`,
    ]) {
      await expect(tx(ctx, (t) => t.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
    expect(await billingDigest(db)).toBe(before);
  });
});
