import { describe, expect, it } from 'vitest';
import {
  type BenefitInputs,
  computeInsurerEstimate,
  INSURER_ESTIMATE_METHOD,
  insurerEstimateAt,
} from './insurer-estimate';

/** C12 insurer portion (synthetic benefit placeholders only; method recommended-pending-billing-approval). */
const USD = (minor: number) => ({ currency: 'USD', minor });
const NOW = Date.parse('2026-11-05T12:00:00Z');
const prov = {
  source: 'entered' as const,
  capturedAt: '2026-11-05T10:00:00.000Z',
  recordedByRef: 'syn-user',
  receiptRef: null,
};

function inputs(
  over: Partial<BenefitInputs['benefits']> = {},
  status: BenefitInputs['status'] = 'entered',
): BenefitInputs {
  return {
    status,
    coverageRef: 'cov-1',
    eligibility: {
      eligibilityRef: 'elig-1',
      source: 'entered',
      retrievedAt: '2026-11-05T10:00:00.000Z',
      freshUntil: '2026-11-12T10:00:00.000Z',
    },
    benefits: {
      status: { value: 'active', provenance: prov },
      limits: {
        items: [
          { kind: 'deductible_remaining', amount: USD(0) },
          { kind: 'remaining_maximum', amount: USD(100_000) },
        ],
        provenance: prov,
      },
      coinsurance: {
        items: [
          { categoryCode: 'SYN-A', insurerPercent: 80 },
          { categoryCode: 'SYN-B', insurerPercent: 50 },
        ],
        provenance: prov,
      },
      frequencies: {
        items: [{ categoryCode: 'SYN-A', count: 2, periodMonths: 12, used: 0 }],
        provenance: prov,
      },
      waitingPeriods: { items: [], provenance: prov },
      ...over,
    },
  };
}
const line = (code: string, fee: number, allowance: number | null, ref = code) => ({
  planItemRef: ref,
  procedureCodeRef: code,
  fee: USD(fee),
  allowance: allowance === null ? null : { fee: USD(allowance), scheduleRef: 'syn-allow', versionRef: 'v1' },
});
const at = (i: BenefitInputs, lines: ReturnType<typeof line>[]) =>
  computeInsurerEstimate({ currency: 'USD', serviceDate: '2026-11-05', inputs: i, lines });

