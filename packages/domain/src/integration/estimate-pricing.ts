import { resolvePracticeFee } from '../billing/fees';
import type { EstimatePricing } from '../clinical/estimate-pricing';
import { coverageSummariesFor } from '../rcm/coverage';

/**
 * Integration seam C12 -> B9 (practice fee schedules) and B5 (coverage). Both reads run in the
 * caller's tenant transaction (RLS); nothing here computes an insurer portion or guesses a fee.
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
  };
}
