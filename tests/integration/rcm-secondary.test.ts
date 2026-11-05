import { randomUUID } from 'node:crypto';
import { RefusalError } from '@cuspatlas/contracts';
import { createFakeClearinghouse } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, T_ALPHA } from './support/appointment-fixtures';
import { BILLING_ALL, usd } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, T_BETA, USER_A1, USER_B1 } from './support/fixtures';
import { openRcmHarness, type RcmHarness, today } from './support/rcm-fixtures';

/**
 * B8 secondary claims and coordination of benefits (CL-11) against the fake clearinghouse only
 * (synthetic data; no real COB rules; B-S2 open). A secondary claim needs the primary's paid
 * adjudication and posted remittance, claims only what the primary left as patient responsibility,
 * keeps that amount off the patient while it is unresolved, runs its own full lifecycle, and is
 * flagged (never resubmitted silently) when the primary remittance is reversed. Tertiary is refused.
 */
let db: TestDatabase;
let r: RcmHarness;
const fake = createFakeClearinghouse();
let svc: ReturnType<RcmHarness['service']>;
const scopes = [...BILLING_ALL, 'patients.read', 'patients.write'];
const a1 = () => ctxFor(T_ALPHA, USER_A1, 'human', scopes);
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
type Charge = {
  patientResponsibility: { minor: number };
  insurerResponsibility: { coverageRef: string | null; amount: { minor: number } }[];
};
const charge = async (chargeRef: string) =>
  r.h.ok<{ data: Charge }>(await r.h.call('a1', 'GET', `/v1/billing/charges/${chargeRef}`)).data;
const owed = async (chargeRef: string, coverageRef: string) =>
  (await charge(chargeRef)).insurerResponsibility
    .filter((x) => x.coverageRef === coverageRef)
    .reduce((s, x) => s + x.amount.minor, 0);
const coverage = async (patient: string, payerRef: string, rank: string, feeScheduleRef?: string) => {
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
  r.h.ok(
    await r.h.call('a1', 'POST', `/v1/rcm/coverages/${ref}/eligibility`, {
      source: 'fake_adapter',
      serviceDate: today(),
    }),
    201,
  );
  return ref;
};
let seq = 0;
const era = (payerRef: string, claimRef: string, paid: number, contractual: number, pr: number) => {
  seq += 1;
  const remittanceRef = `syn-era-cob-${Date.now().toString(36)}-${seq}`;
  fake.stageRemittance({
    remittanceRef,
    payerRef,
    currency: 'USD',
    totalPaidMinor: paid,
    lines: [
      {
        lineNo: 1,
        claimRef,
        claimLineNo: 1,
        paidMinor: paid,
        contractualMinor: contractual,
        patientResponsibilityMinor: pr,
      },
    ],
  });
  return remittanceRef;
};
const ingest = async (ref: string) =>
  (await svc.ingestRemittance(a1(), env('rcm.remittances.ingest', { remittanceRef: ref }))).data;
async function submitAndPoll(claimRef: string) {
  const v1 = await svc.validateClaim(a1(), claimRef, env('rcm.claims.validate', { expectedVersion: 1 }));
  expect(v1.data.outcome).toBe('valid');
  const sub = await svc.submitClaim(
    a1(),
    claimRef,
    env('rcm.claims.submit', { expectedVersion: 2, authorization: { mode: 'explicit' } }),
  );
  expect(sub.data.outcome).toBe('transmitted');
  await svc.pollClaim(a1(), claimRef);
}
async function primaryClaim(given: string, secondary: 'now' | 'later' = 'now') {
  const patient = await createPatient(r.h, given);
  const primary = await coverage(patient, 'syn-payer-cob-pri', 'primary', 'syn-fee-cob-pri');
  const sec = secondary === 'now' ? await coverage(patient, 'syn-payer-cob-sec', 'secondary') : null;
  const proc = await r.render(await r.encounter(patient), 'SYN-COB-100');
  const chargeRef = r.h.ok<{ data: { chargeRef: string } }>(await r.consume(proc)).data.chargeRef;
  const claimRef = (
    await svc.prepareClaim(
      a1(),
      env('rcm.claims.prepare', { patientRef: patient, coverageRef: primary, procedureRefs: [proc] }),
    )
  ).data.claimRef;
  return { patient, primary, sec, proc, chargeRef, claimRef };
}
const prepareSecondary = (claimRef: string, coverageRef: string) =>
  svc.prepareSecondaryClaim(a1(), claimRef, env('rcm.claims.prepareSecondary', { coverageRef }));

