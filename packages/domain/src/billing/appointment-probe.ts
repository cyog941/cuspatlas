import type { TenantTransaction } from '@cuspatlas/contracts';

/**
 * Read probe published by workstream B for S22 (OR-11): the charges posted for a set of C14
 * procedures (source `clinical_procedure`, linked by `procedure_ref`). References only, read inside
 * the caller's tenant transaction (RLS).
 */
export async function chargesOfProcedures(
  tx: TenantTransaction,
  procedureIds: readonly string[],
): Promise<string[]> {
  if (procedureIds.length === 0) return [];
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM cuspatlas.billing_charges
     WHERE source = 'clinical_procedure' AND procedure_ref = ANY ($1::text[]) ORDER BY id`,
    [procedureIds],
  );
  return rows.map((r) => r.id);
}
