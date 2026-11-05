import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient } from './support/appointment-fixtures';
import { usd } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { USER_A3 } from './support/fixtures';
import { openRcmHarness, type RcmHarness, today } from './support/rcm-fixtures';

/**
 * B6 claims against the fake clearinghouse only (synthetic data only; no X12, no real payer, no
 * CDT; B-S2 open). Claims come only from rendered procedures with posted charges; readiness names
 * the missing fact and its owner; submission needs explicit approval or a live standing policy;
 * transport, payer and adjudication facts stay distinct; unknown is reconciled, never resubmitted.
 */
let db: TestDatabase;
let r: RcmHarness;
type Res = Awaited<ReturnType<RcmHarness['h']['call']>>;
const reason = (res: Res) => [res.statusCode, res.json().code, res.json().detail?.reason];
const C = '/v1/rcm/claims';
type View = {
  state: string;
  version: number;
  headVersionNo: number;
  versions: {
    reason: string;
    validation: { valid: boolean; current: boolean; issues: { code: string; owner: string }[] } | null;
  }[];
  submissions: { outcome: string }[];
  events: { kind: string; code: string | null; codeSource: string | null; codeVersion: string | null }[];
  appeals: { state: string }[];
};
const view = async (claimRef: string, who: 'a1' | 'a4' = 'a1') =>
  r.h.ok<{ data: View }>(await r.h.call(who, 'GET', `${C}/${claimRef}`)).data;
const post = (who: 'a1' | 'a3' | 'svcA1', url: string, body: unknown, key = randomUUID()) =>
  r.h.call(who, 'POST', url, body, key);

async function setup(given: string, payerRef = 'syn-payer-claims', eligibility = true) {
  const patient = await createPatient(r.h, given);
  const coverageRef = r.h.ok<{ data: { coverageRef: string } }>(
    await r.h.call('a1', 'POST', '/v1/rcm/coverages', {
      patientRef: patient,
      payerRef,
      rank: 'primary',
      relationshipToSubscriber: 'self',
      memberRef: `syn-member-${randomUUID().slice(0, 8)}`,
      effectiveFrom: '2026-01-01',
      feeScheduleRef: 'syn-fee-ppo',
    }),
    201,
  ).data.coverageRef;
  if (eligibility) {
    r.h.ok(
      await post('a1', `/v1/rcm/coverages/${coverageRef}/eligibility`, {
        source: 'fake_adapter',
        serviceDate: today(),
      }),
      201,
    );
  }
  const proc = await r.render(await r.encounter(patient), 'SYN-CLM-100');
  const charge = r.h.ok<{ data: { chargeRef: string } }>(await r.consume(proc)).data.chargeRef;
  return { patient, coverageRef, proc, charge };
}
async function prepared(given: string, payerRef?: string) {
  const s = await setup(given, payerRef);
  const claimRef = r.h.ok<{ data: { claimRef: string } }>(
    await post('a1', C, { patientRef: s.patient, coverageRef: s.coverageRef, procedureRefs: [s.proc] }),
    201,
  ).data.claimRef;
  return { ...s, claimRef };
}
const validateC = async (claimRef: string) =>
  r.h.ok<{ data: { outcome: string; issueCount: number } }>(
    await post('a1', `${C}/${claimRef}/validation`, { expectedVersion: (await view(claimRef)).version }),
    201,
  ).data;
const submit = async (
  claimRef: string,
  who: 'a1' | 'svcA1' = 'a1',
  authorization: unknown = { mode: 'explicit' },
  key = randomUUID(),
) =>
  post(
    who,
    `${C}/${claimRef}/submissions`,
    { expectedVersion: (await view(claimRef)).version, authorization },
    key,
  );
const poll = (claimRef: string) => post('a1', `${C}/${claimRef}/poll`, {});

