import type { TenantTransaction } from '@cuspatlas/contracts';
import type { PostMergeFactProbe } from '../patients/merge';
import { NOTE_POST_MERGE_FACT_PROBE } from './notes/notes';

/**
 * S-D2 seam (ADR 0003, pending approval): clinical facts recorded on a merge survivor after the merge
 * make a later unmerge need the elevated reconciliation review. Counted from the survivor's
 * encounters (opened, assigned or closed after the merge instant) and history (versions recorded on
 * any of the survivor's streams, verifications and review attestations after the merge instant).
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
                  WHERE e.subject_patient_id = $1 AND a.assigned_at > $2)
              + (SELECT count(*) FROM cuspatlas.clinical_history_versions v
                  JOIN cuspatlas.clinical_history_streams s ON s.id = v.stream_id AND s.tenant_id = v.tenant_id
                  WHERE s.subject_patient_id = $1 AND v.recorded_at > $2)
              + (SELECT count(*) FROM cuspatlas.clinical_history_verifications f
                  JOIN cuspatlas.clinical_history_changes c ON c.id = f.change_id AND c.tenant_id = f.tenant_id
                  JOIN cuspatlas.clinical_history_items i ON i.id = c.item_id AND i.tenant_id = c.tenant_id
                  JOIN cuspatlas.clinical_history_streams s ON s.id = i.stream_id AND s.tenant_id = i.tenant_id
                  WHERE s.subject_patient_id = $1 AND f.verified_at > $2)
              + (SELECT count(*) FROM cuspatlas.clinical_history_reviews r
                  JOIN cuspatlas.clinical_encounters e ON e.id = r.encounter_id AND e.tenant_id = r.tenant_id
                  WHERE e.subject_patient_id = $1 AND r.reviewed_at > $2) AS n`,
        [survivorRef, mergedAt],
      );
      return Number(rows[0]?.n ?? 0);
    },
  },
  // C10: notes drafted, signed, amended, addended or co-signed on the survivor after the merge.
  NOTE_POST_MERGE_FACT_PROBE,
];
