import {
  type ActorContext,
  type AppointmentCancel,
  type AppointmentCommandData,
  type AppointmentRecord,
  type AppointmentReschedule,
  assertValid,
  type BookingCreate,
  type BookingResult,
  type BookingWindowInput,
  type CommandEnvelope,
  type CommandResult,
  type Conflict,
  type HoldCommandData,
  type HoldCreate,
  type HoldReconcileData,
  type HoldRelease,
  isRefusalError,
  type NoOperatoryReason,
  RefusalError,
  type ResourceKind,
  type ResourceRef,
  SCHEDULING_PROPERTIES,
  type TenantTransaction,
  validateAppointmentCancel,
  validateAppointmentReschedule,
  validateBookingCreate,
  validateHoldCreate,
  validateHoldReconcile,
  validateHoldRelease,
  validateSchedulingEntityRef,
  type WeeklyInterval,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { assertPatientSchedulable } from '../patients/identity';
import { type AuthorizationDecision, assertLocation } from '../policy/authorize';
import { type AppointmentBase, assertVisibleLocation } from './appointment-base';
import { currentIntentOf, recordNotificationIntent } from './notification-intent';
import { linkRequestToBookingIn, loadRequest } from './requests';
import {
  checkEnvelope,
  failedAt,
  type LocationRow,
  loadLocation,
  MAX_CONFLICTS,
  notFound,
  type ResourceRow,
} from './resources';
import { resolveStagedAppointment } from './staging-resolve';
import { assertHoldNotOffered, expireOfferOfHold } from './waitlist-offers';
import { addDays, formatLocal, isKnownTimeZone, isoWeekday, localToInstant, minutesOf } from './zoned-time';

export const APPOINTMENT_RESOURCE = 'appointment';
export const HOLD_RESOURCE = 'schedulingHold';
/** Override policy (recommended-pending-approval): which conflict kinds an authorized override may clear. */
export const OVERRIDE_POLICY_VERSION = 'booking-override.pending-approval.1';
export const OVERRIDEABLE_KINDS: ReadonlySet<Conflict['kind']> = new Set(['outside_availability']);
const MINUTE = 60_000;
const MAX_MINUTES = 480;
/** Bounded retry budget for an occupancy insert that lost a deadlock (40P01). */
export const OCCUPANCY_ATTEMPTS = 5;

const isPg = (err: unknown, ...codes: string[]) =>
  typeof err === 'object' && err !== null && codes.includes(String((err as { code?: unknown }).code));

/** The typed conflict refusal: 409 with a non-empty, visibility-filtered conflict list. */
export const bookingConflict = (list: readonly Conflict[], retryable = false) =>
  new RefusalError({
    code: 'conflict',
    retryable,
    // Not stored by the idempotency executor: a cancellation can clear the blocker, and the conflict
    // detail is filtered for the caller on every attempt (review hardening, batch 3).
    replayable: false,
    reasonCode: 'booking_conflict',
    detail: { reason: 'booking_conflict', conflicts: list.slice(0, MAX_CONFLICTS) },
  });
const stateConflict = (reason: string) =>
  new RefusalError({ code: 'conflict', reasonCode: 'booking_refused', detail: { reason } });

interface BusyRow extends Record<string, unknown> {
  resource_id: string | null;
  resource_kind: ResourceKind | null;
  source_kind: 'time_block' | 'hold' | 'appointment';
  source_id: string;
}

export interface AppointmentRow extends Record<string, unknown> {
  id: string;
  subject_patient_id: string;
  location_id: string;
  location_ref: string;
  starts_at: Date;
  ends_at: Date;
  time_zone: string;
  provider_id: string;
  operatory_id: string | null;
  no_operatory_reason: NoOperatoryReason | null;
  appointment_type_code: string | null;
  request_id: string | null;
  status: 'booked' | 'cancelled' | 'rescheduled';
  cancel_reason: string | null;
  rescheduled_from_id: string | null;
  rescheduled_to_id: string | null;
  version: number;
  created_at: Date;
}

const APPOINTMENT_COLUMNS = `a.id, a.subject_patient_id, a.location_id, l.location_ref, a.starts_at, a.ends_at, a.time_zone,
  a.provider_id, a.operatory_id, a.no_operatory_reason, a.appointment_type_code, a.request_id, a.status, a.cancel_reason,
  a.rescheduled_from_id, a.rescheduled_to_id, a.version, a.created_at`;

/** One appointment of the current tenant (RLS) that the caller's location policy may see. */
export async function loadAppointment(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  appointmentRef: string,
  lock: '' | 'FOR UPDATE OF a' | 'FOR SHARE OF a' = '',
): Promise<AppointmentRow> {
  if (!validateSchedulingEntityRef(appointmentRef)) throw notFound();
  const { rows } = await tx.query<AppointmentRow>(
    `SELECT ${APPOINTMENT_COLUMNS} FROM cuspatlas.appointments a
     JOIN cuspatlas.scheduling_locations l ON l.id = a.location_id AND l.tenant_id = a.tenant_id
     WHERE a.id = $1 ${lock}`,
    [appointmentRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  assertVisibleLocation(decision, row.location_ref);
  return row;
}

export interface Window {
  readonly s: number;
  readonly e: number;
}

export function checkWindow(startsAt: string, endsAt: string): Window {
  const s = Date.parse(startsAt);
  const e = Date.parse(endsAt);
  if (!(s < e)) throw failedAt('/endsAt', 'intervalOrder');
  const minutes = (e - s) / MINUTE;
  if (!Number.isInteger(minutes)) throw failedAt('/endsAt', 'wholeMinutes');
  if (minutes < 5 || minutes > MAX_MINUTES) throw failedAt('/endsAt', 'durationOutOfRange');
  if (s < Date.now()) throw failedAt('/startsAt', 'inThePast');
  return { s, e };
}

/**
 * Resolves the resources a booking names inside the current tenant. Another tenant's resource is
 * indistinguishable from a missing one (404), and so is a resource at a location the caller may not
 * see; a visible resource at another location of the booking is a 422. Rows are locked FOR NO KEY UPDATE in id order:
 * contenders for one resource queue on its row (deadlock-free), see each other's committed occupancy in
 * their pre-check, and a concurrent deactivation (FOR UPDATE) serializes with the booking; foreign-key
 * inserts (KEY SHARE) from other commands are not blocked. Read-only planning passes `lock = false`.
 */
export async function resolveBookingResources(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  location: LocationRow,
  refs: readonly ResourceRef[],
  lock = true,
): Promise<ResourceRow[]> {
  const ids = refs.map((r) => r.resourceRef);
  if (new Set(ids).size !== ids.length) throw failedAt('/resources', 'duplicate');
  for (const id of ids) if (!validateSchedulingEntityRef(id)) throw notFound();
  const { rows } = await tx.query<ResourceRow>(
    `SELECT r.id, r.kind, r.location_id, l.location_ref, r.display_label, r.display_order, r.status, r.version
     FROM cuspatlas.scheduling_resources r
     JOIN cuspatlas.scheduling_locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id
     WHERE r.id = ANY ($1::uuid[]) ORDER BY r.id ${lock ? 'FOR NO KEY UPDATE OF r' : ''}`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return refs.map((ref, i) => {
    const row = byId.get(ref.resourceRef);
    if (!row) throw notFound();
    assertVisibleLocation(decision, row.location_ref);
    if (row.kind !== ref.kind) throw failedAt(i === 0 ? '/provider' : '/resources', 'kindMismatch');
    if (row.location_id !== location.id) throw failedAt('/resources', 'locationMismatch');
    return row;
  });
}

export const refOf = (r: ResourceRow): ResourceRef => ({ kind: r.kind, resourceRef: r.id });

/** Weekly hours of the version in force, as instants, for the local dates around the window. */
export async function availabilityConflicts(
  tx: TenantTransaction,
  resources: readonly ResourceRow[],
  w: Window,
  timeZone: string,
): Promise<Conflict[]> {
  const out: Conflict[] = [];
  const active = resources.filter((r) => r.status === 'active');
  for (const r of resources) {
    if (r.status !== 'active') {
      out.push({
        kind: r.kind === 'provider' ? 'provider_assignment' : 'outside_availability',
        resourceRef: refOf(r),
        explanation: 'The resource is inactive.',
        overrideable: false,
      });
    }
  }
  if (active.length === 0) return out;
  const startDate = formatLocal(w.s, timeZone).slice(0, 10);
  const endDate = formatLocal(w.e, timeZone).slice(0, 10);
  const versions = await tx.query<{
    resource_id: string;
    effective_from: string;
    time_zone: string;
    weekly: WeeklyInterval[];
  }>(
    `SELECT resource_id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, time_zone, weekly
     FROM cuspatlas.scheduling_availability_versions
     WHERE resource_id = ANY ($1::uuid[]) AND effective_from <= $2::date ORDER BY resource_id, effective_from`,
    [active.map((r) => r.id), endDate],
  );
  for (const r of active) {
    const own = versions.rows.filter((v) => v.resource_id === r.id);
    let covered = false;
    for (let d = addDays(startDate, -1); d <= endDate && !covered; d = addDays(d, 1)) {
      const version = [...own].reverse().find((v) => v.effective_from <= d);
      if (!version) continue;
      for (const iv of version.weekly) {
        if (iv.weekday !== isoWeekday(d)) continue;
        const fs = localToInstant(d, minutesOf(iv.start), version.time_zone);
        const fe = localToInstant(d, minutesOf(iv.end), version.time_zone);
        if (fs <= w.s && w.e <= fe) covered = true;
      }
    }
    if (!covered) {
      out.push({
        kind: 'outside_availability',
        resourceRef: refOf(r),
        explanation:
          own.length === 0
            ? 'The resource has no availability configured.'
            : 'The window is outside the resource availability.',
        overrideable: OVERRIDEABLE_KINDS.has('outside_availability'),
      });
    }
  }
  return out;
}

/** Releases hold occupancy that has expired on these resources in this window (lazy reconciliation). */
export async function releaseExpiredHolds(
  tx: TenantTransaction,
  ids: readonly string[],
  w: Window,
): Promise<void> {
  const expired = await tx.query<{ id: string }>(
    `SELECT DISTINCT h.id FROM cuspatlas.scheduling_holds h
     JOIN cuspatlas.scheduling_occupancy o ON o.source_kind = 'hold' AND o.source_id = h.id AND o.tenant_id = h.tenant_id
     WHERE h.state = 'active' AND h.expires_at <= now() AND o.released_at IS NULL
       AND o.resource_id = ANY ($1::uuid[]) AND o.during && tstzrange($2::timestamptz, $3::timestamptz, '[)')
     ORDER BY h.id`,
    [ids, new Date(w.s), new Date(w.e)],
  );
  if (expired.rows.length > 0)
    await expireHolds(
      tx,
      expired.rows.map((r) => r.id),
    );
}

export async function expireHolds(tx: TenantTransaction, holdIds: readonly string[]): Promise<number> {
  const locked = await tx.query<{ id: string; version: number }>(
    `SELECT id, version FROM cuspatlas.scheduling_holds WHERE id = ANY ($1::uuid[]) AND state = 'active'
       AND expires_at <= now() ORDER BY id FOR UPDATE`,
    [holdIds],
  );
  for (const h of locked.rows) {
    await tx.query(
      `UPDATE cuspatlas.scheduling_occupancy SET released_at = now()
       WHERE source_kind = 'hold' AND source_id = $1 AND released_at IS NULL`,
      [h.id],
    );
    await tx.query(
      `UPDATE cuspatlas.scheduling_holds SET state = 'released', release_reason = 'expired', released_at = now(),
         version = version + 1, updated_at = now() WHERE id = $1`,
      [h.id],
    );
    await recordCommand(
      tx,
      {
        operation: 'scheduling.holds.expire',
        resourceType: HOLD_RESOURCE,
        resourceRef: h.id,
        resourceVersion: h.version + 1,
      },
      { changedFields: ['state'] },
    );
    // S15: an offer made on this hold expires with it (no staff action); its entry is open again.
    await expireOfferOfHold(tx, h.id);
  }
  return locked.rows.length;
}

/**
 * Busy time overlapping the window on these resources (or location-wide). The blocking record is
 * named only to callers who may read bookings; the blocking resource is always one the caller named.
 */
export async function busyConflicts(
  tx: TenantTransaction,
  location: LocationRow,
  ids: readonly string[],
  w: Window,
  ignoreSources: readonly string[],
  canReadBookings: boolean,
): Promise<Conflict[]> {
  const { rows } = await tx.query<BusyRow>(
    `SELECT b.resource_id, r.kind AS resource_kind, b.source_kind, b.source_id
     FROM cuspatlas.scheduling_busy b
     LEFT JOIN cuspatlas.scheduling_resources r ON r.id = b.resource_id AND r.tenant_id = b.tenant_id
     WHERE b.during && tstzrange($1::timestamptz, $2::timestamptz, '[)')
       AND ((b.resource_id IS NULL AND b.location_id = $3) OR b.resource_id = ANY ($4::uuid[]))
       AND NOT (b.source_id = ANY ($5::uuid[]))
     ORDER BY lower(b.during), b.source_id, b.resource_id LIMIT $6`,
    [new Date(w.s), new Date(w.e), location.id, ids, ignoreSources, MAX_CONFLICTS],
  );
  return rows.map((b) => ({
    kind: 'resource_overlap',
    ...(b.resource_id && b.resource_kind
      ? { resourceRef: { kind: b.resource_kind, resourceRef: b.resource_id } }
      : {}),
    ...(canReadBookings ? { existingRef: b.source_id } : {}),
    explanation:
      b.resource_id === null
        ? 'The location is blocked in this window.'
        : b.source_kind === 'appointment'
          ? 'The resource is already booked in this window.'
          : b.source_kind === 'hold'
            ? 'The resource is held for a pending booking in this window.'
            : 'The resource is blocked in this window.',
    overrideable: false,
  }));
}

/** Writes occupancy rows; the exclusion constraint is the authority (23P01 becomes a conflict). */
/** Exported for the bounded-retry unit test. */
export async function occupy(
  tx: TenantTransaction,
  kind: 'hold' | 'appointment',
  sourceId: string,
  location: LocationRow,
  resources: readonly ResourceRef[],
  w: Window,
  recheck: () => Promise<Conflict[]>,
): Promise<void> {
  const ids = resources.map((r) => r.resourceRef);
  // Concurrent inserts of overlapping rows can deadlock inside the exclusion check (each waits for
  // the other's index entry; PostgreSQL aborts one with 40P01). The victim's savepoint is rolled back
  // and the insert retried a bounded number of times: the retry waits for the surviving contender and
  // then sees its committed row (23P01), so it ends as a named conflict, never as a partial booking.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await tx.savepoint(() =>
        tx.query(
          `INSERT INTO cuspatlas.scheduling_occupancy (tenant_id, resource_id, location_id, during, source_kind, source_id,
             created_by)
           SELECT cuspatlas.current_tenant_id(), r, $1, tstzrange($2::timestamptz, $3::timestamptz, '[)'), $4, $5,
             cuspatlas.current_actor_id()
           FROM unnest($6::uuid[]) WITH ORDINALITY AS t(r, n) ORDER BY n`,
          [location.id, new Date(w.s), new Date(w.e), kind, sourceId, [...ids].sort()],
        ),
      );
      return;
    } catch (err) {
      const contended = isPg(err, '40P01', '40001');
      if (contended && attempt < OCCUPANCY_ATTEMPTS) continue;
      if (!contended && !isPg(err, '23P01')) throw err;
      // Re-read the committed occupancy either way: a contender that won is named to the caller.
      const post = await recheck();
      throw bookingConflict(
        post.length > 0
          ? post
          : resources.map((resourceRef) => ({
              kind: 'resource_overlap' as const,
              resourceRef,
              explanation: 'A concurrent booking is contending for the resource in this window.',
              overrideable: false,
            })),
        contended && post.length === 0,
      );
    }
  }
}

export interface Prepared {
  readonly resources: ResourceRow[];
  readonly w: Window;
  readonly operatory: ResourceRow | null;
  readonly provider: ResourceRow;
  readonly noOperatoryReason: NoOperatoryReason | null;
}

/** Schema-independent checks of a booking window and its resources (domain validation, 422). */
export async function prepareWindow(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  location: LocationRow,
  p: BookingWindowInput,
  lock = true,
): Promise<Prepared> {
  if (!isKnownTimeZone(p.timeZone)) throw failedAt('/timeZone', 'unknownTimeZone');
  const refs: ResourceRef[] = [p.provider, ...(p.operatory ? [p.operatory] : []), ...(p.resources ?? [])];
  const rows = await resolveBookingResources(tx, decision, location, refs, lock);
  if (p.operatory === null && p.noOperatoryReason === undefined)
    throw failedAt('/noOperatoryReason', 'required');
  if (p.operatory !== null && p.noOperatoryReason !== undefined) {
    throw failedAt('/noOperatoryReason', 'onlyWithoutOperatory');
  }
  for (const extra of p.resources ?? []) {
    if (extra.kind === 'provider' || extra.kind === 'operatory')
      throw failedAt('/resources', 'equipmentOrStaffOnly');
  }
  const w = checkWindow(p.startsAt, p.endsAt);
  return {
    resources: rows,
    w,
    provider: rows[0] as ResourceRow,
    operatory: p.operatory ? (rows[1] as ResourceRow) : null,
    noOperatoryReason: p.noOperatoryReason ?? null,
  };
}

export async function patientConflicts(
  tx: TenantTransaction,
  patientRef: string,
  canReadPatients: boolean,
): Promise<Conflict[]> {
  try {
    await assertPatientSchedulable(tx, patientRef);
    return [];
  } catch (err) {
    if (!isRefusalError(err) || err.code !== 'conflict') throw err;
    // A caller who may not read patients learns only that the patient cannot be scheduled, never
    // whether the record is merged, deceased or inactive.
    if (!canReadPatients) {
      return [
        { kind: 'patient_unavailable', explanation: 'The patient cannot be scheduled.', overrideable: false },
      ];
    }
    const reason = err.detail?.reason;
    if (reason === 'patient_merged') {
      return [
        {
          kind: 'patient_unavailable',
          explanation: 'The patient record was merged into another record.',
          overrideable: false,
        },
      ];
    }
    return [
      {
        kind: 'patient_inactive',
        explanation:
          reason === 'patient_deceased' ? 'The patient is recorded as deceased.' : 'The patient is inactive.',
        overrideable: false,
      },
    ];
  }
}

/** Applies the override policy: every remaining conflict must be overrideable and authorized. */
function settle(
  conflicts: Conflict[],
  override: BookingWindowInput['override'],
  canOverride: boolean,
): Conflict['kind'][] {
  if (conflicts.length === 0) return [];
  if (override === undefined || conflicts.some((c) => !c.overrideable)) throw bookingConflict(conflicts);
  if (!canOverride) throw new RefusalError({ code: 'forbidden', reasonCode: 'scope_missing' });
  return [...new Set(conflicts.map((c) => c.kind))];
}

/**
 * Inserts a booking for a prepared window after every check; returns the appointment id. The one
 * booking insert path: S10 book and reschedule, S13 series occurrences and S15 offer acceptance.
 */
export async function insertBookingIn(
  tx: TenantTransaction,
  operation: string,
  o: {
    location: LocationRow;
    prepared: Prepared;
    patientRef: string;
    timeZone: string;
    appointmentTypeCode: string | null;
    requestId: string | null;
    holdId: string | null;
    rescheduledFrom: string | null;
    ignoreSources: string[];
    canReadBookings: boolean;
    canReadPatients: boolean;
    override: BookingWindowInput['override'];
    canOverride: boolean;
    extraConflicts: Conflict[];
  },
): Promise<string> {
  const { prepared, location } = o;
  const ids = prepared.resources.map((r) => r.id);
  await releaseExpiredHolds(tx, ids, prepared.w);
  const conflicts = [
    ...o.extraConflicts,
    ...(await patientConflicts(tx, o.patientRef, o.canReadPatients)),
    ...(await availabilityConflicts(tx, prepared.resources, prepared.w, location.time_zone)),
    ...(await busyConflicts(tx, location, ids, prepared.w, o.ignoreSources, o.canReadBookings)),
  ];
  if (location.status !== 'active') throw failedAt('/locationRef', 'locationInactive');
  const overridden = settle(conflicts, o.override, o.canOverride);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.appointments (tenant_id, subject_patient_id, location_id, starts_at, ends_at, time_zone,
       provider_id, operatory_id, no_operatory_reason, appointment_type_code, request_id, hold_id, rescheduled_from_id,
       created_by)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, cuspatlas.current_actor_id())
     RETURNING id`,
    [
      o.patientRef,
      location.id,
      new Date(prepared.w.s),
      new Date(prepared.w.e),
      o.timeZone,
      prepared.provider.id,
      prepared.operatory?.id ?? null,
      prepared.noOperatoryReason,
      o.appointmentTypeCode,
      o.requestId,
      o.holdId,
      o.rescheduledFrom,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('insert returned no row');
  await occupy(tx, 'appointment', id, location, prepared.resources.map(refOf), prepared.w, () =>
    busyConflicts(tx, location, ids, prepared.w, [...o.ignoreSources, id], o.canReadBookings),
  );
  await tx.query(
    `INSERT INTO cuspatlas.appointment_lifecycle_events (tenant_id, appointment_id, kind, related_appointment_id,
       appointment_version, actor_id)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, 1, cuspatlas.current_actor_id())`,
    [id, o.rescheduledFrom === null ? 'booked' : 'rescheduled_in', o.rescheduledFrom],
  );
  await recordCommand(
    tx,
    { operation, resourceType: APPOINTMENT_RESOURCE, resourceRef: id, resourceVersion: 1 },
    { changedFields: ['patientRef', 'window', 'resources', 'status'] },
  );
  // S14: one reminder intent per booking, channel none; a reschedule supersedes the old reminder.
  await recordNotificationIntent(tx, operation, {
    subjectKind: 'appointment',
    subjectId: id,
    locationId: location.id,
    purpose: 'reminder',
    dueAt: new Date(prepared.w.s),
    supersedes: o.rescheduledFrom === null ? null : await currentIntentOf(tx, o.rescheduledFrom, 'reminder'),
  });
  if (overridden.length > 0 && o.override) {
    const ov = await tx.query<{ id: string }>(
      `INSERT INTO cuspatlas.appointment_overrides (tenant_id, appointment_id, override_code, reason_code,
         overridden_kinds, policy_version, actor_id)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4::text[], $5, cuspatlas.current_actor_id())
       RETURNING id`,
      [id, o.override.code, o.override.reasonCode, overridden, OVERRIDE_POLICY_VERSION],
    );
    const overrideId = ov.rows[0]?.id;
    if (!overrideId) throw new Error('insert returned no row');
    // Its own audited record (one audit row per resource version).
    await recordCommand(
      tx,
      {
        operation: 'scheduling.appointments.override',
        resourceType: 'appointmentOverride',
        resourceRef: overrideId,
        resourceVersion: 1,
      },
      { changedFields: ['override'] },
    );
  }
  return id;
}

/**
 * Creates a hold (an occupancy of kind `hold` with an expiry) after the inactive-resource and busy
 * checks; the exclusion constraint is the authority. Shared by S10 holds and S15 waitlist offers.
 */
export async function createHoldIn(
  tx: TenantTransaction,
  operation: string,
  location: LocationRow,
  resources: readonly ResourceRow[],
  w: Window,
  ttlMinutes: number,
  canReadBookings: boolean,
  extraConflicts: readonly Conflict[] = [],
): Promise<{ id: string; expires_at: Date }> {
  const ids = resources.map((r) => r.id);
  await releaseExpiredHolds(tx, ids, w);
  const conflicts = [
    ...extraConflicts,
    ...resources
      .filter((r) => r.status !== 'active')
      .map(
        (r): Conflict => ({
          kind: 'outside_availability',
          resourceRef: refOf(r),
          explanation: 'The resource is inactive.',
          overrideable: false,
        }),
      ),
    ...(await busyConflicts(tx, location, ids, w, [], canReadBookings)),
  ];
  if (conflicts.length > 0) throw bookingConflict(conflicts);
  const { rows } = await tx.query<{ id: string; expires_at: Date }>(
    `INSERT INTO cuspatlas.scheduling_holds (tenant_id, location_id, starts_at, ends_at, expires_at, created_by)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, now() + make_interval(mins => $4), cuspatlas.current_actor_id())
     RETURNING id, expires_at`,
    [location.id, new Date(w.s), new Date(w.e), ttlMinutes],
  );
  const hold = rows[0];
  if (!hold) throw new Error('insert returned no row');
  await occupy(tx, 'hold', hold.id, location, resources.map(refOf), w, () =>
    busyConflicts(tx, location, ids, w, [hold.id], canReadBookings),
  );
  await recordCommand(
    tx,
    { operation, resourceType: HOLD_RESOURCE, resourceRef: hold.id, resourceVersion: 1 },
    { changedFields: ['window', 'resources', 'expiresAt'] },
  );
  return hold;
}

/** Marks an active hold converted into a booking (same transaction as the booking insert). */
export async function convertHoldIn(
  tx: TenantTransaction,
  holdId: string,
  holdVersion: number,
  appointmentId: string,
): Promise<void> {
  await tx.query(
    `UPDATE cuspatlas.scheduling_holds SET state = 'converted', appointment_id = $1, version = version + 1,
       updated_at = now() WHERE id = $2`,
    [appointmentId, holdId],
  );
  await recordCommand(
    tx,
    {
      operation: 'scheduling.holds.convert',
      resourceType: HOLD_RESOURCE,
      resourceRef: holdId,
      resourceVersion: holdVersion + 1,
    },
    { changedFields: ['state', 'appointmentRef'] },
  );
}

/** Releases an active hold with a reason (explicit release, offer decline or withdrawal). */
export async function releaseHoldIn(
  tx: TenantTransaction,
  operation: string,
  holdId: string,
  holdVersion: number,
  reason: string,
): Promise<void> {
  await tx.query(
    `UPDATE cuspatlas.scheduling_occupancy SET released_at = now()
     WHERE source_kind = 'hold' AND source_id = $1 AND released_at IS NULL`,
    [holdId],
  );
  await tx.query(
    `UPDATE cuspatlas.scheduling_holds SET state = 'released', release_reason = $1, released_at = now(),
       version = version + 1, updated_at = now() WHERE id = $2`,
    [reason, holdId],
  );
  await recordCommand(
    tx,
    { operation, resourceType: HOLD_RESOURCE, resourceRef: holdId, resourceVersion: holdVersion + 1 },
    { changedFields: ['state'] },
  );
}

/** S10 commands and queries: holds, booking, reschedule, cancel and the appointment read. */
export function createBookingOperations(base: AppointmentBase) {
  const { deps, execute } = base;

  async function probes(ctx: ActorContext, override: unknown) {
    const canReadBookings = await base.can(ctx, 'scheduling.appointments.read');
    const canReadPatients = await base.can(ctx, 'patients.read');
    const canOverride =
      override === undefined ? false : await base.can(ctx, 'scheduling.appointments.override');
    return { canReadBookings, canReadPatients, canOverride };
  }

  async function releaseOccupancy(tx: TenantTransaction, kind: 'hold' | 'appointment', sourceId: string) {
    await tx.query(
      `UPDATE cuspatlas.scheduling_occupancy SET released_at = now()
       WHERE source_kind = $1 AND source_id = $2 AND released_at IS NULL`,
      [kind, sourceId],
    );
  }

  return {
    bookAppointment(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<BookingResult>> {
      const op = 'scheduling.appointments.book';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<BookingCreate>(validateBookingCreate, p, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, p.locationRef);
        const { canReadBookings, canReadPatients, canOverride } = await probes(ctx, p.override);
        return deps.withTenantTransaction(ctx, async (tx) => {
          // FOR SHARE: serializes with a location-wide block (which takes the row FOR UPDATE).
          const location = await loadLocation(tx, p.locationRef, 'share');
          const request =
            p.requestRef === undefined
              ? null
              : await loadRequest(tx, decision, p.requestRef, 'FOR UPDATE OF q');
          const hold =
            p.holdRef === undefined ? null : await loadHold(tx, decision, p.holdRef, 'FOR UPDATE OF h');
          return execute<BookingResult>(ctx, envelope, tx, async () => {
            // Window and resource validation run inside the handler, so a same-key retry replays the
            // recorded result even after the start has passed (review hardening, batch 3).
            const prepared = await prepareWindow(tx, decision, location, p);
            const extra: Conflict[] = [];
            const ignore: string[] = [];
            if (hold) {
              if (hold.state !== 'active') throw stateConflict('hold_not_active');
              if (hold.expired) throw stateConflict('hold_expired');
              // A waitlist offer's hold books only through the offer's explicit acceptance (S15).
              await assertHoldNotOffered(tx, hold.id);
              if (hold.location_id !== location.id) throw failedAt('/holdRef', 'locationMismatch');
              const heldIds = new Set(hold.resource_ids);
              if (!prepared.resources.every((r) => heldIds.has(r.id)))
                throw failedAt('/holdRef', 'resourcesNotHeld');
              if (prepared.w.s < hold.starts_at.getTime() || prepared.w.e > hold.ends_at.getTime()) {
                extra.push({
                  kind: 'insufficient_duration',
                  explanation: 'The held window is shorter than the booking.',
                  overrideable: false,
                });
              }
              ignore.push(hold.id);
            }
            if (request) {
              if (request.subject_patient_id !== p.patientRef)
                throw failedAt('/requestRef', 'patientMismatch');
              if (request.location_id !== location.id) throw failedAt('/requestRef', 'locationMismatch');
              if (['scheduled', 'declined', 'expired', 'withdrawn'].includes(request.state)) {
                throw stateConflict('request_closed');
              }
            }
            // A converted hold gives its range to the booking: released first, in this transaction.
            if (hold) await releaseOccupancy(tx, 'hold', hold.id);
            const id = await insertBookingIn(tx, op, {
              location,
              prepared,
              patientRef: p.patientRef,
              timeZone: p.timeZone,
              appointmentTypeCode: p.appointmentTypeCode ?? null,
              requestId: request?.id ?? null,
              holdId: hold?.id ?? null,
              rescheduledFrom: null,
              ignoreSources: ignore,
              canReadBookings,
              canReadPatients,
              override: p.override,
              canOverride,
              extraConflicts: extra,
            });
            if (hold) {
              await tx.query(
                `UPDATE cuspatlas.scheduling_holds SET state = 'converted', appointment_id = $1, version = version + 1,
                   updated_at = now() WHERE id = $2`,
                [id, hold.id],
              );
              await recordCommand(
                tx,
                {
                  operation: 'scheduling.holds.convert',
                  resourceType: HOLD_RESOURCE,
                  resourceRef: hold.id,
                  resourceVersion: hold.version + 1,
                },
                { changedFields: ['state', 'appointmentRef'] },
              );
            }
            if (request) {
              await linkRequestToBookingIn(
                tx,
                op,
                request,
                {
                  id,
                  subject_patient_id: p.patientRef,
                  location_id: location.id,
                  status: 'booked',
                  request_id: request.id,
                },
                'booked',
              );
            }
            return { data: { outcome: 'booked', appointmentRef: id, conflicts: [] }, version: 1 };
          });
        });
      });
    },

    holdSlot(ctx: ActorContext, envelope: CommandEnvelope<unknown>): Promise<CommandResult<BookingResult>> {
      const op = 'scheduling.holds.create';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<HoldCreate>(validateHoldCreate, p, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, p.locationRef);
        const canReadBookings = await base.can(ctx, 'scheduling.appointments.read');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, p.locationRef, 'share');
          const resources = await resolveBookingResources(tx, decision, location, p.resources);
          return execute<BookingResult>(ctx, envelope, tx, async () => {
            const w = checkWindow(p.startsAt, p.endsAt);
            if (location.status !== 'active') throw failedAt('/locationRef', 'locationInactive');
            const settings = await tx.query<{ ttl: number }>(
              'SELECT hold_ttl_minutes AS ttl FROM cuspatlas.scheduling_policy_settings',
            );
            const ttl = p.ttlMinutes ?? settings.rows[0]?.ttl ?? 15;
            const hold = await createHoldIn(tx, op, location, resources, w, ttl, canReadBookings);
            return {
              data: {
                outcome: 'held',
                holdRef: hold.id,
                expiresAt: hold.expires_at.toISOString(),
                conflicts: [],
              },
              version: 1,
            };
          });
        });
      });
    },

    releaseHold(
      ctx: ActorContext,
      holdRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<HoldCommandData>> {
      const op = 'scheduling.holds.release';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<HoldRelease>(validateHoldRelease, p, SCHEDULING_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const hold = await loadHold(tx, decision, holdRef, 'FOR UPDATE OF h');
          return execute<HoldCommandData>(ctx, { ...envelope, payload: { holdRef, ...p } }, tx, async () => {
            if (hold.state !== 'active') throw stateConflict('hold_not_active');
            await assertHoldNotOffered(tx, hold.id);
            await releaseOccupancy(tx, 'hold', hold.id);
            const reason = hold.expired ? 'expired' : p.reasonCode;
            await tx.query(
              `UPDATE cuspatlas.scheduling_holds SET state = 'released', release_reason = $1, released_at = now(),
                 version = version + 1, updated_at = now() WHERE id = $2`,
              [reason, hold.id],
            );
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: HOLD_RESOURCE,
                resourceRef: hold.id,
                resourceVersion: hold.version + 1,
              },
              { changedFields: ['state'] },
            );
            return { data: { holdRef: hold.id, state: 'released' }, version: hold.version + 1 };
          });
        });
      });
    },

    reconcileHolds(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<HoldReconcileData>> {
      const op = 'scheduling.holds.reconcile';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateHoldReconcile, envelope.payload, SCHEDULING_PROPERTIES);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute<HoldReconcileData>(ctx, envelope, tx, async () => {
            const due = await tx.query<{ id: string }>(
              `SELECT h.id FROM cuspatlas.scheduling_holds h
               JOIN cuspatlas.scheduling_locations l ON l.id = h.location_id AND l.tenant_id = h.tenant_id
               WHERE h.state = 'active' AND h.expires_at <= now()
                 AND ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[]))
               ORDER BY h.id LIMIT 500`,
              [decision.locationRefs],
            );
            const released = await expireHolds(
              tx,
              due.rows.map((r) => r.id),
            );
            return { data: { released }, version: 1 };
          }),
        );
      });
    },

    rescheduleAppointment(
      ctx: ActorContext,
      appointmentRef: string,
      envelope: CommandEnvelope<unknown>,
      guard?: (tx: TenantTransaction, appointmentId: string, reasonCode: string) => Promise<void>,
      /** S20: the staging move checks its own entry version inside the guard instead. */
      opts: { readonly versionCheckedByGuard?: boolean } = {},
    ): Promise<CommandResult<BookingResult>> {
      const op = 'scheduling.appointments.reschedule';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<AppointmentReschedule>(validateAppointmentReschedule, p, SCHEDULING_PROPERTIES);
        const { canReadBookings, canReadPatients, canOverride } = await probes(ctx, p.override);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const old = await loadAppointment(tx, decision, appointmentRef, 'FOR UPDATE OF a');
          const location = await loadLocation(tx, old.location_ref, 'share');
          return execute<BookingResult>(
            ctx,
            { ...envelope, payload: { appointmentRef, ...p } },
            tx,
            async () => {
              const prepared = await prepareWindow(tx, decision, location, p);
              if (!opts.versionCheckedByGuard && old.version !== p.expectedVersion) {
                throw new RefusalError({ code: 'stale_version', detail: { currentVersion: old.version } });
              }
              if (old.status !== 'booked') throw stateConflict('appointment_not_booked');
              if (guard) await guard(tx, old.id, p.reasonCode);
              // The old range is released first (same transaction), so the new window may overlap it.
              await releaseOccupancy(tx, 'appointment', old.id);
              const id = await insertBookingIn(tx, op, {
                location,
                prepared,
                patientRef: old.subject_patient_id,
                timeZone: p.timeZone,
                appointmentTypeCode: old.appointment_type_code,
                requestId: old.request_id,
                holdId: null,
                rescheduledFrom: old.id,
                ignoreSources: [],
                canReadBookings,
                canReadPatients,
                override: p.override,
                canOverride,
                extraConflicts: [],
              });
              const { rows } = await tx.query<{ version: number }>(
                `UPDATE cuspatlas.appointments SET status = 'rescheduled', rescheduled_to_id = $1, version = version + 1,
                 updated_at = now() WHERE id = $2 AND version = $3 RETURNING version`,
                [id, old.id, old.version],
              );
              const version = rows[0]?.version;
              if (version === undefined) throw new RefusalError({ code: 'stale_version' });
              await tx.query(
                `INSERT INTO cuspatlas.appointment_lifecycle_events (tenant_id, appointment_id, kind, reason_code,
                 related_appointment_id, appointment_version, actor_id)
               VALUES (cuspatlas.current_tenant_id(), $1, 'rescheduled_out', $2, $3, $4, cuspatlas.current_actor_id())`,
                [old.id, p.reasonCode, id, version],
              );
              await resolveStagedAppointment(tx, op, old.id, 'moved');
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: APPOINTMENT_RESOURCE,
                  resourceRef: old.id,
                  resourceVersion: version,
                },
                { changedFields: ['status', 'rescheduledTo'] },
              );
              if (old.request_id !== null) {
                // The request follows the standing booking; the earlier link stays in its history.
                const req = await tx.query<{ version: number }>(
                  `UPDATE cuspatlas.appointment_requests SET appointment_id = $1, version = version + 1, updated_at = now()
                 WHERE id = $2 AND appointment_id = $3 RETURNING version`,
                  [id, old.request_id, old.id],
                );
                const rv = req.rows[0]?.version;
                if (rv !== undefined) {
                  await tx.query(
                    `INSERT INTO cuspatlas.appointment_request_transitions (tenant_id, request_id, from_state, to_state,
                     reason_code, appointment_id, request_version, actor_id)
                   VALUES (cuspatlas.current_tenant_id(), $1, 'scheduled', 'scheduled', 'rescheduled', $2, $3,
                     cuspatlas.current_actor_id())`,
                    [old.request_id, id, rv],
                  );
                }
              }
              return { data: { outcome: 'booked', appointmentRef: id, conflicts: [] }, version: 1 };
            },
          );
        });
      });
    },

    cancelAppointment(
      ctx: ActorContext,
      appointmentRef: string,
      envelope: CommandEnvelope<unknown>,
      guard?: (tx: TenantTransaction, appointmentId: string, reasonCode: string) => Promise<void>,
    ): Promise<CommandResult<AppointmentCommandData>> {
      const op = 'scheduling.appointments.cancel';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        assertValid<AppointmentCancel>(validateAppointmentCancel, p, SCHEDULING_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const appt = await loadAppointment(tx, decision, appointmentRef, 'FOR UPDATE OF a');
          return execute<AppointmentCommandData>(
            ctx,
            { ...envelope, payload: { appointmentRef, ...p } },
            tx,
            async () => {
              if (appt.status !== 'booked') throw stateConflict('appointment_not_booked');
              if (appt.version !== p.expectedVersion) {
                throw new RefusalError({ code: 'stale_version', detail: { currentVersion: appt.version } });
              }
              if (guard) await guard(tx, appt.id, p.reasonCode);
              await releaseOccupancy(tx, 'appointment', appt.id);
              const { rows } = await tx.query<{ version: number }>(
                `UPDATE cuspatlas.appointments SET status = 'cancelled', cancel_reason = $1, cancelled_at = now(),
                 version = version + 1, updated_at = now() WHERE id = $2 AND version = $3 RETURNING version`,
                [p.reasonCode, appt.id, appt.version],
              );
              const version = rows[0]?.version;
              if (version === undefined) throw new RefusalError({ code: 'stale_version' });
              await tx.query(
                `INSERT INTO cuspatlas.appointment_lifecycle_events (tenant_id, appointment_id, kind, reason_code,
                 appointment_version, actor_id)
               VALUES (cuspatlas.current_tenant_id(), $1, 'cancelled', $2, $3, cuspatlas.current_actor_id())`,
                [appt.id, p.reasonCode, version],
              );
              await resolveStagedAppointment(tx, op, appt.id, 'removed');
              // S14: the cancellation intent (channel none) supersedes the booking's reminder; the
              // outbox events of both rows are the seam E7 consumes. Nothing is sent from here.
              await recordNotificationIntent(tx, op, {
                subjectKind: 'appointment',
                subjectId: appt.id,
                locationId: appt.location_id,
                purpose: 'cancellation',
                dueAt: null,
                supersedes: await currentIntentOf(tx, appt.id, 'reminder'),
              });
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: APPOINTMENT_RESOURCE,
                  resourceRef: appt.id,
                  resourceVersion: version,
                },
                { changedFields: ['status', 'notificationIntent'] },
              );
              return { data: { appointmentRef: appt.id, status: 'cancelled' }, version };
            },
          );
        });
      });
    },

    getAppointment(ctx: ActorContext, appointmentRef: string): Promise<AppointmentRecord> {
      return base.guarded(ctx, 'scheduling.appointments.read', async () => {
        const decision = await base.authorize(ctx, 'scheduling.appointments.read');
        return deps.withTenantTransaction(ctx, (tx) => readAppointment(tx, decision, appointmentRef));
      });
    },
  };
}

export interface HoldRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  location_ref: string;
  starts_at: Date;
  ends_at: Date;
  state: 'active' | 'converted' | 'released';
  expired: boolean;
  version: number;
  resource_ids: string[];
}

export async function loadHold(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  holdRef: string,
  lock: '' | 'FOR UPDATE OF h',
): Promise<HoldRow> {
  if (!validateSchedulingEntityRef(holdRef)) throw notFound();
  const { rows } = await tx.query<HoldRow>(
    `SELECT h.id, h.location_id, l.location_ref, h.starts_at, h.ends_at, h.state, (h.expires_at <= now()) AS expired,
       h.version,
       ARRAY(SELECT o.resource_id FROM cuspatlas.scheduling_occupancy o
             WHERE o.source_kind = 'hold' AND o.source_id = h.id AND o.tenant_id = h.tenant_id) AS resource_ids
     FROM cuspatlas.scheduling_holds h
     JOIN cuspatlas.scheduling_locations l ON l.id = h.location_id AND l.tenant_id = h.tenant_id
     WHERE h.id = $1 ${lock}`,
    [holdRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  assertVisibleLocation(decision, row.location_ref);
  return row;
}

export async function readAppointment(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  appointmentRef: string,
): Promise<AppointmentRecord> {
  const a = await loadAppointment(tx, decision, appointmentRef);
  const occ = await tx.query<{ resource_id: string; kind: ResourceKind; released: boolean }>(
    `SELECT o.resource_id, r.kind, o.released_at IS NOT NULL AS released FROM cuspatlas.scheduling_occupancy o
     JOIN cuspatlas.scheduling_resources r ON r.id = o.resource_id AND r.tenant_id = o.tenant_id
     WHERE o.source_kind = 'appointment' AND o.source_id = $1 ORDER BY r.kind, o.resource_id`,
    [a.id],
  );
  const overrides = await tx.query<{
    override_code: AppointmentRecord['overrides'][number]['code'];
    reason_code: string;
    overridden_kinds: string[];
    actor_id: string;
  }>(
    `SELECT override_code, reason_code, overridden_kinds, actor_id FROM cuspatlas.appointment_overrides
     WHERE appointment_id = $1 ORDER BY occurred_at, id`,
    [a.id],
  );
  const life = await tx.query<{
    kind: AppointmentRecord['lifecycle'][number]['kind'];
    reason_code: string | null;
    related_appointment_id: string | null;
    occurred_at: Date;
    appointment_version: number;
  }>(
    `SELECT kind, reason_code, related_appointment_id, occurred_at, appointment_version
     FROM cuspatlas.appointment_lifecycle_events WHERE appointment_id = $1 ORDER BY occurred_at, appointment_version LIMIT 50`,
    [a.id],
  );
  return {
    appointmentRef: a.id,
    patientRef: a.subject_patient_id,
    locationRef: a.location_ref,
    startsAt: a.starts_at.toISOString(),
    endsAt: a.ends_at.toISOString(),
    durationMinutes: (a.ends_at.getTime() - a.starts_at.getTime()) / MINUTE,
    timeZone: a.time_zone,
    provider: { kind: 'provider', resourceRef: a.provider_id },
    operatory: a.operatory_id === null ? null : { kind: 'operatory', resourceRef: a.operatory_id },
    noOperatoryReason: a.no_operatory_reason,
    resources: occ.rows.map((o) => ({
      resourceRef: { kind: o.kind, resourceRef: o.resource_id },
      released: o.released,
    })),
    appointmentTypeCode: a.appointment_type_code,
    requestRef: a.request_id,
    status: a.status,
    cancelReason: a.cancel_reason,
    rescheduledFrom: a.rescheduled_from_id,
    rescheduledTo: a.rescheduled_to_id,
    overrides: overrides.rows.map((o) => ({
      code: o.override_code,
      reasonCode: o.reason_code,
      kinds: o.overridden_kinds,
      actorRef: o.actor_id,
    })),
    lifecycle: life.rows.map((l) => ({
      kind: l.kind,
      reasonCode: l.reason_code,
      relatedAppointmentRef: l.related_appointment_id,
      occurredAt: l.occurred_at.toISOString(),
      version: l.appointment_version,
    })),
    version: a.version,
    createdAt: a.created_at.toISOString(),
  };
}

export type BookingOperations = ReturnType<typeof createBookingOperations>;
