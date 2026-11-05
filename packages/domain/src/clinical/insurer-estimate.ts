import {
  type Benefits,
  type InsurerEstimate,
  type InsurerEstimateInput,
  type InsurerEstimateLine,
  type InsurerLimitation,
  type Money,
  money,
} from '@cuspatlas/contracts';

export type { InsurerEstimate } from '@cuspatlas/contracts';

/**
 * C12 insurer-portion estimate (synthetic engineering method, recommended-pending-billing-approval).
 * It applies B5 structured benefits (coinsurance, remaining deductible, remaining annual maximum,
 * frequency usage, waiting periods) to B9 allowances, line by line in plan order, with integer minor
 * units in BigInt. Any unknown, stale or inactive input falls back to the bounded patient range:
 * nothing is ever assumed, and the result is never a guarantee of payment.
 */
export const INSURER_ESTIMATE_METHOD = {
  ref: 'c12-insurer-portion-v1',
  status: 'recommended-pending-billing-approval',
  description:
    'allowed = min(fee, allowance); deductible from remaining deductible in line order; insurer = floor((allowed - deductible) x coinsurance%) capped by remaining annual maximum; patient = allowed - insurer; a frequency-exhausted or waiting-period line has no insurer portion and the patient owes the fee',
} as const satisfies InsurerEstimate['method'];

export type CoverageInputStatus = 'none' | 'entered' | 'unknown' | 'stale' | 'inactive';

export interface BenefitInputs {
  readonly status: CoverageInputStatus;
  readonly coverageRef: string | null;
  readonly eligibility: {
    readonly eligibilityRef: string;
    readonly source: string;
    readonly retrievedAt: string;
    readonly freshUntil: string;
  } | null;
  readonly benefits: Benefits;
}

export interface InsurerEstimateLineInput {
  readonly planItemRef: string;
  readonly procedureCodeRef: string;
  readonly fee: Money;
  readonly allowance: {
    readonly fee: Money;
    readonly scheduleRef: string;
    readonly versionRef: string;
  } | null;
}

export const insurerEstimateUnavailable = (
  reason: Extract<InsurerEstimate, { kind: 'unavailable' }>['reason'],
  missing: string[] = [],
) =>
  ({
    kind: 'unavailable',
    reason,
    missing,
    fallback: 'patient_range',
    method: INSURER_ESTIMATE_METHOD,
    notAGuarantee: true,
  }) as const;

