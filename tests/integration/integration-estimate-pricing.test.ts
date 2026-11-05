import { randomUUID } from 'node:crypto';
import { validateEstimateCommandResult } from '@cuspatlas/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppointmentHarness, createPatient } from './support/appointment-fixtures';
import { recordCoverage } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { seedPracticeFees } from './support/fee-fixtures';
import { openRcmHarness } from './support/rcm-fixtures';

/**
 * Integration seam C12 -> B9 fees and B5 coverage (synthetic data only). The server's practice fee is
 * authoritative for each estimate line; B5's coverage status decides inactive and stale eligibility.
 */
let db: TestDatabase;
let h: AppointmentHarness;
const PLANS = '/v1/clinical/treatment-plans';
const USD = (minor: number) => ({ currency: 'USD', minor });
const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

type Estimate = {
  estimateRef: string;
  feeScheduleVersionRef: string | null;
  complete: boolean;
  lines: {
    planItemRef: string;
    feeScheduleRef: string;
    feeScheduleVersionRef: string | null;
    fee: unknown;
  }[];
  itemsWithoutFee: string[];
  coverageStatus: string;
  grossAmount: unknown;
  patientResponsibility: Record<string, unknown>;
  insurerEstimate: unknown;
  notAGuarantee: true;
};

