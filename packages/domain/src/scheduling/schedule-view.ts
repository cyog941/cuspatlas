import type { TenantTransaction } from '@cuspatlas/contracts';
import { vocabularyLabel } from '@cuspatlas/contracts';
import { attendanceSnapshotsOf } from './attendance';
import { addDays, daysInclusive, formatLocal, isoWeekday, localToInstant, minutesOf } from './zoned-time';

/**
 * S19 (OR-03): the scheduling-owned read functions behind the schedule view. Each runs in the caller's
 * tenant transaction (RLS-bound), issues SELECT statements only and authorizes nothing itself: the
 * caller (an A21 composer or a scheduling read) has already authorized `scheduling.read` and the
 * location. Free time is never returned as such: it is what is neither booked nor unavailable, the
 * same computation the S9 search applies (availability versions minus occupancy and blocks).
 */
export const SCHEDULE_VIEW_MAX_DAYS = 14;
export const SCHEDULE_VIEW_MAX_APPOINTMENTS = 500;

export interface ScheduleLocation {
  readonly id: string;
  readonly locationRef: string;
  readonly timeZone: string;
}

export interface ScheduledAppointment {
  readonly appointmentRef: string;
  readonly version: number;
  readonly patientRef: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly localStart: string;
  readonly localEnd: string;
  readonly timeZone: string;
  readonly appointmentTypeCode: string | null;
  readonly requestRef: string | null;
  readonly resources: readonly { kind: 'provider' | 'operatory'; resourceRef: string }[];
  readonly attendance: { state: string; label: string; next: readonly string[] };
}

export interface ScheduleBlock {
  readonly blockRef: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly reasonCode: string;
  /** Every resource the block spans (empty = location-wide); one object, never one per resource. */
  readonly resourceRefs: readonly string[];
  readonly locationWide: boolean;
}

export type UnavailableReason = 'closed' | 'blocked' | 'outside_availability';
export interface UnavailableInterval {
  readonly resourceRef: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly reason: UnavailableReason;
  readonly blockRef?: string;
}

export interface ScheduleCounter {
  readonly key: 'open_requests' | 'blocks' | 'staging' | 'waitlist';
  readonly value: number;
  readonly scope: { readonly kind: 'location'; readonly locationRef: string; readonly basis: string };
}

type Interval = readonly [number, number];

/** Range bounds of local dates [from, to] in the location zone (half-open instants). */
export function rangeOf(location: ScheduleLocation, from: string, to: string): Interval {
  return [localToInstant(from, 0, location.timeZone), localToInstant(addDays(to, 1), 0, location.timeZone)];
}

const APPOINTMENT_SELECT = `SELECT a.id, a.version, a.status, a.subject_patient_id, a.starts_at, a.ends_at,
  a.appointment_type_code, a.request_id, a.provider_id, a.operatory_id FROM cuspatlas.appointments a`;
interface AppointmentRow extends Record<string, unknown> {
  id: string;
  version: number;
  status: string;
  subject_patient_id: string;
  starts_at: Date;
  ends_at: Date;
  appointment_type_code: string | null;
  request_id: string | null;
  provider_id: string;
  operatory_id: string | null;
}

async function project(
  tx: TenantTransaction,
  location: ScheduleLocation,
  rows: readonly AppointmentRow[],
): Promise<ScheduledAppointment[]> {
  const snaps = await attendanceSnapshotsOf(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const s = snaps.get(r.id);
    const state = s?.state ?? 'scheduled';
    return {
      appointmentRef: r.id,
      version: r.version,
      patientRef: r.subject_patient_id,
      startsAt: r.starts_at.toISOString(),
      endsAt: r.ends_at.toISOString(),
      localStart: formatLocal(r.starts_at.getTime(), location.timeZone),
      localEnd: formatLocal(r.ends_at.getTime(), location.timeZone),
      timeZone: location.timeZone,
      appointmentTypeCode: r.appointment_type_code,
      requestRef: r.request_id,
      resources: [
        { kind: 'provider' as const, resourceRef: r.provider_id },
        ...(r.operatory_id ? [{ kind: 'operatory' as const, resourceRef: r.operatory_id }] : []),
      ],
      attendance: { state, label: vocabularyLabel('attendance', state), next: [...(s?.next ?? [])] },
    };
  });
}

