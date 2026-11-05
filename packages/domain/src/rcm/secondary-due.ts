import type { TenantTransaction } from '@cuspatlas/contracts';

/** A primary charge whose patient responsibility waits for a secondary coverage found after the ERA. */
export interface LateSecondary {
  readonly chargeId: string;
  readonly claimId: string;
  readonly coverageId: string;
}

/**
 * Late secondary coverage (CL-11): a paid primary claim (adjudicated paid, no secondary claim yet)
 * whose remittance left patient responsibility on a charge while the patient holds a rank-2 coverage
 * that was effective on the date of service. That amount is the secondary insurer's to be claimed,
 * not the patient's to be billed, until the secondary claim is prepared (which moves it) or the
 * coverage no longer applies. Read-only; shared by the claims workflow and the statement guard so the
 * two cannot disagree. Scope by claim ids or by patient ids (a statement's covered accounts).
 */
export async function lateSecondaryDue(
  tx: TenantTransaction,
  scope: { readonly claimIds?: readonly string[]; readonly patientIds?: readonly string[] },
): Promise<LateSecondary[]> {
  const { rows } = await tx.query<{ charge_id: string; claim_id: string; coverage_id: string }>(
    `SELECT DISTINCT l.charge_id, c.id AS claim_id, sec.id AS coverage_id
     FROM cuspatlas.rcm_claims c
     JOIN LATERAL (
       SELECT x.version_id FROM cuspatlas.rcm_claim_submissions x
       WHERE x.claim_id = c.id AND x.outcome = 'transmitted'
         AND EXISTS (SELECT 1 FROM cuspatlas.rcm_claim_events e WHERE e.submission_id = x.id AND e.kind = 'adjudicated_paid')
       ORDER BY x.created_at DESC, x.id DESC LIMIT 1) s ON true
     JOIN cuspatlas.rcm_claim_lines l ON l.version_id = s.version_id
     JOIN LATERAL (
       SELECT sc.id FROM cuspatlas.rcm_coverages sc
       JOIN LATERAL (SELECT * FROM cuspatlas.rcm_coverage_versions x WHERE x.coverage_id = sc.id
                     ORDER BY x.coverage_version DESC LIMIT 1) v ON true
       WHERE sc.patient_id IN (SELECT p.id FROM cuspatlas.patients p WHERE p.id = c.patient_id OR p.merged_into = c.patient_id)
         AND v.benefit_rank = 2 AND v.effective_from <= l.date_of_service
         AND (v.effective_until IS NULL OR v.effective_until >= l.date_of_service)
       ORDER BY v.effective_from, sc.created_at, sc.id LIMIT 1) sec ON true
     WHERE (SELECT v.benefit_rank FROM cuspatlas.rcm_coverage_versions v WHERE v.coverage_id = c.coverage_id
            ORDER BY v.coverage_version DESC LIMIT 1) = 1
       AND NOT EXISTS (SELECT 1 FROM cuspatlas.rcm_secondary_claims x WHERE x.claim_id = c.id OR x.primary_claim_id = c.id)
       AND (SELECT coalesce(sum(j.amount_minor), 0) FROM cuspatlas.billing_journal_lines j
            WHERE j.charge_id = l.charge_id AND j.account = 'patient_receivable') > 0
       AND EXISTS (SELECT 1 FROM cuspatlas.billing_journal_entries e
                   WHERE e.charge_id = l.charge_id AND e.reason_code = 'remittance_patient_responsibility')
       AND ($1::uuid[] IS NULL OR c.id = ANY ($1::uuid[]))
       AND ($2::uuid[] IS NULL OR c.patient_id = ANY ($2::uuid[]))
     ORDER BY 1, 2, 3`,
    [scope.claimIds ? [...scope.claimIds] : null, scope.patientIds ? [...scope.patientIds] : null],
  );
  return rows.map((r) => ({ chargeId: r.charge_id, claimId: r.claim_id, coverageId: r.coverage_id }));
}
