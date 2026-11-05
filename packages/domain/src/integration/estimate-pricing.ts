import { resolveAllowance, resolvePracticeFee } from '../billing/fees';
import type { EstimatePricing } from '../clinical/estimate-pricing';
import { coverageSummariesFor } from '../rcm/coverage';

/**
 * Integration seam C12 -> B9 (practice fee schedules) and B5 (coverage). Both reads run in the
 * caller's tenant transaction (RLS); nothing here computes an insurer portion (C12 does, from these reads) or guesses a fee.
 */
export function createBillingEstimatePricing(): EstimatePricing {
  return {
    async practiceFee(tx, q) {
      const r = await resolvePracticeFee(tx, q.procedureCodeRef, q.serviceDate, q.locationId);
      return r === null ? null : { fee: r.fee, scheduleRef: r.scheduleRef, versionRef: r.versionRef };
    },
    async coverage(tx, patientRef, serviceDate) {
      const [primary] = await coverageSummariesFor(tx, [patientRef], serviceDate);
      return primary === undefined ? 'none' : primary.coverageStatus;
    },
    async benefitInputs(tx, patientRef, serviceDate) {
      const [primary] = await coverageSummariesFor(tx, [patientRef], serviceDate);
      if (primary === undefined)
        return { status: 'none', coverageRef: null, eligibility: null, benefits: {} };
      const e = primary.eligibility;
      return {
        status: primary.coverageStatus,
        coverageRef: primary.coverageRef,
        eligibility:
          e === null
            ? null
            : {
                eligibilityRef: e.eligibilityRef,
                source: e.source,
                retrievedAt: e.retrievedAt,
                freshUntil: e.freshUntil,
              },
        benefits: e?.benefits ?? {},
      };
    },
    async allowance(tx, q) {
      const r = await resolveAllowance(tx, q.procedureCodeRef, q.serviceDate, q.coverageRef);
      return r === null ? null : { fee: r.fee, scheduleRef: r.scheduleRef, versionRef: r.versionRef };
    },
  };
}
