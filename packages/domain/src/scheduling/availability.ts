import {
  type ActorContext,
  type AvailabilityOutcome,
  type AvailabilitySearch,
  type AvailabilitySearchResult,
  type AvailabilityWindow,
  assertValid,
  type ResourceKind,
  SCHEDULING_PROPERTIES,
  type ResourceRef as SchedulingResourceRef,
  type TenantTransaction,
  validateAvailabilitySearch,
  type WeeklyInterval,
} from '@cuspatlas/contracts';
import { payloadDigest } from '../commands/digest';
import type { AuthorizationDecision } from '../policy/authorize';
import type { SchedulingCursorCodec } from './cursor';
import { failedAt, loadLocation, type ResourceRow, resolveResourceRefs } from './resources';
import {
  addDays,
  daysInclusive,
  formatLocal,
  isKnownTimeZone,
  isoWeekday,
  isRealDate,
  localToInstant,
  minutesOf,
} from './zoned-time';

/** ADR 0009 S-S3-R3 (recommended-pending-approval). */
export const AVAILABILITY_HORIZON_DAYS = 31;
export const AVAILABILITY_POLICY_REF = 'adr-0009/s-s3-r2-r3';
const DEFAULT_LIMIT = 25;
const DEFAULT_SLOT = 15;
const MINUTE = 60_000;

/** What this search does not evaluate (stated in every response, never silently assumed). */
export const NOT_CONSIDERED = [
  'provider_credentials',
  'equipment_eligibility',
  'appointment_type_rules',
  'patient_availability',
  'payer_rules',
] as const;

const STATEMENT =
  'Advisory only: computed from availability versions, time blocks and current occupancy at read time; a concurrent booking may take a window, and booking rechecks against the database constraint.';

type Interval = readonly [number, number];

interface VersionRow extends Record<string, unknown> {
  resource_id: string;
  effective_from: string;
  time_zone: string;
  weekly: WeeklyInterval[];
}
interface BusyRow extends Record<string, unknown> {
  resource_id: string | null;
  starts_ms: string;
  ends_ms: string;
}

/** Sorted, disjoint union of intervals minus `busy` (both half-open). */
function subtract(free: Interval[], busy: readonly Interval[]): Interval[] {
  let out = free;
  for (const [bs, be] of busy) {
    const next: Interval[] = [];
    for (const [s, e] of out) {
      if (be <= s || bs >= e) next.push([s, e]);
      else {
        if (bs > s) next.push([s, bs]);
        if (be < e) next.push([be, e]);
      }
    }
    out = next;
  }
  return out;
}

const covers = (free: readonly Interval[], s: number, e: number) =>
  free.some(([fs, fe]) => fs <= s && e <= fe);

/**
 * S9 availability search. Read-only by construction: it issues SELECT statements only (no executor,
 * no recordCommand, no idempotency reservation), so it writes no hold, appointment, audit or outbox
 * row. The busy intervals come from `cuspatlas.scheduling_busy`, the seam S10 bookings and holds
 * populate through `scheduling_occupancy`.
 */
