import type { Money, TenantTransaction } from '@cuspatlas/contracts';
import type { BenefitInputs } from './insurer-estimate';

/**
 * C12 -> B9/B5 port. The server's practice fee is authoritative for every estimate line and the
 * coverage state is read, never invented. Implemented in `integration/estimate-pricing.ts`.
 */
export interface EstimatePricing {
  /** The practice fee of a code on a service date (location schedule first), or null when none is configured. */
  practiceFee(
    tx: TenantTransaction,
    query: {
      readonly procedureCodeRef: string;
      readonly serviceDate: string;
      readonly locationId: string | null;
    },
  ): Promise<{ readonly fee: Money; readonly scheduleRef: string; readonly versionRef: string } | null>;
  /**
   * B5's status of the patient's primary coverage on the service date: `none` when no coverage is on
   * file, else `entered` (current eligibility), `stale`, `inactive` (verified inactive) or `unknown`.
   */
  coverage(
    tx: TenantTransaction,
    patientRef: string,
    serviceDate: string,
  ): Promise<'none' | 'entered' | 'unknown' | 'stale' | 'inactive'>;
  /**
   * B5's primary coverage on the service date with its latest usable eligibility record (source,
   * capture instant, freshness) and structured benefits, for the C12 insurer-portion estimate.
   */
  benefitInputs(tx: TenantTransaction, patientRef: string, serviceDate: string): Promise<BenefitInputs>;
  /** B9's payer allowance of a code under a coverage on a service date, or null when none is configured. */
  allowance(
    tx: TenantTransaction,
    query: { readonly procedureCodeRef: string; readonly serviceDate: string; readonly coverageRef: string },
  ): Promise<{ readonly fee: Money; readonly scheduleRef: string; readonly versionRef: string } | null>;
}