const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function computeInsurerEstimate(q: {
  readonly currency: string;
  readonly serviceDate: string;
  /** The instant B5/B9 were read (the capture instant of a schedule-sourced input). */
  readonly readAt?: string;
  readonly inputs: BenefitInputs;
  readonly lines: readonly InsurerEstimateLineInput[];
}): InsurerEstimate {
  const { inputs: i, currency } = q;
  const readAt = q.readAt ?? new Date().toISOString();
  const m = (minor: bigint) => money(currency, minor);
  if (i.status === 'none') return insurerEstimateUnavailable('coverage_none');
  if (i.status === 'unknown') return insurerEstimateUnavailable('coverage_unknown');
  if (i.status === 'stale') return insurerEstimateUnavailable('coverage_stale');
  const elig = i.eligibility;
  const statusInput: InsurerEstimateInput = {
    name: 'coverage_status',
    source: i.benefits.status?.provenance.source ?? elig?.source ?? 'unknown',
    sourceRef: elig?.eligibilityRef ?? null,
    capturedAt: i.benefits.status?.provenance.capturedAt ?? elig?.retrievedAt ?? readAt,
    freshUntil: elig?.freshUntil ?? null,
  };
  if (i.status === 'inactive') {
    // A verified inactive coverage is a known fact: no insurer portion, the patient owes every fee.
    let total = 0n;
    const lines = q.lines.map((l) => {
      total += BigInt(l.fee.minor);
      return {
        planItemRef: l.planItemRef,
        procedureCodeRef: l.procedureCodeRef,
        fee: l.fee,
        allowed: l.fee,
        deductibleApplied: m(0n),
        insurerPercent: null,
        insurerPortion: m(0n),
        patientPortion: l.fee,
        limitation: 'coverage_inactive' as const,
      };
    });
    return {
      kind: 'estimated',
      basis: 'coverage_inactive',
      insurerPortion: m(0n),
      patientPortion: m(total),
      lines,
      inputs: [statusInput],
      method: INSURER_ESTIMATE_METHOD,
      notAGuarantee: true,
    };
  }
  const b = i.benefits;
  const missing: string[] = [];
  if (elig === null || b.status?.value !== 'active') missing.push('coverage_active');
  const limit = (kind: string) => b.limits?.items.find((x) => x.kind === kind)?.amount;
  const ded = limit('deductible_remaining');
  const max = limit('remaining_maximum');
  if (ded === undefined || ded.currency !== currency) missing.push('deductible_remaining');
  if (max === undefined || max.currency !== currency) missing.push('annual_maximum_remaining');
  if (b.frequencies === undefined) missing.push('frequencies');
  if (b.waitingPeriods === undefined) missing.push('waiting_periods');
  for (const l of q.lines) {
    const code = l.procedureCodeRef;
    if (!b.coinsurance?.items.some((c) => c.categoryCode === code)) missing.push(`coinsurance:${code}`);
    if (l.allowance === null || l.allowance.fee.currency !== currency) missing.push(`allowance:${code}`);
    const f = b.frequencies?.items.find((x) => x.categoryCode === code);
    if (f !== undefined && f.used === undefined) missing.push(`frequency_usage:${code}`);
  }
  if (missing.length > 0 || ded === undefined || max === undefined) {
    return insurerEstimateUnavailable('input_unknown', [...new Set(missing)]);
  }
  let deductibleLeft = BigInt(ded.minor);
  let maximumLeft = BigInt(max.minor);
  let insurerTotal = 0n;
  let patientTotal = 0n;
  const lines: InsurerEstimateLine[] = [];
  for (const l of q.lines) {
    const code = l.procedureCodeRef;
    const fee = BigInt(l.fee.minor);
    const pct = b.coinsurance?.items.find((c) => c.categoryCode === code)?.insurerPercent ?? 0;
    const f = b.frequencies?.items.find((x) => x.categoryCode === code);
    const w = b.waitingPeriods?.items.find((x) => x.categoryCode === code);
    let limitation: InsurerLimitation = 'none';
    if (f !== undefined && BigInt(f.used ?? 0) >= BigInt(f.count)) limitation = 'frequency_limit_reached';
    else if (w !== undefined && w.satisfiedOn > q.serviceDate) limitation = 'waiting_period';
    if (limitation !== 'none') {
      // Not covered: no allowance applies and the patient owes the fee.
      patientTotal += fee;
      lines.push({
        planItemRef: l.planItemRef,
        procedureCodeRef: code,
        fee: l.fee,
        allowed: l.fee,
        deductibleApplied: m(0n),
        insurerPercent: pct,
        insurerPortion: m(0n),
        patientPortion: l.fee,
        limitation,
      });
      continue;
    }
    const allowed = min(fee, BigInt((l.allowance as { fee: Money }).fee.minor));
    const deductible = min(deductibleLeft, allowed);
    deductibleLeft -= deductible;
    const share = ((allowed - deductible) * BigInt(pct)) / 100n;
    const insurer = min(share, maximumLeft);
    if (insurer < share || maximumLeft === 0n) limitation = 'annual_maximum_reached';
    maximumLeft -= insurer;
    insurerTotal += insurer;
    patientTotal += allowed - insurer;
    lines.push({
      planItemRef: l.planItemRef,
      procedureCodeRef: code,
      fee: l.fee,
      allowed: m(allowed),
      deductibleApplied: m(deductible),
      insurerPercent: pct,
      insurerPortion: m(insurer),
      patientPortion: m(allowed - insurer),
      limitation,
    });
  }
  const p = (
    name: InsurerEstimateInput['name'],
    prov: { source: string; capturedAt: string } | undefined,
  ) => ({
    name,
    source: prov?.source ?? 'unknown',
    sourceRef: elig?.eligibilityRef ?? null,
    capturedAt: prov?.capturedAt ?? readAt,
    freshUntil: elig?.freshUntil ?? null,
  });
  const allowanceInputs: InsurerEstimateInput[] = [];
  for (const l of q.lines) {
    if (l.allowance === null) continue;
    const ref = `${l.allowance.scheduleRef}@${l.allowance.versionRef}`;
    if (allowanceInputs.some((x) => x.sourceRef === ref)) continue;
    allowanceInputs.push({
      name: 'allowance',
      source: 'fee_schedule',
      sourceRef: ref,
      capturedAt: readAt,
      freshUntil: null,
    });
  }
  return {
    kind: 'estimated',
    basis: 'benefits_applied',
    insurerPortion: m(insurerTotal),
    patientPortion: m(patientTotal),
    lines,
    inputs: [
      statusInput,
      p('coinsurance', b.coinsurance?.provenance),
      p('deductible_remaining', b.limits?.provenance),
      p('annual_maximum_remaining', b.limits?.provenance),
      p('frequencies', b.frequencies?.provenance),
      p('waiting_periods', b.waitingPeriods?.provenance),
      ...allowanceInputs,
    ],
    method: INSURER_ESTIMATE_METHOD,
    notAGuarantee: true,
  };
}

/** A stored estimate at a read instant: any input past its freshness window reads unavailable. */
export function insurerEstimateAt(stored: InsurerEstimate, at: number): InsurerEstimate {
  if (stored.kind !== 'estimated' || stored.basis === 'coverage_inactive') return stored;
  const stale = stored.inputs.filter((x) => x.freshUntil !== null && Date.parse(x.freshUntil) < at);
  return stale.length === 0
    ? stored
    : insurerEstimateUnavailable('input_stale', [...new Set(stale.map((x) => x.name))]);
}