beforeAll(async () => {
  db = await openTestDatabase('integration_estimate_pricing');
  h = (await openRcmHarness(db, { mcp: false })).h;
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

async function plan(name: string, codes: readonly string[]) {
  const patientRef = await createPatient(h, name);
  const created = h.ok<{ data: { plan: { headVersionRef: string } } }>(
    await h.call('a1', 'POST', PLANS, { patientRef, displayText: 'Synthetic plan' }, randomUUID()),
    201,
  ).data.plan;
  const versionRef = created.headVersionRef;
  const detail = h.ok<{ data: { targetRef: string } }>(
    await h.call('a1', 'POST', `${PLANS}/versions/${versionRef}/details`, {
      expectedRevision: 1,
      scope: 'whole_mouth',
    }),
    201,
  ).data.targetRef;
  const items: string[] = [];
  for (const [i, code] of codes.entries()) {
    items.push(
      h.ok<{ data: { targetRef: string } }>(
        await h.call('a1', 'POST', `${PLANS}/details/${detail}/items`, {
          expectedRevision: 2 + i,
          procedureCodeRef: code,
          sequence: i + 1,
          feeScheduleRef: 'syn-fee-practice',
        }),
        201,
      ).data.targetRef,
    );
  }
  return { patientRef, versionRef, items };
}
const generate = (versionRef: string, body: Record<string, unknown>) =>
  h.call('a1', 'POST', `${PLANS}/versions/${versionRef}/estimates`, body, randomUUID());
const okE = (res: Awaited<ReturnType<AppointmentHarness['call']>>) => {
  const json = h.ok<{ data: Estimate }>(res, 201);
  expect(validateEstimateCommandResult(json)).toBe(true);
  return json.data;
};
const reason = (res: Awaited<ReturnType<AppointmentHarness['call']>>) => [
  res.statusCode,
  res.json().detail?.reason ?? res.json().code,
];

describe('C12 -> B9/B5 estimate pricing seam', () => {
  it('prices every line from the B9 practice schedule and records its version', async () => {
    const fees = await seedPracticeFees(db, [
      ['SYN-EP-100', 12_000],
      ['SYN-EP-101', 3_000],
    ]);
    const p = await plan('Synthetic Pricing Server', ['SYN-EP-100', 'SYN-EP-101']);
    const e = okE(await generate(p.versionRef, { lines: p.items.map((planItemRef) => ({ planItemRef })) }));
    expect(e.complete).toBe(true);
    expect(e.grossAmount).toEqual(USD(15_000));
    expect(e.feeScheduleVersionRef).toBe(fees.versionRef);
    expect(e.lines.map((l) => [l.fee, l.feeScheduleRef, l.feeScheduleVersionRef])).toEqual([
      [USD(12_000), 'syn-fee-practice', fees.versionRef],
      [USD(3_000), 'syn-fee-practice', fees.versionRef],
    ]);
    expect(e.notAGuarantee).toBe(true);
    // A supplied fee equal to the server's is accepted as a check.
    okE(await generate(p.versionRef, { lines: [{ planItemRef: p.items[0], fee: USD(12_000) }] }));
  });

  it('refuses a supplied fee that differs from the server fee (409), writing nothing', async () => {
    await seedPracticeFees(db, [['SYN-EP-200', 8_000]]);
    const p = await plan('Synthetic Pricing Mismatch', ['SYN-EP-200']);
    expect(
      reason(await generate(p.versionRef, { lines: [{ planItemRef: p.items[0], fee: USD(7_999) }] })),
    ).toEqual([409, 'fee_mismatch']);
    expect(
      reason(
        await generate(p.versionRef, {
          lines: [{ planItemRef: p.items[0], fee: { currency: 'EUR', minor: 8_000 } }],
        }),
      ),
    ).toEqual([409, 'fee_mismatch']);
    const { rows } = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.clinical_estimates WHERE plan_version_id = $1',
      [p.versionRef],
    );
    expect(rows[0].n).toBe(0);
  });

  it('leaves an item without a configured fee unpriced and the estimate incomplete (no guessed amount)', async () => {
    await seedPracticeFees(db, [['SYN-EP-300', 5_000]]);
    const p = await plan('Synthetic Pricing Missing', ['SYN-EP-300', 'SYN-EP-NOFEE']);
    const e = okE(await generate(p.versionRef, { lines: p.items.map((planItemRef) => ({ planItemRef })) }));
    expect(e.complete).toBe(false);
    expect(e.grossAmount).toBeNull();
    expect(e.lines.map((l) => l.planItemRef)).toEqual([p.items[0]]);
    expect(e.itemsWithoutFee).toEqual([p.items[1]]);
    expect(e.patientResponsibility).toEqual({ kind: 'not_available', label: 'estimate_incomplete' });
    // A supplied fee for an item B9 does not price is refused, not used.
    expect(
      reason(await generate(p.versionRef, { lines: [{ planItemRef: p.items[1], fee: USD(1) }] })),
    ).toEqual([409, 'fee_mismatch']);
  });

  it('a new fee schedule version reprices a new estimate and shows the new version; the old one keeps its own', async () => {
    const v1 = await seedPracticeFees(db, [['SYN-EP-400', 10_000]]);
    const p = await plan('Synthetic Pricing Version', ['SYN-EP-400']);
    const e1 = okE(await generate(p.versionRef, { lines: [{ planItemRef: p.items[0] }] }));
    const v2 = await seedPracticeFees(db, [['SYN-EP-400', 11_000]]);
    const e2 = okE(await generate(p.versionRef, { lines: [{ planItemRef: p.items[0] }] }));
    expect([e1.feeScheduleVersionRef, e1.grossAmount]).toEqual([v1.versionRef, USD(10_000)]);
    expect([e2.feeScheduleVersionRef, e2.grossAmount]).toEqual([v2.versionRef, USD(11_000)]);
    const old = h.ok<{ data: Estimate }>(
      await h.call('a1', 'GET', `/v1/clinical/estimates/${e1.estimateRef}`),
    );
    expect([old.data.feeScheduleVersionRef, old.data.grossAmount]).toEqual([v1.versionRef, USD(10_000)]);
    // A caller pinning the earlier version is refused rather than silently repriced.
    expect(
      reason(
        await generate(p.versionRef, {
          lines: [{ planItemRef: p.items[0] }],
          feeScheduleVersionRef: v1.versionRef,
        }),
      ),
    ).toEqual([409, 'fee_schedule_version_mismatch']);
  });

  it('B5 inactive coverage applies no insurer portion: the range is the gross alone', async () => {
    await seedPracticeFees(db, [['SYN-EP-500', 9_000]]);
    const p = await plan('Synthetic Pricing Inactive', ['SYN-EP-500']);
    const cov = await recordCoverage(h, p.patientRef, { payerRef: 'syn-payer-inactive-ep' });
    h.ok(
      await h.call('a1', 'POST', `/v1/rcm/coverages/${cov}/eligibility`, {
        source: 'fake_adapter',
        serviceDate: today(),
      }),
      201,
    );
    const e = okE(await generate(p.versionRef, { lines: [{ planItemRef: p.items[0] }] }));
    expect(e.coverageStatus).toBe('inactive');
    expect(e.patientResponsibility).toEqual({
      kind: 'range',
      low: USD(9_000),
      high: USD(9_000),
      basis: 'coverage_inactive',
    });
    expect(e.notAGuarantee).toBe(true);
    const read = h.ok<{ data: Estimate }>(
      await h.call('a1', 'GET', `/v1/clinical/estimates/${e.estimateRef}`),
    );
    expect(read.data.coverageStatus).toBe('inactive');
  });

  it('B5 stale eligibility reads stale, even with a fresh entered source', async () => {
    await seedPracticeFees(db, [['SYN-EP-600', 4_000]]);
    const p = await plan('Synthetic Pricing Stale', ['SYN-EP-600']);
    const cov = await recordCoverage(h, p.patientRef);
    h.ok(
      await h.call('a1', 'POST', `/v1/rcm/coverages/${cov}/eligibility`, {
        source: 'fake_adapter',
        serviceDate: tomorrow(),
      }),
      201,
    );
    const e = okE(
      await generate(p.versionRef, {
        lines: [{ planItemRef: p.items[0] }],
        assumptions: [
          { kind: 'coverage', sourceRef: 'syn-coverage-source', sourceAsOf: new Date().toISOString() },
        ],
      }),
    );
    expect(e.coverageStatus).toBe('stale');
    expect(e.patientResponsibility).toMatchObject({ kind: 'range', basis: 'coverage_not_applied' });
  });

  it('C12 insurer portion: entered B5 benefits and a B9 allowance give per-line and total portions with sources', async () => {
    await seedPracticeFees(db, [
      ['SYN-EP-700', 12_000],
      ['SYN-EP-701', 20_000],
    ]);
    await seedPracticeFees(
      db,
      [
        ['SYN-EP-700', 10_000],
        ['SYN-EP-701', 15_000],
      ],
      { allowanceRef: 'syn-fee-allow-ep7' },
    );
    const p = await plan('Synthetic Insurer Portion', ['SYN-EP-700', 'SYN-EP-701']);
    const cov = await recordCoverage(h, p.patientRef, { feeScheduleRef: 'syn-fee-allow-ep7' });
    const benefits = (coins: { categoryCode: string; insurerPercent: number }[]) => ({
      activeStatus: 'active',
      limits: [
        { kind: 'deductible_remaining', amount: USD(2_500) },
        { kind: 'remaining_maximum', amount: USD(100_000) },
      ],
      frequencies: [{ categoryCode: 'SYN-EP-700', count: 2, periodMonths: 12, used: 0 }],
      coinsurance: coins,
      waitingPeriods: [],
    });
    h.ok(
      await h.call('a1', 'POST', `/v1/rcm/coverages/${cov}/eligibility`, {
        source: 'entered',
        serviceDate: today(),
        benefits: benefits([
          { categoryCode: 'SYN-EP-700', insurerPercent: 80 },
          { categoryCode: 'SYN-EP-701', insurerPercent: 50 },
        ]),
      }),
      201,
    );
    const e = okE(await generate(p.versionRef, { lines: p.items.map((planItemRef) => ({ planItemRef })) }));
    const ie = e.insurerEstimate as Record<string, unknown> & { lines: Record<string, unknown>[] };
    expect(ie).toMatchObject({
      kind: 'estimated',
      basis: 'benefits_applied',
      insurerPortion: USD(13_500),
      patientPortion: USD(11_500),
      notAGuarantee: true,
      method: { ref: 'c12-insurer-portion-v1', status: 'recommended-pending-billing-approval' },
    });
    expect(ie.lines.map((l) => [l.allowed, l.deductibleApplied, l.insurerPortion, l.patientPortion])).toEqual(
      [
        [USD(10_000), USD(2_500), USD(6_000), USD(4_000)],
        [USD(15_000), USD(0), USD(7_500), USD(7_500)],
      ],
    );
    expect((ie.inputs as { name: string }[]).map((x) => x.name)).toContain('allowance');
    // The existing bounded/labelled patient responsibility stays alongside (never a guarantee).
    expect(['unknown', 'range']).toContain(e.patientResponsibility.kind);
    const read = h.ok<{ data: Estimate }>(
      await h.call('a1', 'GET', `/v1/clinical/estimates/${e.estimateRef}`),
    );
    expect(read.data.insurerEstimate).toEqual(e.insurerEstimate);
  });

  it('C12 insurer portion: unknown coinsurance falls back to the range; inactive coverage is all patient', async () => {
    await seedPracticeFees(db, [['SYN-EP-800', 9_000]]);
    await seedPracticeFees(db, [['SYN-EP-800', 8_000]], { allowanceRef: 'syn-fee-allow-ep8' });
    const p = await plan('Synthetic Insurer Unknown', ['SYN-EP-800']);
    const cov = await recordCoverage(h, p.patientRef, { feeScheduleRef: 'syn-fee-allow-ep8' });
    h.ok(
      await h.call('a1', 'POST', `/v1/rcm/coverages/${cov}/eligibility`, {
        source: 'entered',
        serviceDate: today(),
        benefits: {
          activeStatus: 'active',
          limits: [
            { kind: 'deductible_remaining', amount: USD(0) },
            { kind: 'remaining_maximum', amount: USD(100_000) },
          ],
          frequencies: [],
          waitingPeriods: [],
        },
      }),
      201,
    );
    const e = okE(await generate(p.versionRef, { lines: [{ planItemRef: p.items[0] }] }));
    expect(e.insurerEstimate).toMatchObject({
      kind: 'unavailable',
      reason: 'input_unknown',
      fallback: 'patient_range',
      missing: ['coinsurance:SYN-EP-800'],
    });
    expect(['unknown', 'range']).toContain(e.patientResponsibility.kind);

    await seedPracticeFees(db, [['SYN-EP-801', 9_000]]);
    const q = await plan('Synthetic Insurer Inactive', ['SYN-EP-801']);
    const cov2 = await recordCoverage(h, q.patientRef, { payerRef: 'syn-payer-inactive-ep8' });
    h.ok(
      await h.call('a1', 'POST', `/v1/rcm/coverages/${cov2}/eligibility`, {
        source: 'fake_adapter',
        serviceDate: today(),
      }),
      201,
    );
    const f = okE(await generate(q.versionRef, { lines: [{ planItemRef: q.items[0] }] }));
    expect(f.insurerEstimate).toMatchObject({
      kind: 'estimated',
      basis: 'coverage_inactive',
      insurerPortion: USD(0),
      patientPortion: USD(9_000),
    });
  });

  it('C12 insurer portion: fake-adapter structured benefits (syn-payer-full) are applied with their receipt', async () => {
    await seedPracticeFees(db, [['SYN-PROPHY', 9_000]]);
    await seedPracticeFees(db, [['SYN-PROPHY', 7_000]], { allowanceRef: 'syn-fee-allow-ep9' });
    const p = await plan('Synthetic Insurer Adapter', ['SYN-PROPHY']);
    const cov = await recordCoverage(h, p.patientRef, {
      payerRef: 'syn-payer-full-ep9',
      feeScheduleRef: 'syn-fee-allow-ep9',
    });
    h.ok(
      await h.call('a1', 'POST', `/v1/rcm/coverages/${cov}/eligibility`, {
        source: 'fake_adapter',
        serviceDate: today(),
      }),
      201,
    );
    const e = okE(await generate(p.versionRef, { lines: [{ planItemRef: p.items[0] }] }));
    expect(e.insurerEstimate).toMatchObject({
      kind: 'estimated',
      insurerPortion: USD(7_000),
      patientPortion: USD(0),
    });
    const sources = (e.insurerEstimate as { inputs: { name: string; source: string }[] }).inputs;
    expect(sources.find((x) => x.name === 'coinsurance')?.source).toBe('fake_adapter');
  });
});
