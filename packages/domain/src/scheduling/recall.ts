import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  type FollowUpWorklistQuery,
  type RecallDueQuery,
  type RecallPolicyDefine,
  type RecallTaskCreate,
  type RecallTaskResolve,
  RefusalError,
  SCHEDULING_PROPERTIES,
  type TenantTransaction,
  validateFollowUpWorklistQuery,
  validateRecallDueQuery,
  validateRecallPolicyDefine,
  validateRecallTaskCreate,
  validateRecallTaskResolve,
  validateSchedulingEntityRef,
  type WorkItem,
  type WorkItemListData,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { type AuthorizationDecision, assertLocation } from '../policy/authorize';
import { AVAILABLE, workItem, workList } from '../work-items';
import { type AppointmentBase, assertVisibleLocation } from './appointment-base';
import { attendanceStatesOf } from './attendance';
import { currentIntentOf, recordNotificationIntent } from './notification-intent';
import { occurrenceDate } from './recurrence';
import { checkEnvelope, loadLocation, notFound } from './resources';
import { formatLocal, localToInstant } from './zoned-time';

/**
 * S16: recall policy and due computation (ADR 0009 S-D7, recommended-pending-approval). The due list
 * is computed from stored state on every read and writes nothing; it states the policy version and
 * its freshness basis. The implementable qualifying event is an attended visit (the latest booking
 * whose derived S11 attendance reached arrival: arrived, waiting or in care); the completed-procedure
 * basis is refused until C14 exists. Whether a due patient may be contacted is E6's decision; this
 * module evaluates no consent. PT-03 (S part): the follow-up worklist of open recall tasks and
 * unbooked or lost-booking requests; treatment, lab and referral follow-up are C-owned and reported as
 * not covered.
 */
export const RECALL_TASK_RESOURCE = 'recallTask';
export const RECALL_POLICY_RESOURCE = 'recallPolicy';
const ATTENDED = new Set(['arrived', 'waiting', 'in_care']);
const LIMIT = 500;

export interface RecallPolicyRecord {
  readonly policyRef: string;
  readonly category: string;
  readonly version: number;
  readonly intervalMonths: number;
  readonly basis: 'attended_visit';
  readonly appointmentTypeCodes: string[];
  readonly excludeBooked: boolean;
  readonly createdAt: string;
}
export interface RecallDueData {
  readonly asOf: string;
  readonly policy: RecallPolicyRecord;
  readonly freshness: {
    readonly computedAt: string;
    readonly basis: 'computed_from_stored_state';
    readonly sourceAgeSeconds: number;
  };
  readonly due: {
    readonly patientRef: string;
    readonly lastEventRef: string;
    readonly lastEventAt: string;
    readonly dueDate: string;
    readonly reason: 'interval_elapsed';
    readonly futureBookingRef: string | null;
    readonly exclusionNotApplied: 'already_booked' | null;
    readonly openTaskRef: string | null;
  }[];
  readonly excluded: {
    readonly patientRef: string;
    readonly reason: 'already_booked' | 'patient_deceased' | 'patient_inactive';
  }[];
  readonly noBaseline: { readonly patientRef: string }[];
  readonly counts: { readonly due: number; readonly excluded: number; readonly noBaseline: number };
}
export interface RecallTaskData {
  readonly recallTaskRef: string;
  readonly state: 'open' | 'resolved';
  readonly created: boolean;
  readonly policyVersion: number;
  readonly dueDate: string;
  readonly intentRef: string | null;
}

interface PolicyRow extends Record<string, unknown> {
  id: string;
  category: string;
  version: number;
  interval_months: number;
  basis: 'attended_visit';
  appointment_type_codes: string[];
  exclude_booked: boolean;
  created_at: Date;
}
const POLICY_COLUMNS =
  'id, category, version, interval_months, basis, appointment_type_codes, exclude_booked, created_at';
const policyRecord = (p: PolicyRow): RecallPolicyRecord => ({
  policyRef: p.id,
  category: p.category,
  version: p.version,
  intervalMonths: p.interval_months,
  basis: p.basis,
  appointmentTypeCodes: p.appointment_type_codes,
  excludeBooked: p.exclude_booked,
  createdAt: p.created_at.toISOString(),
});

