import type { TenantTransaction } from '@cuspatlas/contracts';

/**
 * Narrow reads billing needs from coverage (B5) and from the S location registry, kept outside the
 * billing directory so billing code names billing tables only (structural test in billing-journal).
 * Each runs in the caller's tenant transaction under RLS.
 */
export async function coverageOf(
  tx: TenantTransaction,
  coverageId: string,
): Promise<{ id: string; patientId: string; payerRef: string; feeScheduleRef: string | null } | null> {
  const { rows } = await tx.query<{ id: string; patient_id: string; payer_ref: string; fee: string | null }>(
    `SELECT c.id, c.patient_id, c.payer_ref,
       (SELECT v.fee_schedule_ref FROM cuspatlas.rcm_coverage_versions v WHERE v.coverage_id = c.id
        ORDER BY v.coverage_version DESC LIMIT 1) AS fee
     FROM cuspatlas.rcm_coverages c WHERE c.id = $1`,
    [coverageId],
  );
  const r = rows[0];
  return r ? { id: r.id, patientId: r.patient_id, payerRef: r.payer_ref, feeScheduleRef: r.fee } : null;
}

export async function locationIdOf(tx: TenantTransaction, locationRef: string): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM cuspatlas.scheduling_locations WHERE location_ref = $1',
    [locationRef],
  );
  return rows[0]?.id ?? null;
}

export async function locationRefsOf(
  tx: TenantTransaction,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await tx.query<{ id: string; location_ref: string }>(
    'SELECT id, location_ref FROM cuspatlas.scheduling_locations WHERE id = ANY ($1::uuid[])',
    [[...ids]],
  );
  return new Map(rows.map((r) => [r.id, r.location_ref]));
}

export async function locationIdsOf(tx: TenantTransaction, refs: readonly string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM cuspatlas.scheduling_locations WHERE location_ref = ANY ($1::text[])',
    [[...refs]],
  );
  return rows.map((r) => r.id);
}

/**
 * B9 contractual adjustments (review MUST-FAIL 4): the claim's coverage, whether it holds a paid
 * adjudication, and whether the charge is a line of one of its transmitted versions. null: hidden.
 */
export async function claimAdjudicationOf(
  tx: TenantTransaction,
  claimRef: string,
  chargeId: string,
): Promise<{ coverage_id: string; paid: boolean; on_claim: boolean } | null> {
  const { rows } = await tx.query<{ coverage_id: string; paid: boolean; on_claim: boolean }>(
    `SELECT c.coverage_id,
       EXISTS (SELECT 1 FROM cuspatlas.rcm_claim_events e WHERE e.claim_id = c.id AND e.kind = 'adjudicated_paid') AS paid,
       EXISTS (SELECT 1 FROM cuspatlas.rcm_claim_submissions s JOIN cuspatlas.rcm_claim_lines l ON l.version_id = s.version_id
               WHERE s.claim_id = c.id AND s.outcome = 'transmitted' AND l.charge_id = $2) AS on_claim
     FROM cuspatlas.rcm_claims c WHERE c.id = $1`,
    [claimRef, chargeId],
  );
  return rows[0] ?? null;
}