/** Booked appointments of a location overlapping the range, start order (tie-break ref), capped. */
export async function appointmentsInRange(
  tx: TenantTransaction,
  location: ScheduleLocation,
  range: Interval,
  cap = SCHEDULE_VIEW_MAX_APPOINTMENTS,
): Promise<{ appointments: ScheduledAppointment[]; truncated: boolean }> {
  const { rows } = await tx.query<AppointmentRow>(
    `${APPOINTMENT_SELECT} WHERE a.location_id = $1 AND a.status = 'booked' AND a.starts_at < $3 AND a.ends_at > $2
     ORDER BY a.starts_at, a.id LIMIT $4`,
    [location.id, new Date(range[0]), new Date(range[1]), cap + 1],
  );
  return { truncated: rows.length > cap, appointments: await project(tx, location, rows.slice(0, cap)) };
}

/** One appointment by reference (any status) with its location; null when hidden or missing. */
export async function appointmentFacts(
  tx: TenantTransaction,
  appointmentRef: string,
): Promise<(ScheduledAppointment & { status: string; location: ScheduleLocation }) | null> {
  const { rows } = await tx.query<AppointmentRow & { location_id: string; location_ref: string; tz: string }>(
    `SELECT x.*, a.location_id, l.location_ref, l.time_zone AS tz FROM (${APPOINTMENT_SELECT} WHERE a.id = $1) x
     JOIN cuspatlas.appointments a ON a.id = x.id
     JOIN cuspatlas.scheduling_locations l ON l.id = a.location_id AND l.tenant_id = a.tenant_id`,
    [appointmentRef],
  );
  const r = rows[0];
  if (!r) return null;
  const location = { id: r.location_id, locationRef: r.location_ref, timeZone: r.tz };
  const [a] = await project(tx, location, [r]);
  return { ...(a as ScheduledAppointment), status: r.status, location };
}

/** Time blocks overlapping the range, each one object spanning its resources. */
export async function blocksInRange(
  tx: TenantTransaction,
  location: ScheduleLocation,
  range: Interval,
): Promise<ScheduleBlock[]> {
  const { rows } = await tx.query<{
    id: string;
    starts_at: Date;
    ends_at: Date;
    reason_code: string;
    resource_count: number;
    resource_ids: string[] | null;
  }>(
    `SELECT b.id, b.starts_at, b.ends_at, b.reason_code, b.resource_count,
       (SELECT array_agg(o.resource_id ORDER BY o.resource_id) FROM cuspatlas.scheduling_occupancy o
        WHERE o.tenant_id = b.tenant_id AND o.source_kind = 'time_block' AND o.source_id = b.id
          AND o.released_at IS NULL) AS resource_ids
     FROM cuspatlas.scheduling_time_blocks b
     WHERE b.location_id = $1 AND b.starts_at < $3 AND b.ends_at > $2 ORDER BY b.starts_at, b.id LIMIT 500`,
    [location.id, new Date(range[0]), new Date(range[1])],
  );
  return rows.map((r) => ({
    blockRef: r.id,
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at.toISOString(),
    reasonCode: r.reason_code,
    resourceRefs: r.resource_ids ?? [],
    locationWide: r.resource_count === 0,
  }));
}

/**
 * Unavailable intervals per active provider and operatory of the location, distinct from free time:
 * `closed` (no availability in force that local day), `outside_availability` (the parts of a working
 * day outside its hours) and `blocked` (a time block inside the range, resource or location wide).
 */
