import { randomUUID } from 'node:crypto';
import { type ActorContext, RefusalError } from '@cuspatlas/contracts';
import { createFakeClearinghouse } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, T_ALPHA } from './support/appointment-fixtures';
import { BILLING_ALL, usd } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, SVC_A1, T_BETA, USER_A1, USER_A3, USER_A4, USER_B1 } from './support/fixtures';
import { openRcmHarness, type RcmHarness, today } from './support/rcm-fixtures';

/**
 * B7 review-line resolution (CL-10; synthetic ERA-like advice from the fake clearinghouse only). A
 * review line is never edited: each resolution is its own fact, every posting a balanced entry tagged
 * with the remittance and linked to the resolution; a residual is adjusted or written off only with a
 * second human's approval, a write-off only under a workflow policy limit; routing to appeal posts the
 * paid amount only and never moves unresolved insurer responsibility to the patient.
 */
let db: TestDatabase;
let r: RcmHarness;
const fake = createFakeClearinghouse();
let svc: ReturnType<RcmHarness['service']>;
const scopes = [...BILLING_ALL, 'patients.read', 'patients.write'];
const a1 = () => ctxFor(T_ALPHA, USER_A1, 'human', scopes);
const a3 = () => ctxFor(T_ALPHA, USER_A3, 'human', scopes);
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
const charge = async (chargeRef: string) =>
  r.h.ok<{
    data: {
      patientResponsibility: { minor: number };
      insurerResponsibility: { amount: { minor: number } }[];
    };
  }>(await r.h.call('a1', 'GET', `/v1/billing/charges/${chargeRef}`)).data;
const insurer = async (chargeRef: string) =>
  (await charge(chargeRef)).insurerResponsibility.reduce((s, x) => s + x.amount.minor, 0);
type RemView = {
  clearing: { minor: number };
  lines: {
    lineNo: number;
    status: string;
    reviewReason: string | null;
    resolution: { action: string; state: string } | null;
  }[];
};
const remView = async (ref: string) =>
  r.h.ok<{ data: RemView }>(await r.h.call('a1', 'GET', `/v1/rcm/remittances/${ref}`)).data;

async function transmitted(given: string) {
  const patient = await createPatient(r.h, given);
  const coverageRef = r.h.ok<{ data: { coverageRef: string } }>(
    await r.h.call('a1', 'POST', '/v1/rcm/coverages', {
      patientRef: patient,
      payerRef: 'syn-payer-res',
      rank: 'primary',
      relationshipToSubscriber: 'self',
      memberRef: `syn-member-${randomUUID().slice(0, 8)}`,
      effectiveFrom: '2026-01-01',
      feeScheduleRef: 'syn-fee-res-ppo',
    }),
    201,
  ).data.coverageRef;
  r.h.ok(
    await r.h.call('a1', 'POST', `/v1/rcm/coverages/${coverageRef}/eligibility`, {
      source: 'fake_adapter',
      serviceDate: today(),
    }),
    201,
  );
  const proc = await r.render(await r.encounter(patient), 'SYN-RES-100');
  const chargeRef = r.h.ok<{ data: { chargeRef: string } }>(await r.consume(proc)).data.chargeRef;
  const claimRef = (
    await svc.prepareClaim(
      a1(),
      env('rcm.claims.prepare', { patientRef: patient, coverageRef, procedureRefs: [proc] }),
    )
  ).data.claimRef;
  await svc.validateClaim(a1(), claimRef, env('rcm.claims.validate', { expectedVersion: 1 }));
  await svc.submitClaim(
    a1(),
    claimRef,
    env('rcm.claims.submit', { expectedVersion: 2, authorization: { mode: 'explicit' } }),
  );
  return { claimRef, chargeRef };
}
let seq = 0;
const era = (lines: { claimRef: string; paid: number; contractual: number; pr: number }[]) => {
  seq += 1;
  const remittanceRef = `syn-era-res-${Date.now().toString(36)}-${seq}`;
  fake.stageRemittance({
    remittanceRef,
    payerRef: 'syn-payer-res',
    currency: 'USD',
    totalPaidMinor: lines.reduce((s, l) => s + l.paid, 0),
    lines: lines.map((l, i) => ({
      lineNo: i + 1,
      claimRef: l.claimRef,
      claimLineNo: 1,
      paidMinor: l.paid,
      contractualMinor: l.contractual,
      patientResponsibilityMinor: l.pr,
    })),
  });
  return remittanceRef;
};
const ingest = async (ref: string) =>
  (await svc.ingestRemittance(a1(), env('rcm.remittances.ingest', { remittanceRef: ref }))).data
    .remittanceRef;
const resolve = (ctx: ActorContext, rem: string, lineNo: number, body: Record<string, unknown>) =>
  svc.resolveRemittanceLine(
    ctx,
    rem,
    String(lineNo),
    env('rcm.remittances.resolveLine', { reasonCode: 'staff_review', ...body }),
  );
const decide = (ctx: ActorContext, resolutionRef: string, decision: 'approved' | 'rejected') =>
  svc.decideRemittanceResolution(ctx, resolutionRef, env('rcm.remittances.decideResolution', { decision }));