/** The current (latest) version of a category; another tenant's category is indistinguishable. */
async function currentPolicy(tx: TenantTransaction, category: string): Promise<PolicyRow> {
  const { rows } = await tx.query<PolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM cuspatlas.recall_policies WHERE category = $1 ORDER BY version DESC LIMIT 1`,
    [category],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * The due computation. Visibility: a tenant-wide caller sees every patient of the tenant; a
 * location-restricted caller (or a query naming a location) sees only patients with a booking at
 * those locations, and only events and bookings there, so no other location is enumerated.
 */
async function computeDue(
  tx: TenantTransaction,
  locations: readonly string[] | null,
  policy: PolicyRow,
  asOf: number,
): Promise<RecallDueData> {
  const types = policy.appointment_type_codes.length > 0 ? policy.appointment_type_codes : null;
  const past = await tx.query<{
    id: string;
    subject_patient_id: string;
    starts_at: Date;
    time_zone: string;
  }>(
    `SELECT a.id, a.subject_patient_id, a.starts_at, a.time_zone FROM cuspatlas.appointments a
     JOIN cuspatlas.scheduling_locations l ON l.id = a.location_id AND l.tenant_id = a.tenant_id
     WHERE a.status = 'booked' AND a.starts_at <= $1 AND ($2::text[] IS NULL OR l.location_ref = ANY ($2::text[]))
       AND ($3::text[] IS NULL OR a.appointment_type_code = ANY ($3::text[]))
     ORDER BY a.starts_at DESC, a.id`,
    [new Date(asOf), locations, types],
  );
  const states = await attendanceStatesOf(
    tx,
    past.rows.map((r) => r.id),
  );
  const lastEvent = new Map<string, (typeof past.rows)[number]>();
  for (const r of past.rows) {
    if (lastEvent.has(r.subject_patient_id)) continue;
    if (ATTENDED.has(states.get(r.id) ?? 'scheduled')) lastEvent.set(r.subject_patient_id, r);
  }
  const future = await tx.query<{ id: string; subject_patient_id: string }>(
    `SELECT DISTINCT ON (a.subject_patient_id) a.id, a.subject_patient_id FROM cuspatlas.appointments a
     JOIN cuspatlas.scheduling_locations l ON l.id = a.location_id AND l.tenant_id = a.tenant_id
     WHERE a.status = 'booked' AND a.starts_at > $1 AND ($2::text[] IS NULL OR l.location_ref = ANY ($2::text[]))
     ORDER BY a.subject_patient_id, a.starts_at, a.id`,
    [new Date(asOf), locations],
  );
  const booked = new Map(future.rows.map((r) => [r.subject_patient_id, r.id]));
  const population = await tx.query<{ id: string; status: 'active' | 'inactive' | 'deceased' }>(
    locations === null
      ? 'SELECT id, status FROM cuspatlas.patients WHERE merged_into IS NULL ORDER BY id'
      : `SELECT p.id, p.status FROM cuspatlas.patients p WHERE p.merged_into IS NULL AND EXISTS (
           SELECT 1 FROM cuspatlas.appointments a
           JOIN cuspatlas.scheduling_locations l ON l.id = a.location_id AND l.tenant_id = a.tenant_id
           WHERE a.subject_patient_id = p.id AND l.location_ref = ANY ($1::text[])) ORDER BY p.id`,
    locations === null ? [] : [locations],
  );
  const tasks = await tx.query<{ id: string; subject_patient_id: string }>(
    `SELECT t.id, t.subject_patient_id FROM cuspatlas.recall_tasks t
     JOIN cuspatlas.recall_policies p ON p.id = t.policy_id AND p.tenant_id = t.tenant_id
     WHERE t.state = 'open' AND p.category = $1 ORDER BY t.created_at, t.id`,
    [policy.category],
  );
  const openTask = new Map(tasks.rows.map((t) => [t.subject_patient_id, t.id]));
  const due: RecallDueData['due'][number][] = [];
  const excluded: RecallDueData['excluded'][number][] = [];
  const noBaseline: RecallDueData['noBaseline'][number][] = [];
  for (const p of population.rows) {
    if (p.status === 'deceased' || p.status === 'inactive') {
      excluded.push({
        patientRef: p.id,
        reason: p.status === 'deceased' ? 'patient_deceased' : 'patient_inactive',
      });
      continue;
    }
    const ev = lastEvent.get(p.id);
    if (!ev) {
      noBaseline.push({ patientRef: p.id });
      continue;
    }
    // Interval in the visit's own zone; month-end clamps as in S-S3-R1.
    const eventDate = formatLocal(ev.starts_at.getTime(), ev.time_zone).slice(0, 10);
    const dueDate = occurrenceDate(eventDate, 'monthly', policy.interval_months, 1);
    if (dueDate > formatLocal(asOf, ev.time_zone).slice(0, 10)) continue;
    const futureRef = booked.get(p.id) ?? null;
    if (futureRef !== null && policy.exclude_booked) {
      excluded.push({ patientRef: p.id, reason: 'already_booked' });
      continue;
    }
    due.push({
      patientRef: p.id,
      lastEventRef: ev.id,
      lastEventAt: ev.starts_at.toISOString(),
      dueDate,
      reason: 'interval_elapsed',
      futureBookingRef: futureRef,
      exclusionNotApplied: futureRef === null ? null : 'already_booked',
      openTaskRef: openTask.get(p.id) ?? null,
    });
  }
  const now = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
  return {
    asOf: new Date(asOf).toISOString(),
    policy: policyRecord(policy),
    freshness: { computedAt: now.toISOString(), basis: 'computed_from_stored_state', sourceAgeSeconds: 0 },
    due: due.slice(0, LIMIT),
    excluded: excluded.slice(0, LIMIT),
    noBaseline: noBaseline.slice(0, LIMIT),
    counts: { due: due.length, excluded: excluded.length, noBaseline: noBaseline.length },
  };
}

/**
 * E6 seam (published for recall enrollment): S16's due computation for the current policy of a
 * category, unchanged. E consumes the due list; it never re-derives recall policy.
 */
export async function recallDueFor(
  tx: TenantTransaction,
  locations: readonly string[] | null,
  category: string,
  asOf: number,
): Promise<RecallDueData> {
  return computeDue(tx, locations, await currentPolicy(tx, category), asOf);
}

const scopeOf = (decision: AuthorizationDecision, locationRef: string | undefined) =>
  locationRef !== undefined ? [locationRef] : decision.locationRefs;

const NOT_COVERED = [
  { area: 'accepted_unscheduled_treatment', owner: 'C11', reason: 'producer_not_deployed' },
  { area: 'lab_returns', owner: 'C16', reason: 'producer_not_deployed' },
  { area: 'referral_responses', owner: 'C17', reason: 'producer_not_deployed' },
];

export function createRecallOperations(base: AppointmentBase) {
  const { deps, execute } = base;
  return {
    defineRecallPolicy(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'scheduling.recall.definePolicy';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as RecallPolicyDefine;
        assertValid<RecallPolicyDefine>(validateRecallPolicyDefine, p, SCHEDULING_PROPERTIES);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute<{ policyRef: string; category: string; version: number }>(ctx, envelope, tx, async () => {
            if (p.basis !== 'attended_visit') {
              // C14 completion events do not exist; no substitute basis is invented.
              throw new RefusalError({
                code: 'conflict',
                reasonCode: 'booking_refused',
                replayable: false,
                detail: { reason: 'basis_unavailable' },
              });
            }
            // Versions of one category serialize on the latest row (a concurrent define gets 23505).
            const latest = await tx.query<{ version: number }>(
              'SELECT max(version)::int AS version FROM cuspatlas.recall_policies WHERE category = $1',
              [p.category],
            );
            const version = (latest.rows[0]?.version ?? 0) + 1;
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.recall_policies (tenant_id, category, version, interval_months, basis,
                 appointment_type_codes, exclude_booked, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5::text[], $6, cuspatlas.current_actor_id())
               RETURNING id`,
              [
                p.category,
                version,
                p.intervalMonths,
                p.basis,
                [...(p.appointmentTypeCodes ?? [])].sort(),
                p.excludeBooked ?? true,
              ],
            );
            const id = rows[0]?.id;
            if (!id) throw new Error('insert returned no row');
            await recordCommand(
              tx,
              { operation: op, resourceType: RECALL_POLICY_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['category', 'interval', 'basis', 'exclusion'] },
            );
            return { data: { policyRef: id, category: p.category, version }, version: 1 };
          }),
        );
      });
    },

    listRecallPolicies(ctx: ActorContext): Promise<RecallPolicyRecord[]> {
      const op = 'scheduling.recall.policies';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<PolicyRow>(
            `SELECT ${POLICY_COLUMNS} FROM cuspatlas.recall_policies ORDER BY category, version LIMIT 200`,
          );
          return rows.map(policyRecord);
        });
      });
    },

    recallDue(ctx: ActorContext, query: unknown): Promise<RecallDueData> {
      const op = 'scheduling.recall.due';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        const q = query as RecallDueQuery;
        assertValid<RecallDueQuery>(validateRecallDueQuery, q, SCHEDULING_PROPERTIES);
        if (q.locationRef !== undefined) assertLocation(decision.locationRefs, q.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const policy = await currentPolicy(tx, q.category);
          const asOf = q.asOf === undefined ? Date.now() : Date.parse(q.asOf);
          return computeDue(tx, scopeOf(decision, q.locationRef), policy, asOf);
        });
      });
    },

    createRecallTask(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<RecallTaskData>> {
      const op = 'scheduling.recall.createTask';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as RecallTaskCreate;
        assertValid<RecallTaskCreate>(validateRecallTaskCreate, p, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, p.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, p.locationRef);
          const policy = await currentPolicy(tx, p.category);
          return execute<RecallTaskData>(ctx, envelope, tx, async () => {
            if (policy.version !== p.expectedPolicyVersion) {
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: policy.version } });
            }
            const existing = await tx.query<{ id: string; due_date: string; version: number }>(
              `SELECT id, to_char(due_date, 'YYYY-MM-DD') AS due_date, version FROM cuspatlas.recall_tasks
               WHERE subject_patient_id = $1 AND policy_id = $2 AND state = 'open' FOR UPDATE`,
              [p.patientRef, policy.id],
            );
            const open = existing.rows[0];
            if (open) {
              return {
                data: {
                  recallTaskRef: open.id,
                  state: 'open',
                  created: false,
                  policyVersion: policy.version,
                  dueDate: open.due_date,
                  intentRef: await currentIntentOf(tx, open.id, 'recall'),
                },
                version: open.version,
              };
            }
            const asOf = p.asOf === undefined ? Date.now() : Date.parse(p.asOf);
            const list = await computeDue(tx, decision.locationRefs, policy, asOf);
            const item = list.due.find((d) => d.patientRef === p.patientRef);
            if (!item) {
              throw new RefusalError({
                code: 'conflict',
                reasonCode: 'booking_refused',
                detail: { reason: 'not_due' },
              });
            }
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.recall_tasks (tenant_id, subject_patient_id, location_id, policy_id, category,
                 policy_version, due_date, last_event_appointment_id, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6::date, $7, cuspatlas.current_actor_id())
               RETURNING id`,
              [
                p.patientRef,
                location.id,
                policy.id,
                policy.category,
                policy.version,
                item.dueDate,
                item.lastEventRef,
              ],
            );
            const id = rows[0]?.id;
            if (!id) throw new Error('insert returned no row');
            await recordCommand(
              tx,
              { operation: op, resourceType: RECALL_TASK_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['patientRef', 'policy', 'dueDate', 'state'] },
            );
            const intentRef = await recordNotificationIntent(tx, op, {
              subjectKind: 'recall_task',
              subjectId: id,
              locationId: location.id,
              purpose: 'recall',
              dueAt: new Date(localToInstant(item.dueDate, 0, location.time_zone)),
            });
            return {
              data: {
                recallTaskRef: id,
                state: 'open',
                created: true,
                policyVersion: policy.version,
                dueDate: item.dueDate,
                intentRef,
              },
              version: 1,
            };
          });
        });
      });
    },

    resolveRecallTask(
      ctx: ActorContext,
      recallTaskRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<RecallTaskData>> {
      const op = 'scheduling.recall.resolveTask';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as RecallTaskResolve;
        assertValid<RecallTaskResolve>(validateRecallTaskResolve, p, SCHEDULING_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          if (!validateSchedulingEntityRef(recallTaskRef)) throw notFound();
          const { rows } = await tx.query<{
            id: string;
            location_ref: string;
            state: 'open' | 'resolved';
            policy_version: number;
            due_date: string;
            version: number;
          }>(
            `SELECT t.id, l.location_ref, t.state, t.policy_version, to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
               t.version
             FROM cuspatlas.recall_tasks t
             JOIN cuspatlas.scheduling_locations l ON l.id = t.location_id AND l.tenant_id = t.tenant_id
             WHERE t.id = $1 FOR UPDATE OF t`,
            [recallTaskRef],
          );
          const t = rows[0];
          if (!t) throw notFound();
          assertVisibleLocation(decision, t.location_ref);
          return execute<RecallTaskData>(
            ctx,
            { ...envelope, payload: { recallTaskRef, ...p } },
            tx,
            async () => {
              if (t.version !== p.expectedVersion)
                throw new RefusalError({ code: 'stale_version', detail: { currentVersion: t.version } });
              if (t.state !== 'open')
                throw new RefusalError({ code: 'conflict', detail: { reason: 'task_resolved' } });
              // Never deleted: the task records how it was resolved.
              await tx.query(
                `UPDATE cuspatlas.recall_tasks SET state = 'resolved', resolution_reason = $1, resolved_at = now(),
                 version = version + 1, updated_at = now() WHERE id = $2`,
                [p.reasonCode, t.id],
              );
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: RECALL_TASK_RESOURCE,
                  resourceRef: t.id,
                  resourceVersion: t.version + 1,
                },
                { changedFields: ['state'] },
              );
              return {
                data: {
                  recallTaskRef: t.id,
                  state: 'resolved',
                  created: false,
                  policyVersion: t.policy_version,
                  dueDate: t.due_date,
                  intentRef: null,
                },
                version: t.version + 1,
              };
            },
          );
        });
      });
    },

    followUpWorklist(ctx: ActorContext, query: unknown): Promise<WorkItemListData> {
      const op = 'scheduling.followUp.worklist';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        const q = query as FollowUpWorklistQuery;
        assertValid<FollowUpWorklistQuery>(validateFollowUpWorklistQuery, q, SCHEDULING_PROPERTIES);
        if (q.locationRef !== undefined) assertLocation(decision.locationRefs, q.locationRef);
        const scope = scopeOf(decision, q.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const items: WorkItem[] = [];
          const tasks = await tx.query<{
            id: string;
            subject_patient_id: string;
            due_date: string;
            time_zone: string;
            merged: boolean;
            booked: boolean;
          }>(
            `SELECT t.id, t.subject_patient_id, to_char(t.due_date, 'YYYY-MM-DD') AS due_date, l.time_zone,
               (p.merged_into IS NOT NULL) AS merged,
               EXISTS (SELECT 1 FROM cuspatlas.appointments a WHERE a.subject_patient_id = t.subject_patient_id
                 AND a.status = 'booked' AND a.starts_at > now()) AS booked
             FROM cuspatlas.recall_tasks t
             JOIN cuspatlas.scheduling_locations l ON l.id = t.location_id AND l.tenant_id = t.tenant_id
             JOIN cuspatlas.patients p ON p.id = t.subject_patient_id AND p.tenant_id = t.tenant_id
             WHERE t.state = 'open' AND ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[]))
             ORDER BY t.due_date, t.id LIMIT 300`,
            [scope],
          );
          for (const t of tasks.rows) {
            const reason = t.merged
              ? 'patient_merged'
              : t.booked
                ? 'patient_booked_since_task'
                : 'recall_contact_due';
            items.push(
              workItem({
                workItemRef: t.id,
                kind: 'recall_task_open',
                reasonCode: reason,
                explanation:
                  reason === 'recall_contact_due'
                    ? 'The patient is due for recall and has no booking. Contact them through the practice process; no message was sent.'
                    : reason === 'patient_booked_since_task'
                      ? 'The patient booked after this recall task was created. Resolve the task with a reason.'
                      : 'The patient record was merged into another; resolve this task and recompute recall for the survivor.',
                evidenceRefs: [
                  { kind: 'recallTask', ref: t.id },
                  { kind: 'patient', ref: t.subject_patient_id },
                ],
                owner: { queue: 'recall', principalRef: null },
                dueAt: new Date(localToInstant(t.due_date, 0, t.time_zone)).toISOString(),
                suggestedNextAction: reason === 'recall_contact_due' ? 'contact_for_recall' : 'resolve_task',
                blockingDependencies: reason === 'recall_contact_due' ? ['E6'] : [],
              }),
            );
          }
          const requests = await tx.query<{
            id: string;
            state: string;
            urgent: boolean;
            appointment_id: string | null;
            appointment_status: string | null;
            subject_patient_id: string;
          }>(
            `SELECT q.id, q.state, q.urgent, q.appointment_id, a.status AS appointment_status, q.subject_patient_id
             FROM cuspatlas.appointment_requests q
             JOIN cuspatlas.scheduling_locations l ON l.id = q.location_id AND l.tenant_id = q.tenant_id
             LEFT JOIN cuspatlas.appointments a ON a.id = q.appointment_id AND a.tenant_id = q.tenant_id
             WHERE ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[]))
               AND (q.state IN ('open', 'in_review') OR (q.state = 'scheduled' AND a.status IN ('cancelled', 'booked')))
             ORDER BY q.created_at, q.id LIMIT 300`,
            [scope],
          );
          const scheduled = requests.rows.filter((r) => r.state === 'scheduled' && r.appointment_id !== null);
          const noShow = await attendanceStatesOf(
            tx,
            scheduled.map((r) => r.appointment_id as string),
          );
          for (const r of requests.rows) {
            // A scheduled request whose booking still stands is fine unless the visit was a no-show.
            if (
              r.state === 'scheduled' &&
              r.appointment_status === 'booked' &&
              noShow.get(r.appointment_id as string) !== 'no_show'
            )
              continue;
            const lost = r.state === 'scheduled';
            items.push(
              workItem({
                workItemRef: r.id,
                kind: lost ? 'request_booking_lost' : 'request_unbooked',
                reasonCode: lost
                  ? noShow.get(r.appointment_id as string) === 'no_show'
                    ? 'linked_booking_no_show'
                    : 'linked_booking_cancelled'
                  : 'request_open_unbooked',
                explanation: lost
                  ? 'The booking made for this request was cancelled and nothing replaced it. Rebook or close the request with a reason.'
                  : 'This appointment request has no booking yet. Offer a time or close it with a reason.',
                evidenceRefs: [
                  { kind: 'appointmentRequest', ref: r.id },
                  ...(r.appointment_id ? [{ kind: 'appointment', ref: r.appointment_id }] : []),
                ],
                owner: { queue: 'scheduling', principalRef: null },
                dueAt: null,
                priority: r.urgent ? 'urgent' : 'routine',
                priorityRationale: r.urgent ? 'request_marked_urgent' : 'default_routine',
                suggestedNextAction: lost ? 'rebook_or_close_request' : 'offer_appointment',
                blockingDependencies: [],
              }),
            );
          }
          const now = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          return { ...workList(now, AVAILABLE, items), notCovered: NOT_COVERED };
        });
      });
    },
  };
}

export type RecallOperations = ReturnType<typeof createRecallOperations>;
