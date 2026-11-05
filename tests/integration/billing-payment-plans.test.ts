import { randomUUID } from 'node:crypto';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, T_ALPHA } from './support/appointment-fixtures';
import {
  addGuarantor,
  type BillingHarness,
  billingDigest,
  billingLeakSurface,
  openBillingHarness,
  usd,
} from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, USER_A1 } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * B3: payment plans, auto-pay through the synthetic provider port and the plan worklists (synthetic
 * data only; every rule recommended-pending-billing-approval, ADR 0008; card and auto-pay execution
 * blocked-on-discovery, B-S1). REST and MCP under the runtime role.
 */
let db: TestDatabase;
let h: BillingHarness;

const PLANS = '/v1/billing/payment-plans';
const WL = '/v1/billing/payment-plan-worklist';
type View = Record<string, unknown> & {
  version: number;
  installments: { periodNo: number; dueOn: string; amount: unknown; collected: unknown; state: string }[];
  attempts: { planAttemptRef: string; periodNo: number; outcome: string; attemptRef: string | null }[];
  events: { kind: string; authorizationRef: string | null }[];
  terms: { termsVersion: number; contractTotal: unknown }[];
};
type Item = Record<string, unknown> & { planRef: string; kind: string };

const reason = (res: { statusCode: number; json: () => { code?: string; detail?: { reason?: string } } }) => [
  res.statusCode,
  res.json().code,
  res.json().detail?.reason,
];
const view = async (planRef: string, who = 'a1') =>
  h.ok<{ data: View }>(await h.call(who, 'GET', `${PLANS}/${planRef}`)).data;
const worklist = async (kind: string) =>
  h.ok<{ data: Item[]; totalCount: number; truncated: boolean }>(
    await h.call('a1', 'GET', `${WL}?kind=${kind}`),
  );
const itemsFor = async (planRef: string, kind: string) =>
  (await worklist(kind)).data.filter((i) => i.planRef === planRef);

async function createPlan(
  patientRef: string,
  extra: Record<string, unknown> = {},
): Promise<{ planRef: string; version: number }> {
  const r = h.ok<{ data: { planRef: string; termsVersion: number }; version: number }>(
    await h.call('a1', 'POST', PLANS, {
      patientRef,
      contractTotal: usd(1200),
      installmentCount: 3,
      firstDueOn: '2026-08-01',
      timeZone: 'America/New_York',
      ...extra,
    }),
    201,
  );
  expect(r.data.termsVersion).toBe(1);
  return { planRef: r.data.planRef, version: r.version };
}
let authSeq = 0;
const authRef = () => {
  authSeq += 1;
  return `syn-auth-${Date.now().toString(36)}-${authSeq}`;
};
async function authorize(planRef: string): Promise<number> {
  const v = (await view(planRef)).version;
  return h.ok<{ version: number }>(
    await h.call('a1', 'POST', `${PLANS}/${planRef}/authorizations`, {
      expectedVersion: v,
      authorizationRef: authRef(),
      evidenceRef: 'syn-evidence-signed-agreement',
    }),
    201,
  ).version;
}
async function enroll(planRef: string, instrumentRef: string, cardExpiry = '2099-12', auth = authRef()) {
  const v = (await view(planRef)).version;
  return h.call('a1', 'POST', `${PLANS}/${planRef}/autopay`, {
    expectedVersion: v,
    state: 'active',
    instrumentRef,
    cardExpiry,
    authorizationRef: auth,
  });
}
const collect = (planRef: string, body: Record<string, unknown>, key: string = randomUUID(), who = 'a1') =>
  h.call(who, 'POST', `${PLANS}/${planRef}/collections`, body, key);
type Collected = {
  data: { outcome: string; planAttemptRef: string; attemptRef: string | null; paymentRef: string | null };
};
async function readyPlan(given: string, instrument = 'syn-card-ok', expiry = '2099-12') {
  const patient = await createPatient(h, given);
  const { planRef } = await createPlan(patient);
  await authorize(planRef);
  h.ok(await enroll(planRef, instrument, expiry), 201);
  return { patient, planRef };
}