const policy = (limit: number) =>
  svc.publishWorkflowPolicy(
    a1(),
    env('rcm.workflowPolicies.publish', {
      payerRef: 'syn-payer-res',
      acknowledgementDueMinutes: 60,
      followUpMinutes: 43200,
      exceptionDueMinutes: 1440,
      maxEscalations: 2,
      writeOffLimit: usd(limit),
    }),
  );

beforeAll(async () => {
  db = await openTestDatabase('rcm_remittance_resolution');
  r = await openRcmHarness(db);
  svc = r.service({ claims: fake });
  await r.publishFee('syn-fee-standard', [['SYN-RES-100', 20000]]);
  r.h.ok(
    await r.h.call('a1', 'POST', '/v1/billing/fee-schedules/versions', {
      scheduleRef: 'syn-fee-res-ppo',
      purpose: 'allowance',
      effectiveFrom: '2026-01-01',
      items: [{ codeRef: 'SYN-RES-100', fee: usd(15000) }],
    }),
    201,
  );
  await db.admin.query(
    "UPDATE cuspatlas.memberships SET scopes = scopes || '{billing.correct}'::text[] WHERE principal_id = $1",
    [USER_A3],
  );
});

afterAll(async () => {
  await r?.h.close();
  await db?.close();
});

describe('B7 review-line resolution', () => {
  it('1. an unmatched line is matched to a transmitted claim line and posts; the line row is never edited', async () => {
    const a = await transmitted('Synthetic Res Matched');
    const b = await transmitted('Synthetic Res Unmatched');
    const rem = await ingest(
      era([
        { claimRef: a.claimRef, paid: 12000, contractual: 5000, pr: 3000 },
        { claimRef: randomUUID(), paid: 12000, contractual: 5000, pr: 3000 },
      ]),
    );
    const lineRows = async () =>
      (
        await db.admin.query(
          'SELECT * FROM cuspatlas.rcm_remittance_lines WHERE remittance_id = $1 ORDER BY line_no',
          [rem],
        )
      ).rows;
    const before = await lineRows();
    expect(await refusal(resolve(a1(), rem, 1, { action: 'match_claim_line' }))).toBe(
      'conflict:line_not_in_review',
    );
    expect(await refusal(resolve(a1(), rem, 2, { action: 'match_claim_line' }))).toBe(
      'validation_failed:claim_required',
    );
    const ok = await resolve(a1(), rem, 2, {
      action: 'match_claim_line',
      claimRef: b.claimRef,
      claimLineNo: 1,
    });
    expect([ok.data.state, ok.data.entryRefs.length]).toStrictEqual(['posted', 3]);
    expect([
      await insurer(b.chargeRef),
      (await charge(b.chargeRef)).patientResponsibility.minor,
    ]).toStrictEqual([0, 3000]);
    expect(
      await refusal(
        resolve(a1(), rem, 2, { action: 'route_to_appeal', claimRef: b.claimRef, claimLineNo: 1 }),
      ),
    ).toBe('conflict:line_already_resolved');
    expect(await lineRows()).toStrictEqual(before);
    const v = await remView(rem);
    expect(v.lines.map((l) => [l.status, l.resolution?.state ?? null])).toStrictEqual([
      ['posted', null],
      ['review', 'posted'],
    ]);
    // With the review line resolved the clearing balance equals the ERA total and settles.
    expect(v.clearing.minor).toBe(24000);
    const settled = await svc.settleRemittance(
      a1(),
      rem,
      env('rcm.remittances.settle', { settlementRef: 'syn-eft-res-1', amount: usd(24000) }),
    );
    expect(settled.data.outcome).toBe('settled');
  });

  it('2. a residual adjustment posts only after another human approves', async () => {
    const c = await transmitted('Synthetic Res Adjust');
    const rem = await ingest(era([{ claimRef: c.claimRef, paid: 10000, contractual: 0, pr: 2000 }]));
    expect((await remView(rem)).lines[0]?.reviewReason).toBe('amount_mismatch');
    const req = await resolve(a1(), rem, 1, { action: 'post_with_adjustment' });
    expect([req.data.state, req.data.entryRefs]).toStrictEqual(['pending_approval', []]);
    expect(await insurer(c.chargeRef)).toBe(20000);
    expect(await refusal(decide(a1(), req.data.resolutionRef, 'approved'))).toBe(
      'self_approval_denied:self_approval_denied',
    );
    const ok = await decide(a3(), req.data.resolutionRef, 'approved');
    expect([ok.data.state, ok.data.entryRefs.length]).toStrictEqual(['posted', 3]);
    expect([
      await insurer(c.chargeRef),
      (await charge(c.chargeRef)).patientResponsibility.minor,
    ]).toStrictEqual([0, 2000]);
    const { rows } = await db.admin.query(
      `SELECT e.kind, e.reason_code FROM cuspatlas.billing_journal_entries e
       JOIN cuspatlas.rcm_remittance_resolution_postings p ON p.entry_id = e.id WHERE p.resolution_id = $1 ORDER BY e.kind`,
      [req.data.resolutionRef],
    );
    expect(rows).toStrictEqual([
      { kind: 'adjustment', reason_code: 'remittance_residual_adjustment' },
      { kind: 'insurerPayment', reason_code: 'remittance_paid' },
      { kind: 'responsibilityTransfer', reason_code: 'remittance_patient_responsibility' },
    ]);
    expect(await refusal(decide(a3(), req.data.resolutionRef, 'approved'))).toBe('conflict:already_decided');
  });

  it('3. a write-off needs a workflow policy limit (rechecked at approval) and another human', async () => {
    const c = await transmitted('Synthetic Res Write Off');
    const rem = await ingest(era([{ claimRef: c.claimRef, paid: 15000, contractual: 0, pr: 0 }]));
    expect(await refusal(resolve(a1(), rem, 1, { action: 'write_off' }))).toBe(
      'conflict:write_off_policy_required',
    );
    expect((await policy(1000)).data.versionNo).toBe(1);
    expect(await refusal(resolve(a1(), rem, 1, { action: 'write_off' }))).toBe(
      'conflict:write_off_limit_exceeded',
    );
    expect((await policy(10000)).data.versionNo).toBe(2);
    const req = await resolve(a1(), rem, 1, { action: 'write_off' });
    expect(req.data.state).toBe('pending_approval');
    await policy(100);
    expect(await refusal(decide(a3(), req.data.resolutionRef, 'approved'))).toBe(
      'conflict:write_off_limit_exceeded',
    );
    expect((await decide(a3(), req.data.resolutionRef, 'rejected')).data.state).toBe('rejected');
    expect(await insurer(c.chargeRef)).toBe(20000);
    await policy(10000);
    const again = await resolve(a1(), rem, 1, { action: 'write_off' });
    const ok = await decide(a3(), again.data.resolutionRef, 'approved');
    expect(ok.data.state).toBe('posted');
    expect([
      await insurer(c.chargeRef),
      (await charge(c.chargeRef)).patientResponsibility.minor,
    ]).toStrictEqual([0, 0]);
    const { rows } = await db.admin.query(
      `SELECT e.kind FROM cuspatlas.billing_journal_entries e
       JOIN cuspatlas.rcm_remittance_resolution_postings p ON p.entry_id = e.id WHERE p.resolution_id = $1 ORDER BY e.kind`,
      [again.data.resolutionRef],
    );
    expect(rows.map((x) => x.kind)).toStrictEqual(['insurerPayment', 'writeOff']);
  });

  it('4. routing an underpayment to appeal posts the paid amount only; the rest stays insurer responsibility', async () => {
    const c = await transmitted('Synthetic Res Appeal');
    const rem = await ingest(era([{ claimRef: c.claimRef, paid: 9000, contractual: 9000, pr: 2000 }]));
    expect((await remView(rem)).lines[0]?.reviewReason).toBe('underpayment');
    const routed = await resolve(a1(), rem, 1, { action: 'route_to_appeal' });
    expect([routed.data.state, routed.data.entryRefs.length]).toStrictEqual(['routed', 1]);
    expect([
      await insurer(c.chargeRef),
      (await charge(c.chargeRef)).patientResponsibility.minor,
    ]).toStrictEqual([11000, 0]);
    // A correction reverses the resolution's postings with the rest of the remittance.
    const rev = await svc.reverseRemittance(
      a1(),
      rem,
      env('rcm.remittances.reverse', { reasonCode: 'payer_correction' }),
    );
    expect(rev.data.posted).toBe(1);
    expect(await insurer(c.chargeRef)).toBe(20000);
  });

  it('5. service principals, read-only roles and other tenants are refused; nothing changes', async () => {
    const c = await transmitted('Synthetic Res Denials');
    const rem = await ingest(era([{ claimRef: c.claimRef, paid: 1000, contractual: 0, pr: 0 }]));
    const before = await insurer(c.chargeRef);
    expect(
      await refusal(
        resolve(ctxFor(T_ALPHA, SVC_A1, 'service', BILLING_ALL), rem, 1, { action: 'route_to_appeal' }),
      ),
    ).toBe('forbidden:principal_kind_denied');
    expect(
      await refusal(
        resolve(ctxFor(T_ALPHA, USER_A4, 'human', BILLING_ALL), rem, 1, { action: 'route_to_appeal' }),
      ),
    ).toBe('forbidden:scope_missing');
    expect(
      await refusal(
        resolve(ctxFor(T_BETA, USER_B1, 'human', BILLING_ALL), rem, 1, { action: 'route_to_appeal' }),
      ),
    ).toBe('not_found:resource_hidden_or_missing');
    const rest = await r.h.call('b1', 'POST', `/v1/rcm/remittances/${rem}/lines/1/resolutions`, {
      action: 'route_to_appeal',
      reasonCode: 'staff_review',
    });
    expect(rest.statusCode).toBe(404);
    expect(await insurer(c.chargeRef)).toBe(before);
  });
});
