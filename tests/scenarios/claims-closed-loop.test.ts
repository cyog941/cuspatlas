import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, T_ALPHA } from '../integration/support/appointment-fixtures';
import { BILLING_ALL, usd } from '../integration/support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from '../integration/support/db';
import { ctxFor, SVC_A1, USER_A1 } from '../integration/support/fixtures';
import { openRcmHarness, type RcmHarness, today } from '../integration/support/rcm-fixtures';
import { createFakeClearinghouse, RefusalError } from '../integration/support/rcm-scenario';

/**
 * Closed-loop claims scenario (CL-01..CL-12) on synthetic data and the fake clearinghouse only. One
 * claim lineage from a rendered procedure to closure: charge, claim, readiness failing on a missing
 * fact, the fix, dispatch under a standing policy, acknowledgement, payer rejection, linked corrected
 * replacement, payment, remittance with partial pay and patient responsibility, secondary claim,
 * settlements, allocations, statement, patient payment and closure. Every state change is its own
 * fact (a workflow step by reference), and replays, re-ingestion and repeated advances post nothing
 * twice. Nothing here is validated by a billing reviewer or a real payer (B-S2 open).
 */
let db: TestDatabase;
let r: RcmHarness;
const fake = createFakeClearinghouse();
let svc: ReturnType<RcmHarness['service']>;
const scopes = [...BILLING_ALL, 'patients.read', 'patients.write'];
const a1 = () => ctxFor(T_ALPHA, USER_A1, 'human', scopes);
const engine = () => ctxFor(T_ALPHA, SVC_A1, 'service', BILLING_ALL);
const env = (operation: string, payload: unknown, key = randomUUID()) => ({
  operation,
  idempotencyKey: key,
  payload,
});
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof RefusalError
      ? `${err.code}:${(err.detail as { reason?: string } | undefined)?.reason ?? err.reasonCode ?? ''}`
      : `error:${String(err)}`;
  }
};
const count = async (sql: string, params: unknown[] = []) =>
  ((await db.admin.query(sql, params)).rows[0] as { n: number }).n;

beforeAll(async () => {
  db = await openTestDatabase('claims_closed_loop');
  r = await openRcmHarness(db);
  svc = r.service({ claims: fake });
  await r.publishFee('syn-fee-standard', [['SYN-CL-100', 20000]]);
  r.h.ok(
    await r.h.call('a1', 'POST', '/v1/billing/fee-schedules/versions', {
      scheduleRef: 'syn-fee-cl-pri',
      purpose: 'allowance',
      effectiveFrom: '2026-01-01',
      items: [{ codeRef: 'SYN-CL-100', fee: usd(15000) }],
    }),
    201,
  );
});

afterAll(async () => {
  await r?.h.close();
  await db?.close();
});

