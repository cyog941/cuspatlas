import { randomUUID } from 'node:crypto';
import { RefusalError } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAuthorize, createFakeClearinghouse } from '@cuspatlas/domain';
import { createWorker } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, T_ALPHA } from './support/appointment-fixtures';
import { BILLING_ALL, usd } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { FakeProvider } from './support/fake-provider';
import { ctxFor, SVC_A1, USER_A1 } from './support/fixtures';
import { openRcmHarness, type RcmHarness, SVC_BILLING_WORKER, today } from './support/rcm-fixtures';

/**
 * Review hardening of B8, the closed-loop workflow and B7 (synthetic data; fake clearinghouse only):
 * a secondary coverage recorded after the primary ERA, unmatched ERA lines that must not leak into
 * unrelated workflows, bounded automation retries driven by durable timers, an unverified write-down
 * routed to review, and concurrent advances that record no spurious refusal.
 */
let db: TestDatabase;
let r: RcmHarness;
const fake = createFakeClearinghouse();
let svc: ReturnType<RcmHarness['service']>;
const scopes = [...BILLING_ALL, 'patients.read', 'patients.write'];
const a1 = () => ctxFor(T_ALPHA, USER_A1, 'human', scopes);
const engine = () => ctxFor(T_ALPHA, SVC_A1, 'service', BILLING_ALL);
const env = (operation: string, payload: unknown) => ({ operation, idempotencyKey: randomUUID(), payload });
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
const PRI = 'syn-payer-hx-pri';
const SEC = 'syn-payer-hx-sec';
const NOALLOW = 'syn-payer-hx-noallow';

