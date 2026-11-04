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
                  WHERE e.subject_patient_id = $1 AND (e.opened_at >= $2 OR e.closed_at >= $2))
              + (SELECT count(*) FROM cuspatlas.clinical_encounter_assignments a
                  JOIN cuspatlas.clinical_encounters e ON e.id = a.encounter_id AND e.tenant_id = a.tenant_id
                  WHERE e.subject_patient_id = $1 AND a.assigned_at >= $2)
              + (SELECT count(*) FROM cuspatlas.clinical_history_versions v
                  JOIN cuspatlas.clinical_history_streams s ON s.id = v.stream_id AND s.tenant_id = v.tenant_id
                  WHERE s.subject_patient_id = $1 AND v.recorded_at >= $2)
              + (SELECT count(*) FROM cuspatlas.clinical_history_verifications f
                  JOIN cuspatlas.clinical_history_changes c ON c.id = f.change_id AND c.tenant_id = f.tenant_id
                  JOIN cuspatlas.clinical_history_items i ON i.id = c.item_id AND i.tenant_id = c.tenant_id
                  JOIN cuspatlas.clinical_history_streams s ON s.id = i.stream_id AND s.tenant_id = i.tenant_id
                  WHERE s.subject_patient_id = $1 AND f.verified_at >= $2)
              + (SELECT count(*) FROM cuspatlas.clinical_history_reviews r
                  JOIN cuspatlas.clinical_encounters e ON e.id = r.encounter_id AND e.tenant_id = r.tenant_id
                  WHERE e.subject_patient_id = $1 AND r.reviewed_at >= $2) AS n`,
        [survivorRef, mergedAt],
      );
      return Number(rows[0]?.n ?? 0);
    },
  },
  // C6: chart entries recorded on any of the survivor's charts after the merge instant.
  {
    factKind: 'clinical',
    async count(tx: TenantTransaction, survivorRef: string, mergedAt: Date): Promise<number> {
      const { rows } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM cuspatlas.clinical_chart_entries x
         JOIN cuspatlas.clinical_charts c ON c.id = x.chart_id AND c.tenant_id = x.tenant_id
         WHERE c.subject_patient_id = $1 AND x.recorded_at >= $2`,
        [survivorRef, mergedAt],
      );
      return Number(rows[0]?.n ?? 0);
    },
  },
  // C7: exams, corrections and derivations on any of the survivor's perio streams after the merge.
  {
    factKind: 'clinical',
    async count(tx: TenantTransaction, survivorRef: string, mergedAt: Date): Promise<number> {
      const { rows } = await tx.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM cuspatlas.clinical_perio_exams x
                  JOIN cuspatlas.clinical_perio_streams s ON s.id = x.stream_id AND s.tenant_id = x.tenant_id
                  WHERE s.subject_patient_id = $1 AND x.recorded_at >= $2)
              + (SELECT count(*) FROM cuspatlas.clinical_perio_measurements m
                  JOIN cuspatlas.clinical_perio_exams x ON x.id = m.exam_id AND x.tenant_id = m.tenant_id
                  JOIN cuspatlas.clinical_perio_streams s ON s.id = x.stream_id AND s.tenant_id = x.tenant_id
                  WHERE s.subject_patient_id = $1 AND m.supersedes_measurement_id IS NOT NULL AND m.recorded_at >= $2)
              + (SELECT count(*) FROM cuspatlas.clinical_perio_derivations d
                  JOIN cuspatlas.clinical_perio_exams x ON x.id = d.exam_id AND x.tenant_id = d.tenant_id
                  JOIN cuspatlas.clinical_perio_streams s ON s.id = x.stream_id AND s.tenant_id = x.tenant_id
                  WHERE s.subject_patient_id = $1 AND d.computed_at >= $2) AS n`,
        [survivorRef, mergedAt],
      );
      return Number(rows[0]?.n ?? 0);
    },
  },
  // C11: plans, versions, details, items and their state events on the survivor's plans after the merge.
  {
    factKind: 'clinical',
    async count(tx: TenantTransaction, survivorRef: string, mergedAt: Date): Promise<number> {
      const { rows } = await tx.query<{ n: number }>(
        `WITH p AS (SELECT id, tenant_id FROM cuspatlas.clinical_treatment_plans WHERE subject_patient_id = $1),
              v AS (SELECT x.id, x.tenant_id, x.created_at FROM cuspatlas.clinical_plan_versions x
                    JOIN p ON p.id = x.plan_id AND p.tenant_id = x.tenant_id)
         SELECT (SELECT count(*) FROM v WHERE v.created_at >= $2)
              + (SELECT count(*) FROM cuspatlas.clinical_plan_details d JOIN v ON v.id = d.plan_version_id
                  AND v.tenant_id = d.tenant_id WHERE d.created_at >= $2)
              + (SELECT count(*) FROM cuspatlas.clinical_plan_item_events e
                  JOIN cuspatlas.clinical_plan_items i ON i.id = e.item_id AND i.tenant_id = e.tenant_id
                  JOIN v ON v.id = i.plan_version_id AND v.tenant_id = i.tenant_id WHERE e.recorded_at >= $2)
              + (SELECT count(*) FROM cuspatlas.clinical_plan_detail_events de
                  JOIN cuspatlas.clinical_plan_details d ON d.id = de.detail_id AND d.tenant_id = de.tenant_id
                  JOIN v ON v.id = d.plan_version_id AND v.tenant_id = d.tenant_id WHERE de.recorded_at >= $2) AS n`,
        [survivorRef, mergedAt],
      );
      return Number(rows[0]?.n ?? 0);
    },
  },
  // C10: notes drafted, signed, amended, addended or co-signed on the survivor after the merge.
  NOTE_POST_MERGE_FACT_PROBE,
];