describe('closed-loop claims journey (synthetic)', () => {
  it('runs from rendered procedure to closure with every state change a separate fact and no double posting', async () => {
    const patient = await createPatient(r.h, 'Synthetic Closed Loop');
    const coverage = async (payerRef: string, rank: string, feeScheduleRef?: string) =>
      r.h.ok<{ data: { coverageRef: string } }>(
        await r.h.call('a1', 'POST', '/v1/rcm/coverages', {
          patientRef: patient,
          payerRef,
          rank,
          relationshipToSubscriber: 'self',
          memberRef: `syn-member-${randomUUID().slice(0, 8)}`,
          effectiveFrom: '2026-01-01',
          ...(feeScheduleRef ? { feeScheduleRef } : {}),
        }),
        201,
      ).data.coverageRef;
    const eligibility = async (coverageRef: string) =>
      r.h.ok(
        await r.h.call('a1', 'POST', `/v1/rcm/coverages/${coverageRef}/eligibility`, {
          source: 'fake_adapter',
          serviceDate: today(),
        }),
        201,
      );
    const primary = await coverage('syn-payer-cl-reject-first', 'primary', 'syn-fee-cl-pri');
    const secondary = await coverage('syn-payer-cl-sec', 'secondary');
    await eligibility(secondary);

    // CL-01 visit preparation: the primary's eligibility is unknown (never implied), with its owner.
    const prep = await svc.prepareVisit(a1(), patient, { serviceDate: today() });
    expect([prep.ready, prep.paymentAssurance, prep.missing]).toStrictEqual([
      false,
      'none',
      [{ code: 'eligibility_unknown', owner: 'front_office', sourceRef: primary }],
    ]);

    // C14 rendered procedure -> B charge (the consumer), then the claim (CL-02).
    const proc = await r.render(await r.encounter(patient), 'SYN-CL-100');
    const chargeRef = r.h.ok<{ data: { chargeRef: string } }>(await r.consume(proc)).data.chargeRef;
    const claimRef = (
      await svc.prepareClaim(
        a1(),
        env('rcm.claims.prepare', { patientRef: patient, coverageRef: primary, procedureRefs: [proc] }),
      )
    ).data.claimRef;
    const policyRef = (
      await svc.createSubmissionPolicy(a1(), env('rcm.submissionPolicies.create', { maxBilled: usd(100000) }))
    ).data.policyRef;
    const workflowPolicyRef = (
      await svc.publishWorkflowPolicy(
        a1(),
        env('rcm.workflowPolicies.publish', {
          acknowledgementDueMinutes: 60,
          followUpMinutes: 43200,
          exceptionDueMinutes: 1440,
          maxEscalations: 2,
          writeOffLimit: usd(0),
        }),
      )
    ).data.policyRef;
    const wf = (
      await svc.startClaimWorkflow(
        a1(),
        env('rcm.workflows.start', { claimRef, workflowPolicyRef, submissionPolicyRef: policyRef }),
      )
    ).data.workflowRef;
    expect(await refusal(svc.startClaimWorkflow(a1(), env('rcm.workflows.start', { claimRef })))).toBe(
      'conflict:workflow_exists',
    );
    const advance = () => svc.advanceClaimWorkflow(engine(), wf);
    const view = () => svc.getClaimWorkflow(a1(), wf);
    const openKeys = async () =>
      (await view()).exceptions.filter((x) => x.state === 'open').map((x) => x.issueKey.split(':')[0]);
    const entries = () =>
      count('SELECT count(*)::int AS n FROM cuspatlas.billing_journal_entries WHERE charge_id = $1', [
        chargeRef,
      ]);

    // CL-03 readiness fails on a missing fact: one owned exception for it, nothing dispatched.
    await advance();
    expect(await openKeys()).toStrictEqual(['eligibility_not_current']);
    expect(
      (await view()).exceptions.find((x) => x.issueKey.startsWith('eligibility_not_current'))?.owner,
    ).toBe('front_office');
    await advance();
    expect(await openKeys()).toStrictEqual(['eligibility_not_current']);
    expect(
      await count('SELECT count(*)::int AS n FROM cuspatlas.rcm_claim_submissions WHERE claim_id = $1', [
        claimRef,
      ]),
    ).toBe(0);

    // The fix: the front office records eligibility. The workflow revalidates, then dispatches under the
    // standing policy (CL-05), and the exception resolves once the underlying issue is gone.
    await eligibility(primary);
    await advance();
    await advance();
    let v = await view();
    expect(v.claims[0]?.state).toBe('transmitted');
    expect(await openKeys()).toStrictEqual([]);
    const dispatch = v.steps.find((s) => s.step === 'dispatch');
    expect(dispatch?.authority).toMatchObject({ kind: 'standing_policy', submissionPolicyRef: policyRef });

    // CL-06/CL-07: acknowledgement then payer rejection; a human prepares the linked corrected replacement.
    await advance();
    v = await view();
    expect(v.claims[0]?.state).toBe('payer_rejected');
    expect(await openKeys()).toStrictEqual(['correct_and_replace']);
    const claimVersion = r.h.ok<{ data: { version: number } }>(
      await r.h.call('a1', 'GET', `/v1/rcm/claims/${claimRef}`),
    ).data.version;
    await svc.replaceClaim(
      a1(),
      claimRef,
      env('rcm.claims.replace', { expectedVersion: claimVersion, reasonCode: 'payer_reported_error' }),
    );
    const afterFirstTransfer = await entries();
    for (let i = 0; i < 3; i += 1) await advance();
    v = await view();
    expect(v.claims[0]?.state).toBe('paid');
    // The replacement's transmission moved nothing again (the amount was already the insurer's).
    expect(await entries()).toBe(afterFirstTransfer);

    // CL-10: remittance with partial pay and patient responsibility, kept off the patient (CL-11).
    let seq = 0;
    const era = (payerRef: string, claim: string, paid: number, contractual: number, pr: number) => {
      seq += 1;
      const ref = `syn-era-cl-${Date.now().toString(36)}-${seq}`;
      fake.stageRemittance({
        remittanceRef: ref,
        payerRef,
        currency: 'USD',
        totalPaidMinor: paid,
        lines: [
          {
            lineNo: 1,
            claimRef: claim,
            claimLineNo: 2 - 1,
            paidMinor: paid,
            contractualMinor: contractual,
            patientResponsibilityMinor: pr,
          },
        ],
      });
      return ref;
    };
    const eraPrimary = era('syn-payer-cl-reject-first', claimRef, 12000, 5000, 3000);
    const rem1 = (
      await svc.ingestRemittance(a1(), env('rcm.remittances.ingest', { remittanceRef: eraPrimary }))
    ).data;
    expect([rem1.outcome, rem1.posted]).toStrictEqual(['ingested', 1]);
    expect(
      (await svc.ingestRemittance(a1(), env('rcm.remittances.ingest', { remittanceRef: eraPrimary }))).data
        .outcome,
    ).toBe('duplicate');
    await advance();
    v = await view();
    expect(v.responsibilities[0]?.patient.minor).toBe(0);

    // Closure is refused while anything is unresolved.
    expect(
      await refusal(
        svc.closeClaimWorkflow(a1(), wf, env('rcm.workflows.close', { expectedVersion: v.version })),
      ),
    ).toBe('conflict:closure_blocked');

    // CL-11 secondary claim prepared, validated, dispatched and paid by the workflow under the policy.
    for (let i = 0; i < 4; i += 1) await advance();
    v = await view();
    expect(v.claims.map((c) => [c.rank, c.state])).toStrictEqual([
      [1, 'paid'],
      [2, 'paid'],
    ]);
    const secondaryClaim = v.claims[1]?.claimRef as string;
    const rem2 = (
      await svc.ingestRemittance(
        a1(),
        env('rcm.remittances.ingest', {
          remittanceRef: era('syn-payer-cl-sec', secondaryClaim, 2000, 0, 1000),
        }),
      )
    ).data;
    expect(rem2.posted).toBe(1);

    // Settlements are separate facts (an ERA is never cash); a replayed settlement posts nothing.
    const settleKey = randomUUID();
    await svc.settleRemittance(
      a1(),
      rem1.remittanceRef,
      env('rcm.remittances.settle', { settlementRef: 'syn-eft-cl-1', amount: usd(12000) }, settleKey),
    );
    const replay = await svc.settleRemittance(
      a1(),
      rem1.remittanceRef,
      env('rcm.remittances.settle', { settlementRef: 'syn-eft-cl-1', amount: usd(12000) }, settleKey),
    );
    expect(replay.replayed).toBe(true);
    await svc.settleRemittance(
      a1(),
      rem2.remittanceRef,
      env('rcm.remittances.settle', { settlementRef: 'syn-eft-cl-2', amount: usd(2000) }),
    );
    await advance();
    expect(await openKeys()).toStrictEqual(['statement_due']);

    // CL-12: statement (B4; delivery is E7), patient payment and allocation (B2), then closure.
    r.h.ok(
      await r.h.call('a1', 'POST', '/v1/billing/statements', {
        guarantorRef: patient,
        cutoffAt: new Date().toISOString(),
        basis: 'posted_through_cutoff',
      }),
      201,
    );
    await advance();
    expect(await openKeys()).toStrictEqual([]);
    const paymentRef = r.h.ok<{ data: { paymentRef: string } }>(
      await r.h.call('a1', 'POST', '/v1/billing/payments', {
        patientRef: patient,
        amount: usd(1000),
        method: 'cash',
      }),
      201,
    ).data.paymentRef;
    r.h.ok(
      await r.h.call('a1', 'POST', `/v1/billing/payments/${paymentRef}/allocations`, {
        allocations: [{ chargeRef, amount: usd(1000) }],
      }),
      201,
    );
    await advance();
    const stepsBefore = (await view()).steps.length;
    const entriesBefore = await count('SELECT count(*)::int AS n FROM cuspatlas.billing_journal_entries');
    // Retries: repeated advances and re-ingestion add no step and post nothing.
    for (let i = 0; i < 3; i += 1) expect((await advance()).data.changes).toBe(0);
    await svc.ingestRemittance(a1(), env('rcm.remittances.ingest', { remittanceRef: eraPrimary }));
    expect((await view()).steps.length).toBe(stepsBefore);
    expect(await count('SELECT count(*)::int AS n FROM cuspatlas.billing_journal_entries')).toBe(
      entriesBefore,
    );

    v = await view();
    const closed = await svc.closeClaimWorkflow(
      a1(),
      wf,
      env('rcm.workflows.close', { expectedVersion: v.version }),
    );
    expect(closed.data.outcome).toBe('closed');
    v = await view();
    expect(v.closure?.breakdown).toStrictEqual([
      {
        chargeRef,
        billed: usd(20000),
        insurerPayment: usd(14000),
        patientPayment: usd(1000),
        contractualAdjustment: usd(5000),
        otherAdjustment: usd(0),
        writeOff: usd(0),
        transfersNet: usd(0),
        unresolved: usd(0),
      },
    ]);
    expect(
      await refusal(
        svc.closeClaimWorkflow(a1(), wf, env('rcm.workflows.close', { expectedVersion: v.version })),
      ),
    ).toBe('conflict:workflow_closed');

    // Every state change is its own linked fact (never a collapsed status field).
    const kinds = v.steps.map((s) => `${s.step}/${s.outcome}`);
    for (const k of [
      'assembly/prepared',
      'readiness/invalid',
      'readiness/valid',
      'dispatch/transmitted',
      'transport_acknowledgement/transport_acknowledged',
      'payer_acknowledgement/payer_acknowledged',
      'payer_rejection/payer_rejected',
      'correction/replacement',
      'adjudication_paid/adjudicated_paid',
      'remittance_line/posted',
      'secondary_claim/prepared',
      'settlement/settled',
      'allocation/insurer_payment',
      'allocation/adjustment',
      'allocation/responsibility_transfer',
      'statement/generated',
      'patient_payment/allocation',
      'closure/closed',
    ])
      expect([k, kinds.includes(k)]).toStrictEqual([k, true]);
    expect(v.steps.filter((s) => s.step === 'dispatch')).toHaveLength(3);
    // Interventions: who acted (humans fixed facts and approved money; the policy drove dispatch).
    const humans = v.steps.filter(
      (s) => s.authority.actorRef === USER_A1 || s.authority.approvedBy === USER_A1,
    ).length;
    const automated = v.steps.filter((s) => s.step === 'automation').length;
    expect(humans).toBeGreaterThan(0);
    expect(automated).toBeGreaterThan(0);
    process.stdout.write(
      `\nCLOSED-LOOP SCENARIO: ${v.steps.length} steps, ${automated} automation steps, ${humans} human-authored facts, ${v.exceptions.length} exceptions (all resolved), journal entries on the charge ${await entries()}\n`,
    );
  });
});
