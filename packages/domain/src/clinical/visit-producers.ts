import type { TenantTransaction } from '@cuspatlas/contracts';
import type { Authorize } from '../policy/authorize';
import type {
  VisitContextProducer,
  VisitContextProducers,
  VisitProducerRecord,
} from '../scheduling/visit-context';
import { UUID } from './base';
import { resolveHistoryReference } from './history';
import { LAB_CASE_VISIT_PRODUCER } from './lab-cases';

/**
 * The C producers behind the S12 visit context, through S12's published domain port. Each answer is a
 * reference, a version and a provenance label: never clinical text. Every call runs in the visit
 * context's own tenant transaction (RLS-bound) and applies clinical policy first: a caller without
 * `clinical.read` gets the slot reported unavailable (reads) or a 403 (commands), never a clinical
 * reference.
 */
export interface ClinicalVisitProducerDeps {
  readonly authorize: Authorize;
}

export function createClinicalVisitContextProducers(deps: ClinicalVisitProducerDeps): VisitContextProducers {
  const available = async (tx: TenantTransaction): Promise<boolean> => {
    try {
      await deps.authorize(tx.ctx, 'clinical.encounters.read', { tenantId: tx.ctx.tenantId, id: 'clinical' });
      return true;
    } catch {
      return false;
    }
  };
  const uuid = (ref: string) => (UUID.test(ref) ? ref : null);

  /** C8: a pin is a reference to one recorded history version; its current version is the stream head. */
  const medicalHistory: VisitContextProducer = {
    available,
    async resolve(tx, ref) {
      const { rows } = await tx.query<{
        id: string;
        provenance: string;
        head: number;
        subject: string;
      }>(
        `SELECT v.id, v.provenance, s.head_sequence AS head, s.subject_patient_id AS subject
         FROM cuspatlas.clinical_history_versions v
         JOIN cuspatlas.clinical_history_streams s ON s.id = v.stream_id AND s.tenant_id = v.tenant_id
         WHERE v.id = $1`,
        [uuid(ref)],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        ref: r.id,
        version: r.head,
        provenanceRef: `C8:${r.provenance}`,
        status: 'resolved',
        patientRef: r.subject,
      };
    },
    async current(tx, patientRef) {
      const reference = await resolveHistoryReference(tx, patientRef);
      if (!reference.recorded) return null;
      const heads = reference.versions.filter((v) => v.version > 0);
      const { rows } = await tx.query<{ id: string; sequence: number; provenance: string }>(
        `SELECT v.id, v.sequence, v.provenance FROM cuspatlas.clinical_history_versions v
         WHERE (v.stream_id, v.sequence) IN (SELECT * FROM unnest($1::uuid[], $2::int[]))
         ORDER BY v.recorded_at DESC, v.id LIMIT 1`,
        [heads.map((h) => h.streamRef), heads.map((h) => h.version)],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        ref: r.id,
        version: r.sequence,
        provenanceRef: `C8:${r.provenance}`,
        status: 'resolved',
        patientRef: reference.patientRef,
      };
    },
  };

  /** C13: an assigned form is a captured consent; a withdrawn consent resolves as voided. */
  const forms: VisitContextProducer = {
    available,
    async resolve(tx, ref) {
      const { rows } = await tx.query<{
        id: string;
        version: number;
        method: string;
        subject: string;
        withdrawn: boolean;
      }>(
        `SELECT c.id, c.version, c.method, c.subject_patient_id AS subject,
           EXISTS (SELECT 1 FROM cuspatlas.clinical_consent_withdrawals w WHERE w.consent_id = c.id
                   AND w.tenant_id = c.tenant_id) AS withdrawn
         FROM cuspatlas.clinical_consents c WHERE c.id = $1`,
        [uuid(ref)],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        ref: r.id,
        version: r.version,
        provenanceRef: `C13:${r.method}`,
        status: r.withdrawn ? 'voided' : 'resolved',
        patientRef: r.subject,
      };
    },
  };

  /** C10: the notes of the visit's encounters (drafts and signed), by reference only. */
  const noteRow = (r: {
    id: string;
    state: string;
    head_sequence: number;
    subject: string;
  }): VisitProducerRecord => ({
    ref: r.id,
    version: Math.max(1, r.head_sequence),
    provenanceRef: `C10:${r.state}`,
    status: 'resolved',
    patientRef: r.subject,
  });
  const noteDrafts: VisitContextProducer = {
    available,
    async resolve(tx, ref) {
      const { rows } = await tx.query<{ id: string; state: string; head_sequence: number; subject: string }>(
        `SELECT n.id, n.state, n.head_sequence, e.subject_patient_id AS subject FROM cuspatlas.clinical_notes n
         JOIN cuspatlas.clinical_encounters e ON e.id = n.encounter_id AND e.tenant_id = n.tenant_id WHERE n.id = $1`,
        [uuid(ref)],
      );
      return rows[0] ? noteRow(rows[0]) : null;
    },
    async listFor(tx, appointmentRef, patientRef) {
      const { rows } = await tx.query<{ id: string; state: string; head_sequence: number; subject: string }>(
        `SELECT n.id, n.state, n.head_sequence, e.subject_patient_id AS subject FROM cuspatlas.clinical_notes n
         JOIN cuspatlas.clinical_encounters e ON e.id = n.encounter_id AND e.tenant_id = n.tenant_id
         WHERE e.appointment_id = $1 AND e.subject_patient_id = $2 ORDER BY n.created_at, n.id LIMIT 50`,
        [appointmentRef, patientRef],
      );
      return rows.map(noteRow);
    },
  };

  /** C11: items of a current plan version whose state is scheduled to this appointment. */
  const superseded = `EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_versions s WHERE s.supersedes_version_id = v.id
                        AND s.tenant_id = v.tenant_id)`;
  const itemSql = `SELECT i.id, last.sequence, last.to_state, last.appointment_id, p.subject_patient_id AS subject,
       ${superseded} AS superseded
     FROM cuspatlas.clinical_plan_items i
     JOIN cuspatlas.clinical_plan_versions v ON v.id = i.plan_version_id AND v.tenant_id = i.tenant_id
     JOIN cuspatlas.clinical_treatment_plans p ON p.id = v.plan_id AND p.tenant_id = v.tenant_id
     JOIN LATERAL (SELECT e.sequence, e.to_state, e.appointment_id FROM cuspatlas.clinical_plan_item_events e
                   WHERE e.item_id = i.id AND e.tenant_id = i.tenant_id ORDER BY e.sequence DESC LIMIT 1) last ON true`;
  const itemRow = (r: {
    id: string;
    sequence: number;
    to_state: string;
    superseded: boolean;
    subject: string;
  }): VisitProducerRecord => ({
    ref: r.id,
    version: r.sequence,
    provenanceRef: `C11:${r.to_state}`,
    status: r.superseded ? 'voided' : 'resolved',
    patientRef: r.subject,
  });
  const treatmentPlanItems: VisitContextProducer = {
    available,
    async resolve(tx, ref) {
      const { rows } = await tx.query<{
        id: string;
        sequence: number;
        to_state: string;
        superseded: boolean;
        subject: string;
      }>(`${itemSql} WHERE i.id = $1`, [uuid(ref)]);
      return rows[0] ? itemRow(rows[0]) : null;
    },
    async listFor(tx, appointmentRef, patientRef) {
      const { rows } = await tx.query<{
        id: string;
        sequence: number;
        to_state: string;
        superseded: boolean;
        subject: string;
      }>(
        `${itemSql} WHERE last.to_state = 'scheduled' AND last.appointment_id = $1 AND p.subject_patient_id = $2
         AND NOT ${superseded} ORDER BY i.sequence, i.id LIMIT 50`,
        [appointmentRef, patientRef],
      );
      return rows.map(itemRow);
    },
  };

  /** C16: a bound lab case resolves to its state; a cancelled case resolves as voided. */
  const labCases: VisitContextProducer = { available, ...LAB_CASE_VISIT_PRODUCER };

  return { medicalHistory, forms, noteDrafts, treatmentPlanItems, labCases };
}
