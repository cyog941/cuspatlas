import { randomUUID } from 'node:crypto';
import { type ActorContext, RefusalError } from '@cuspatlas/contracts';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { createFakeClearinghouse } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, T_ALPHA } from './support/appointment-fixtures';
import { BILLING_ALL, postCharge, usd } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, SVC_A1, USER_A1, USER_A3 } from './support/fixtures';
import { openRcmHarness, type RcmHarness, today } from './support/rcm-fixtures';

/**
 * Hardening of B6, B7 and B9 after the independent review of 6ee7f65 (synthetic data only; fake
 * clearinghouse only). MUST-FAIL items 1-5 and the SHOULD items, each a test written before its fix.
 */
let db: TestDatabase;
let r: RcmHarness;
const fake = createFakeClearinghouse();
let svc: ReturnType<RcmHarness['service']>;
const scopes = [...BILLING_ALL, 'patients.read', 'patients.write'];
const a1 = () => ctxFor(T_ALPHA, USER_A1, 'human', scopes);
const a3 = () => ctxFor(T_ALPHA, USER_A3, 'human', scopes);
const svcCtx = () => ctxFor(T_ALPHA, SVC_A1, 'service', BILLING_ALL);
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
const count = async (sql: string, params: unknown[] = []) =>
  ((await db.admin.query(sql, params)).rows[0] as { n: number }).n;
type View = {
  state: string;
  version: number;
  events: { eventRef: string; kind: string }[];
  appeals: { appealRef: string; state: string }[];
};
const view = async (claimRef: string) =>
  r.h.ok<{ data: View }>(await r.h.call('a1', 'GET', `/v1/rcm/claims/${claimRef}`)).data;

async function setup(
  given: string,
  payerRef = 'syn-payer-hard',
  eligibility: 'adapter' | 'entered' = 'adapter',
) {
  const patient = await createPatient(r.h, given);
  const coverageRef = r.h.ok<{ data: { coverageRef: string } }>(
    await r.h.call('a1', 'POST', '/v1/rcm/coverages', {
      patientRef: patient,
      payerRef,
      rank: 'primary',
      relationshipToSubscriber: 'self',
      memberRef: `syn-member-${randomUUID().slice(0, 8)}`,
      effectiveFrom: '2026-01-01',
      feeScheduleRef: 'syn-fee-hard-ppo',
    }),
    201,
  ).data.coverageRef;
  r.h.ok(
    await r.h.call(
      'a1',
      'POST',
      `/v1/rcm/coverages/${coverageRef}/eligibility`,
      eligibility === 'adapter'
        ? { source: 'fake_adapter', serviceDate: today() }
        : {
            source: 'entered',
            serviceDate: today(),
            freshnessHours: 48,
            benefits: { activeStatus: 'active', limits: [], frequencies: [] },
          },
    ),
    201,
  );
  const proc = await r.render(await r.encounter(patient), 'SYN-HRD-100');
  const charge = r.h.ok<{ data: { chargeRef: string } }>(await r.consume(proc)).data.chargeRef;
  return { patient, coverageRef, proc, charge };
}
async function prepared(given: string, payerRef?: string) {
  const s = await setup(given, payerRef);
  const claimRef = (
    await svc.prepareClaim(
      a1(),
      env('rcm.claims.prepare', {
        patientRef: s.patient,
        coverageRef: s.coverageRef,
        procedureRefs: [s.proc],
      }),
    )
  ).data.claimRef;
  return { ...s, claimRef };
}
async function submitted(given: string, payerRef?: string, service = svc) {
  const c = await prepared(given, payerRef);
  await svc.validateClaim(a1(), c.claimRef, env('rcm.claims.validate', { expectedVersion: 1 }));
  const sub = service.submitClaim(
    a1(),
    c.claimRef,
    env('rcm.claims.submit', { expectedVersion: 2, authorization: { mode: 'explicit' } }),
  );
  return { ...c, sub };
}
let eraSeq = 0;
const stage = (
  claimRef: string,
  lines: { paid: number; contractual: number; pr: number }[],
  total?: number,
) => {
  eraSeq += 1;
  const remittanceRef = `syn-era-hard-${Date.now().toString(36)}-${eraSeq}`;
  fake.stageRemittance({
    remittanceRef,
    payerRef: 'syn-payer-hard',
    currency: 'USD',
    totalPaidMinor: total ?? lines.reduce((s, l) => s + l.paid, 0),
    lines: lines.map((l, i) => ({
      lineNo: i + 1,
      claimRef: i === 0 ? claimRef : randomUUID(),
      claimLineNo: 1,
      paidMinor: l.paid,
      contractualMinor: l.contractual,
      patientResponsibilityMinor: l.pr,
    })),
  });
  return remittanceRef;
};
const ingest = (remittanceRef: string) =>
  svc.ingestRemittance(a1(), env('rcm.remittances.ingest', { remittanceRef }));

