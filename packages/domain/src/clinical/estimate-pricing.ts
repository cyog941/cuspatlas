import type { Money, TenantTransaction } from '@cuspatlas/contracts';

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
}
