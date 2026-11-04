import type { TenantTransaction } from '@cuspatlas/contracts';
import type { PostMergeFactProbe } from '../patients/merge';

/**
 * S-D2 seam (ADR 0003, pending approval): clinical facts recorded on a merge survivor after the merge
 * make a later unmerge need the elevated reconciliation review. Counted from the survivor's
 * encounters: opened, assigned or closed after the merge instant.
 */
export const CLINICAL_POST_MERGE_FACT_PROBES: readonly PostMergeFactProbe[] = [
  {
    factKind: 'clinical',
    async count(tx: TenantTransaction, survivorRef: string, mergedAt: Date): Promise<number> {
      const { rows } = await tx.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM cuspatlas.clinical_encounters e
                  WHERE e.subject_patient_id = $1 AND (e.opened_at > $2 OR e.closed_at > $2))
              + (SELECT count(*) FROM cuspatlas.clinical_encounter_assignments a
                  JOIN cuspatlas.clinical_encounters e ON e.id = a.encounter_id AND e.tenant_id = a.tenant_id
                  WHERE e.subject_patient_id = $1 AND a.assigned_at > $2) AS n`,
        [survivorRef, mergedAt],
      );
      return Number(rows[0]?.n ?? 0);
    },
  },
];
