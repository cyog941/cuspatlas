import { randomUUID } from 'node:crypto';
import { RefusalError } from '@cuspatlas/contracts';
import { createFakeClearinghouse } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, T_ALPHA } from './support/appointment-fixtures';
import { BILLING_ALL, usd } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, SVC_A1, USER_A1 } from './support/fixtures';
import { openRcmHarness, type RcmHarness, today } from './support/rcm-fixtures';

/**
 * B7 remittance from the fake clearinghouse (synthetic ERA-like structure, not X12; synthetic data
 * only). Idempotent per remittance reference; matched lines post balanced entries; ambiguity,
 * mismatch and underpayment go to review; an ERA is never cash; settlement is a separate fact;
 * corrections reverse.
 */
let db: TestDatabase;
let r: RcmHarness;
const fake = createFakeClearinghouse();
const ctx = () => ctxFor(T_ALPHA, USER_A1, 'human', [...BILLING_ALL, 'patients.read', 'patients.write']);
let svc: ReturnType<RcmHarness['service']>;
const env = (operation: string, payload: unknown) => ({ operation, idempotencyKey: randomUUID(), payload });
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof RefusalError
      ? `${err.code}:${(err.detail as { reason?: string } | undefined)?.reason ?? ''}`
      : String(err);
  }
};
const open = async (chargeRef: string) =>
  r.h.ok<{
    data: {
      patientResponsibility: { minor: number };
      insurerResponsibility: { amount: { minor: number } }[];
    };
  }>(await r.h.call('a1', 'GET', `/v1/billing/charges/${chargeRef}`)).data;

