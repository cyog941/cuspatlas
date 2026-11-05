import type { TenantTransaction } from '@cuspatlas/contracts';

/**
 * Read probe published by the RCM part of workstream B for S22 (OR-11): the claims whose lines carry
 * any of the given charges. References only, read inside the caller's tenant transaction (RLS).
 */
export async function claimsOfCharges(
  tx: TenantTransaction,
  chargeIds: readonly string[],
): Promise<string[]> {
  if (chargeIds.length === 0) return [];
  const { rows } = await tx.query<{ claim_id: string }>(
    `SELECT DISTINCT v.claim_id FROM cuspatlas.rcm_claim_lines l
     JOIN cuspatlas.rcm_claim_versions v ON v.id = l.version_id AND v.tenant_id = l.tenant_id
     WHERE l.charge_id = ANY ($1::uuid[]) ORDER BY v.claim_id`,
    [chargeIds],
  );
  return rows.map((r) => r.claim_id);
}