describe('computeInsurerEstimate', () => {
  it('full benefit: coinsurance of the allowance per line and in total, with every input source', () => {
    const e = at(inputs(), [line('SYN-A', 12_000, 10_000), line('SYN-B', 20_000, 15_000)]);
    if (e.kind !== 'estimated') throw new Error(JSON.stringify(e));
    expect(e.lines.map((l) => [l.allowed, l.insurerPortion, l.patientPortion])).toEqual([
      [USD(10_000), USD(8_000), USD(2_000)],
      [USD(15_000), USD(7_500), USD(7_500)],
    ]);
    expect([e.insurerPortion, e.patientPortion]).toEqual([USD(15_500), USD(9_500)]);
    expect(e.notAGuarantee).toBe(true);
    expect(e.method).toEqual(INSURER_ESTIMATE_METHOD);
    expect(e.method.status).toBe('recommended-pending-billing-approval');
    const names = e.inputs.map((x) => x.name);
    for (const n of [
      'coverage_status',
      'coinsurance',
      'deductible_remaining',
      'annual_maximum_remaining',
      'frequencies',
      'waiting_periods',
      'allowance',
    ])
      expect(names).toContain(n);
    for (const x of e.inputs) expect(typeof x.capturedAt).toBe('string');
  });

  it('deductible partly met: the remaining deductible is taken from the first line before coinsurance', () => {
    const i = inputs({
      limits: {
        items: [
          { kind: 'deductible_remaining', amount: USD(2_500) },
          { kind: 'remaining_maximum', amount: USD(100_000) },
        ],
        provenance: prov,
      },
    });
    const e = at(i, [line('SYN-A', 10_000, 10_000), line('SYN-A', 10_000, 10_000, 'item-2')]);
    if (e.kind !== 'estimated') throw new Error('expected estimated');
    expect(e.lines.map((l) => [l.deductibleApplied, l.insurerPortion, l.patientPortion])).toEqual([
      [USD(2_500), USD(6_000), USD(4_000)],
      [USD(0), USD(8_000), USD(2_000)],
    ]);
  });

  it('annual maximum exhausted: the insurer portion is capped and then zero', () => {
    const i = inputs({
      limits: {
        items: [
          { kind: 'deductible_remaining', amount: USD(0) },
          { kind: 'remaining_maximum', amount: USD(5_000) },
        ],
        provenance: prov,
      },
    });
    const e = at(i, [line('SYN-A', 10_000, 10_000), line('SYN-A', 10_000, 10_000, 'item-2')]);
    if (e.kind !== 'estimated') throw new Error('expected estimated');
    expect(e.lines.map((l) => [l.insurerPortion, l.patientPortion, l.limitation])).toEqual([
      [USD(5_000), USD(5_000), 'annual_maximum_reached'],
      [USD(0), USD(10_000), 'annual_maximum_reached'],
    ]);
    expect(e.insurerPortion).toEqual(USD(5_000));
  });

  it('frequency limit hit: that line carries no insurer portion and the patient owes the full fee', () => {
    const i = inputs({
      frequencies: {
        items: [{ categoryCode: 'SYN-A', count: 2, periodMonths: 12, used: 2 }],
        provenance: prov,
      },
    });
    const e = at(i, [line('SYN-A', 12_000, 10_000), line('SYN-B', 20_000, 15_000)]);
    if (e.kind !== 'estimated') throw new Error('expected estimated');
    expect(e.lines[0]).toMatchObject({
      insurerPortion: USD(0),
      patientPortion: USD(12_000),
      limitation: 'frequency_limit_reached',
    });
    expect(e.lines[1]?.insurerPortion).toEqual(USD(7_500));
  });

  it('waiting period not yet satisfied: no insurer portion for that line', () => {
    const i = inputs({
      waitingPeriods: { items: [{ categoryCode: 'SYN-B', satisfiedOn: '2027-01-01' }], provenance: prov },
    });
    const e = at(i, [line('SYN-B', 20_000, 15_000)]);
    if (e.kind !== 'estimated') throw new Error('expected estimated');
    expect(e.lines[0]).toMatchObject({
      insurerPortion: USD(0),
      patientPortion: USD(20_000),
      limitation: 'waiting_period',
    });
  });

  it('unknown coinsurance falls back to the patient range (never a guessed percentage)', () => {
    const e = at(inputs(), [line('SYN-C', 10_000, 10_000)]);
    expect(e).toMatchObject({ kind: 'unavailable', fallback: 'patient_range', notAGuarantee: true });
    if (e.kind === 'unavailable') expect(e.missing).toContain('coinsurance:SYN-C');
  });

  it('unknown allowance, deductible, frequency usage or a non-current coverage fall back as well', () => {
    expect(at(inputs(), [line('SYN-A', 10_000, null)]).kind).toBe('unavailable');
    expect(at(inputs({ limits: { items: [], provenance: prov } }), [line('SYN-A', 1, 1)]).kind).toBe(
      'unavailable',
    );
    const noUsage = inputs({
      frequencies: { items: [{ categoryCode: 'SYN-A', count: 2, periodMonths: 12 }], provenance: prov },
    });
    expect(at(noUsage, [line('SYN-A', 1, 1)]).kind).toBe('unavailable');
    const { waitingPeriods: _w, ...noWaiting } = inputs().benefits;
    expect(at({ ...inputs(), benefits: noWaiting }, [line('SYN-A', 1, 1)]).kind).toBe('unavailable');
    expect(at(inputs({}, 'stale'), [line('SYN-A', 1, 1)]).kind).toBe('unavailable');
    expect(at(inputs({}, 'unknown'), [line('SYN-A', 1, 1)]).kind).toBe('unavailable');
    expect(at(inputs({}, 'none'), [line('SYN-A', 1, 1)]).kind).toBe('unavailable');
  });

  it('inactive coverage: no insurer portion, the patient owes the full fee', () => {
    const e = at(inputs({}, 'inactive'), [line('SYN-A', 12_000, null), line('SYN-B', 3_000, null)]);
    if (e.kind !== 'estimated') throw new Error('expected estimated');
    expect(e.basis).toBe('coverage_inactive');
    expect([e.insurerPortion, e.patientPortion]).toEqual([USD(0), USD(15_000)]);
  });

  it('a stored estimate whose eligibility has aged out reads unavailable at read time', () => {
    const e = at(inputs(), [line('SYN-A', 12_000, 10_000)]);
    expect(insurerEstimateAt(e, NOW).kind).toBe('estimated');
    expect(insurerEstimateAt(e, Date.parse('2026-12-01T00:00:00Z'))).toMatchObject({
      kind: 'unavailable',
      reason: 'input_stale',
    });
  });
});
