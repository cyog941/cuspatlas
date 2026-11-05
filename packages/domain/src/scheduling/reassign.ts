import {
  type ActorContext,
  type AppointmentPatientReassign,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  RefusalError,
  SCHEDULING_PROPERTIES,
  validateAppointmentPatientReassign,
  validateSchedulingEntityRef,
} from '@cuspatlas/contracts';
import { chargesOfProcedures } from '../billing/appointment-probe';
import { clinicalFactsOfAppointment } from '../clinical/appointment-probe';
import { recordCommand } from '../events/record-command';
import { claimsOfCharges } from '../rcm/appointment-probe';
import type { AppointmentBase } from './appointment-base';
import { attendanceFactsOf } from './attendance';
import { APPOINTMENT_RESOURCE, loadAppointment } from './booking';
import { checkEnvelope, failedAt, notFound } from './resources';

export interface ReassignData {
  readonly appointmentRef: string;
  readonly patientRef: string;
  readonly previousPatientRef: string;
  readonly reassignmentRef: string;
}

/** OR-11 refusal reasons, each with the supported remediation operation. */
const REMEDIATION = {
  charges_attached: 'billing.entries.reverse',
  clinical_facts_attached: 'clinical.procedures.correct',
  attendance_recorded: 'scheduling.appointments.book',
} as const;

/**
 * S22 (OR-11): reassign an appointment's patient while no clinical (C5 encounter, C10 note, C14
 * procedure), billing (charge, claim) or attendance fact references it. It never moves C or B facts;
 * the reassignment is a recorded fact of its own, and the database relink guard admits the change
 * only with that record in the same transaction. The appointment row lock serializes it against a
 * concurrent clinical write (an encounter insert takes a key-share lock on the appointment).
 */
export function createReassignOperations(base: AppointmentBase) {
  const { deps, execute } = base;
  return {
    reassignAppointmentPatient(
      ctx: ActorContext,
      appointmentRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ReassignData>> {
      const op = 'scheduling.appointments.reassignPatient';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as AppointmentPatientReassign;
        assertValid<AppointmentPatientReassign>(validateAppointmentPatientReassign, p, SCHEDULING_PROPERTIES);
        const seeClinical = await base.can(ctx, 'clinical.encounters.read');
        const seeBilling = await base.can(ctx, 'billing.charges.read');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const appt = await loadAppointment(tx, decision, appointmentRef, 'FOR UPDATE OF a');
          if (!validateSchedulingEntityRef(p.patientRef)) throw notFound();
          const patient = await tx.query<{ id: string; merged_into: string | null; status: string }>(
            'SELECT id, merged_into, status FROM cuspatlas.patients WHERE id = $1',
            [p.patientRef],
          );
          const target = patient.rows[0];
          if (!target) throw notFound();
          return execute<ReassignData>(
            ctx,
            { ...envelope, payload: { appointmentRef, ...p } },
            tx,
            async () => {
              if (appt.version !== p.expectedVersion)
                throw new RefusalError({ code: 'stale_version', detail: { currentVersion: appt.version } });
              if (appt.status !== 'booked')
                throw new RefusalError({ code: 'conflict', detail: { reason: 'appointment_not_booked' } });
              if (target.merged_into !== null) throw failedAt('/patientRef', 'patientMerged');
              if (target.status !== 'active') throw failedAt('/patientRef', 'patientNotActive');
              if (target.id === appt.subject_patient_id) throw failedAt('/patientRef', 'samePatient');

              const clinical = await clinicalFactsOfAppointment(tx, appt.id);
              const charges = await chargesOfProcedures(tx, clinical.procedures);
              const billing = { charges, claims: await claimsOfCharges(tx, charges) };
              const attendance = await attendanceFactsOf(tx, appt.id);
              const reason =
                billing.charges.length > 0
                  ? 'charges_attached'
                  : clinical.encounters.length + clinical.notes.length + clinical.procedures.length > 0
                    ? 'clinical_facts_attached'
                    : attendance.length > 0
                      ? 'attendance_recorded'
                      : null;
              if (reason !== null) {
                // Only the references the caller may read; a restricted caller still gets the reason.
                const refs = [
                  ...(seeBilling
                    ? [
                        ...billing.charges.map((ref) => ({ kind: 'charge', ref })),
                        ...billing.claims.map((ref) => ({ kind: 'claim', ref })),
                      ]
                    : []),
                  ...(seeClinical
                    ? [
                        ...clinical.encounters.map((ref) => ({ kind: 'encounter', ref })),
                        ...clinical.notes.map((ref) => ({ kind: 'note', ref })),
                        ...clinical.procedures.map((ref) => ({ kind: 'procedure', ref })),
                      ]
                    : []),
                  ...attendance.map((ref) => ({ kind: 'attendanceTransition', ref })),
                ].slice(0, 50);
                throw new RefusalError({
                  code: 'conflict',
                  replayable: false,
                  detail: { reason, blockingRefs: refs, alternative: REMEDIATION[reason] },
                });
              }
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.appointment_patient_reassignments (tenant_id, appointment_id, prior_patient_id,
                 new_patient_id, reason_code, appointment_version, actor_id)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, cuspatlas.current_actor_id()) RETURNING id`,
                [appt.id, appt.subject_patient_id, target.id, p.reasonCode, appt.version + 1],
              );
              const updated = await tx.query<{ version: number }>(
                `UPDATE cuspatlas.appointments SET subject_patient_id = $1, version = version + 1, updated_at = now()
               WHERE id = $2 AND version = $3 RETURNING version`,
                [target.id, appt.id, appt.version],
              );
              const version = updated.rows[0]?.version;
              if (version === undefined) throw new RefusalError({ code: 'stale_version' });
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: APPOINTMENT_RESOURCE,
                  resourceRef: appt.id,
                  resourceVersion: version,
                },
                { changedFields: ['patient'] },
              );
              return {
                data: {
                  appointmentRef: appt.id,
                  patientRef: target.id,
                  previousPatientRef: appt.subject_patient_id,
                  reassignmentRef: (rows[0] as { id: string }).id,
                },
                version,
              };
            },
          );
        });
      });
    },
  };
}