export async function searchAvailabilityIn(
  tx: TenantTransaction,
  ctx: ActorContext,
  decision: AuthorizationDecision,
  query: AvailabilitySearch,
  cursors: SchedulingCursorCodec,
): Promise<AvailabilitySearchResult> {
  const slot = query.slotMinutes ?? DEFAULT_SLOT;
  const buffer = query.bufferMinutes ?? 0;
  const limit = query.limit ?? DEFAULT_LIMIT;
  const location = await loadLocation(tx, query.locationRef);

  // Explicit resources are resolved first: another tenant's resource is 404, another location 403.
  const named = query.requirements.filter((r) => r.resourceRef !== undefined) as SchedulingResourceRef[];
  const namedRows = await resolveResourceRefs(tx, decision, named);

  if (location.status !== 'active') throw failedAt('/locationRef', 'locationInactive');
  if (!isRealDate(query.from)) throw failedAt('/from', 'invalidDate');
  if (!isRealDate(query.to)) throw failedAt('/to', 'invalidDate');
  const days = daysInclusive(query.from, query.to);
  if (days < 1) throw failedAt('/to', 'rangeOrder');
  if (days > AVAILABILITY_HORIZON_DAYS) throw failedAt('/to', 'beyondHorizon');
  if (!isKnownTimeZone(query.displayTimeZone)) throw failedAt('/displayTimeZone', 'unknownTimeZone');
  const knownZone = await tx.query('SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = $1', [
    query.displayTimeZone,
  ]);
  if (knownZone.rowCount === 0) throw failedAt('/displayTimeZone', 'unknownTimeZone');
  for (const row of namedRows) {
    if (row.location_id !== location.id) throw failedAt('/requirements', 'locationMismatch');
  }
  for (const [i, req] of named.entries()) {
    if (namedRows[i]?.kind !== req.kind) throw failedAt('/requirements', 'kindMismatch');
  }

  // A cursor is bound to tenant and to the exact query (everything but cursor and limit).
  const { cursor: _c, limit: _l, ...shape } = query;
  const scope = `availability:${payloadDigest(shape).slice(0, 32)}`;
  const after = query.cursor === undefined ? null : Number(cursors.decode(ctx.tenantId, scope, query.cursor));
  if (after !== null && !Number.isSafeInteger(after)) throw failedAt('/cursor', 'invalid');

  // Candidate resources per requirement, in display order.
  const kinds = [
    ...new Set(query.requirements.filter((r) => r.resourceRef === undefined).map((r) => r.kind)),
  ];
  const pooled =
    kinds.length === 0
      ? []
      : (
          await tx.query<ResourceRow>(
            `SELECT r.id, r.kind, r.location_id, l.location_ref, r.display_label, r.display_order, r.status, r.version
             FROM cuspatlas.scheduling_resources r
             JOIN cuspatlas.scheduling_locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id
             WHERE r.location_id = $1 AND r.kind = ANY ($2::text[]) ORDER BY r.display_order, r.id`,
            [location.id, kinds],
          )
        ).rows;
  const byId = new Map<string, ResourceRow>([...pooled, ...namedRows].map((r) => [r.id, r]));
  const allIds = [...byId.keys()];
  const versions = (
    await tx.query<VersionRow>(
      `SELECT resource_id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, time_zone, weekly
       FROM cuspatlas.scheduling_availability_versions
       WHERE resource_id = ANY ($1::uuid[]) AND effective_from <= $2::date ORDER BY resource_id, effective_from`,
      [allIds, query.to],
    )
  ).rows;
  const versionsOf = new Map<string, VersionRow[]>();
  for (const v of versions) versionsOf.set(v.resource_id, [...(versionsOf.get(v.resource_id) ?? []), v]);

  const excluded: {
    resourceRef: SchedulingResourceRef;
    reason: 'inactive' | 'no_availability_configured';
  }[] = [];
  const exclude = (r: ResourceRow, reason: 'inactive' | 'no_availability_configured') => {
    if (!excluded.some((e) => e.resourceRef.resourceRef === r.id)) {
      excluded.push({ resourceRef: { kind: r.kind, resourceRef: r.id }, reason });
    }
  };
  const eligible = (r: ResourceRow) => {
    if (r.status !== 'active') {
      exclude(r, 'inactive');
      return false;
    }
    if (!versionsOf.has(r.id)) {
      exclude(r, 'no_availability_configured');
      return false;
    }
    return true;
  };
  const candidates: ResourceRow[][] = query.requirements.map((req) => {
    const pool =
      req.resourceRef !== undefined
        ? [byId.get(req.resourceRef) as ResourceRow]
        : pooled.filter((r) => r.kind === req.kind);
    return pool.filter(eligible);
  });

  const rangeStart = localToInstant(query.from, 0, location.time_zone);
  const rangeEnd = localToInstant(addDays(query.to, 1), 0, location.time_zone);
  const constraints = {
    applied: [
      'availability_hours',
      'time_blocks',
      'occupancy',
      'location_blocks',
      ...(buffer > 0 ? ['buffer_after'] : []),
      'not_before_now',
      ...(query.appointmentTypeCode ? ['appointment_type_recorded_only'] : []),
    ],
    durationMinutes: query.durationMinutes,
    bufferMinutes: buffer,
    slotMinutes: slot,
    locationTimeZone: location.time_zone,
    displayTimeZone: query.displayTimeZone,
    ...(query.appointmentTypeCode ? { appointmentTypeCode: query.appointmentTypeCode } : {}),
    policyRef: AVAILABILITY_POLICY_REF,
  };
  const coverage = {
    notConsidered: [...NOT_CONSIDERED],
    excludedResources: excluded.slice(0, 100),
    statement: STATEMENT,
  };
  const result = (
    outcome: AvailabilityOutcome,
    windows: AvailabilityWindow[],
    nextCursor: string | null,
  ) => ({
    outcome,
    advisory: true as const,
    windows,
    nextCursor,
    constraints,
    coverage,
  });

  const failing = candidates.findIndex((c) => c.length === 0);
  if (failing >= 0) {
    const req = query.requirements[failing];
    const pool =
      req?.resourceRef !== undefined
        ? [byId.get(req.resourceRef)]
        : pooled.filter((r) => r.kind === req?.kind);
    const unconfigured = pool.some((r) => r && r.status === 'active' && !versionsOf.has(r.id));
    return result(unconfigured ? 'no_availability_configured' : 'no_eligible_resource', [], null);
  }

  const busyRows = (
    await tx.query<BusyRow>(
      `SELECT resource_id, (extract(epoch FROM lower(during)) * 1000)::bigint::text AS starts_ms,
         (extract(epoch FROM upper(during)) * 1000)::bigint::text AS ends_ms
       FROM cuspatlas.scheduling_busy
       WHERE location_id = $1 AND (resource_id IS NULL OR resource_id = ANY ($2::uuid[]))
         AND during && tstzrange($3::timestamptz, $4::timestamptz, '[)')`,
      [location.id, allIds, new Date(rangeStart), new Date(rangeEnd + buffer * MINUTE)],
    )
  ).rows;
  const wide: Interval[] = [];
  const busyOf = new Map<string, Interval[]>();
  for (const b of busyRows) {
    const iv: Interval = [Number(b.starts_ms), Number(b.ends_ms)];
    if (b.resource_id === null) wide.push(iv);
    else busyOf.set(b.resource_id, [...(busyOf.get(b.resource_id) ?? []), iv]);
  }

  // Free time per resource: availability of the version in force on each local date (in that
  // version's zone), minus its occupancy and every location-wide block.
  const freeOf = new Map<string, Interval[]>();
  for (const id of new Set(candidates.flat().map((r) => r.id))) {
    const own = versionsOf.get(id) ?? [];
    const free: Interval[] = [];
    for (let i = 0; i < days; i += 1) {
      const date = addDays(query.from, i);
      const version = [...own].reverse().find((v) => v.effective_from <= date);
      if (!version) continue;
      const weekday = isoWeekday(date);
      for (const w of version.weekly) {
        if (w.weekday !== weekday) continue;
        free.push([
          localToInstant(date, minutesOf(w.start), version.time_zone),
          localToInstant(date, minutesOf(w.end), version.time_zone),
        ]);
      }
    }
    freeOf.set(id, subtract(free, [...(busyOf.get(id) ?? []), ...wide]));
  }

  const now = Date.now();
  const windows: AvailabilityWindow[] = [];
  let more = false;
  outer: for (let i = 0; i < days; i += 1) {
    const date = addDays(query.from, i);
    const dayStart = localToInstant(date, 0, location.time_zone);
    const dayEnd = localToInstant(addDays(date, 1), 0, location.time_zone);
    for (let t = dayStart; t < dayEnd; t += slot * MINUTE) {
      if (t < now || (after !== null && t <= after)) continue;
      const end = t + query.durationMinutes * MINUTE;
      const needUntil = end + buffer * MINUTE;
      const chosen: ResourceRow[] = [];
      for (const pool of candidates) {
        const pick = pool.find((r) => !chosen.includes(r) && covers(freeOf.get(r.id) ?? [], t, needUntil));
        if (!pick) break;
        chosen.push(pick);
      }
      if (chosen.length !== candidates.length) continue;
      if (windows.length === limit) {
        more = true;
        break outer;
      }
      windows.push({
        startsAt: new Date(t).toISOString(),
        endsAt: new Date(end).toISOString(),
        durationMinutes: (end - t) / MINUTE,
        localStart: formatLocal(t, query.displayTimeZone),
        localEnd: formatLocal(end, query.displayTimeZone),
        timeZone: query.displayTimeZone,
        resources: chosen.map((r) => ({ kind: r.kind as ResourceKind, resourceRef: r.id })),
      });
    }
  }
  const last = windows[windows.length - 1];
  const nextCursor =
    more && last ? cursors.encode(ctx.tenantId, scope, String(Date.parse(last.startsAt))) : null;
  return result(windows.length > 0 ? 'windows' : 'none_free', windows, nextCursor);
}

/** Schema check for the search body, exported so the service applies it after authorization. */
export function assertAvailabilitySearch(query: unknown): asserts query is AvailabilitySearch {
  assertValid<AvailabilitySearch>(validateAvailabilitySearch, query, SCHEDULING_PROPERTIES);
}