beforeAll(async () => {
  db = await openTestDatabase('billing_payment_plans');
  h = await openBillingHarness(db, { pool: 10, mcp: true });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('B3 plan terms, guarantor and authorization facts', () => {
  it('1. a plan keeps contract total, installments, authorization, auto-pay and card state as distinct fields', async () => {
    const patient = await createPatient(h, 'Synthetic Plan Patient');
    const guarantor = await createPatient(h, 'Synthetic Plan Guarantor');
    await addGuarantor(h, patient, guarantor);
    const { planRef } = await createPlan(patient, { guarantorRef: guarantor, contractTotal: usd(1000) });
    const v = await view(planRef);
    expect(v).toMatchObject({
      planRef,
      patientRef: patient,
      guarantorRef: guarantor,
      guarantorBasis: 'relationship',
      contractTotal: usd(1000),
      installment: usd(334),
      installmentCount: 3,
      collected: usd(0),
      balance: usd(1000),
      authorizationState: 'unsigned',
      autoPayState: 'not_enrolled',
      cardExpiryState: 'absent',
      planState: 'open',
      termsVersion: 1,
      // Every installment date is past: the plan is overdue, the contract total is untouched.
      overdue: usd(1000),
      overdueSince: '2026-08-01',
      nextDueOn: '2026-08-01',
    });
    // Residue to the earliest installment (ADR 0008 M-4).
    expect(v.installments.map((i) => [i.periodNo, i.dueOn, i.amount, i.state])).toStrictEqual([
      [1, '2026-08-01', usd(334), 'overdue'],
      [2, '2026-09-01', usd(333), 'overdue'],
      [3, '2026-10-01', usd(333), 'overdue'],
    ]);
    // Missing signature is a first-class work item; collection is refused without the fact.
    const missing = await itemsFor(planRef, 'missing_signature');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      reasonCode: 'authorization_missing',
      owner: 'practice',
      queue: 'billing',
      suggestedAction: 'obtain_signed_authorization',
      overdue: true,
      guarantorRef: guarantor,
    });
    expect(reason(await collect(planRef, { periodNo: 1 }))).toStrictEqual([
      409,
      'conflict',
      'unsigned_authorization',
    ]);
    expect(
      (
        await h.call('a1', 'POST', `${PLANS}/${planRef}/authorizations`, {
          expectedVersion: v.version,
          authorizationRef: authRef(),
        })
      ).statusCode,
    ).toBe(400);
    await authorize(planRef);
    const after = await view(planRef);
    expect([after.authorizationState, after.events.map((e) => e.kind)]).toStrictEqual([
      'authorized',
      ['authorized'],
    ]);
    expect(await itemsFor(planRef, 'missing_signature')).toStrictEqual([]);
    // Stale expected version is a typed 409.
    expect(
      reason(
        await h.call('a1', 'POST', `${PLANS}/${planRef}/authorizations`, {
          expectedVersion: v.version,
          authorizationRef: authRef(),
          evidenceRef: 'syn-evidence-x',
        }),
      ),
    ).toStrictEqual([409, 'stale_version', undefined]);
    // A self-guaranteed plan names the patient as its own guarantor.
    const self = await createPlan(guarantor);
    expect(await view(self.planRef)).toMatchObject({ guarantorRef: guarantor, guarantorBasis: 'self' });
  });

  it('2. the guarantor must be the current S5 guarantor; time zone, tenant and caller strings are checked', async () => {
    const patient = await createPatient(h, 'Synthetic Plan Checks');
    const stranger = await createPatient(h, 'Synthetic Plan Stranger');
    const base = {
      patientRef: patient,
      contractTotal: usd(500),
      installmentCount: 2,
      firstDueOn: '2026-12-01',
      timeZone: 'America/New_York',
    };
    const before = await billingDigest(db);
    expect(reason(await h.call('a1', 'POST', PLANS, { ...base, guarantorRef: stranger }))).toStrictEqual([
      422,
      'validation_failed',
      'guarantor_unresolved',
    ]);
    expect(
      reason(await h.call('a1', 'POST', PLANS, { ...base, timeZone: 'Mars/Olympus_Mons' })),
    ).toStrictEqual([422, 'validation_failed', 'invalid_time_zone']);
    expect(
      reason(await h.call('a1', 'POST', PLANS, { ...base, contractTotal: { currency: 'EUR', minor: 500 } })),
    ).toStrictEqual([422, 'validation_failed', 'currency_mismatch']);
    const beta = await createPatient(h, 'Synthetic Beta Plan', 'b1');
    const hidden = await h.call('a1', 'POST', PLANS, { ...base, patientRef: beta });
    const missing = await h.call('a1', 'POST', PLANS, { ...base, patientRef: randomUUID() });
    expect(hidden.statusCode).toBe(missing.statusCode);
    expect(hidden.json()).toMatchObject({ code: 'not_found' });
    expect(hidden.json().detail).toStrictEqual(missing.json().detail);
    for (const bad of [
      { ...base, installmentCount: 0 },
      { ...base, installmentCount: 1.5 },
      { ...base, contractTotal: { currency: 'USD', minor: 10.5 } },
      { ...base, timeZone: MARKER },
      { ...base, tenantId: T_ALPHA },
    ]) {
      const r = await h.call('a1', 'POST', PLANS, bad);
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain(MARKER);
    }
    expect(await billingDigest(db)).toBe(before);
    expect((await h.call('a4', 'POST', PLANS, base)).statusCode).toBe(403);
  });
});