/** A transmitted claim for one 20000 procedure (allowance 15000) through the shared fake. */
async function transmitted(given: string) {
  const patient = await createPatient(r.h, given);
  const coverageRef = r.h.ok<{ data: { coverageRef: string } }>(
    await r.h.call('a1', 'POST', '/v1/rcm/coverages', {
      patientRef: patient,
      payerRef: 'syn-payer-era',
      rank: 'primary',
      relationshipToSubscriber: 'self',
      memberRef: `syn-member-${randomUUID().slice(0, 8)}`,
      effectiveFrom: '2026-01-01',
      feeScheduleRef: 'syn-fee-era-ppo',
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
  const proc = await r.render(await r.encounter(patient), 'SYN-ERA-100');
  const charge = r.h.ok<{ data: { chargeRef: string } }>(await r.consume(proc)).data.chargeRef;
  const claim = await svc.prepareClaim(
    ctx(),
    env('rcm.claims.prepare', { patientRef: patient, coverageRef, procedureRefs: [proc] }),
  );
  const claimRef = claim.data.claimRef;
  await svc.validateClaim(ctx(), claimRef, env('rcm.claims.validate', { expectedVersion: 1 }));
  const sub = await svc.submitClaim(
    ctx(),
    claimRef,
    env('rcm.claims.submit', { expectedVersion: 2, authorization: { mode: 'explicit' } }),
  );
  expect(sub.data.outcome).toBe('transmitted');
  return { claimRef, charge };
}
let eraSeq = 0;
const era = (
  lines: { claimRef: string; paid: number; contractual: number; pr: number; denial?: string }[],
) => {
  eraSeq += 1;
  const remittanceRef = `syn-era-${Date.now().toString(36)}-${eraSeq}`;
  fake.stageRemittance({
    remittanceRef,
    payerRef: 'syn-payer-era',
    currency: 'USD',
    totalPaidMinor: lines.reduce((s, l) => s + l.paid, 0),
    lines: lines.map((l, i) => ({
      lineNo: i + 1,
      claimRef: l.claimRef,
      claimLineNo: 1,
      paidMinor: l.paid,
      contractualMinor: l.contractual,
      patientResponsibilityMinor: l.pr,
      ...(l.denial ? { denialCode: l.denial } : {}),
    })),
  });
  return remittanceRef;
};
const ingest = (remittanceRef: string) =>
  svc.ingestRemittance(ctx(), env('rcm.remittances.ingest', { remittanceRef }));

beforeAll(async () => {
  db = await openTestDatabase('rcm_remittance');
  r = await openRcmHarness(db);
  svc = r.service({ claims: fake });
  await r.publishFee('syn-fee-standard', [['SYN-ERA-100', 20000]]);
  r.h.ok(
    await r.h.call('a1', 'POST', '/v1/billing/fee-schedules/versions', {
      scheduleRef: 'syn-fee-era-ppo',
      purpose: 'allowance',
      effectiveFrom: '2026-01-01',
      items: [{ codeRef: 'SYN-ERA-100', fee: usd(15000) }],
    }),
    201,
  );
});

afterAll(async () => {
  await r?.h.close();
  await db?.close();
});

describe('B7 remittance ingestion and reconciliation', () => {
  it('1. a matched line posts paid to clearing, contractual and patient responsibility; a duplicate changes nothing', async () => {
    const c = await transmitted('Synthetic ERA Matched');
    const ref = era([{ claimRef: c.claimRef, paid: 12000, contractual: 5000, pr: 3000 }]);
    const first = await ingest(ref);
    expect([first.data.outcome, first.data.posted, first.data.review]).toStrictEqual(['ingested', 1, 0]);
    const ch = await open(c.charge);
    expect([
      ch.patientResponsibility.minor,
      ch.insurerResponsibility.reduce((s, x) => s + x.amount.minor, 0),
    ]).toStrictEqual([3000, 0]);
    const again = await ingest(ref);
    expect([again.data.outcome, again.data.remittanceRef]).toStrictEqual([
      'duplicate',
      first.data.remittanceRef,
    ]);
    expect((await open(c.charge)).patientResponsibility.minor).toBe(3000);
    // An ERA is not cash: the paid amount sits in clearing until the deposit is recorded.
    const v = r.h.ok<{ data: { clearing: { minor: number }; settled: { minor: number } } }>(
      await r.h.call('a1', 'GET', `/v1/rcm/remittances/${first.data.remittanceRef}`),
    ).data;
    expect([v.clearing.minor, v.settled.minor]).toStrictEqual([12000, 0]);
    expect(
      await refusal(
        svc.settleRemittance(
          ctx(),
          first.data.remittanceRef,
          env('rcm.remittances.settle', { settlementRef: 'syn-eft-short-1', amount: usd(11000) }),
        ),
      ),
    ).toBe('conflict:settlement_mismatch');
    await svc.settleRemittance(
      ctx(),
      first.data.remittanceRef,
      env('rcm.remittances.settle', { settlementRef: 'syn-eft-ok-1', amount: usd(12000) }),
    );
    const after = r.h.ok<{ data: { clearing: { minor: number }; settled: { minor: number } } }>(
      await r.h.call('a1', 'GET', `/v1/rcm/remittances/${first.data.remittanceRef}`),
    ).data;
    expect([after.clearing.minor, after.settled.minor]).toStrictEqual([0, 12000]);
  });

  it('2. unmatched, mismatched and underpaid lines go to review; a denial is recorded, not posted', async () => {
    const a = await transmitted('Synthetic ERA Under');
    const b = await transmitted('Synthetic ERA Mismatch');
    const d = await transmitted('Synthetic ERA Denied');
    const ref = era([
      { claimRef: randomUUID(), paid: 100, contractual: 0, pr: 0 },
      { claimRef: a.claimRef, paid: 9000, contractual: 9000, pr: 2000 },
      { claimRef: b.claimRef, paid: 1000, contractual: 0, pr: 0 },
      { claimRef: d.claimRef, paid: 0, contractual: 0, pr: 0, denial: 'SYN-DN-045' },
    ]);
    const res = await ingest(ref);
    expect([res.data.posted, res.data.review, res.data.denied]).toStrictEqual([0, 3, 1]);
    const v = r.h.ok<{
      data: { lines: { status: string; reviewReason: string | null; denialCode: string | null }[] };
    }>(await r.h.call('a1', 'GET', `/v1/rcm/remittances/${res.data.remittanceRef}`)).data;
    expect(v.lines.map((l) => [l.status, l.reviewReason ?? l.denialCode])).toStrictEqual([
      ['review', 'unmatched_claim'],
      ['review', 'underpayment'],
      ['review', 'amount_mismatch'],
      ['denied', 'SYN-DN-045'],
    ]);
    for (const c of [a, b, d])
      expect((await open(c.charge)).insurerResponsibility[0]?.amount.minor).toBe(20000);
  });

  it('3. a correction reverses every posting (settlement first); other tenants and roles are refused', async () => {
    const c = await transmitted('Synthetic ERA Reversed');
    const res = await ingest(era([{ claimRef: c.claimRef, paid: 15000, contractual: 5000, pr: 0 }]));
    await svc.settleRemittance(
      ctx(),
      res.data.remittanceRef,
      env('rcm.remittances.settle', { settlementRef: 'syn-eft-rev-1', amount: usd(15000) }),
    );
    const rev = await svc.reverseRemittance(
      ctx(),
      res.data.remittanceRef,
      env('rcm.remittances.reverse', { reasonCode: 'payer_correction' }),
    );
    expect([rev.data.outcome, rev.data.posted]).toStrictEqual(['reversed', 3]);
    expect((await open(c.charge)).insurerResponsibility[0]?.amount.minor).toBe(20000);
    expect(
      await refusal(
        svc.reverseRemittance(
          ctx(),
          res.data.remittanceRef,
          env('rcm.remittances.reverse', { reasonCode: 'again' }),
        ),
      ),
    ).toBe('conflict:already_reversed');
    expect((await r.h.call('b1', 'GET', `/v1/rcm/remittances/${res.data.remittanceRef}`)).statusCode).toBe(
      404,
    );
    expect((await r.h.call('a5', 'GET', `/v1/rcm/remittances/${res.data.remittanceRef}`)).statusCode).toBe(
      403,
    );
    const svcCtx = ctxFor(T_ALPHA, SVC_A1, 'service', BILLING_ALL);
    expect(
      await refusal(
        svc.reverseRemittance(
          svcCtx,
          res.data.remittanceRef,
          env('rcm.remittances.reverse', { reasonCode: 'x_y' }),
        ),
      ),
    ).toBe('forbidden:');
  });
});