export async function unavailableIntervals(
  tx: TenantTransaction,
  location: ScheduleLocation,
  from: string,
  to: string,
  blocks: readonly ScheduleBlock[],
): Promise<UnavailableInterval[]> {
  const { rows: resources } = await tx.query<{ id: string }>(
    `SELECT id FROM cuspatlas.scheduling_resources WHERE location_id = $1 AND status = 'active'
       AND kind IN ('provider', 'operatory') ORDER BY display_order, id LIMIT 100`,
    [location.id],
  );
  const ids = resources.map((r) => r.id);
  const { rows: versions } = await tx.query<{
    resource_id: string;
    effective_from: string;
    time_zone: string;
    weekly: { weekday: number; start: string; end: string }[];
  }>(
    `SELECT resource_id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, time_zone, weekly
     FROM cuspatlas.scheduling_availability_versions
     WHERE resource_id = ANY ($1::uuid[]) AND effective_from <= $2::date ORDER BY resource_id, effective_from`,
    [ids, to],
  );
  const out: UnavailableInterval[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();
  const days = daysInclusive(from, to);
  for (const id of ids) {
    const own = versions.filter((v) => v.resource_id === id);
    for (let i = 0; i < days; i += 1) {
      const date = addDays(from, i);
      const dayStart = localToInstant(date, 0, location.timeZone);
      const dayEnd = localToInstant(addDays(date, 1), 0, location.timeZone);
      const version = [...own].reverse().find((v) => v.effective_from <= date);
      const open: Interval[] = (version?.weekly ?? [])
        .filter((w) => w.weekday === isoWeekday(date))
        .map(
          (w): Interval => [
            localToInstant(date, minutesOf(w.start), version?.time_zone ?? location.timeZone),
            localToInstant(date, minutesOf(w.end), version?.time_zone ?? location.timeZone),
          ],
        )
        .sort((a, b) => a[0] - b[0]);
      if (open.length === 0) {
        out.push({ resourceRef: id, startsAt: iso(dayStart), endsAt: iso(dayEnd), reason: 'closed' });
        continue;
      }
      let cursor = dayStart;
      for (const [s, e] of open) {
        if (s > cursor)
          out.push({
            resourceRef: id,
            startsAt: iso(cursor),
            endsAt: iso(s),
            reason: 'outside_availability',
          });
        cursor = Math.max(cursor, e);
      }
      if (cursor < dayEnd)
        out.push({
          resourceRef: id,
          startsAt: iso(cursor),
          endsAt: iso(dayEnd),
          reason: 'outside_availability',
        });
    }
    for (const b of blocks) {
      if (b.locationWide || b.resourceRefs.includes(id))
        out.push({
          resourceRef: id,
          startsAt: b.startsAt,
          endsAt: b.endsAt,
          reason: 'blocked',
          blockRef: b.blockRef,
        });
    }
  }
  return out.sort((a, b) =>
    a.resourceRef === b.resourceRef
      ? a.startsAt < b.startsAt
        ? -1
        : a.startsAt > b.startsAt
          ? 1
          : 0
      : a.resourceRef < b.resourceRef
        ? -1
        : 1,
  );
}

/** Counters with their scope: open requests, blocks in range, staged entries and active waitlist. */
export async function scheduleCounters(
  tx: TenantTransaction,
  location: ScheduleLocation,
  blocksInView: number,
): Promise<ScheduleCounter[]> {
  const { rows } = await tx.query<{ requests: number; staging: number; waitlist: number }>(
    `SELECT
       (SELECT count(*)::int FROM cuspatlas.appointment_requests WHERE location_id = $1
          AND state IN ('open', 'in_review')) AS requests,
       (SELECT count(*)::int FROM cuspatlas.scheduling_staging_entries e
          JOIN cuspatlas.scheduling_staging_lists l ON l.id = e.list_id AND l.tenant_id = e.tenant_id
          WHERE l.location_id = $1 AND e.state = 'staged') AS staging,
       (SELECT count(*)::int FROM cuspatlas.waitlist_entries WHERE location_id = $1
          AND state IN ('active', 'offered')) AS waitlist`,
    [location.id],
  );
  const r = rows[0] as { requests: number; staging: number; waitlist: number };
  const scope = (basis: string) => ({ kind: 'location' as const, locationRef: location.locationRef, basis });
  return [
    { key: 'open_requests', value: r.requests, scope: scope('state open or in_review, any date') },
    { key: 'blocks', value: blocksInView, scope: scope('time blocks overlapping the requested range') },
    { key: 'staging', value: r.staging, scope: scope('staged entries of the location staging list') },
    { key: 'waitlist', value: r.waitlist, scope: scope('waitlist entries active or offered') },
  ];
}