async function coverage(
  patient: string,
  payerRef: string,
  rank: string,
  feeScheduleRef?: string,
  withEligibility = true,
) {
  const ref = r.h.ok<{ data: { coverageRef: string } }>(
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
  if (withEligibility)
    r.h.ok(
      await r.h.call('a1', 'POST', `/v1/rcm/coverages/${ref}/eligibility`, {
        source: 'fake_adapter',
        serviceDate: today(),
      }),
      201,
    );
  return ref;
}
async function primaryClaim(given: string, payerRef = PRI, fee: string | null = 'syn-fee-hx-pri') {
  const patient = await createPatient(r.h, given);
  const primary = await coverage(patient, payerRef, 'primary', fee ?? undefined);
  const proc = await r.render(await r.encounter(patient), 'SYN-HX-100');
  const chargeRef = r.h.ok<{ data: { chargeRef: string } }>(await r.consume(proc)).data.chargeRef;
  const claimRef = (
    await svc.prepareClaim(
      a1(),
      env('rcm.claims.prepare', { patientRef: patient, coverageRef: primary, procedureRefs: [proc] }),
    )
  ).data.claimRef;
  return { patient, primary, chargeRef, claimRef };
}
async function submitAndPoll(claimRef: string) {
  await svc.validateClaim(a1(), claimRef, env('rcm.claims.validate', { expectedVersion: 1 }));
  await svc.submitClaim(
    a1(),
    claimRef,
    env('rcm.claims.submit', { expectedVersion: 2, authorization: { mode: 'explicit' } }),
  );
  await svc.pollClaim(a1(), claimRef);
}
let seq = 0;
type EraLine = {
  claimRef: string;
  claimLineNo?: number;
  paid: number;
  contractual: number;
  pr: number;
};
const era = (payerRef: string, lines: EraLine[]) => {
  seq += 1;
  const remittanceRef = `syn-era-hx-${Date.now().toString(36)}-${seq}`;
  fake.stageRemittance({
    remittanceRef,
    payerRef,
    currency: 'USD',
    totalPaidMinor: lines.reduce((s, l) => s + l.paid, 0),
    lines: lines.map((l, i) => ({
      lineNo: i + 1,
      claimRef: l.claimRef,
      claimLineNo: l.claimLineNo ?? 1,
      paidMinor: l.paid,
      contractualMinor: l.contractual,
      patientResponsibilityMinor: l.pr,
    })),
  });
  return remittanceRef;
};
const ingest = async (ref: string) =>
  (await svc.ingestRemittance(a1(), env('rcm.remittances.ingest', { remittanceRef: ref }))).data;
const startWorkflow = async (claimRef: string, submissionPolicyRef?: string) =>
  (
    await svc.startClaimWorkflow(
      a1(),
      env('rcm.workflows.start', { claimRef, ...(submissionPolicyRef ? { submissionPolicyRef } : {}) }),
    )
  ).data.workflowRef;
const submissionPolicy = async () =>
  (await svc.createSubmissionPolicy(a1(), env('rcm.submissionPolicies.create', { maxBilled: usd(100000) })))
    .data.policyRef;
const openKeys = async (wf: string) =>
  (await svc.getClaimWorkflow(a1(), wf)).exceptions.filter((x) => x.state === 'open').map((x) => x.issueKey);
const statement = (patient: string) =>
  r.h.call('a1', 'POST', '/v1/billing/statements', {
    guarantorRef: patient,
    cutoffAt: new Date().toISOString(),
    basis: 'posted_through_cutoff',
  });
const worker = () =>
  createWorker({
    workerPrincipalId: SVC_BILLING_WORKER,
    withTenantTransaction: createTenantTransactionRunner(db.app),
    authorize: createAuthorize(createMembershipSource(db.app)),
    memberships: createMembershipSource(db.app),
    attempts: createSecurityAttemptSink(db.sink),
    backoffSeconds: () => 0,
    claimWorkflows: svc,
  });
const drain = async () => {
  const w = worker();
  const adapter = new FakeProvider();
  for (let i = 0; i < 30; i += 1) if ((await w.runOnce(T_ALPHA, adapter)).length === 0) break;
};
/** Test clock: the append-only timer and outbox rows are moved into the past by the fixture role only. */
async function makeDue(wf: string) {
  const c = await db.admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    await c.query(
      `UPDATE cuspatlas.rcm_claim_workflow_timers SET due_at = now() - interval '1 second'
       WHERE workflow_id = $1 AND kind = 'automation_retry'`,
      [wf],
    );
    await c.query(
      `UPDATE cuspatlas.outbox_events SET next_attempt_at = now() - interval '1 second'
       WHERE aggregate_type = 'rcmWorkflowTimer' AND state IN ('pending', 'retry')
         AND aggregate_id IN (SELECT id FROM cuspatlas.rcm_claim_workflow_timers WHERE workflow_id = $1)`,
      [wf],
    );
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}
const retryTimers = async (wf: string) =>
  (
    await db.admin.query(
      `SELECT level, kind FROM cuspatlas.rcm_claim_workflow_timers WHERE workflow_id = $1 AND kind = 'automation_retry'
       ORDER BY level`,
      [wf],
    )
  ).rows as { level: number; kind: string }[];

beforeAll(async () => {
  db = await openTestDatabase('rcm_review_hardening_b8_cl');
  r = await openRcmHarness(db);
  svc = r.service({ claims: fake });
  await r.publishFee('syn-fee-standard', [['SYN-HX-100', 20000]]);
  r.h.ok(
    await r.h.call('a1', 'POST', '/v1/billing/fee-schedules/versions', {
      scheduleRef: 'syn-fee-hx-pri',
      purpose: 'allowance',
      effectiveFrom: '2026-01-01',
      items: [{ codeRef: 'SYN-HX-100', fee: usd(15000) }],
    }),
    201,
  );
});

afterAll(async () => {
  await r?.h.close();
  await db?.close();
});

describe('1. a secondary coverage recorded after the primary ERA', () => {
  it('raises secondary_claim_due, suppresses statement_due and refuses a statement until it is resolved', async () => {
    const c = await primaryClaim('Synthetic Late Secondary');
    await submitAndPoll(c.claimRef);
    await ingest(era(PRI, [{ claimRef: c.claimRef, paid: 12000, contractual: 5000, pr: 3000 }]));
    const sec = await coverage(c.patient, SEC, 'secondary');
    const wf = await startWorkflow(c.claimRef);
    await svc.advanceClaimWorkflow(engine(), wf);
    const keys = await openKeys(wf);
    expect(keys).toContain(`secondary_claim_due:${sec}`);
    expect(keys.some((k) => k.startsWith('statement_due:'))).toBe(false);
    const blocked = await statement(c.patient);
    expect([blocked.statusCode, blocked.json().detail?.reason]).toStrictEqual([
      409,
      'secondary_claim_pending',
    ]);
    await svc.prepareSecondaryClaim(
      a1(),
      c.claimRef,
      env('rcm.claims.prepareSecondary', { coverageRef: sec }),
    );
    await svc.advanceClaimWorkflow(engine(), wf);
    expect((await openKeys(wf)).some((k) => k.startsWith('secondary_claim_due:'))).toBe(false);
    expect((await statement(c.patient)).statusCode).toBe(201);
  });

  it('the standing policy prepares the late secondary itself', async () => {
    const c = await primaryClaim('Synthetic Late Secondary Auto');
    await submitAndPoll(c.claimRef);
    await ingest(era(PRI, [{ claimRef: c.claimRef, paid: 12000, contractual: 5000, pr: 3000 }]));
    const sec = await coverage(c.patient, SEC, 'secondary');
    const wf = await startWorkflow(c.claimRef, await submissionPolicy());
    await svc.advanceClaimWorkflow(engine(), wf);
    const v = await svc.getClaimWorkflow(a1(), wf);
    expect(v.claims.map((x) => x.rank)).toStrictEqual([1, 2]);
    expect(v.steps.some((s) => s.step === 'automation' && s.outcome === 'secondary_done')).toBe(true);
    expect(v.exceptions.filter((x) => x.issueKey === `secondary_claim_due:${sec}`)).toHaveLength(0);
  });
});

describe('2. unmatched ERA lines do not leak into unrelated workflows', () => {
  it('attaches a line only to the workflows it could match', async () => {
    const a = await primaryClaim('Synthetic Leak A');
    const b = await primaryClaim('Synthetic Leak B');
    await submitAndPoll(a.claimRef);
    await submitAndPoll(b.claimRef);
    const wfA = await startWorkflow(a.claimRef);
    const wfB = await startWorkflow(b.claimRef);
    const rem = await ingest(
      era(PRI, [
        { claimRef: a.claimRef, paid: 15000, contractual: 5000, pr: 0 },
        { claimRef: b.claimRef, paid: 1000, contractual: 0, pr: 0 },
        { claimRef: randomUUID(), paid: 0, contractual: 0, pr: 0 },
      ]),
    );
    expect([rem.posted, rem.review]).toStrictEqual([1, 2]);
    await svc.advanceClaimWorkflow(engine(), wfA);
    await svc.advanceClaimWorkflow(engine(), wfB);
    const reviewKeys = async (wf: string) =>
      (await openKeys(wf)).filter((k) => k.startsWith('remittance_review:')).sort();
    // A is fully paid: neither the mismatch of B's line nor the unmatched line concerns it.
    expect(await reviewKeys(wfA)).toStrictEqual([]);
    expect((await reviewKeys(wfB)).map((k) => k.split(':')[2])).toStrictEqual(['2', '3']);
  });
});

describe('3. automation retries are driven by durable timers and bounded', () => {
  it('a refused dispatch under a standing policy retries by timer and surfaces one exception at the bound', async () => {
    const c = await primaryClaim('Synthetic Retry Stall');
    const sp = await submissionPolicy();
    const wf = await startWorkflow(c.claimRef, sp);
    await svc.advanceClaimWorkflow(engine(), wf);
    await svc.revokeSubmissionPolicy(
      a1(),
      sp,
      env('rcm.submissionPolicies.revoke', { reasonCode: 'practice_request' }),
    );
    for (let i = 0; i < 4; i += 1) {
      await makeDue(wf);
      await drain();
    }
    const v = await svc.getClaimWorkflow(a1(), wf);
    const refused = v.steps.filter((s) => s.step === 'automation' && s.outcome.startsWith('submit_refused'));
    expect(refused.map((s) => s.attempt)).toStrictEqual([1, 2, 3]);
    expect(v.exceptions.filter((x) => x.state === 'open').map((x) => x.issueKey.split(':')[0])).toStrictEqual(
      ['submit_claim'],
    );
    // Bounded: the continuation plus one timer per refusal that may still be retried, none after the bound.
    expect((await retryTimers(wf)).map((t) => t.level)).toStrictEqual([0, 1, 2]);
  });

  it('a stale eligibility surfaces its exception from the timer alone, without another manual advance', async () => {
    const c = await primaryClaim('Synthetic Stale Eligibility');
    const wf = await startWorkflow(c.claimRef, await submissionPolicy());
    await svc.advanceClaimWorkflow(engine(), wf);
    expect(await openKeys(wf)).toStrictEqual([]);
    const k = await db.admin.connect();
    try {
      await k.query('BEGIN');
      await k.query("SET LOCAL session_replication_role = 'replica'");
      await k.query(
        "UPDATE cuspatlas.rcm_eligibility_records SET retrieved_at = retrieved_at - interval '10 days' WHERE coverage_id = $1",
        [c.primary],
      );
      await k.query('COMMIT');
    } finally {
      k.release();
    }
    await makeDue(wf);
    await drain();
    expect((await openKeys(wf)).map((x) => x.split(':')[0])).toStrictEqual(['eligibility_not_current']);
  });
});

describe('4. a write-down with no configured allowance goes to review', () => {
  it('paid 0 with a contractual amount, or a contractual share above the limit, is not posted', async () => {
    const zero = await primaryClaim('Synthetic Writedown Zero', NOALLOW, null);
    await submitAndPoll(zero.claimRef);
    const z = await ingest(era(NOALLOW, [{ claimRef: zero.claimRef, paid: 0, contractual: 20000, pr: 0 }]));
    expect([z.posted, z.review]).toStrictEqual([0, 1]);
    const big = await primaryClaim('Synthetic Writedown Big', NOALLOW, null);
    await submitAndPoll(big.claimRef);
    const b = await ingest(era(NOALLOW, [{ claimRef: big.claimRef, paid: 4000, contractual: 16000, pr: 0 }]));
    expect([b.posted, b.review]).toStrictEqual([0, 1]);
    const ok = await primaryClaim('Synthetic Writedown Normal', NOALLOW, null);
    await submitAndPoll(ok.claimRef);
    const n = await ingest(
      era(NOALLOW, [{ claimRef: ok.claimRef, paid: 12000, contractual: 5000, pr: 3000 }]),
    );
    expect([n.posted, n.review]).toStrictEqual([1, 0]);
    const { rows } = await db.admin.query(
      `SELECT review_reason FROM cuspatlas.rcm_remittance_lines WHERE remittance_id = $1`,
      [z.remittanceRef],
    );
    expect(rows[0].review_reason).toBe('allowance_unknown_write_down');
  });
});

describe('NIT. concurrent advances', () => {
  it('record no refusal step and the same steps as one advance', async () => {
    const c = await primaryClaim('Synthetic Concurrent Advance');
    const wf = await startWorkflow(c.claimRef, await submissionPolicy());
    const results = await Promise.all(
      Array.from({ length: 4 }, () => refusal(svc.advanceClaimWorkflow(engine(), wf))),
    );
    expect(results).toStrictEqual(['ok', 'ok', 'ok', 'ok']);
    const v = await svc.getClaimWorkflow(a1(), wf);
    expect(v.steps.filter((s) => s.outcome.includes('_refused_'))).toStrictEqual([]);
    // One action per advance, serialized: exactly what four sequential advances would have done.
    expect(
      v.steps
        .filter((s) => s.step === 'automation')
        .map((s) => s.outcome)
        .sort(),
    ).toStrictEqual(['poll_done', 'submit_done', 'validate_done']);
  });
});
