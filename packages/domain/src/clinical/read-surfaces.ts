import type { TenantTransaction } from '@cuspatlas/contracts';

/**
 * C11 / C16 / C10 published read functions for the A21 composers and the A18 huddle. Each runs in the
 * caller's tenant transaction (RLS-bound), selects only and authorizes nothing: the composer checks
 * `clinical.read` for the component first. References, codes and states only: never clinical text.
 */
export interface PlannedProcedure {
  readonly appointmentRef: string;
  readonly planItemRef: string;
  readonly procedureCodeRef: string;
  readonly toothRef: string | null;
  readonly surfaces: readonly string[];
  readonly areaCode: string | null;
  readonly state: 'scheduled';
}

/** C11: current (not superseded) plan items whose latest event schedules them to the appointments. */
export async function plannedProceduresFor(
  tx: TenantTransaction,
  appointmentRefs: readonly string[],
): Promise<PlannedProcedure[]> {
  if (appointmentRefs.length === 0) return [];
  const { rows } = await tx.query<{
    id: string;
    appointment_id: string;
    procedure_code_ref: string;
    tooth_canonical_ref: string | null;
    surfaces: string[] | null;
    area_code: string | null;
  }>(
    `SELECT i.id, last.appointment_id, i.procedure_code_ref, i.tooth_canonical_ref, i.surfaces, i.area_code
     FROM cuspatlas.clinical_plan_items i
     JOIN cuspatlas.clinical_plan_versions v ON v.id = i.plan_version_id AND v.tenant_id = i.tenant_id
     JOIN LATERAL (SELECT e.to_state, e.appointment_id FROM cuspatlas.clinical_plan_item_events e
                   WHERE e.item_id = i.id AND e.tenant_id = i.tenant_id ORDER BY e.sequence DESC LIMIT 1) last ON true
     WHERE last.to_state = 'scheduled' AND last.appointment_id = ANY ($1::uuid[])
       AND NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_versions s WHERE s.supersedes_version_id = v.id
                       AND s.tenant_id = v.tenant_id)
     ORDER BY last.appointment_id, i.sequence, i.id LIMIT 2000`,
    [[...appointmentRefs]],
  );
  return rows.map((r) => ({
    appointmentRef: r.appointment_id,
    planItemRef: r.id,
    procedureCodeRef: r.procedure_code_ref,
    toothRef: r.tooth_canonical_ref,
    surfaces: r.surfaces ?? [],
    areaCode: r.area_code,
    state: 'scheduled' as const,
  }));
}

export interface AppointmentLabCase {
  readonly appointmentRef: string;
  readonly labCaseRef: string;
  readonly state: string;
  readonly expectedReturnDate: string | null;
  readonly received: boolean;
}

/** C16: lab cases bound to the appointments (state and expected return date only). */
export async function labCasesFor(
  tx: TenantTransaction,
  appointmentRefs: readonly string[],
): Promise<AppointmentLabCase[]> {
  if (appointmentRefs.length === 0) return [];
  const { rows } = await tx.query<{
    id: string;
    appointment_id: string;
    state: string;
    expected: string | null;
    received: string | null;
  }>(
    `SELECT id, appointment_id, state, to_char(expected_return_date, 'YYYY-MM-DD') AS expected,
       to_char(received_date, 'YYYY-MM-DD') AS received
     FROM cuspatlas.clinical_lab_cases WHERE appointment_id = ANY ($1::uuid[]) ORDER BY appointment_id, id LIMIT 2000`,
    [[...appointmentRefs]],
  );
  return rows.map((r) => ({
    appointmentRef: r.appointment_id,
    labCaseRef: r.id,
    state: r.state,
    expectedReturnDate: r.expected,
    received: r.received !== null,
  }));
}

/** C10: unsigned (draft) notes per patient, counted (never their text). */
export async function unsignedNotesFor(
  tx: TenantTransaction,
  patientRefs: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (patientRefs.length === 0) return out;
  const { rows } = await tx.query<{ subject: string; n: number }>(
    `SELECT e.subject_patient_id AS subject, count(*)::int AS n FROM cuspatlas.clinical_notes n
     JOIN cuspatlas.clinical_encounters e ON e.id = n.encounter_id AND e.tenant_id = n.tenant_id
     WHERE e.subject_patient_id = ANY ($1::uuid[]) AND n.state = 'draft' GROUP BY e.subject_patient_id`,
    [[...patientRefs]],
  );
  for (const r of rows) out.set(r.subject, r.n);
  return out;
}