describe('B3 auto-pay attempts through the synthetic provider', () => {
  it('3. a successful run posts one payment; a scheduler rerun adds no second attempt; concurrent runs make one', async () => {
    const { patient, planRef } = await readyPlan('Synthetic Plan Success');
    expect(await view(planRef)).toMatchObject({ autoPayState: 'active', cardExpiryState: 'current' });
    const key = `plan-run-${planRef}-1`;
    const first = h.ok<Collected>(await collect(planRef, { periodNo: 1 }, key), 201);
    expect(first.data.outcome).toBe('confirmed');
    const pay = h.ok<{ data: Record<string, unknown> }>(
      await h.call('a1', 'GET', `/v1/billing/payments/${first.data.paymentRef}`),
    ).data;
    expect(pay).toMatchObject({ patientRef: patient, method: 'card_synthetic', amount: usd(400) });
    const replay = h.ok<Collected & { replayed: boolean }>(await collect(planRef, { periodNo: 1 }, key), 201);
    expect([replay.replayed, replay.data.planAttemptRef]).toStrictEqual([true, first.data.planAttemptRef]);
    expect(reason(await collect(planRef, { periodNo: 1 }))).toStrictEqual([
      409,
      'conflict',
      'duplicate_period',
    ]);
    const race = await Promise.all([1, 2, 3].map(() => collect(planRef, { periodNo: 2 })));
    expect(race.map((r) => r.statusCode).sort()).toStrictEqual([201, 409, 409]);
    const v = await view(planRef);
    expect(v.attempts.filter((a) => a.periodNo === 2)).toHaveLength(1);
    expect(v).toMatchObject({
      collected: usd(800),
      balance: usd(400),
      contractTotal: usd(1200),
      nextDueOn: '2026-10-01',
    });
    expect(v.installments.map((i) => i.state)).toStrictEqual(['paid', 'paid', 'overdue']);
    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.billing_payment_attempts WHERE patient_id = $1`,
      [patient],
    );
    expect(rows[0].n).toBe(2);
    h.ok(await collect(planRef, { periodNo: 3 }), 201);
    expect(await view(planRef)).toMatchObject({ planState: 'completed', balance: usd(0), nextDueOn: null });
    expect(reason(await collect(planRef, { periodNo: 3 }))).toStrictEqual([
      409,
      'conflict',
      'plan_completed',
    ]);
  });

  it('4. a declined attempt is one failed-auto-pay item; a retry is explicit and resolves it', async () => {
    const { planRef } = await readyPlan('Synthetic Plan Decline', 'syn-card-decline');
    const declined = h.ok<Collected>(await collect(planRef, { periodNo: 1 }), 201);
    expect([declined.data.outcome, declined.data.paymentRef]).toStrictEqual(['declined', null]);
    expect(await view(planRef)).toMatchObject({ autoPayState: 'failed', collected: usd(0) });
    const items = await itemsFor(planRef, 'failed_autopay');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      reasonCode: 'autopay_declined',
      owner: 'practice',
      queue: 'billing',
      suggestedAction: 'contact_guarantor_or_retry',
      evidenceRefs: [{ kind: 'planAttempt', ref: declined.data.planAttemptRef }],
    });
    expect(typeof items[0]?.dueAt).toBe('string');
    expect(reason(await collect(planRef, { periodNo: 1 }))).toStrictEqual([
      409,
      'conflict',
      'duplicate_period',
    ]);
    // A new instrument needs a new authorization record; then an explicit retry collects.
    h.ok(await enroll(planRef, 'syn-card-replacement'), 201);
    const retried = h.ok<Collected>(await collect(planRef, { periodNo: 1, retry: true }), 201);
    expect(retried.data.outcome).toBe('confirmed');
    expect(await itemsFor(planRef, 'failed_autopay')).toStrictEqual([]);
    const v = await view(planRef);
    expect(v.attempts.map((a) => a.outcome)).toStrictEqual(['declined', 'confirmed']);
    expect(v.autoPayState).toBe('active');
  });

  it('5. an unknown outcome blocks the plan with one reconciliation item and is never retried blindly', async () => {
    const { planRef } = await readyPlan('Synthetic Plan Unknown', 'syn-card-timeout-captured');
    const unknown = h.ok<Collected>(await collect(planRef, { periodNo: 1 }), 201);
    expect([unknown.data.outcome, unknown.data.paymentRef]).toStrictEqual(['unknown', null]);
    const v = await view(planRef);
    expect(v).toMatchObject({ autoPayState: 'blocked', collected: usd(0) });
    for (const r of [
      await collect(planRef, { periodNo: 1, retry: true }),
      await collect(planRef, { periodNo: 2 }),
      await h.call('a1', 'POST', `${PLANS}/${planRef}/close`, {
        expectedVersion: v.version,
        outcome: 'voided',
        reasonCode: 'patient_request',
      }),
      await h.call('a1', 'POST', `${PLANS}/${planRef}/amendments`, {
        expectedVersion: v.version,
        contractTotal: usd(1200),
        installmentCount: 4,
        firstDueOn: '2026-12-01',
        reasonCode: 'hardship',
      }),
    ]) {
      expect(reason(r)).toStrictEqual([409, 'conflict', 'attempt_in_flight']);
    }
    // The one reconciliation item is the B2 unknown-outcome item; the plan worklist adds no second one.
    const recon = h
      .ok<{ data: { subjectRef: string }[] }>(
        await h.call('a1', 'GET', '/v1/billing/worklist?kind=unknown_payment_outcome'),
      )
      .data.filter((i) => i.subjectRef === unknown.data.attemptRef);
    expect(recon).toHaveLength(1);
    expect(await itemsFor(planRef, 'failed_autopay')).toStrictEqual([]);
    const resolved = h.ok<{ data: { outcome: string; paymentRef: string } }>(
      await h.call('a1', 'POST', `/v1/billing/payment-attempts/${unknown.data.attemptRef}/reconcile`, {}),
    );
    expect(resolved.data.outcome).toBe('confirmed');
    const after = await view(planRef);
    expect(after).toMatchObject({ autoPayState: 'active', collected: usd(400) });
    expect(after.installments[0]?.state).toBe('paid');
    expect(after.attempts).toMatchObject([{ outcome: 'confirmed', attemptRef: unknown.data.attemptRef }]);
  });

  it('6. an expired card is a state with its own worklist; the run records a blocked attempt and charges nothing', async () => {
    const { patient, planRef } = await readyPlan('Synthetic Plan Expired', 'syn-card-ok', '2020-01');
    expect(await view(planRef)).toMatchObject({ cardExpiryState: 'expired', planState: 'open' });
    const blocked = h.ok<Collected>(await collect(planRef, { periodNo: 1 }), 201);
    expect([blocked.data.outcome, blocked.data.attemptRef, blocked.data.paymentRef]).toStrictEqual([
      'blocked',
      null,
      null,
    ]);
    const expired = await itemsFor(planRef, 'expired_card');
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      reasonCode: 'card_expired',
      suggestedAction: 'obtain_new_instrument_and_authorization',
      evidenceRefs: [{ kind: 'planAttempt', ref: blocked.data.planAttemptRef }],
    });
    expect(await itemsFor(planRef, 'failed_autopay')).toStrictEqual([]);
    const { rows } = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.billing_payments WHERE patient_id = $1',
      [patient],
    );
    expect(rows[0].n).toBe(0);
    expect(reason(await collect(planRef, { periodNo: 1 }))).toStrictEqual([
      409,
      'conflict',
      'duplicate_period',
    ]);
    // Updating the card needs a new authorization record; reusing one is refused.
    const prior = (await view(planRef)).events.find((e) => e.kind === 'autopay_enrolled')?.authorizationRef;
    expect(reason(await enroll(planRef, 'syn-card-ok', '2099-01', prior as string))).toStrictEqual([
      409,
      'conflict',
      'authorization_reused',
    ]);
    h.ok(await enroll(planRef, 'syn-card-renewed', '2099-01'), 201);
    const v = await view(planRef);
    expect(v.cardExpiryState).toBe('current');
    expect(v.events.filter((e) => e.kind === 'autopay_enrolled')).toHaveLength(2);
    expect(await itemsFor(planRef, 'expired_card')).toStrictEqual([]);
    expect(h.ok<Collected>(await collect(planRef, { periodNo: 1, retry: true }), 201).data.outcome).toBe(
      'confirmed',
    );
  });

  it('7. pausing auto-pay refuses collection; resuming reuses the recorded instrument', async () => {
    const { planRef } = await readyPlan('Synthetic Plan Pause');
    const v = await view(planRef);
    h.ok(
      await h.call('a1', 'POST', `${PLANS}/${planRef}/autopay`, {
        expectedVersion: v.version,
        state: 'paused',
      }),
      201,
    );
    expect((await view(planRef)).autoPayState).toBe('paused');
    expect(reason(await collect(planRef, { periodNo: 1 }))).toStrictEqual([
      409,
      'conflict',
      'autopay_paused',
    ]);
    const p = await view(planRef);
    h.ok(
      await h.call('a1', 'POST', `${PLANS}/${planRef}/autopay`, {
        expectedVersion: p.version,
        state: 'active',
      }),
      201,
    );
    expect((await view(planRef)).autoPayState).toBe('active');
    const bare = await createPatient(h, 'Synthetic Plan No Card');
    const plan = await createPlan(bare);
    await authorize(plan.planRef);
    expect(reason(await collect(plan.planRef, { periodNo: 1 }))).toStrictEqual([
      409,
      'conflict',
      'instrument_absent',
    ]);
    const future = await createPlan(bare, { firstDueOn: '2099-01-01' });
    await authorize(future.planRef);
    h.ok(await enroll(future.planRef, 'syn-card-ok'), 201);
    expect(reason(await collect(future.planRef, { periodNo: 1 }))).toStrictEqual([
      422,
      'validation_failed',
      'period_not_due',
    ]);
    expect(reason(await collect(future.planRef, { periodNo: 9 }))).toStrictEqual([
      422,
      'validation_failed',
      'period_not_found',
    ]);
  });

  it('8. a partially collected installment records partial application, never rounds to paid', async () => {
    const { planRef } = await readyPlan('Synthetic Plan Partial');
    expect(reason(await collect(planRef, { periodNo: 1, amount: usd(401) }))).toStrictEqual([
      422,
      'validation_failed',
      'amount_exceeds_installment',
    ]);
    h.ok(await collect(planRef, { periodNo: 1, amount: usd(150) }), 201);
    let v = await view(planRef);
    expect([v.installments[0]?.state, v.installments[0]?.collected]).toStrictEqual([
      'partially_paid',
      usd(150),
    ]);
    expect(v.overdue).toStrictEqual(usd(1050));
    h.ok(await collect(planRef, { periodNo: 1, retry: true }), 201);
    v = await view(planRef);
    expect([v.installments[0]?.state, v.installments[0]?.collected]).toStrictEqual(['paid', usd(400)]);
  });
});

describe('B3 amendments, void and default', () => {
  it('9. an amendment is a new terms version; history stays readable and the new terms need a new signature', async () => {
    const { planRef } = await readyPlan('Synthetic Plan Amend');
    h.ok(await collect(planRef, { periodNo: 1 }), 201);
    const v = await view(planRef);
    const amend = (body: Record<string, unknown>) =>
      h.call('a1', 'POST', `${PLANS}/${planRef}/amendments`, {
        expectedVersion: v.version,
        installmentCount: 2,
        firstDueOn: '2026-10-15',
        reasonCode: 'hardship',
        ...body,
      });
    expect(reason(await amend({ contractTotal: usd(400) }))).toStrictEqual([
      422,
      'validation_failed',
      'amendment_below_collected',
    ]);
    const ok = h.ok<{ data: { termsVersion: number } }>(await amend({ contractTotal: usd(1100) }), 201);
    expect(ok.data.termsVersion).toBe(2);
    const after = await view(planRef);
    expect(after).toMatchObject({
      termsVersion: 2,
      contractTotal: usd(1100),
      collected: usd(400),
      balance: usd(700),
      authorizationState: 'unsigned',
      installmentCount: 2,
    });
    expect(after.installments.map((i) => [i.periodNo, i.dueOn, i.amount])).toStrictEqual([
      [1, '2026-10-15', usd(350)],
      [2, '2026-11-15', usd(350)],
    ]);
    expect(after.terms.map((t) => [t.termsVersion, t.contractTotal])).toStrictEqual([
      [1, usd(1200)],
      [2, usd(1100)],
    ]);
    expect(after.attempts).toHaveLength(1);
    expect(await itemsFor(planRef, 'missing_signature')).toHaveLength(1);
    expect(reason(await amend({ contractTotal: usd(1000) }))).toStrictEqual([
      409,
      'stale_version',
      undefined,
    ]);
  });

  it('10. void and default are distinct human decisions; history and collected money stay', async () => {
    const { patient, planRef } = await readyPlan('Synthetic Plan Void');
    const paid = h.ok<Collected>(await collect(planRef, { periodNo: 1 }), 201);
    const v = await view(planRef);
    const close = (who: string, outcome: string, version = v.version) =>
      h.call(who, 'POST', `${PLANS}/${planRef}/close`, {
        expectedVersion: version,
        outcome,
        reasonCode: 'patient_request',
      });
    expect((await close('a3', 'voided')).statusCode).toBe(403);
    expect((await close('svcA1', 'voided')).statusCode).toBe(403);
    expect(
      (
        await h.call('a1', 'POST', `${PLANS}/${planRef}/close`, {
          expectedVersion: v.version,
          outcome: 'voided',
        })
      ).statusCode,
    ).toBe(400);
    h.ok(await close('a1', 'voided'), 201);
    const voided = await view(planRef);
    expect(voided).toMatchObject({
      planState: 'voided',
      closedReasonCode: 'patient_request',
      collected: usd(400),
    });
    expect(voided.attempts).toHaveLength(1);
    expect(
      h.ok<{ data: { state: string } }>(
        await h.call('a1', 'GET', `/v1/billing/payments/${paid.data.paymentRef}`),
      ).data.state,
    ).toBe('received');
    expect(reason(await collect(planRef, { periodNo: 2 }))).toStrictEqual([409, 'conflict', 'plan_voided']);
    expect(reason(await close('a1', 'defaulted', voided.version))).toStrictEqual([
      409,
      'conflict',
      'plan_closed',
    ]);
    for (const kind of ['missing_signature', 'expired_card', 'failed_autopay', 'overdue']) {
      expect(await itemsFor(planRef, kind)).toStrictEqual([]);
    }
    const other = await createPlan(patient);
    const ov = await view(other.planRef);
    expect((await itemsFor(other.planRef, 'overdue'))[0]).toMatchObject({
      reasonCode: 'installment_overdue',
      amount: usd(1200),
      suggestedAction: 'contact_guarantor',
      overdue: true,
    });
    h.ok(
      await h.call('a1', 'POST', `${PLANS}/${other.planRef}/close`, {
        expectedVersion: ov.version,
        outcome: 'defaulted',
        reasonCode: 'no_contact',
      }),
      201,
    );
    expect((await view(other.planRef)).planState).toBe('defaulted');
    const audit = await db.admin.query(
      `SELECT operation FROM cuspatlas.audit_events WHERE resource_ref = $1 ORDER BY occurred_at`,
      [other.planRef],
    );
    expect(audit.rows.map((r) => r.operation)).toStrictEqual(['billing.plans.create', 'billing.plans.close']);
  });
});

describe('B3 isolation, parity and storage', () => {
  it('11. another tenant cannot read or act on a plan; the refusal equals a missing plan', async () => {
    const { planRef } = await readyPlan('Synthetic Plan Hidden');
    const missing = randomUUID();
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['POST', '/collections', { periodNo: 1 }],
      [
        'POST',
        '/authorizations',
        { expectedVersion: 1, authorizationRef: 'syn-auth-x', evidenceRef: 'syn-evidence-x' },
      ],
      ['POST', '/close', { expectedVersion: 1, outcome: 'voided', reasonCode: 'x' }],
    ] as const) {
      const hidden = await h.call('b1', method, `${PLANS}/${planRef}${suffix}`, body);
      const absent = await h.call('a1', method, `${PLANS}/${missing}${suffix}`, body);
      expect([suffix, hidden.statusCode, hidden.json().code]).toStrictEqual([suffix, 404, 'not_found']);
      expect(hidden.json().detail).toStrictEqual(absent.json().detail);
    }
    expect((await h.call('b1', 'GET', `${WL}?kind=overdue`)).json().data).toStrictEqual([]);
    expect((await h.call(h.a5, 'GET', `${PLANS}/${planRef}`)).statusCode).toBe(403);
    expect((await h.call(h.a5, 'GET', `${WL}?kind=overdue`)).statusCode).toBe(403);
    expect((await h.call('a4', 'GET', `${PLANS}/${planRef}`)).statusCode).toBe(200);
  });

  it('12. MCP gives the same plan, conflict and worklist outcomes as REST', async () => {
    const { planRef } = await readyPlan('Synthetic Plan Mcp');
    const first = await h.mcp(
      'a1',
      'billing_plans_collect',
      { planRef, periodNo: 1, idempotencyKey: randomUUID() },
      201,
    );
    expect((first.body.data as { outcome: string }).outcome).toBe('confirmed');
    const dup = await h.mcp('a1', 'billing_plans_collect', {
      planRef,
      periodNo: 1,
      idempotencyKey: randomUUID(),
    });
    expect([dup.status, dup.code, (dup.body.detail as { reason: string }).reason]).toStrictEqual([
      409,
      'conflict',
      'duplicate_period',
    ]);
    const read = await h.mcp('a4', 'billing_plans_get', { planRef });
    expect((read.body.data as { collected: unknown }).collected).toStrictEqual(usd(400));
    const wl = await h.mcp('a4', 'billing_plans_worklist', { kind: 'overdue' });
    expect((wl.body.data as Item[]).some((i) => i.planRef === planRef)).toBe(true);
    const hidden = await h.mcp('b1', 'billing_plans_get', { planRef });
    expect([hidden.status, hidden.code]).toStrictEqual([404, 'not_found']);
  });

  it('13. plan facts are append-only under the runtime role and one attempt per period number is unique', async () => {
    const { planRef } = await readyPlan('Synthetic Plan Storage');
    h.ok(await collect(planRef, { periodNo: 1 }), 201);
    const tx = createTenantTransactionRunner(db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    const before = await billingDigest(db);
    for (const sql of [
      `UPDATE cuspatlas.billing_payment_plans SET time_zone = 'UTC' WHERE id = '${planRef}'`,
      `DELETE FROM cuspatlas.billing_payment_plans WHERE id = '${planRef}'`,
      `UPDATE cuspatlas.billing_payment_plan_terms SET installment_count = 9 WHERE plan_id = '${planRef}'`,
      `DELETE FROM cuspatlas.billing_payment_plan_events WHERE plan_id = '${planRef}'`,
      `UPDATE cuspatlas.billing_payment_plan_attempts SET outcome = 'declined' WHERE plan_id = '${planRef}'`,
      `DELETE FROM cuspatlas.billing_payment_plan_attempts WHERE plan_id = '${planRef}'`,
    ]) {
      await expect(tx(ctx, (t) => t.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      tx(ctx, (t) =>
        t.query(
          `INSERT INTO cuspatlas.billing_payment_plan_attempts (tenant_id, plan_id, terms_version, period_no, attempt_no,
             outcome, block_reason, amount_minor, currency, created_by)
           VALUES (cuspatlas.current_tenant_id(), $1, 1, 1, 1, 'blocked', 'card_expired', 400, 'USD', cuspatlas.current_actor_id())`,
          [planRef],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await billingDigest(db)).toBe(before);
    const cols = await db.admin.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'cuspatlas'
         AND table_name LIKE 'billing\\_payment\\_plan%' AND column_name ~ '(balance|overdue|state|status)'`,
    );
    expect(cols.rows).toStrictEqual([]);
  });

  it('14. caller strings are closed patterns and the marker never reaches a log or a row', async () => {
    const { planRef } = await readyPlan('Synthetic Plan Privacy');
    const v = await view(planRef);
    for (const [suffix, body] of [
      [
        '/authorizations',
        { expectedVersion: v.version, authorizationRef: MARKER, evidenceRef: 'syn-evidence-x' },
      ],
      [
        '/authorizations',
        { expectedVersion: v.version, authorizationRef: 'syn-auth-x', evidenceRef: MARKER },
      ],
      [
        '/autopay',
        {
          expectedVersion: v.version,
          state: 'active',
          instrumentRef: MARKER,
          cardExpiry: '2099-12',
          authorizationRef: 'syn-auth-y',
        },
      ],
      [
        '/autopay',
        {
          expectedVersion: v.version,
          state: 'active',
          instrumentRef: 'syn-card-ok',
          cardExpiry: MARKER,
          authorizationRef: 'syn-auth-y',
        },
      ],
      ['/close', { expectedVersion: v.version, outcome: 'voided', reasonCode: MARKER }],
      [
        '/amendments',
        {
          expectedVersion: v.version,
          contractTotal: usd(1),
          installmentCount: 1,
          firstDueOn: '2026-12-01',
          reasonCode: MARKER,
        },
      ],
    ] as const) {
      const r = await h.call('a1', 'POST', `${PLANS}/${planRef}${suffix}`, body);
      expect([suffix, r.statusCode]).toStrictEqual([suffix, 400]);
      expect(r.body).not.toContain(MARKER);
    }
    expect(await billingLeakSurface(db)).not.toContain(MARKER);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });
});
