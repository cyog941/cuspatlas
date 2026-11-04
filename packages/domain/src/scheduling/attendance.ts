import {
  type ActorContext,
  type AttendanceCommandData,
  type AttendanceKind,
  type AttendanceRecord,
  type AttendanceState,
  type AttendanceTransitionRecord,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  type DailyWorklistData,
  type NoOperatoryReason,
  RefusalError,
  SCHEDULING_PROPERTIES,
  type TenantTransaction,
  type VisitStatusData,
  validateAttendanceRecord,
  validateWorklistQuery,
  type WorklistQuery,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { assertLocation } from '../policy/authorize';
import type { AppointmentBase } from './appointment-base';
import { loadAppointment } from './booking';
import { checkEnvelope, failedAt, loadLocation } from './resources';
import { addDays, isRealDate, localToInstant } from './zoned-time';

export const ATTENDANCE_RESOURCE = 'attendanceTransition';
const MAX_TRANSITIONS = 200;

/** Kinds that need a configured reason code (exception outcomes). */
const EXCEPTIONS: ReadonlySet<AttendanceKind> = new Set(['late', 'no_show', 'left_without_treatment']);
/** Kinds only the booking commands append (cancel, reschedule). */
const BOOKING_OWNED: ReadonlySet<AttendanceKind> = new Set(['cancelled', 'rescheduled']);
const TERMINAL: ReadonlySet<AttendanceState> = new Set([
  'left_without_treatment',
  'no_show',
  'cancelled',
  'rescheduled',
]);
/** States in which the visit has begun: the booking can no longer be cancelled or moved. */
const STARTED: ReadonlySet<AttendanceState> = new Set([
  'arrived',
  'waiting',
  'in_care',
  'left_without_treatment',
  'no_show',
]);

const stateOf = (kind: AttendanceKind): AttendanceState =>
  kind === 'confirmed_manual' || kind === 'confirmed_automated'
    ? 'confirmed'
    : kind === 'arrived' || kind === 'arrived_curbside'
      ? 'arrived'
      : kind;

/**
 * Transition guards (proposed; ADR 0009 does not decide them): what may follow each derived state.
 * Clinical completion and billing are not attendance kinds at all.
 */
const NEXT: Readonly<Record<AttendanceState, readonly AttendanceKind[]>> = {
  scheduled: [
    'confirmed_manual',
    'confirmed_automated',
    'arrived',
    'arrived_curbside',
    'late',
    'no_show',
    'cancelled',
    'rescheduled',
  ],
  confirmed: ['arrived', 'arrived_curbside', 'late', 'no_show', 'cancelled', 'rescheduled'],
  late: ['arrived', 'arrived_curbside', 'no_show', 'cancelled', 'rescheduled'],
  arrived: ['waiting', 'in_care', 'left_without_treatment'],
  waiting: ['in_care', 'left_without_treatment'],
  in_care: ['left_without_treatment'],
  left_without_treatment: [],
  no_show: [],
  cancelled: [],
  rescheduled: [],
};

const invalidTransition = () =>
  new RefusalError({ code: 'conflict', detail: { reason: 'attendance_transition_invalid' } });

interface TransitionRow extends Record<string, unknown> {
  id: string;
  appointment_id: string;
  sequence: number;
  kind: AttendanceKind;
  source: 'staff' | 'automation' | 'booking_command';
  provenance_ref: string | null;
  reason_code: string | null;
  note: string | null;
  claimed_at: Date | null;
  amends_transition_id: string | null;
  actor_id: string;
  occurred_at: Date;
}

/** Effective transitions after amendments, oldest first (an amendment replaces what it amends). */
function effective(rows: readonly TransitionRow[]): TransitionRow[] {
  const out: TransitionRow[] = [];
  for (const r of rows) {
    if (r.amends_transition_id !== null) {
      const i = out.findIndex((x) => x.id === r.amends_transition_id);
      if (i >= 0) out.splice(i, 1);
    }
    out.push(r);
  }
  return out;
}

const derive = (rows: readonly TransitionRow[]): AttendanceState => {
  const last = effective(rows).at(-1);
  return last === undefined ? 'scheduled' : stateOf(last.kind);
};

const confirmationOf = (rows: readonly TransitionRow[]): 'manual' | 'automated' | null => {
  const c = effective(rows)
    .filter((r) => r.kind === 'confirmed_manual' || r.kind === 'confirmed_automated')
    .at(-1);
  return c === undefined ? null : c.kind === 'confirmed_automated' ? 'automated' : 'manual';
};

async function loadTransitions(
  tx: TenantTransaction,
  appointmentIds: readonly string[],
): Promise<TransitionRow[]> {
  const { rows } = await tx.query<TransitionRow>(
    `SELECT id, appointment_id, sequence, kind, source, provenance_ref, reason_code, note, claimed_at,
       amends_transition_id, actor_id, occurred_at
     FROM cuspatlas.appointment_attendance_transitions WHERE appointment_id = ANY ($1::uuid[])
     ORDER BY appointment_id, sequence`,
    [appointmentIds],
  );
  return rows;
}

const toRecord = (r: TransitionRow): AttendanceTransitionRecord => ({
  transitionRef: r.id,
  appointmentRef: r.appointment_id,
  sequence: r.sequence,
  kind: r.kind,
  source: r.source,
  provenanceRef: r.provenance_ref,
  reasonCode: r.reason_code,
  note: r.note,
  claimedAt: r.claimed_at === null ? null : r.claimed_at.toISOString(),
  amendsTransitionRef: r.amends_transition_id,
  actorRef: r.actor_id,
  occurredAt: r.occurred_at.toISOString(),
});

async function append(
  tx: TenantTransaction,
  operation: string,
  appointmentId: string,
  sequence: number,
  t: {
    kind: AttendanceKind;
    source: 'staff' | 'automation' | 'booking_command';
    provenanceRef: string | null;
    reasonCode: string | null;
    note: string | null;
    claimedAt: string | null;
    amends: string | null;
  },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.appointment_attendance_transitions (tenant_id, appointment_id, sequence, kind, source,
       provenance_ref, reason_code, note, claimed_at, amends_transition_id, actor_id)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, cuspatlas.current_actor_id())
     RETURNING id`,
    [appointmentId, sequence, t.kind, t.source, t.provenanceRef, t.reasonCode, t.note, t.claimedAt, t.amends],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('insert returned no row');
  await recordCommand(
    tx,
    { operation, resourceType: ATTENDANCE_RESOURCE, resourceRef: id, resourceVersion: 1 },
    { changedFields: ['kind', ...(t.amends === null ? [] : ['amends'])] },
  );
  return id;
}

/**
 * Booking-side guard (S10 cancel and reschedule): a visit that has begun cannot be cancelled or
 * moved; otherwise the booking command appends the matching attendance fact in its transaction.
 */
export async function bookingAttendanceGuard(
  tx: TenantTransaction,
  operation: string,
  appointmentId: string,
  kind: 'cancelled' | 'rescheduled',
  reasonCode: string,
): Promise<void> {
  const rows = await loadTransitions(tx, [appointmentId]);
  const state = derive(rows);
  if (STARTED.has(state)) {
    throw new RefusalError({
      code: 'conflict',
      reasonCode: 'booking_refused',
      detail: { reason: 'attendance_started' },
    });
  }
  if (!NEXT[state].includes(kind)) throw invalidTransition();
  await append(tx, operation, appointmentId, rows.length + 1, {
    kind,
    source: 'booking_command',
    provenanceRef: null,
    reasonCode,
    note: null,
    claimedAt: null,
    amends: null,
  });
}

/** S11 commands and queries. Attendance writes no booking, clinical or financial state. */
export function createAttendanceOperations(base: AppointmentBase) {
  const { deps, execute } = base;
  return {
    recordAttendance(
      ctx: ActorContext,
      appointmentRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<AttendanceCommandData>> {
      const op = 'scheduling.attendance.record';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<AttendanceRecord>(validateAttendanceRecord, p, SCHEDULING_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          // Serializes with other transitions and with cancel/reschedule of the same booking.
          const appt = await loadAppointment(tx, decision, appointmentRef, 'FOR UPDATE OF a');
          return execute<AttendanceCommandData>(
            ctx,
            { ...envelope, payload: { appointmentRef, ...p } },
            tx,
            async () => {
              if (BOOKING_OWNED.has(p.kind)) throw failedAt('/kind', 'useBookingCommand');
              if (p.kind === 'confirmed_automated' && p.provenanceRef === undefined) {
                throw failedAt('/provenanceRef', 'required');
              }
              if (p.kind !== 'confirmed_automated' && p.provenanceRef !== undefined) {
                throw failedAt('/provenanceRef', 'onlyForAutomatedConfirmation');
              }
              const amending = p.amendsTransitionRef !== undefined;
              const reasonKind = amending ? 'amendment' : EXCEPTIONS.has(p.kind) ? p.kind : null;
              if (reasonKind === null && p.reasonCode !== undefined)
                throw failedAt('/reasonCode', 'onlyForExceptions');
              if (reasonKind !== null) {
                if (p.reasonCode === undefined) throw failedAt('/reasonCode', 'required');
                const configured = await tx.query(
                  'SELECT 1 FROM cuspatlas.scheduling_attendance_reasons WHERE kind = $1 AND reason_code = $2',
                  [reasonKind, p.reasonCode],
                );
                if (configured.rowCount === 0) throw failedAt('/reasonCode', 'notConfigured');
              }
              const rows = await loadTransitions(tx, [appt.id]);
              if (rows.length >= MAX_TRANSITIONS) throw failedAt('/', 'tooManyTransitions');
              const eff = effective(rows);
              let from: AttendanceState;
              if (amending) {
                const last = eff.at(-1);
                if (last === undefined || last.id !== p.amendsTransitionRef) {
                  throw new RefusalError({ code: 'conflict', detail: { reason: 'amend_latest_only' } });
                }
                if (last.source === 'booking_command') {
                  throw new RefusalError({ code: 'conflict', detail: { reason: 'amend_booking_fact' } });
                }
                from = derive(eff.slice(0, -1));
              } else {
                from = derive(rows);
              }
              if (appt.status !== 'booked' && !TERMINAL.has(from)) throw invalidTransition();
              if (!NEXT[from].includes(p.kind)) throw invalidTransition();
              const id = await append(tx, op, appt.id, rows.length + 1, {
                kind: p.kind,
                source: p.kind === 'confirmed_automated' ? 'automation' : 'staff',
                provenanceRef: p.provenanceRef ?? null,
                reasonCode: p.reasonCode ?? null,
                note: p.note ?? null,
                claimedAt: p.claimedAt === undefined ? null : new Date(p.claimedAt).toISOString(),
                amends: p.amendsTransitionRef ?? null,
              });
              return {
                data: {
                  transitionRef: id,
                  appointmentRef: appt.id,
                  kind: p.kind,
                  state: stateOf(p.kind),
                  sequence: rows.length + 1,
                },
                version: rows.length + 1,
              };
            },
          );
        });
      });
    },

    listAttendance(ctx: ActorContext, appointmentRef: string): Promise<AttendanceTransitionRecord[]> {
      return base.guarded(ctx, 'scheduling.attendance.list', async () => {
        const decision = await base.authorize(ctx, 'scheduling.attendance.list');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const appt = await loadAppointment(tx, decision, appointmentRef);
          return (await loadTransitions(tx, [appt.id])).map(toRecord);
        });
      });
    },

    getVisitStatus(ctx: ActorContext, appointmentRef: string): Promise<VisitStatusData> {
      return base.guarded(ctx, 'scheduling.attendance.visitStatus', async () => {
        const decision = await base.authorize(ctx, 'scheduling.attendance.visitStatus');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const appt = await loadAppointment(tx, decision, appointmentRef);
          const rows = await loadTransitions(tx, [appt.id]);
          const last = effective(rows).at(-1);
          return {
            appointmentRef: appt.id,
            booking: { status: appt.status, version: appt.version },
            attendance: {
              state: derive(rows),
              confirmation: confirmationOf(rows),
              lastTransitionAt: last === undefined ? null : last.occurred_at.toISOString(),
              transitions: rows.length,
            },
            clinicalCompletion: {
              ref: null,
              owner: 'C5',
              statement:
                'Encounter closure is recorded by the clinical workstream (C5), never by attendance.',
            },
            billing: {
              ref: null,
              owner: 'B1',
              statement: 'Charges and claims are recorded by billing (B1), never by attendance.',
            },
          };
        });
      });
    },

    dailyWorklist(ctx: ActorContext, query: unknown): Promise<DailyWorklistData> {
      return base.guarded(ctx, 'scheduling.worklist.daily', async () => {
        const decision = await base.authorize(ctx, 'scheduling.worklist.daily');
        assertValid<WorklistQuery>(validateWorklistQuery, query, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, query.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, query.locationRef);
          if (!isRealDate(query.date)) throw failedAt('/date', 'invalidDate');
          const from = localToInstant(query.date, 0, location.time_zone);
          const to = localToInstant(addDays(query.date, 1), 0, location.time_zone);
          const { rows } = await tx.query<{
            id: string;
            subject_patient_id: string;
            starts_at: Date;
            ends_at: Date;
            provider_id: string;
            operatory_id: string | null;
            no_operatory_reason: NoOperatoryReason | null;
            status: 'booked' | 'cancelled' | 'rescheduled';
          }>(
            `SELECT id, subject_patient_id, starts_at, ends_at, provider_id, operatory_id, no_operatory_reason, status
             FROM cuspatlas.appointments WHERE location_id = $1 AND starts_at >= $2 AND starts_at < $3
             ORDER BY starts_at, id LIMIT 200`,
            [location.id, new Date(from), new Date(to)],
          );
          const all = await loadTransitions(
            tx,
            rows.map((r) => r.id),
          );
          const counts: Record<string, number> = {
            booked: 0,
            cancelled: 0,
            rescheduled: 0,
            confirmedManual: 0,
            confirmedAutomated: 0,
          };
          const appointments = rows.map((a) => {
            const own = all.filter((t) => t.appointment_id === a.id);
            const state = derive(own);
            const confirmation = confirmationOf(own);
            counts[a.status] = (counts[a.status] ?? 0) + 1;
            const stateKey = `attendance_${state}`;
            counts[stateKey] = (counts[stateKey] ?? 0) + 1;
            if (confirmation === 'manual') counts.confirmedManual = (counts.confirmedManual ?? 0) + 1;
            if (confirmation === 'automated')
              counts.confirmedAutomated = (counts.confirmedAutomated ?? 0) + 1;
            return {
              appointmentRef: a.id,
              patientRef: a.subject_patient_id,
              startsAt: a.starts_at.toISOString(),
              endsAt: a.ends_at.toISOString(),
              provider: { kind: 'provider' as const, resourceRef: a.provider_id },
              operatory:
                a.operatory_id === null ? null : { kind: 'operatory' as const, resourceRef: a.operatory_id },
              noOperatoryReason: a.no_operatory_reason,
              status: a.status,
              attendanceState: state,
              confirmation,
            };
          });
          return {
            locationRef: location.location_ref,
            date: query.date,
            timeZone: location.time_zone,
            counts,
            appointments,
          };
        });
      });
    },
  };
}

export type AttendanceOperations = ReturnType<typeof createAttendanceOperations>;
