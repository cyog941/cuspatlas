import type { TenantTransaction } from '@cuspatlas/contracts';

/** Clinical facts attached to one appointment: C5 encounters, C10 notes and C14 rendered procedures. */
export interface ClinicalAppointmentFacts {
  readonly encounters: readonly string[];
  readonly notes: readonly string[];
  readonly procedures: readonly string[];
}

/**
 * Read probe published by workstream C for S22 (OR-11): references only, read inside the caller's
 * tenant transaction (RLS). Notes and procedures are reached through the appointment's encounter.
 */
export async function clinicalFactsOfAppointment(
  tx: TenantTransaction,
  appointmentId: string,
): Promise<ClinicalAppointmentFacts> {
  const enc = await tx.query<{ id: string }>(
    'SELECT id FROM cuspatlas.clinical_encounters WHERE appointment_id = $1 ORDER BY id',
    [appointmentId],
  );
  const encounters = enc.rows.map((r) => r.id);
  if (encounters.length === 0) return { encounters, notes: [], procedures: [] };
  const notes = await tx.query<{ id: string }>(
    'SELECT id FROM cuspatlas.clinical_notes WHERE encounter_id = ANY ($1::uuid[]) ORDER BY id',
    [encounters],
  );
  const procedures = await tx.query<{ id: string }>(
    'SELECT id FROM cuspatlas.clinical_rendered_procedures WHERE encounter_id = ANY ($1::uuid[]) ORDER BY id',
    [encounters],
  );
  return { encounters, notes: notes.rows.map((r) => r.id), procedures: procedures.rows.map((r) => r.id) };
}