beforeAll(async () => {
  db = await openTestDatabase('rcm_claims');
  r = await openRcmHarness(db);
  await r.publishFee('syn-fee-standard', [
    ['SYN-CLM-100', 20000],
    ['SYN-NOFEE-X', 0],
  ]);
  r.h.ok(
    await r.h.call('a1', 'POST', '/v1/billing/fee-schedules/versions', {
      scheduleRef: 'syn-fee-ppo',
      purpose: 'allowance',
      effectiveFrom: '2026-01-01',
      items: [{ codeRef: 'SYN-CLM-100', fee: usd(15000) }],
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

describe('B6 preparation and readiness', () => {
  it('1. a claim is assembled only from rendered procedures with posted charges', async () => {
    const s = await setup('Synthetic Claim Source');
    expect(
      (
        await post('a1', C, {
          patientRef: s.patient,
          coverageRef: s.coverageRef,
          procedureRefs: [randomUUID()],
        })
      ).statusCode,
    ).toBe(404);
    const unpriced = await r.render(await r.encounter(s.patient), 'SYN-NOFEE-X', 2);
    const missing = await post('a1', C, {
      patientRef: s.patient,
      coverageRef: s.coverageRef,
      procedureRefs: [unpriced],
    });
    expect(reason(missing)).toStrictEqual([409, 'conflict', 'missing_completion_fact']);
    const ok = r.h.ok<{ data: { claimRef: string } }>(
      await post('a1', C, { patientRef: s.patient, coverageRef: s.coverageRef, procedureRefs: [s.proc] }),
      201,
    ).data;
    const v = r.h.ok<{
      data: {
        state: string;
        versions: {
          lines: { chargeRef: string; billed: { minor: number }; allowance: { minor: number } }[];
        }[];
      };
    }>(await r.h.call('a1', 'GET', `${C}/${ok.claimRef}`)).data;
    expect([
      v.state,
      v.versions[0]?.lines[0]?.chargeRef,
      v.versions[0]?.lines[0]?.billed.minor,
      v.versions[0]?.lines[0]?.allowance.minor,
    ]).toStrictEqual(['prepared', s.charge, 20000, 15000]);
  });

  it('2. readiness names the missing fact and owner; a change invalidates the validation', async () => {
    const s = await setup('Synthetic Claim Readiness', 'syn-payer-claims', false);
    const claimRef = r.h.ok<{ data: { claimRef: string } }>(
      await post('a1', C, { patientRef: s.patient, coverageRef: s.coverageRef, procedureRefs: [s.proc] }),
      201,
    ).data.claimRef;
    const first = await validateC(claimRef);
    expect([first.outcome, first.issueCount]).toStrictEqual(['invalid', 1]);
    expect((await view(claimRef)).versions[0]?.validation?.issues).toStrictEqual([
      { code: 'eligibility_not_current', owner: 'front_office', sourceRef: s.coverageRef },
    ]);
    expect(reason(await submit(claimRef))).toStrictEqual([409, 'conflict', 'claim_not_ready']);
    r.h.ok(
      await post('a1', `/v1/rcm/coverages/${s.coverageRef}/eligibility`, {
        source: 'fake_adapter',
        serviceDate: today(),
      }),
      201,
    );
    expect((await validateC(claimRef)).outcome).toBe('valid');
    expect((await view(claimRef)).state).toBe('validated');
    // A new eligibility record of another kind changes no input; a coverage change does.
    r.h.ok(
      await post('a1', `/v1/rcm/coverages/${s.coverageRef}/versions`, {
        expectedVersion: 1,
        rank: 'primary',
        relationshipToSubscriber: 'self',
        memberRef: 'syn-member-changed',
        effectiveFrom: '2026-01-01',
        reasonCode: 'member_corrected',
      }),
      201,
    );
    expect((await view(claimRef)).versions[0]?.validation?.current).toBe(false);
    expect(reason(await submit(claimRef))).toStrictEqual([409, 'conflict', 'validation_stale']);
  });
});

describe('B6 submission under explicit approval or a standing policy', () => {
  it('3. explicit human approval transmits once; the billed amount becomes insurer responsibility', async () => {
    const c = await prepared('Synthetic Claim Explicit');
    await validateC(c.claimRef);
    expect(reason(await submit(c.claimRef, 'svcA1'))).toStrictEqual([403, 'forbidden', undefined]);
    const key = randomUUID();
    const first = r.h.ok<{ data: { outcome: string } }>(
      await submit(c.claimRef, 'a1', { mode: 'explicit' }, key),
      201,
    );
    expect(first.data.outcome).toBe('transmitted');
    const again = await post(
      'a1',
      `${C}/${c.claimRef}/submissions`,
      { expectedVersion: (await view(c.claimRef)).version - 1, authorization: { mode: 'explicit' } },
      key,
    );
    expect(again.json().replayed).toBe(true);
    expect(reason(await submit(c.claimRef))).toStrictEqual([409, 'conflict', 'already_submitted']);
    const ch = r.h.ok<{
      data: {
        patientResponsibility: { minor: number };
        insurerResponsibility: { amount: { minor: number } }[];
      };
    }>(await r.h.call('a1', 'GET', `/v1/billing/charges/${c.charge}`)).data;
    expect([ch.patientResponsibility.minor, ch.insurerResponsibility[0]?.amount.minor]).toStrictEqual([
      0, 20000,
    ]);
    const v = await view(c.claimRef);
    expect([v.state, v.events.map((e) => e.kind)]).toStrictEqual(['transmitted', ['transport_acknowledged']]);
  });

  it('4. a standing policy is rechecked at execution: revoked, payer and limit', async () => {
    const policy = async (body: Record<string, unknown>) =>
      r.h.ok<{ data: { policyRef: string } }>(await post('a1', '/v1/rcm/submission-policies', body), 201).data
        .policyRef;
    const live = await policy({ maxBilled: usd(50000) });
    const small = await policy({ maxBilled: usd(100) });
    const other = await policy({ maxBilled: usd(50000), payerRef: 'syn-payer-somewhere' });
    const revoked = await policy({ maxBilled: usd(50000) });
    r.h.ok(
      await post('a1', `/v1/rcm/submission-policies/${revoked}/revoke`, { reasonCode: 'policy_withdrawn' }),
      201,
    );
    const c = await prepared('Synthetic Claim Policy');
    await validateC(c.claimRef);
    expect(reason(await submit(c.claimRef, 'svcA1', { mode: 'policy', policyRef: revoked }))).toStrictEqual([
      409,
      'conflict',
      'policy_revoked',
    ]);
    expect(reason(await submit(c.claimRef, 'svcA1', { mode: 'policy', policyRef: small }))).toStrictEqual([
      409,
      'conflict',
      'policy_limit_exceeded',
    ]);
    expect(reason(await submit(c.claimRef, 'svcA1', { mode: 'policy', policyRef: other }))).toStrictEqual([
      409,
      'conflict',
      'policy_payer_mismatch',
    ]);
    expect(
      r.h.ok<{ data: { outcome: string } }>(
        await submit(c.claimRef, 'svcA1', { mode: 'policy', policyRef: live }),
        201,
      ).data.outcome,
    ).toBe('transmitted');
    // Creating or revoking a policy is a human-only correction.
    expect((await post('svcA1', '/v1/rcm/submission-policies', { maxBilled: usd(1) })).statusCode).toBe(403);
  });
});

describe('B6 responses, rejection, denial and appeal', () => {
  it('5. a transport rejection is distinct, actionable and corrected by a linked replacement', async () => {
    const c = await prepared('Synthetic Claim Rejected', 'syn-payer-reject-a');
    await validateC(c.claimRef);
    expect(r.h.ok<{ data: { outcome: string } }>(await submit(c.claimRef), 201).data.outcome).toBe(
      'rejected',
    );
    const v = await view(c.claimRef);
    expect([v.state, v.events[0]?.kind, v.events[0]?.code, v.events[0]?.codeSource]).toStrictEqual([
      'transport_rejected',
      'transport_rejected',
      'SYN-RJ-001',
      'syn-clearinghouse-rejections',
    ]);
    const work = r.h.ok<{ data: { data: { kind: string; claimRef: string; owner: string }[] } }>(
      await r.h.call('a1', 'GET', `${C}/worklist`),
    ).data.data;
    expect(work.filter((w) => w.claimRef === c.claimRef).map((w) => [w.kind, w.owner])).toStrictEqual([
      ['correct_and_replace', 'billing'],
    ]);
    const rep = r.h.ok<{ data: { versionNo: number } }>(
      await post('a1', `${C}/${c.claimRef}/replacement`, {
        expectedVersion: v.version,
        reasonCode: 'payer_id_corrected',
      }),
      201,
    ).data;
    expect(rep.versionNo).toBe(2);
    const after = await view(c.claimRef);
    expect([
      after.headVersionNo,
      after.versions.map((x) => x.reason),
      after.submissions.length,
    ]).toStrictEqual([2, ['prepared', 'replacement'], 1]);
  });

  it('6. an unknown submission is reconciled by lookup, never resubmitted', async () => {
    const c = await prepared('Synthetic Claim Unknown', 'syn-payer-transport-timeout-a');
    await validateC(c.claimRef);
    expect(r.h.ok<{ data: { outcome: string } }>(await submit(c.claimRef), 201).data.outcome).toBe('unknown');
    expect((await view(c.claimRef)).state).toBe('submission_unknown');
    expect(reason(await submit(c.claimRef))).toStrictEqual([409, 'conflict', 'already_submitted']);
    r.h.ok(await poll(c.claimRef));
    const v = await view(c.claimRef);
    expect([v.submissions.length, v.submissions[0]?.outcome]).toStrictEqual([1, 'transmitted']);
    const { rows } = await db.admin.query(
      'SELECT resolved_by_lookup FROM cuspatlas.rcm_claim_submissions WHERE claim_id = $1',
      [c.claimRef],
    );
    expect(rows).toStrictEqual([{ resolved_by_lookup: true }]);
  });

  it('7. a denial carries its synthetic code source; the appeal is a reviewed draft', async () => {
    const c = await prepared('Synthetic Claim Denied', 'syn-payer-deny-a');
    await validateC(c.claimRef);
    r.h.ok(await submit(c.claimRef), 201);
    expect(r.h.ok<{ data: { eventCount: number } }>(await poll(c.claimRef)).data.eventCount).toBe(2);
    expect(r.h.ok<{ data: { eventCount: number } }>(await poll(c.claimRef)).data.eventCount).toBe(0);
    const v = await view(c.claimRef);
    const denial = v.events.find((e) => e.kind === 'adjudicated_denied');
    expect([v.state, denial?.code, denial?.codeSource, denial?.codeVersion]).toStrictEqual([
      'denied',
      'SYN-DN-045',
      'syn-denial-codes',
      'v1',
    ]);
    const { rows } = await db.admin.query(
      "SELECT id FROM cuspatlas.rcm_claim_events WHERE claim_id = $1 AND kind = 'adjudicated_denied'",
      [c.claimRef],
    );
    const draft = r.h.ok<{ data: { appealRef: string; state: string } }>(
      await post('a1', `${C}/${c.claimRef}/appeals`, {
        basisCode: 'medical_necessity',
        denialEventRef: rows[0].id,
        attachmentRefs: ['syn-img-xray-1'],
      }),
      201,
    ).data;
    expect(draft.state).toBe('draft');
    expect(
      reason(
        await post('a1', `${C}/${c.claimRef}/appeals`, {
          basisCode: 'medical_necessity',
          denialEventRef: rows[0].id,
        }),
      ),
    ).toStrictEqual([409, 'conflict', 'duplicate_appeal']);
    expect(
      (await post('a1', `/v1/rcm/appeals/${draft.appealRef}/review`, { decision: 'approve_and_send' }))
        .statusCode,
    ).toBe(403);
    const sent = r.h.ok<{ data: { state: string } }>(
      await post('a3', `/v1/rcm/appeals/${draft.appealRef}/review`, { decision: 'approve_and_send' }),
      201,
    ).data;
    expect(sent.state).toBe('sent');
  });

  it('8. a paid adjudication, the follow-up worklist and tenant/role denials', async () => {
    const c = await prepared('Synthetic Claim Paid');
    await validateC(c.claimRef);
    r.h.ok(await submit(c.claimRef), 201);
    const before = r.h.ok<{ data: { data: { kind: string; claimRef: string; dueAt: string }[] } }>(
      await r.h.call('a1', 'GET', `${C}/worklist`),
    ).data.data;
    expect(before.filter((w) => w.claimRef === c.claimRef).map((w) => w.kind)).toStrictEqual(['follow_up']);
    r.h.ok(await poll(c.claimRef));
    expect((await view(c.claimRef)).state).toBe('paid');
    expect((await r.h.call('b1', 'GET', `${C}/${c.claimRef}`)).statusCode).toBe(404);
    expect((await r.h.call('a5', 'GET', `${C}/${c.claimRef}`)).statusCode).toBe(403);
    expect((await view(c.claimRef, 'a4')).state).toBe('paid');
    expect((await r.h.call('a4', 'POST', `${C}/${c.claimRef}/poll`, {})).statusCode).toBe(403);
  });
});