beforeAll(async () => {
  db = await openTestDatabase('rcm_secondary');
  r = await openRcmHarness(db);
  svc = r.service({ claims: fake });
  await r.publishFee('syn-fee-standard', [['SYN-COB-100', 20000]]);
  r.h.ok(
    await r.h.call('a1', 'POST', '/v1/billing/fee-schedules/versions', {
      scheduleRef: 'syn-fee-cob-pri',
      purpose: 'allowance',
      effectiveFrom: '2026-01-01',
      items: [{ codeRef: 'SYN-COB-100', fee: usd(15000) }],
    }),
    201,
  );
});

afterAll(async () => {
  await r?.h.close();
  await db?.close();
});

describe('B8 secondary claims and coordination of benefits', () => {
  it('1. no secondary before the primary adjudication and remittance; the PR stays off the patient', async () => {
    const c = await primaryClaim('Synthetic Cob Dependency');
    const sec = c.sec as string;
    expect(await refusal(prepareSecondary(c.claimRef, sec))).toBe('conflict:primary_pending');
    await submitAndPoll(c.claimRef);
    expect(await refusal(prepareSecondary(c.claimRef, sec))).toBe('conflict:missing_adjudication');
    const rem = await ingest(era('syn-payer-cob-pri', c.claimRef, 12000, 5000, 3000));
    expect(rem.posted).toBe(1);
    // CL-11: the primary's patient responsibility is the secondary's open responsibility, not the patient's.
    expect([
      (await charge(c.chargeRef)).patientResponsibility.minor,
      await owed(c.chargeRef, sec),
    ]).toStrictEqual([0, 3000]);
    expect(await refusal(prepareSecondary(c.claimRef, c.primary))).toBe(
      'validation_failed:coverage_not_secondary',
    );
  });

  it('2. the secondary claims only what the primary left, runs its own lifecycle and never double-posts', async () => {
    const c = await primaryClaim('Synthetic Cob Lifecycle');
    const sec = c.sec as string;
    await submitAndPoll(c.claimRef);
    await ingest(era('syn-payer-cob-pri', c.claimRef, 12000, 5000, 3000));
    const s = await prepareSecondary(c.claimRef, sec);
    expect(s.data.outcome).toBe('prepared');
    expect(await refusal(prepareSecondary(c.claimRef, sec))).toBe('conflict:secondary_exists');
    const view = r.h.ok<{
      data: {
        rank: number;
        primaryClaimRef: string | null;
        versions: { lines: { billed: { minor: number } }[] }[];
      };
    }>(await r.h.call('a1', 'GET', `/v1/rcm/claims/${s.data.claimRef}`)).data;
    expect([view.rank, view.primaryClaimRef, view.versions[0]?.lines[0]?.billed.minor]).toStrictEqual([
      2,
      c.claimRef,
      3000,
    ]);
    const { rows: ev } = await db.admin.query(
      'SELECT primary_claim_id, jsonb_array_length(cob_evidence) AS n FROM cuspatlas.rcm_secondary_claims WHERE claim_id = $1',
      [s.data.claimRef],
    );
    expect(ev).toStrictEqual([{ primary_claim_id: c.claimRef, n: 1 }]);
    const entries = async () =>
      (
        await db.admin.query(
          'SELECT count(*)::int AS n FROM cuspatlas.billing_journal_entries WHERE charge_id = $1',
          [c.chargeRef],
        )
      ).rows[0].n;
    const before = await entries();
    await submitAndPoll(s.data.claimRef);
    // Transmission of the secondary moves nothing: the amount is already the secondary's.
    expect(await entries()).toBe(before);
    expect([
      (await charge(c.chargeRef)).patientResponsibility.minor,
      await owed(c.chargeRef, sec),
    ]).toStrictEqual([0, 3000]);
    const second = await ingest(era('syn-payer-cob-sec', s.data.claimRef, 2000, 0, 1000));
    expect(second.posted).toBe(1);
    expect([
      (await charge(c.chargeRef)).patientResponsibility.minor,
      await owed(c.chargeRef, sec),
      await owed(c.chargeRef, c.primary),
    ]).toStrictEqual([1000, 0, 0]);
  });

  it('3. a secondary coverage recorded after the primary ERA takes the PR from the patient at preparation', async () => {
    const c = await primaryClaim('Synthetic Cob Later', 'later');
    await submitAndPoll(c.claimRef);
    await ingest(era('syn-payer-cob-pri', c.claimRef, 12000, 5000, 3000));
    expect((await charge(c.chargeRef)).patientResponsibility.minor).toBe(3000);
    const sec = await coverage(c.patient, 'syn-payer-cob-sec', 'secondary');
    await prepareSecondary(c.claimRef, sec);
    expect([
      (await charge(c.chargeRef)).patientResponsibility.minor,
      await owed(c.chargeRef, sec),
    ]).toStrictEqual([0, 3000]);
  });

  it('4. a reversed primary remittance flags the secondary for review instead of resubmitting it', async () => {
    const c = await primaryClaim('Synthetic Cob Reversed');
    await submitAndPoll(c.claimRef);
    const rem = await ingest(era('syn-payer-cob-pri', c.claimRef, 12000, 5000, 3000));
    const s = await prepareSecondary(c.claimRef, c.sec as string);
    expect(
      (await svc.validateClaim(a1(), s.data.claimRef, env('rcm.claims.validate', { expectedVersion: 1 })))
        .data.outcome,
    ).toBe('valid');
    await svc.reverseRemittance(
      a1(),
      rem.remittanceRef,
      env('rcm.remittances.reverse', { reasonCode: 'payer_correction' }),
    );
    const v = r.h.ok<{ data: { versions: { validation: { current: boolean } | null }[] } }>(
      await r.h.call('a1', 'GET', `/v1/rcm/claims/${s.data.claimRef}`),
    ).data;
    expect(v.versions[0]?.validation?.current).toBe(false);
    expect(
      await refusal(
        svc.submitClaim(
          a1(),
          s.data.claimRef,
          env('rcm.claims.submit', { expectedVersion: 2, authorization: { mode: 'explicit' } }),
        ),
      ),
    ).toBe('conflict:validation_stale');
    const again = await svc.validateClaim(
      a1(),
      s.data.claimRef,
      env('rcm.claims.validate', { expectedVersion: 2 }),
    );
    expect(again.data.outcome).toBe('invalid');
    const issues = r.h
      .ok<{ data: { versions: { validation: { issues: { code: string }[] } | null }[] } }>(
        await r.h.call('a1', 'GET', `/v1/rcm/claims/${s.data.claimRef}`),
      )
      .data.versions[0]?.validation?.issues.map((i) => i.code);
    expect(issues).toContain('primary_reversed');
  });

  it('5. tertiary coordination is refused; another tenant cannot name the primary', async () => {
    const c = await primaryClaim('Synthetic Cob Tertiary');
    await submitAndPoll(c.claimRef);
    await ingest(era('syn-payer-cob-pri', c.claimRef, 12000, 5000, 3000));
    const tertiary = await coverage(c.patient, 'syn-payer-cob-ter', 'tertiary');
    expect(await refusal(prepareSecondary(c.claimRef, tertiary))).toBe(
      'validation_failed:tertiary_not_supported',
    );
    expect(
      await refusal(
        svc.prepareSecondaryClaim(
          ctxFor(T_BETA, USER_B1, 'human', BILLING_ALL),
          c.claimRef,
          env('rcm.claims.prepareSecondary', { coverageRef: c.sec }),
        ),
      ),
    ).toBe('not_found:resource_hidden_or_missing');
    const rest = await r.h.call('b1', 'POST', `/v1/rcm/claims/${c.claimRef}/secondary`, {
      coverageRef: c.sec,
    });
    expect(rest.statusCode).toBe(404);
  });
});
