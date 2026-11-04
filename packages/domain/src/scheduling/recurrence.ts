import {
  type ActorContext,
  assertValid,
  type BookingWindowInput,
  type CommandEnvelope,
  type CommandResult,
  type Conflict,
  RefusalError,
  SCHEDULING_PROPERTIES,
  SERIES_DEFAULT_LIMIT,
  SERIES_LIMIT_CEILING,
  SERIES_LIMIT_NAME,
  type SeriesCommandData,
  type SeriesCreate,
  type SeriesEnd,
  type SeriesExtend,
  type SeriesPlanData,
  type SeriesRecord,
  type TenantTransaction,
  validateSchedulingEntityRef,
  validateSeriesCreate,
  validateSeriesEnd,
  validateSeriesExtend,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { type AuthorizationDecision, assertLocation } from '../policy/authorize';
import { type AppointmentBase, assertVisibleLocation } from './appointment-base';
import {
  availabilityConflicts,
  busyConflicts,
  insertBookingIn,
  patientConflicts,
  prepareWindow,
} from './booking';
import {
  checkEnvelope,
  failedAt,
  type LocationRow,
  loadLocation,
  MAX_CONFLICTS,
  notFound,
} from './resources';
import { localToInstant, minutesOf } from './zoned-time';

export const SERIES_RESOURCE = 'appointmentSeries';
const MINUTE = 60_000;
/** Conflicts reported per occurrence (the refusal stays bounded: at most 52 x 10). */
const MAX_CONFLICTS_PER_OCCURRENCE = 10;

/** One computed occurrence (1-based index) in the location's zone. */
interface Planned {
  readonly index: number;
  readonly localDate: string;
  readonly s: number;
  readonly e: number;
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Local date of occurrence `k` (0-based). Weekly: every `interval` weeks. Monthly (S-S3-R1): the
 * anchor day, or the last day of a month that has no such day; the anchor is kept, so a series
 * anchored on the 31st returns to the 31st in the next long month. Never skipped, never moved into
 * the next month.
 */
export function occurrenceDate(first: string, frequency: 'weekly' | 'monthly', interval: number, k: number) {
  const [y, m, d] = first.split('-').map(Number) as [number, number, number];
  if (frequency === 'weekly') {
    return new Date(Date.UTC(y, m - 1, d) + k * interval * 7 * 86_400_000).toISOString().slice(0, 10);
  }
  const total = m - 1 + k * interval;
  const yy = y + Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${yy}-${pad(mm)}-${pad(Math.min(d, daysInMonth(yy, mm)))}`;
}

/**
 * Occurrences `from`..`from+count-1`. Wall-clock start in the location zone resolved with S-S3-R2
 * (a missing local time moves forward by the gap, a repeated one takes the earlier instant); the
 * duration is real elapsed minutes.
 */
function plan(
  p: {
    firstDate: string;
    frequency: 'weekly' | 'monthly';
    interval: number;
    startMinutes: number;
    duration: number;
  },
  timeZone: string,
  from: number,
  count: number,
): Planned[] {
  const out: Planned[] = [];
  for (let index = from; index < from + count; index += 1) {
    const localDate = occurrenceDate(p.firstDate, p.frequency, p.interval, index - 1);
    const s = localToInstant(localDate, p.startMinutes, timeZone);
    out.push({ index, localDate, s, e: s + p.duration * MINUTE });
  }
  return out;
}

interface SeriesRow extends Record<string, unknown> {
  id: string;
  subject_patient_id: string;
  location_id: string;
  location_ref: string;
  frequency: 'weekly' | 'monthly';
  interval_count: number;
  first_date: string;
  start_minutes: number;
  duration_minutes: number;
  time_zone: string;
  provider_id: string;
  operatory_id: string | null;
  no_operatory_reason: BookingWindowInput['noOperatoryReason'] | null;
  additional_resource_ids: string[];
  additional_kinds: ('equipment' | 'staff')[];
  appointment_type_code: string | null;
  limit_at_creation: number;
  occurrence_count: number;
  state: 'active' | 'ended';
  end_reason: string | null;
  version: number;
}

const SERIES_COLUMNS = `s.id, s.subject_patient_id, s.location_id, l.location_ref, s.frequency, s.interval_count,
  to_char(s.first_date, 'YYYY-MM-DD') AS first_date, s.start_minutes, s.duration_minutes, s.time_zone, s.provider_id,
  s.operatory_id, s.no_operatory_reason, s.additional_resource_ids,
  ARRAY(SELECT r.kind FROM unnest(s.additional_resource_ids) WITH ORDINALITY AS x(id, n)
        JOIN cuspatlas.scheduling_resources r ON r.id = x.id ORDER BY x.n) AS additional_kinds,
  s.appointment_type_code, s.limit_at_creation, s.occurrence_count, s.state, s.end_reason, s.version`;

async function loadSeries(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  seriesRef: string,
  lock: '' | 'FOR UPDATE OF s' = '',
): Promise<SeriesRow> {
  if (!validateSchedulingEntityRef(seriesRef)) throw notFound();
  const { rows } = await tx.query<SeriesRow>(
    `SELECT ${SERIES_COLUMNS} FROM cuspatlas.appointment_series s
     JOIN cuspatlas.scheduling_locations l ON l.id = s.location_id AND l.tenant_id = s.tenant_id
     WHERE s.id = $1 ${lock}`,
    [seriesRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  assertVisibleLocation(decision, row.location_ref);
  return row;
}

/** The configured per-request limit (ADR 0009 S-D1 pending approval: default 26, ceiling 52). */
async function occurrenceLimit(tx: TenantTransaction): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    'SELECT series_occurrence_limit AS n FROM cuspatlas.scheduling_policy_settings',
  );
  return Math.min(rows[0]?.n ?? SERIES_DEFAULT_LIMIT, SERIES_LIMIT_CEILING);
}

function assertWithinLimit(count: number, limit: number): void {
  if (count > limit) {
    throw new RefusalError({
      code: 'validation_failed',
      reasonCode: 'booking_refused',
      detail: {
        reason: 'series_limit_exceeded',
        limit: { name: SERIES_LIMIT_NAME, value: limit },
        violations: [{ pointer: '/count', rule: 'seriesLimit' }],
      },
    });
  }
}

interface Shape {
  readonly patientRef: string;
  readonly window: Omit<BookingWindowInput, 'startsAt' | 'endsAt'>;
  readonly appointmentTypeCode: string | null;
}

const shapeOfRequest = (p: SeriesCreate, timeZone: string): Shape => ({
  patientRef: p.patientRef,
  window: {
    timeZone,
    provider: p.provider,
    operatory: p.operatory,
    ...(p.noOperatoryReason === undefined ? {} : { noOperatoryReason: p.noOperatoryReason }),
    ...(p.resources === undefined ? {} : { resources: p.resources }),
  },
  appointmentTypeCode: p.appointmentTypeCode ?? null,
});

const shapeOfRow = (r: SeriesRow): Shape => ({
  patientRef: r.subject_patient_id,
  window: {
    timeZone: r.time_zone,
    provider: { kind: 'provider', resourceRef: r.provider_id },
    operatory: r.operatory_id === null ? null : { kind: 'operatory', resourceRef: r.operatory_id },
    ...(r.no_operatory_reason ? { noOperatoryReason: r.no_operatory_reason } : {}),
    ...(r.additional_resource_ids.length > 0
      ? {
          resources: r.additional_resource_ids.map((id, i) => ({
            kind: r.additional_kinds[i] ?? 'equipment',
            resourceRef: id,
          })),
        }
      : {}),
  },
  appointmentTypeCode: r.appointment_type_code,
});

/** Per-occurrence checks without any write (the same checks the S10 insert path applies). */
async function check(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  location: LocationRow,
  shape: Shape,
  occurrences: readonly Planned[],
  canReadBookings: boolean,
) {
  const patient = await patientConflicts(tx, shape.patientRef);
  const out: { o: Planned; conflicts: Conflict[]; prepared: Awaited<ReturnType<typeof prepareWindow>> }[] =
    [];
  for (const o of occurrences) {
    const prepared = await prepareWindow(tx, decision, location, {
      ...shape.window,
      startsAt: new Date(o.s).toISOString(),
      endsAt: new Date(o.e).toISOString(),
    });
    const ids = prepared.resources.map((r) => r.id);
    const conflicts = [
      ...patient,
      ...(await availabilityConflicts(tx, prepared.resources, prepared.w, location.time_zone)),
      ...(await busyConflicts(tx, location, ids, prepared.w, [], canReadBookings)),
    ].slice(0, MAX_CONFLICTS_PER_OCCURRENCE);
    out.push({ o, conflicts, prepared });
  }
  return out;
}

const seriesConflict = (checked: { o: Planned; conflicts: Conflict[] }[]) => {
  const blocked = checked.filter((c) => c.conflicts.length > 0);
  // Not replayed from the idempotency record: the blocking bookings can be cancelled, and the
  // per-occurrence detail is evaluated for the current caller on every attempt.
  return new RefusalError({
    code: 'conflict',
    reasonCode: 'booking_conflict',
    replayable: false,
    detail: {
      reason: 'booking_conflict',
      conflicts: blocked.flatMap((b) => b.conflicts).slice(0, MAX_CONFLICTS),
      occurrences: blocked.map((b) => ({
        index: b.o.index,
        startsAt: new Date(b.o.s).toISOString(),
        conflicts: b.conflicts,
      })),
    },
  });
};

/** S13 commands and queries. Occurrences are bookings through the S10 insert path. */
export function createRecurrenceOperations(base: AppointmentBase) {
  const { deps, execute } = base;

  /**
   * Books occurrences after the full pre-check: atomically (any conflict refuses the whole set and
   * writes nothing) or, with `skip`, only the conflict-free ones (skipped ones are recorded with the
   * first conflict kind as the reason). A conflict that appears between pre-check and insert (a
   * concurrent booking) fails the whole transaction through the occupancy constraint.
   */
  async function materialize(
    tx: TenantTransaction,
    operation: string,
    decision: AuthorizationDecision,
    location: LocationRow,
    seriesId: string,
    shape: Shape,
    occurrences: readonly Planned[],
    skip: boolean,
    canReadBookings: boolean,
  ) {
    const checked = await check(tx, decision, location, shape, occurrences, canReadBookings);
    const blocked = checked.filter((c) => c.conflicts.length > 0);
    if (blocked.length > 0 && (!skip || blocked.length === checked.length)) throw seriesConflict(checked);
    const appointmentRefs: string[] = [];
    const skippedOccurrences: SeriesCommandData['skippedOccurrences'] = [];
    for (const c of checked) {
      if (c.conflicts.length > 0) {
        const reason = (c.conflicts[0] as Conflict).kind;
        skippedOccurrences.push({ index: c.o.index, localDate: c.o.localDate, reason });
        await insertOccurrence(tx, seriesId, c.o, null, reason);
        continue;
      }
      const id = await insertBookingIn(tx, operation, {
        location,
        prepared: c.prepared,
        patientRef: shape.patientRef,
        timeZone: location.time_zone,
        appointmentTypeCode: shape.appointmentTypeCode,
        requestId: null,
        holdId: null,
        rescheduledFrom: null,
        ignoreSources: [],
        canReadBookings,
        override: undefined,
        canOverride: false,
        extraConflicts: [],
      });
      await insertOccurrence(tx, seriesId, c.o, id, null);
      appointmentRefs.push(id);
    }
    return { appointmentRefs, skippedOccurrences };
  }

  async function insertOccurrence(
    tx: TenantTransaction,
    seriesId: string,
    o: Planned,
    appointmentId: string | null,
    skipReason: string | null,
  ) {
    await tx.query(
      `INSERT INTO cuspatlas.appointment_series_occurrences (tenant_id, series_id, occurrence_index, local_date,
         starts_at, ends_at, outcome, appointment_id, skip_reason)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3::date, $4, $5, $6, $7, $8)`,
      [
        seriesId,
        o.index,
        o.localDate,
        new Date(o.s),
        new Date(o.e),
        appointmentId === null ? 'skipped' : 'booked',
        appointmentId,
        skipReason,
      ],
    );
  }

  const requestPlan = (p: SeriesCreate) => ({
    firstDate: p.firstDate,
    frequency: p.pattern.frequency,
    interval: p.pattern.interval,
    startMinutes: minutesOf(p.startTime),
    duration: p.durationMinutes,
  });
  const rowPlan = (r: SeriesRow) => ({
    firstDate: r.first_date,
    frequency: r.frequency,
    interval: r.interval_count,
    startMinutes: r.start_minutes,
    duration: r.duration_minutes,
  });

  return {
    planSeries(ctx: ActorContext, query: unknown): Promise<SeriesPlanData> {
      const op = 'scheduling.series.plan';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        const p = query as SeriesCreate;
        assertValid<SeriesCreate>(validateSeriesCreate, p, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, p.locationRef);
        const canReadBookings = await base.can(ctx, 'scheduling.appointments.read');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, p.locationRef);
          const limit = await occurrenceLimit(tx);
          assertWithinLimit(p.count, limit);
          const occurrences = plan(requestPlan(p), location.time_zone, 1, p.count);
          const checked = await check(
            tx,
            decision,
            location,
            shapeOfRequest(p, location.time_zone),
            occurrences,
            canReadBookings,
          );
          return {
            limit: { name: SERIES_LIMIT_NAME, value: limit, ceiling: SERIES_LIMIT_CEILING },
            requested: p.count,
            conflicted: checked.filter((c) => c.conflicts.length > 0).length,
            occurrences: checked.map((c) => ({
              index: c.o.index,
              localDate: c.o.localDate,
              startsAt: new Date(c.o.s).toISOString(),
              endsAt: new Date(c.o.e).toISOString(),
              conflicts: c.conflicts,
            })),
          };
        });
      });
    },

    createSeries(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<SeriesCommandData>> {
      const op = 'scheduling.series.create';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as SeriesCreate;
        assertValid<SeriesCreate>(validateSeriesCreate, p, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, p.locationRef);
        const canReadBookings = await base.can(ctx, 'scheduling.appointments.read');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, p.locationRef, 'share');
          return execute<SeriesCommandData>(ctx, envelope, tx, async () => {
            const limit = await occurrenceLimit(tx);
            assertWithinLimit(p.count, limit);
            if (location.status !== 'active') throw failedAt('/locationRef', 'locationInactive');
            const occurrences = plan(requestPlan(p), location.time_zone, 1, p.count);
            const shape = shapeOfRequest(p, location.time_zone);
            const extra = (p.resources ?? []).map((r) => r.resourceRef);
            const { rows } = await tx
              .query<{ id: string }>(
                `INSERT INTO cuspatlas.appointment_series (tenant_id, subject_patient_id, location_id, frequency,
                 interval_count, first_date, start_minutes, duration_minutes, time_zone, provider_id, operatory_id,
                 no_operatory_reason, additional_resource_ids, appointment_type_code, limit_at_creation,
                 occurrence_count, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12::uuid[],
                 $13, $14, $15, cuspatlas.current_actor_id())
               RETURNING id`,
                [
                  p.patientRef,
                  location.id,
                  p.pattern.frequency,
                  p.pattern.interval,
                  p.firstDate,
                  minutesOf(p.startTime),
                  p.durationMinutes,
                  location.time_zone,
                  p.provider.resourceRef,
                  p.operatory?.resourceRef ?? null,
                  p.noOperatoryReason ?? null,
                  extra,
                  p.appointmentTypeCode ?? null,
                  limit,
                  p.count,
                ],
              )
              .catch((err: unknown) => {
                // A foreign or missing patient/resource reference never reaches the insert unrefused
                // (the pre-check reads them first); a foreign-key race is still hidden as not found.
                if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23503') {
                  throw notFound();
                }
                throw err;
              });
            const seriesId = rows[0]?.id;
            if (!seriesId) throw new Error('insert returned no row');
            const made = await materialize(
              tx,
              op,
              decision,
              location,
              seriesId,
              shape,
              occurrences,
              p.skipConflicts === true,
              canReadBookings,
            );
            await recordCommand(
              tx,
              { operation: op, resourceType: SERIES_RESOURCE, resourceRef: seriesId, resourceVersion: 1 },
              { changedFields: ['pattern', 'occurrences', 'state'] },
            );
            return {
              data: {
                seriesRef: seriesId,
                state: 'active',
                requested: p.count,
                created: made.appointmentRefs.length,
                skipped: made.skippedOccurrences.length,
                appointmentRefs: made.appointmentRefs,
                skippedOccurrences: made.skippedOccurrences,
                openOccurrenceRefs: [],
              },
              version: 1,
            };
          });
        });
      });
    },

    extendSeries(
      ctx: ActorContext,
      seriesRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<SeriesCommandData>> {
      const op = 'scheduling.series.extend';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as SeriesExtend;
        assertValid<SeriesExtend>(validateSeriesExtend, p, SCHEDULING_PROPERTIES);
        const canReadBookings = await base.can(ctx, 'scheduling.appointments.read');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const series = await loadSeries(tx, decision, seriesRef, 'FOR UPDATE OF s');
          const location = await loadLocation(tx, series.location_ref, 'share');
          return execute<SeriesCommandData>(
            ctx,
            { ...envelope, payload: { seriesRef, ...p } },
            tx,
            async () => {
              if (series.version !== p.expectedVersion) {
                throw new RefusalError({ code: 'stale_version', detail: { currentVersion: series.version } });
              }
              if (series.state !== 'active') {
                throw new RefusalError({ code: 'conflict', detail: { reason: 'series_not_active' } });
              }
              assertWithinLimit(p.count, await occurrenceLimit(tx));
              const occurrences = plan(
                rowPlan(series),
                series.time_zone,
                series.occurrence_count + 1,
                p.count,
              );
              const made = await materialize(
                tx,
                op,
                decision,
                location,
                series.id,
                shapeOfRow(series),
                occurrences,
                p.skipConflicts === true,
                canReadBookings,
              );
              const { rows } = await tx.query<{ version: number }>(
                `UPDATE cuspatlas.appointment_series SET occurrence_count = occurrence_count + $1, version = version + 1,
                 updated_at = now() WHERE id = $2 AND version = $3 RETURNING version`,
                [p.count, series.id, series.version],
              );
              const version = rows[0]?.version;
              if (version === undefined) throw new RefusalError({ code: 'stale_version' });
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: SERIES_RESOURCE,
                  resourceRef: series.id,
                  resourceVersion: version,
                },
                { changedFields: ['occurrences'] },
              );
              return {
                data: {
                  seriesRef: series.id,
                  state: 'active',
                  requested: p.count,
                  created: made.appointmentRefs.length,
                  skipped: made.skippedOccurrences.length,
                  appointmentRefs: made.appointmentRefs,
                  skippedOccurrences: made.skippedOccurrences,
                  openOccurrenceRefs: [],
                },
                version,
              };
            },
          );
        });
      });
    },

    endSeries(
      ctx: ActorContext,
      seriesRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<SeriesCommandData>> {
      const op = 'scheduling.series.end';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as SeriesEnd;
        assertValid<SeriesEnd>(validateSeriesEnd, p, SCHEDULING_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const series = await loadSeries(tx, decision, seriesRef, 'FOR UPDATE OF s');
          return execute<SeriesCommandData>(
            ctx,
            { ...envelope, payload: { seriesRef, ...p } },
            tx,
            async () => {
              if (series.version !== p.expectedVersion) {
                throw new RefusalError({ code: 'stale_version', detail: { currentVersion: series.version } });
              }
              if (series.state !== 'active') {
                throw new RefusalError({ code: 'conflict', detail: { reason: 'series_not_active' } });
              }
              const { rows } = await tx.query<{ version: number }>(
                `UPDATE cuspatlas.appointment_series SET state = 'ended', end_reason = $1, ended_at = now(),
                 version = version + 1, updated_at = now() WHERE id = $2 AND version = $3 RETURNING version`,
                [p.reasonCode, series.id, series.version],
              );
              const version = rows[0]?.version;
              if (version === undefined) throw new RefusalError({ code: 'stale_version' });
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: SERIES_RESOURCE,
                  resourceRef: series.id,
                  resourceVersion: version,
                },
                { changedFields: ['state'] },
              );
              // Ending deletes and cancels nothing: future bookings are named for explicit reassignment.
              const open = (await currentOccurrences(tx, series.id)).filter(
                (c) => c.status === 'booked' && c.startsAt > Date.now(),
              );
              return {
                data: {
                  seriesRef: series.id,
                  state: 'ended',
                  requested: 0,
                  created: 0,
                  skipped: 0,
                  appointmentRefs: [],
                  skippedOccurrences: [],
                  openOccurrenceRefs: open.map((c) => c.currentRef),
                },
                version,
              };
            },
          );
        });
      });
    },

    getSeries(ctx: ActorContext, seriesRef: string): Promise<SeriesRecord> {
      const op = 'scheduling.series.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const s = await loadSeries(tx, decision, seriesRef);
          const occ = await tx.query<{
            occurrence_index: number;
            local_date: string;
            starts_at: Date;
            ends_at: Date;
            outcome: 'booked' | 'skipped';
            skip_reason: string | null;
            appointment_id: string | null;
          }>(
            `SELECT occurrence_index, to_char(local_date, 'YYYY-MM-DD') AS local_date, starts_at, ends_at, outcome,
               skip_reason, appointment_id
             FROM cuspatlas.appointment_series_occurrences WHERE series_id = $1 ORDER BY occurrence_index LIMIT 1000`,
            [s.id],
          );
          const current = new Map((await currentOccurrences(tx, s.id)).map((c) => [c.originRef, c]));
          const exc = await tx.query<{
            occurrence_index: number;
            appointment_id: string;
            kind: 'cancelled' | 'rescheduled';
            reason_code: string;
            occurred_at: Date;
          }>(
            `SELECT occurrence_index, appointment_id, kind, reason_code, occurred_at
             FROM cuspatlas.appointment_series_exceptions WHERE series_id = $1 ORDER BY occurred_at, id LIMIT 1000`,
            [s.id],
          );
          const hh = Math.floor(s.start_minutes / 60);
          return {
            seriesRef: s.id,
            patientRef: s.subject_patient_id,
            locationRef: s.location_ref,
            pattern: { frequency: s.frequency, interval: s.interval_count },
            firstDate: s.first_date,
            startTime: `${pad(hh)}:${pad(s.start_minutes % 60)}`,
            durationMinutes: s.duration_minutes,
            timeZone: s.time_zone,
            provider: { kind: 'provider', resourceRef: s.provider_id },
            operatory: s.operatory_id === null ? null : { kind: 'operatory', resourceRef: s.operatory_id },
            state: s.state,
            endReason: s.end_reason,
            limitAtCreation: s.limit_at_creation,
            version: s.version,
            occurrences: occ.rows.map((o) => {
              const c = o.appointment_id === null ? undefined : current.get(o.appointment_id);
              return {
                index: o.occurrence_index,
                localDate: o.local_date,
                startsAt: o.starts_at.toISOString(),
                endsAt: o.ends_at.toISOString(),
                outcome: o.outcome,
                skipReason: o.skip_reason,
                appointmentRef: o.appointment_id,
                currentAppointmentRef: c?.currentRef ?? null,
                status: c?.status ?? null,
              };
            }),
            exceptions: exc.rows.map((e) => ({
              index: e.occurrence_index,
              appointmentRef: e.appointment_id,
              kind: e.kind,
              reasonCode: e.reason_code,
              occurredAt: e.occurred_at.toISOString(),
            })),
          };
        });
      });
    },
  };
}

/** For each booked occurrence: the standing booking at the end of its reschedule chain. */
async function currentOccurrences(tx: TenantTransaction, seriesId: string) {
  const { rows } = await tx.query<{
    origin: string;
    id: string;
    status: 'booked' | 'cancelled' | 'rescheduled';
    starts_at: Date;
  }>(
    `WITH RECURSIVE chain (origin, id, status, starts_at, next_id, depth) AS (
       SELECT a.id, a.id, a.status, a.starts_at, a.rescheduled_to_id, 0
       FROM cuspatlas.appointment_series_occurrences o
       JOIN cuspatlas.appointments a ON a.id = o.appointment_id AND a.tenant_id = o.tenant_id
       WHERE o.series_id = $1
       UNION ALL
       SELECT c.origin, a.id, a.status, a.starts_at, a.rescheduled_to_id, c.depth + 1
       FROM chain c JOIN cuspatlas.appointments a ON a.id = c.next_id
       WHERE c.depth < 50
     )
     SELECT origin, id, status, starts_at FROM chain WHERE next_id IS NULL OR depth = 50`,
    [seriesId],
  );
  return rows.map((r) => ({
    originRef: r.origin,
    currentRef: r.id,
    status: r.status,
    startsAt: r.starts_at.getTime(),
  }));
}

/**
 * Booking-side hook (cancel and reschedule): when the appointment is a series occurrence, or a
 * booking rescheduled from one, the change is recorded as a series exception naming the occurrence.
 */
export async function recordSeriesException(
  tx: TenantTransaction,
  appointmentId: string,
  kind: 'cancelled' | 'rescheduled',
  reasonCode: string,
): Promise<void> {
  const { rows } = await tx.query<{ series_id: string; occurrence_index: number }>(
    `WITH RECURSIVE back (id, prev_id, depth) AS (
       SELECT a.id, a.rescheduled_from_id, 0 FROM cuspatlas.appointments a WHERE a.id = $1
       UNION ALL
       SELECT a.id, a.rescheduled_from_id, b.depth + 1 FROM back b JOIN cuspatlas.appointments a ON a.id = b.prev_id
       WHERE b.depth < 50
     )
     SELECT o.series_id, o.occurrence_index FROM back b
     JOIN cuspatlas.appointment_series_occurrences o ON o.appointment_id = b.id
     ORDER BY b.depth LIMIT 1`,
    [appointmentId],
  );
  const occ = rows[0];
  if (!occ) return;
  await tx.query(
    `INSERT INTO cuspatlas.appointment_series_exceptions (tenant_id, series_id, occurrence_index, appointment_id, kind,
       reason_code, actor_id)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, cuspatlas.current_actor_id())`,
    [occ.series_id, occ.occurrence_index, appointmentId, kind, reasonCode],
  );
}

export type RecurrenceOperations = ReturnType<typeof createRecurrenceOperations>;