beforeAll(async () => {
  db = await openTestDatabase('rcm_review_hardening');
  r = await openRcmHarness(db);
  svc = r.service({ claims: fake });
  await r.publishFee('syn-fee-standard', [['SYN-HRD-100', 20000]]);
  r.h.ok(
    await r.h.call('a1', 'POST', '/v1/billing/fee-schedules/versions', {
      scheduleRef: 'syn-fee-hard-ppo',
      purpose: 'allowance',
      effectiveFrom: '2026-01-01',
      items: [{ codeRef: 'SYN-HRD-100', fee: usd(15000) }],
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

describe('MUST-FAIL', () => {
  it('1. a replacement follows only a rejection or denial of the latest submission: never after payment, never while unknown', async () => {
    const paid = await submitted('Synthetic Hard Paid');
    expect((await paid.sub).data.outcome).toBe('transmitted');
    await svc.pollClaim(a1(), paid.claimRef);
    const v = await view(paid.claimRef);
    expect(v.state).toBe('paid');
    expect(
      await refusal(
        svc.replaceClaim(
          a1(),
          paid.claimRef,
          env('rcm.claims.replace', { expectedVersion: v.version, reasonCode: 'resubmit' }),
        ),
      ),
    ).toBe('conflict:claim_adjudicated_paid');
    const unknown = await submitted('Synthetic Hard Unknown', 'syn-payer-transport-timeout-h');
    expect((await unknown.sub).data.outcome).toBe('unknown');
    expect(
      await refusal(
        svc.replaceClaim(
          a1(),
          unknown.claimRef,
          env('rcm.claims.replace', {
            expectedVersion: (await view(unknown.claimRef)).version,
            reasonCode: 'x',
          }),
        ),
      ),
    ).toBe('conflict:submission_unresolved');
    expect(
      await count('SELECT count(*)::int AS n FROM cuspatlas.rcm_claim_versions WHERE claim_id = $1', [
        unknown.claimRef,
      ]),
    ).toBe(1);
  });

  it('2. a procedure is on at most one open claim per coverage rank (domain 409, database backstop)', async () => {
    const c = await prepared('Synthetic Hard Twice');
    expect(
      await refusal(
        svc.prepareClaim(
          a1(),
          env('rcm.claims.prepare', {
            patientRef: c.patient,
            coverageRef: c.coverageRef,
            procedureRefs: [c.proc],
          }),
        ),
      ),
    ).toBe('conflict:procedure_on_open_claim');
    expect(
      await count('SELECT count(*)::int AS n FROM cuspatlas.rcm_claims WHERE patient_id = $1', [c.patient]),
    ).toBe(1);
    const run = createTenantTransactionRunner(db.app);
    const err = await run(a1(), async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM cuspatlas.rcm_claim_versions WHERE claim_id = $1',
        [c.claimRef],
      );
      return tx
        .query(
          `INSERT INTO cuspatlas.rcm_claim_procedure_holds (tenant_id, procedure_id, benefit_rank, claim_id, version_id)
           VALUES (cuspatlas.current_tenant_id(), $1, 1, $2, $3)`,
          [c.proc, c.claimRef, rows[0]?.id],
        )
        .then(
          () => 'inserted',
          (e: { code?: string }) => e.code,
        );
    }).catch((e: { code?: string }) => e.code);
    expect(err).toBe('23505');
  });

  it('3. a malformed ERA (negative or fractional amounts) is a typed 422 and posts or stores nothing', async () => {
    const c = await submitted('Synthetic Hard Malformed');
    await c.sub;
    const before = await count('SELECT count(*)::int AS n FROM cuspatlas.billing_journal_entries');
    const negative = stage(c.claimRef, [{ paid: 60, contractual: 60, pr: -20 }]);
    expect(await refusal(ingest(negative))).toBe('validation_failed:malformed_remittance');
    eraSeq += 1;
    const fractional = `syn-era-hard-frac-${eraSeq}`;
    fake.stageRemittance({
      remittanceRef: fractional,
      payerRef: 'syn-payer-hard',
      currency: 'USD',
      totalPaidMinor: 10.5,
      lines: [
        {
          lineNo: 1,
          claimRef: c.claimRef,
          claimLineNo: 1,
          paidMinor: 10.5,
          contractualMinor: 0,
          patientResponsibilityMinor: 0,
        },
      ],
    });
    expect(await refusal(ingest(fractional))).toBe('validation_failed:malformed_remittance');
    expect(await count('SELECT count(*)::int AS n FROM cuspatlas.billing_journal_entries')).toBe(before);
    expect(await count('SELECT count(*)::int AS n FROM cuspatlas.rcm_remittances')).toBe(0);
  });

  it('4. a contractual adjustment names an adjudicated claim, is capped at billed - allowance and needs a second human', async () => {
    const c = await submitted('Synthetic Hard Contractual');
    await c.sub;
    const body = (claimRef: string | undefined, minor: number) => ({
      kind: 'contractual',
      responsibility: 'insurer',
      coverageRef: c.coverageRef,
      ...(claimRef ? { claimRef } : {}),
      amount: usd(minor),
      reasonCode: 'contractual_allowance',
    });
    const post = (ctx: ActorContext, payload: unknown) =>
      svc.postAdjustment(ctx, c.charge, env('billing.adjustments.post', payload));
    expect(await refusal(post(a1(), body(undefined, 100)))).toBe('validation_failed:claim_required');
    expect(await refusal(post(a1(), body(c.claimRef, 100)))).toBe('conflict:claim_not_adjudicated');
    await svc.pollClaim(a1(), c.claimRef);
    expect(await refusal(post(svcCtx(), body(c.claimRef, 100)))).toBe('forbidden:principal_kind_denied');
    expect(await refusal(post(a1(), body(c.claimRef, 5001)))).toBe(
      'validation_failed:contractual_exceeds_allowance_gap',
    );
    const req = await post(a1(), body(c.claimRef, 3000));
    expect([req.data.outcome, req.data.entryRef]).toStrictEqual(['pending_approval', null]);
    // Pending requests count against the gap.
    expect(await refusal(post(a1(), body(c.claimRef, 2001)))).toBe(
      'validation_failed:contractual_exceeds_allowance_gap',
    );
    const decide = (ctx: ActorContext) =>
      svc.decideAdjustment(
        ctx,
        req.data.requestRef as string,
        env('billing.adjustments.decide', { decision: 'approved' }),
      );
    expect(await refusal(decide(a1()))).toBe('self_approval_denied:self_approval_denied');
    const ok = await decide(a3());
    expect(ok.data.outcome).toBe('posted');
    const ch = r.h.ok<{ data: { insurerResponsibility: { amount: { minor: number } }[] } }>(
      await r.h.call('a1', 'GET', `/v1/billing/charges/${c.charge}`),
    ).data;
    expect(ch.insurerResponsibility[0]?.amount.minor).toBe(17000);
  });

  it('5. a location-restricted reader never sees charges without a location in the receivables report', async () => {
    const patient = await createPatient(r.h, 'Synthetic Hard Nolocation');
    await postCharge(r.h, patient, 777);
    const all = r.h.ok<{ data: { rows: { locationRef: string | null }[] } }>(
      await r.h.call('a1', 'GET', '/v1/billing/reports/receivables'),
    ).data;
    expect(all.rows.map((x) => x.locationRef)).toContain(null);
    await db.admin.query(
      "UPDATE cuspatlas.memberships SET location_refs = '{loc-elsewhere}' WHERE principal_id = $1",
      [USER_A3],
    );
    try {
      const mine = r.h.ok<{ data: { rows: { locationRef: string | null }[] } }>(
        await r.h.call('a3', 'GET', '/v1/billing/reports/receivables'),
      ).data;
      expect(mine.rows).toStrictEqual([]);
    } finally {
      await db.admin.query('UPDATE cuspatlas.memberships SET location_refs = NULL WHERE principal_id = $1', [
        USER_A3,
      ]);
    }
  });
});

describe('SHOULD', () => {
  it('settlement equals the ERA total, names review lines as the gap, and is human-only', async () => {
    const c = await submitted('Synthetic Hard Settle');
    await c.sub;
    const ref = stage(c.claimRef, [
      { paid: 12000, contractual: 5000, pr: 3000 },
      { paid: 100, contractual: 0, pr: 0 },
    ]);
    const rem = await ingest(ref);
    expect([rem.data.posted, rem.data.review]).toStrictEqual([1, 1]);
    const settle = (ctx: ActorContext, minor: number) =>
      svc.settleRemittance(
        ctx,
        rem.data.remittanceRef,
        env('rcm.remittances.settle', {
          settlementRef: `syn-eft-hard-${randomUUID().slice(0, 8)}`,
          amount: usd(minor),
        }),
      );
    expect(await refusal(settle(a1(), 12000))).toBe('conflict:settlement_mismatch');
    expect(await refusal(settle(a1(), 12100))).toBe('conflict:settlement_pending_review');
    expect(await refusal(settle(svcCtx(), 12100))).toBe('forbidden:principal_kind_denied');
  });

  it('a submission left pending by a crash is reconciled by lookup after its deadline, with a worklist item', async () => {
    const runner = createTenantTransactionRunner(db.app);
    let calls = 0;
    const crashing = r.service({
      claims: fake,
      providerTimeoutMs: 30,
      providerLeaseMarginMs: 30,
      withTenantTransaction: async (ctx, work) => {
        calls += 1;
        // Call 1 reads the attachment package, call 2 records the pending submission (phase 1), the
        // partner is called, and call 3 (recording the answer) crashes.
        if (calls === 3) throw new Error('synthetic crash after the partner call');
        return runner(ctx, work);
      },
    });
    const c = await submitted('Synthetic Hard Crash', undefined, crashing);
    expect(await refusal(c.sub)).toMatch(/^error:/);
    expect((await view(c.claimRef)).state).toBe('submission_pending');
    const slow = r.service({ claims: fake, providerTimeoutMs: 30_000 });
    // Inside the deadline nothing is looked up (the request may still be in flight).
    const early = r.service({ claims: fake });
    const res = await refusal(early.pollClaim(a1(), c.claimRef));
    expect(['conflict:submission_in_flight', 'ok']).toContain(res);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const work = await slow.listClaimWorklist(a1(), {});
    expect(
      work.data.filter((w) => w.claimRef === c.claimRef).map((w) => [w.kind, w.reasonCode]),
    ).toStrictEqual([['reconcile_submission', 'submission_pending']]);
    await svc.pollClaim(a1(), c.claimRef);
    const { rows } = await db.admin.query(
      'SELECT outcome, resolved_by_lookup FROM cuspatlas.rcm_claim_submissions WHERE claim_id = $1',
      [c.claimRef],
    );
    expect(rows).toStrictEqual([{ outcome: 'transmitted', resolved_by_lookup: true }]);
  });

  it('readiness treats staff-entered (unverified) eligibility as not current', async () => {
    const s = await setup('Synthetic Hard Entered', 'syn-payer-hard', 'entered');
    const claimRef = (
      await svc.prepareClaim(
        a1(),
        env('rcm.claims.prepare', {
          patientRef: s.patient,
          coverageRef: s.coverageRef,
          procedureRefs: [s.proc],
        }),
      )
    ).data.claimRef;
    const v = await svc.validateClaim(a1(), claimRef, env('rcm.claims.validate', { expectedVersion: 1 }));
    expect([v.data.outcome, v.data.issueCount]).toStrictEqual(['invalid', 1]);
  });

  it('the claims worklist is newest first with a truncation flag', async () => {
    const older = await prepared('Synthetic Hard Older');
    const newer = await prepared('Synthetic Hard Newer');
    const w = await svc.listClaimWorklist(a1(), {});
    expect(w.truncated).toBe(false);
    const order = w.data.map((i) => i.claimRef).filter((x) => x === older.claimRef || x === newer.claimRef);
    expect(order).toStrictEqual([newer.claimRef, older.claimRef]);
  });

  it('an appeal approved while its send was unknown is resolved by lookup, then a same-key send; actor columns are bound by RLS', async () => {
    const c = await submitted('Synthetic Hard Appeal', 'syn-payer-deny-h');
    await c.sub;
    await svc.pollClaim(a1(), c.claimRef);
    const denial = (await view(c.claimRef)).events.find((e) => e.kind === 'adjudicated_denied');
    const draft = await svc.draftAppeal(
      a1(),
      c.claimRef,
      env('rcm.appeals.draft', { basisCode: 'medical_necessity', denialEventRef: denial?.eventRef }),
    );
    const silent = r.service({ claims: { ...fake, sendAppeal: async () => null } });
    const reviewed = await silent.reviewAppeal(
      a3(),
      draft.data.appealRef,
      env('rcm.appeals.review', { decision: 'approve_and_send' }),
    );
    expect(reviewed.data.state).toBe('send_unknown');
    await svc.pollClaim(a1(), c.claimRef);
    expect((await view(c.claimRef)).appeals.map((a) => a.state)).toStrictEqual(['sent']);
    const { rows } = await db.admin.query(
      'SELECT resolved_by FROM cuspatlas.rcm_appeal_send_resolutions WHERE appeal_id = $1',
      [draft.data.appealRef],
    );
    expect(rows).toStrictEqual([{ resolved_by: 'resend_same_key' }]);
    // A runtime-role insert cannot name another principal as the drafter.
    const run = createTenantTransactionRunner(db.app);
    const code = await run(a1(), (tx) =>
      tx.query(
        `INSERT INTO cuspatlas.rcm_appeals (tenant_id, claim_id, denial_event_id, basis_code, package_digest, drafted_by)
         VALUES (cuspatlas.current_tenant_id(), $1, $2, 'forged_basis', $3, $4)`,
        [c.claimRef, denial?.eventRef, 'a'.repeat(64), USER_A3],
      ),
    ).then(
      () => 'inserted',
      (e: { code?: string }) => e.code,
    );
    expect(code).toBe('42501');
  });

  it('concurrent ingests of one ERA dedupe; the same reference with different content is a typed conflict', async () => {
    const c = await submitted('Synthetic Hard Concurrent');
    await c.sub;
    const ref = stage(c.claimRef, [{ paid: 15000, contractual: 5000, pr: 0 }]);
    const outcomes = await Promise.all([ingest(ref), ingest(ref)]);
    expect(outcomes.map((o) => o.data.outcome).sort()).toStrictEqual(['duplicate', 'ingested']);
    fake.stageRemittance({
      remittanceRef: ref,
      payerRef: 'syn-payer-hard',
      currency: 'USD',
      totalPaidMinor: 14000,
      lines: [
        {
          lineNo: 1,
          claimRef: c.claimRef,
          claimLineNo: 1,
          paidMinor: 14000,
          contractualMinor: 6000,
          patientResponsibilityMinor: 0,
        },
      ],
    });
    expect(await refusal(ingest(ref))).toBe('conflict:remittance_content_changed');
  });
});
