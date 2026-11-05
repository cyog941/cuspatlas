import {
  type ActorContext,
  type AvailabilitySearchResult,
  type AvailabilitySet,
  type AvailabilitySummary,
  type AvailabilityVersion,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  type Conflict,
  type Location,
  type LocationDefine,
  type LocationListQuery,
  type LocationSummary,
  type LocationTimeZoneChange,
  type MembershipSource,
  type Page,
  RefusalError,
  type Resource,
  type ResourceDeactivate,
  type ResourceDefine,
  type ResourceDetail,
  type ResourceKind,
  type ResourceListQuery,
  type ResourceSummary,
  SCHEDULING_PROPERTIES,
  type ResourceRef as SchedulingResourceRef,
  type StateLabelReport,
  type TenantTransaction,
  type TimeBlockCreate,
  type TimeBlockSummary,
  validateAvailabilitySet,
  validateLocationDefine,
  validateLocationListQuery,
  validateLocationTimeZoneChange,
  validateResourceDeactivate,
  validateResourceDefine,
  validateResourceListQuery,
  validateResourceRefId,
  validateSchedulingIdempotencyKey,
  validateSchedulingLocationRef,
  validateTimeBlockCreate,
  type WeeklyInterval,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, withAttemptRecording } from '../commands/boundary';
import { executeOnce } from '../commands/execute-once';
import type { CommandExecutor } from '../commands/executor';
import { recordCommand } from '../events/record-command';
import {
  type ActionName,
  type AuthorizationDecision,
  type Authorize,
  assertLocation,
} from '../policy/authorize';
import { assertAvailabilitySearch, searchAvailabilityIn } from './availability';
import { releaseExpiredHolds } from './booking';
import { createSchedulingCursorCodec, type SchedulingCursorCodec } from './cursor';
import type { VisitContextProducers } from './visit-context';
import { isKnownTimeZone, isRealDate, minutesOf } from './zoned-time';

/** One patient's latest qualifying completed procedure (C14), as the recall computation needs it. */
export interface CompletedProcedureEvent {
  readonly patientRef: string;
  readonly procedureRef: string;
  readonly dateOfService: string;
  readonly timeZone: string;
}
/** C14 seam for S16: the latest active (non-reversed) rendered procedure per current patient. */
export type CompletedProcedureReader = (
  tx: TenantTransaction,
  query: {
    readonly codeRefs: readonly string[];
    readonly asOf: number;
    readonly locations: readonly string[] | null;
  },
) => Promise<CompletedProcedureEvent[]>;

export interface SchedulingDeps {
  readonly authorize: Authorize;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly recording: AttemptRecordingDeps;
  /** Defaults to the durable executeOnce; tests may inject a different executor. */
  readonly execute?: CommandExecutor;
  /** Defaults to a per-process random HMAC key. */
  readonly cursors?: SchedulingCursorCodec;
  /**
   * S12 clinical producers behind the visit context. The API and MCP deploy the C producers; a missing
   * producer is reported `unavailable`; domain tests may inject a synthetic stub at this port.
   */
  readonly visitContextProducers?: VisitContextProducers;
  /**
   * S16 completed-procedure recall basis: the C14 read of qualifying procedures. Absent means the basis
   * is unavailable (refused), never substituted.
   */
  readonly completedProcedures?: CompletedProcedureReader;
  /**
   * Live membership lookup for principals other than the caller (RLS hides them from the runtime
   * role inside a tenant transaction). Used to validate a standing-policy grantee; absent means no
   * grantee can be validated, so a grant is refused.
   */
  readonly memberships?: MembershipSource;
  /** S18/OR-D6: maximum availability search window in local days (default 60). */
  readonly availabilityMaxWindowDays?: number;
}

/** Version of the reserved state-label vocabulary held by cuspatlas.scheduling_state_terms(). */
export const STATE_LABEL_VOCABULARY_VERSION = 'scheduling-state-labels.1';
export const MAX_CONFLICTS = 50;
const DEFAULT_LIMIT = 25;

export interface LocationRow extends Record<string, unknown> {
  id: string;
  location_ref: string;
  display_label: string;
  time_zone: string;
  status: 'active' | 'inactive';
  version: number;
}

export interface ResourceRow extends Record<string, unknown> {
  id: string;
  kind: ResourceKind;
  location_id: string;
  location_ref: string;
  display_label: string | null;
  display_order: number;
  status: 'active' | 'inactive';
  version: number;
}

interface BusyRow extends Record<string, unknown> {
  resource_id: string | null;
  resource_kind: ResourceKind | null;
  source_kind: 'time_block' | 'hold' | 'appointment';
  source_id: string;
}

export const notFound = () =>
  new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
export const invalidAt = (pointer: string, rule: string) =>
  new RefusalError({ code: 'invalid_request', detail: { violations: [{ pointer, rule }] } });
export const failedAt = (pointer: string, rule: string) =>
  new RefusalError({ code: 'validation_failed', detail: { violations: [{ pointer, rule }] } });
const conflictAt = (pointer: string, rule: string) =>
  new RefusalError({ code: 'conflict', detail: { violations: [{ pointer, rule }] } });
// A conflict depends on other records' current state, so a same-key retry must re-evaluate it, never replay.
const conflicts = (list: readonly Conflict[]) =>
  new RefusalError({
    code: 'conflict',
    replayable: false,
    ...(list.length > 0 ? { detail: { conflicts: list } } : {}),
  });

const isPgError = (err: unknown, code: string) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;

const RESOURCE_COLUMNS = `r.id, r.kind, r.location_id, l.location_ref, r.display_label, r.display_order, r.status,
  r.version`;

const OCCUPIED: Readonly<Record<BusyRow['source_kind'], string>> = {
  appointment: 'The resource is already occupied by an appointment in this window.',
  hold: 'The resource is held for a pending booking in this window.',
  time_block: 'The resource is already blocked in this window.',
};

/**
 * One conflict for a busy row. The blocking record (booking, hold or block) is named only to callers
 * who may read bookings (scheduling.read); the resource is one the caller already addressed.
 */
function busyConflict(
  row: BusyRow,
  kind: Conflict['kind'],
  canRead: boolean,
  explanation?: string,
): Conflict {
  return {
    kind,
    ...(row.resource_id && row.resource_kind
      ? { resourceRef: { kind: row.resource_kind, resourceRef: row.resource_id } }
      : {}),
    ...(canRead ? { existingRef: row.source_id } : {}),
    explanation: explanation ?? OCCUPIED[row.source_kind],
    overrideable: false,
  };
}

export function checkEnvelope(envelope: CommandEnvelope<unknown>, operation: string): void {
  if (envelope.operation !== operation) throw new RefusalError({ code: 'invalid_request' });
  assertValid(validateSchedulingIdempotencyKey, envelope.idempotencyKey, new Set(['idempotencyKey']));
}

const limitOf = (raw: string | undefined) => (raw === undefined ? DEFAULT_LIMIT : Number(raw));

/** Weekly hours: each interval ordered, no two intervals of one weekday overlapping (never merged). */
function checkWeekly(weekly: readonly WeeklyInterval[]): WeeklyInterval[] {
  const sorted = [...weekly].sort((a, b) => a.weekday - b.weekday || minutesOf(a.start) - minutesOf(b.start));
  for (let i = 0; i < sorted.length; i += 1) {
    const cur = sorted[i] as WeeklyInterval;
    if (minutesOf(cur.start) >= minutesOf(cur.end)) throw failedAt('/weekly', 'intervalOrder');
    const prev = sorted[i - 1];
    if (prev && prev.weekday === cur.weekday && minutesOf(cur.start) < minutesOf(prev.end)) {
      throw failedAt('/weekly', 'intervalsOverlap');
    }
  }
  return sorted.map((w) => ({ weekday: w.weekday, start: w.start, end: w.end }));
}

/** Both the runtime (Intl) and the database zone tables must know the zone. */
async function assertKnownZone(tx: TenantTransaction, timeZone: string): Promise<void> {
  if (!isKnownTimeZone(timeZone)) throw failedAt('/timeZone', 'unknownTimeZone');
  const known = await tx.query('SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = $1', [timeZone]);
  if (known.rowCount === 0) throw failedAt('/timeZone', 'unknownTimeZone');
}

export async function loadLocation(
  tx: TenantTransaction,
  locationRef: string,
  lock: 'none' | 'update' | 'share' = 'none',
): Promise<LocationRow> {
  const suffix = lock === 'update' ? ' FOR UPDATE' : lock === 'share' ? ' FOR SHARE' : '';
  const { rows } = await tx.query<LocationRow>(
    `SELECT id, location_ref, display_label, time_zone, status, version FROM cuspatlas.scheduling_locations
     WHERE location_ref = $1${suffix}`,
    [locationRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

export async function loadResource(
  tx: TenantTransaction,
  resourceRef: string,
  lock: 'none' | 'update' = 'none',
): Promise<ResourceRow> {
  if (!validateResourceRefId(resourceRef)) throw notFound();
  const { rows } = await tx.query<ResourceRow>(
    `SELECT ${RESOURCE_COLUMNS} FROM cuspatlas.scheduling_resources r
     JOIN cuspatlas.scheduling_locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id
     WHERE r.id = $1${lock === 'update' ? ' FOR UPDATE OF r' : ''}`,
    [resourceRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * Resolves caller-named resources inside the current tenant (RLS makes another tenant's resource
 * indistinguishable from a missing one: 404). A resource at a location the caller may not see is a
 * 404 too (review hardening: no same-tenant existence oracle). `share` locks the rows FOR SHARE so
 * a concurrent deactivation serializes with the command.
 */
export async function resolveResourceRefs(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  refs: readonly SchedulingResourceRef[],
  lock: 'none' | 'share' = 'none',
): Promise<ResourceRow[]> {
  if (refs.length === 0) return [];
  for (const r of refs) if (!validateResourceRefId(r.resourceRef)) throw notFound();
  const ids = refs.map((r) => r.resourceRef);
  const { rows } = await tx.query<ResourceRow>(
    `SELECT ${RESOURCE_COLUMNS} FROM cuspatlas.scheduling_resources r
     JOIN cuspatlas.scheduling_locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id
     WHERE r.id = ANY ($1::uuid[]) ORDER BY r.id${lock === 'share' ? ' FOR SHARE OF r' : ''}`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: ResourceRow[] = [];
  for (const ref of refs) {
    const row = byId.get(ref.resourceRef);
    if (!row || !visible(decision, row.location_ref)) throw notFound();
    out.push(row);
  }
  return out;
}

const visible = (decision: AuthorizationDecision, locationRef: string) =>
  decision.locationRefs === null || decision.locationRefs.includes(locationRef);

const toResource = (r: ResourceRow): Resource => ({
  resourceRef: r.id,
  kind: r.kind,
  locationRef: r.location_ref,
  displayLabel: r.display_label,
  displayOrder: r.display_order,
  status: r.status,
  version: r.version,
});

const toLocation = (r: LocationRow): Location => ({
  locationRef: r.location_ref,
  displayLabel: r.display_label,
  timeZone: r.time_zone,
  status: r.status,
  version: r.version,
});

/**
 * S7 resource, operatory and time-block model. The only command/query layer for these tables:
 * REST and MCP call these functions, none of which takes a tenant from its input. Ordering for every
 * operation: authorization, then schema, then location policy and existence (before the executor,
 * so a replay is reauthorized), then domain rules inside the executor handler.
 */
export function createSchedulingResourceService(deps: SchedulingDeps) {
  const execute = deps.execute ?? executeOnce;
  const cursors = deps.cursors ?? createSchedulingCursorCodec();

  function guarded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T> {
    return withAttemptRecording(
      deps.recording,
      { correlationId: ctx.correlationId, tenantId: ctx.tenantId, actorId: ctx.actorId, operation },
      work,
    );
  }
  const authorize = (ctx: ActorContext, action: ActionName) =>
    deps.authorize(ctx, action, { tenantId: ctx.tenantId, id: 'scheduling' });
  /** Probe (no attempt row): may the caller read bookings, and so see which record blocks a slot? */
  const canReadBookings = async (ctx: ActorContext) =>
    authorize(ctx, 'scheduling.appointments.read').then(
      () => true,
      (err: unknown) => {
        if (err instanceof RefusalError && err.code === 'forbidden') return false;
        throw err;
      },
    );

  return {
    defineLocation(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<LocationSummary>> {
      return guarded(ctx, 'scheduling.locations.define', async () => {
        const decision = await authorize(ctx, 'scheduling.locations.define');
        checkEnvelope(envelope, 'scheduling.locations.define');
        const payload = envelope.payload;
        assertValid<LocationDefine>(validateLocationDefine, payload, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, payload.locationRef);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute<LocationSummary>(ctx, envelope, tx, async () => {
            await assertKnownZone(tx, payload.timeZone);
            const { rows } = await tx.query<{ id: string; version: number }>(
              `INSERT INTO cuspatlas.scheduling_locations (tenant_id, location_ref, display_label, time_zone, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id())
               ON CONFLICT (tenant_id, location_ref) DO NOTHING RETURNING id, version`,
              [payload.locationRef, payload.displayLabel, payload.timeZone],
            );
            const row = rows[0];
            if (!row) throw conflictAt('/locationRef', 'alreadyDefined');
            await recordCommand(
              tx,
              {
                operation: 'scheduling.locations.define',
                resourceType: 'schedulingLocation',
                resourceRef: row.id,
                resourceVersion: row.version,
              },
              { changedFields: ['locationRef', 'displayLabel', 'timeZone'] },
            );
            return {
              data: { locationRef: payload.locationRef, timeZone: payload.timeZone },
              version: row.version,
            };
          }),
        );
      });
    },

    changeLocationTimeZone(
      ctx: ActorContext,
      locationRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<LocationSummary>> {
      return guarded(ctx, 'scheduling.locations.changeTimeZone', async () => {
        const decision = await authorize(ctx, 'scheduling.locations.changeTimeZone');
        checkEnvelope(envelope, 'scheduling.locations.changeTimeZone');
        const payload = envelope.payload;
        assertValid<LocationTimeZoneChange>(validateLocationTimeZoneChange, payload, SCHEDULING_PROPERTIES);
        if (!validateSchedulingLocationRef(locationRef)) throw notFound();
        // A location outside the caller's policy is hidden like a missing one, before any lookup.
        if (!visible(decision, locationRef)) throw notFound();
        const canRead = await canReadBookings(ctx);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const current = await loadLocation(tx, locationRef, 'update');
          return execute<LocationSummary>(
            ctx,
            {
              ...envelope,
              payload: { locationRef, timeZone: payload.timeZone, expectedVersion: payload.expectedVersion },
            },
            tx,
            async () => {
              if (current.version !== payload.expectedVersion) {
                throw new RefusalError({
                  code: 'stale_version',
                  detail: { currentVersion: current.version },
                });
              }
              await assertKnownZone(tx, payload.timeZone);
              // Instants are stored in UTC, but hours and display are local: a zone change under
              // future occupied time needs an explicit, recorded migration (not implemented), never
              // a silent reinterpretation.
              const busy = await tx.query<BusyRow>(
                `SELECT b.resource_id, r.kind AS resource_kind, b.source_kind, b.source_id
                 FROM cuspatlas.scheduling_busy b
                 LEFT JOIN cuspatlas.scheduling_resources r ON r.id = b.resource_id AND r.tenant_id = b.tenant_id
                 WHERE b.location_id = $1 AND upper(b.during) > now()
                 ORDER BY lower(b.during), b.source_id LIMIT $2`,
                [current.id, MAX_CONFLICTS],
              );
              if (busy.rows.length > 0) {
                throw conflicts(
                  busy.rows.map((b) =>
                    busyConflict(
                      b,
                      'policy_override_required',
                      canRead,
                      'The location has future occupied time; changing its zone requires an explicit recorded migration.',
                    ),
                  ),
                );
              }
              const { rows } = await tx.query<{ id: string; version: number }>(
                `UPDATE cuspatlas.scheduling_locations SET time_zone = $1, version = version + 1, updated_at = now()
                 WHERE id = $2 AND version = $3 RETURNING id, version`,
                [payload.timeZone, current.id, payload.expectedVersion],
              );
              const row = rows[0];
              if (!row) throw new RefusalError({ code: 'stale_version' });
              await recordCommand(
                tx,
                {
                  operation: 'scheduling.locations.changeTimeZone',
                  resourceType: 'schedulingLocation',
                  resourceRef: row.id,
                  resourceVersion: row.version,
                },
                { changedFields: ['timeZone'] },
              );
              return { data: { locationRef, timeZone: payload.timeZone }, version: row.version };
            },
          );
        });
      });
    },

    listLocations(ctx: ActorContext, query: unknown): Promise<Page<Location>> {
      return guarded(ctx, 'scheduling.locations.list', async () => {
        const decision = await authorize(ctx, 'scheduling.locations.list');
        assertValid<LocationListQuery>(validateLocationListQuery, query, SCHEDULING_PROPERTIES);
        const limit = limitOf(query.limit);
        const after =
          query.cursor === undefined ? null : cursors.decode(ctx.tenantId, 'locations', query.cursor);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<LocationRow>(
            `SELECT id, location_ref, display_label, time_zone, status, version FROM cuspatlas.scheduling_locations
             WHERE ($1::text IS NULL OR location_ref > $1::text)
               AND ($2::text[] IS NULL OR location_ref = ANY ($2::text[]))
             ORDER BY location_ref LIMIT $3`,
            [after, decision.locationRefs, limit + 1],
          );
          const page = rows.slice(0, limit).map(toLocation);
          const last = page[page.length - 1];
          return {
            data: page,
            nextCursor:
              rows.length > limit && last
                ? cursors.encode(ctx.tenantId, 'locations', last.locationRef)
                : null,
          };
        });
      });
    },

    defineResource(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ResourceSummary>> {
      return guarded(ctx, 'scheduling.resources.define', async () => {
        const decision = await authorize(ctx, 'scheduling.resources.define');
        checkEnvelope(envelope, 'scheduling.resources.define');
        const payload = envelope.payload;
        assertValid<ResourceDefine>(validateResourceDefine, payload, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, payload.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, payload.locationRef, 'share');
          return execute<ResourceSummary>(ctx, envelope, tx, async () => {
            if (location.status !== 'active') throw failedAt('/locationRef', 'locationInactive');
            const label = payload.displayLabel ?? null;
            // The database owns the reserved vocabulary (scheduling_state_terms); the same function
            // backs the table's CHECK constraint, so domain and constraint cannot disagree.
            const reserved = await tx.query<{ term: string | null }>(
              'SELECT cuspatlas.scheduling_reserved_label($1) AS term',
              [label],
            );
            if (reserved.rows[0]?.term) throw failedAt('/displayLabel', 'reservedStateLabel');
            const { rows } = await tx.query<{ id: string; version: number }>(
              `INSERT INTO cuspatlas.scheduling_resources (tenant_id, location_id, kind, display_label, display_order,
                 created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id())
               RETURNING id, version`,
              [location.id, payload.kind, label, payload.displayOrder ?? 0],
            );
            const row = rows[0];
            if (!row) throw new Error('insert returned no row');
            await recordCommand(
              tx,
              {
                operation: 'scheduling.resources.define',
                resourceType: 'schedulingResource',
                resourceRef: row.id,
                resourceVersion: row.version,
              },
              { changedFields: ['kind', 'locationRef', 'displayLabel', 'displayOrder'] },
            );
            return {
              data: { resourceRef: row.id, kind: payload.kind, status: 'active' },
              version: row.version,
            };
          });
        });
      });
    },

    setResourceAvailability(
      ctx: ActorContext,
      resourceRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<AvailabilitySummary>> {
      return guarded(ctx, 'scheduling.resources.setAvailability', async () => {
        const decision = await authorize(ctx, 'scheduling.resources.setAvailability');
        checkEnvelope(envelope, 'scheduling.resources.setAvailability');
        const payload = envelope.payload;
        assertValid<AvailabilitySet>(validateAvailabilitySet, payload, SCHEDULING_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          // Locking the resource serializes versions per resource (no second pool connection).
          const resource = await loadResource(tx, resourceRef, 'update');
          assertLocation(decision.locationRefs, resource.location_ref);
          return execute<AvailabilitySummary>(
            ctx,
            {
              ...envelope,
              payload: { resourceRef, effectiveFrom: payload.effectiveFrom, weekly: payload.weekly },
            },
            tx,
            async () => {
              if (resource.status !== 'active') throw failedAt('/', 'resourceInactive');
              if (!isRealDate(payload.effectiveFrom)) throw failedAt('/effectiveFrom', 'invalidDate');
              const weekly = checkWeekly(payload.weekly);
              // A version covers [effectiveFrom, next effectiveFrom). One starting on or before the
              // latest existing version would overlap it: refused, never merged or rewritten.
              const latest = await tx.query<{ effective_from: string }>(
                `SELECT to_char(max(effective_from), 'YYYY-MM-DD') AS effective_from
                 FROM cuspatlas.scheduling_availability_versions WHERE resource_id = $1`,
                [resource.id],
              );
              const max = latest.rows[0]?.effective_from ?? null;
              if (max !== null && payload.effectiveFrom <= max)
                throw conflictAt('/effectiveFrom', 'availabilityOverlap');
              const location = await tx.query<{ time_zone: string }>(
                'SELECT time_zone FROM cuspatlas.scheduling_locations WHERE id = $1',
                [resource.location_id],
              );
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.scheduling_availability_versions (tenant_id, resource_id, effective_from, time_zone,
                   weekly, created_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2::date, $3, $4::jsonb, cuspatlas.current_actor_id())
                 RETURNING id`,
                [resource.id, payload.effectiveFrom, location.rows[0]?.time_zone, JSON.stringify(weekly)],
              );
              const row = rows[0];
              if (!row) throw new Error('insert returned no row');
              await recordCommand(
                tx,
                {
                  operation: 'scheduling.resources.setAvailability',
                  resourceType: 'availabilityVersion',
                  resourceRef: row.id,
                  resourceVersion: 1,
                },
                { changedFields: ['resourceRef', 'effectiveFrom', 'weekly'] },
              );
              return {
                data: {
                  resourceRef: resource.id,
                  availabilityRef: row.id,
                  effectiveFrom: payload.effectiveFrom,
                },
                version: 1,
              };
            },
          );
        });
      });
    },

    deactivateResource(
      ctx: ActorContext,
      resourceRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ResourceSummary>> {
      return guarded(ctx, 'scheduling.resources.deactivate', async () => {
        const decision = await authorize(ctx, 'scheduling.resources.deactivate');
        checkEnvelope(envelope, 'scheduling.resources.deactivate');
        const payload = envelope.payload;
        assertValid<ResourceDeactivate>(validateResourceDeactivate, payload, SCHEDULING_PROPERTIES);
        const canRead = await canReadBookings(ctx);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const resource = await loadResource(tx, resourceRef, 'update');
          if (!visible(decision, resource.location_ref)) throw notFound();
          return execute<ResourceSummary>(
            ctx,
            { ...envelope, payload: { resourceRef, expectedVersion: payload.expectedVersion } },
            tx,
            async () => {
              if (resource.version !== payload.expectedVersion) {
                throw new RefusalError({
                  code: 'stale_version',
                  detail: { currentVersion: resource.version },
                });
              }
              if (resource.status !== 'active') throw conflictAt('/', 'alreadyInactive');
              const future = await tx.query<BusyRow>(
                `SELECT o.resource_id, $2::text AS resource_kind, o.source_kind, o.source_id
                 FROM cuspatlas.scheduling_busy o
                 WHERE o.resource_id = $1 AND o.source_kind IN ('appointment', 'hold') AND upper(o.during) > now()
                 ORDER BY lower(o.during), o.source_id LIMIT $3`,
                [resource.id, resource.kind, MAX_CONFLICTS],
              );
              if (future.rows.length > 0) {
                throw conflicts(
                  future.rows.map((b) =>
                    busyConflict(
                      b,
                      'resource_overlap',
                      canRead,
                      'The resource has a future booking or hold; end its availability at a date instead.',
                    ),
                  ),
                );
              }
              const { rows } = await tx.query<{ id: string; version: number }>(
                `UPDATE cuspatlas.scheduling_resources SET status = 'inactive', deactivated_at = now(),
                   version = version + 1, updated_at = now()
                 WHERE id = $1 AND version = $2 RETURNING id, version`,
                [resource.id, payload.expectedVersion],
              );
              const row = rows[0];
              if (!row) throw new RefusalError({ code: 'stale_version' });
              await recordCommand(
                tx,
                {
                  operation: 'scheduling.resources.deactivate',
                  resourceType: 'schedulingResource',
                  resourceRef: row.id,
                  resourceVersion: row.version,
                },
                { changedFields: ['status'] },
              );
              return {
                data: { resourceRef: row.id, kind: resource.kind, status: 'inactive' },
                version: row.version,
              };
            },
          );
        });
      });
    },

    listResources(ctx: ActorContext, query: unknown): Promise<Page<Resource>> {
      return guarded(ctx, 'scheduling.resources.list', async () => {
        const decision = await authorize(ctx, 'scheduling.resources.list');
        assertValid<ResourceListQuery>(validateResourceListQuery, query, SCHEDULING_PROPERTIES);
        const scope = `resources:${query.locationRef ?? ''}:${query.kind ?? ''}`;
        const limit = limitOf(query.limit);
        const after = query.cursor === undefined ? null : cursors.decode(ctx.tenantId, scope, query.cursor);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<ResourceRow>(
            `SELECT ${RESOURCE_COLUMNS} FROM cuspatlas.scheduling_resources r
             JOIN cuspatlas.scheduling_locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id
             WHERE ($1::uuid IS NULL OR r.id > $1::uuid)
               AND ($2::text[] IS NULL OR l.location_ref = ANY ($2::text[]))
               AND ($3::text IS NULL OR l.location_ref = $3::text)
               AND ($4::text IS NULL OR r.kind = $4::text)
             ORDER BY r.id LIMIT $5`,
            [after, decision.locationRefs, query.locationRef ?? null, query.kind ?? null, limit + 1],
          );
          const page = rows.slice(0, limit).map(toResource);
          const last = page[page.length - 1];
          return {
            data: page,
            nextCursor:
              rows.length > limit && last ? cursors.encode(ctx.tenantId, scope, last.resourceRef) : null,
          };
        });
      });
    },

    getResource(ctx: ActorContext, resourceRef: string): Promise<ResourceDetail> {
      return guarded(ctx, 'scheduling.resources.read', async () => {
        const decision = await authorize(ctx, 'scheduling.resources.read');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const resource = await loadResource(tx, resourceRef);
          if (!visible(decision, resource.location_ref)) throw notFound();
          const versions = await tx.query<{
            id: string;
            effective_from: string;
            time_zone: string;
            weekly: WeeklyInterval[];
          }>(
            `SELECT id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, time_zone, weekly
             FROM cuspatlas.scheduling_availability_versions WHERE resource_id = $1 ORDER BY effective_from`,
            [resource.id],
          );
          const availability: AvailabilityVersion[] = versions.rows.map((v, i) => ({
            availabilityRef: v.id,
            effectiveFrom: v.effective_from,
            effectiveUntil: versions.rows[i + 1]?.effective_from ?? null,
            timeZone: v.time_zone,
            weekly: v.weekly,
          }));
          return { ...toResource(resource), availability };
        });
      });
    },

    createTimeBlock(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<TimeBlockSummary>> {
      return guarded(ctx, 'scheduling.timeBlocks.create', async () => {
        const decision = await authorize(ctx, 'scheduling.timeBlocks.create');
        checkEnvelope(envelope, 'scheduling.timeBlocks.create');
        const payload = envelope.payload;
        assertValid<TimeBlockCreate>(validateTimeBlockCreate, payload, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, payload.locationRef);
        const canRead = await canReadBookings(ctx);
        return deps.withTenantTransaction(ctx, async (tx) => {
          // A location-wide block takes the location row exclusively; S10 bookings take it FOR SHARE,
          // so a location-wide block and a booking at that location serialize.
          const wide = payload.resources.length === 0;
          const location = await loadLocation(tx, payload.locationRef, wide ? 'update' : 'share');
          const resources = await resolveResourceRefs(tx, decision, payload.resources, 'share');
          return execute<TimeBlockSummary>(ctx, envelope, tx, async () => {
            const startsAt = new Date(payload.startsAt);
            const endsAt = new Date(payload.endsAt);
            if (!(startsAt.getTime() < endsAt.getTime())) throw failedAt('/endsAt', 'intervalOrder');
            if (endsAt.getTime() - startsAt.getTime() > 14 * 24 * 3_600_000)
              throw failedAt('/endsAt', 'tooLong');
            if (new Set(resources.map((r) => r.id)).size !== resources.length) {
              throw failedAt('/resources', 'duplicate');
            }
            for (const [i, r] of resources.entries()) {
              if (r.kind !== payload.resources[i]?.kind) throw failedAt('/resources', 'kindMismatch');
              if (r.location_id !== location.id) throw failedAt('/resources', 'locationMismatch');
              if (r.status !== 'active') throw failedAt('/resources', 'resourceInactive');
            }
            if (location.status !== 'active') throw failedAt('/locationRef', 'locationInactive');
            // Expired holds are hidden from scheduling_busy but still occupy the exclusion constraint
            // until released: reap them first, as every booking path does (review hardening, batch 3).
            if (!wide) {
              await releaseExpiredHolds(
                tx,
                resources.map((r) => r.id),
                { s: startsAt.getTime(), e: endsAt.getTime() },
              );
            }
            const overlapping = () =>
              tx.query<BusyRow>(
                `SELECT b.resource_id, r.kind AS resource_kind, b.source_kind, b.source_id
                 FROM cuspatlas.scheduling_busy b
                 LEFT JOIN cuspatlas.scheduling_resources r ON r.id = b.resource_id AND r.tenant_id = b.tenant_id
                 WHERE b.during && tstzrange($1::timestamptz, $2::timestamptz, '[)')
                   AND (($3::boolean AND b.location_id = $4 AND b.source_kind IN ('appointment', 'hold'))
                     OR (NOT $3::boolean AND b.resource_id = ANY ($5::uuid[])))
                 ORDER BY lower(b.during), b.source_id LIMIT $6`,
                [startsAt, endsAt, wide, location.id, resources.map((r) => r.id), MAX_CONFLICTS],
              );
            const pre = await overlapping();
            if (pre.rows.length > 0)
              throw conflicts(pre.rows.map((b) => busyConflict(b, 'resource_overlap', canRead)));
            const { rows } = await tx.query<{ id: string; version: number }>(
              `INSERT INTO cuspatlas.scheduling_time_blocks (tenant_id, location_id, starts_at, ends_at, time_zone,
                 reason_code, resource_count, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id())
               RETURNING id, version`,
              [location.id, startsAt, endsAt, location.time_zone, payload.reasonCode, resources.length],
            );
            const block = rows[0];
            if (!block) throw new Error('insert returned no row');
            if (!wide) {
              try {
                // The exclusion constraint is the authority: a concurrent occupant that committed
                // after the pre-check above makes this insert fail, never double-book.
                await tx.savepoint(() =>
                  tx.query(
                    `INSERT INTO cuspatlas.scheduling_occupancy (tenant_id, resource_id, location_id, during, source_kind,
                       source_id, created_by)
                     SELECT cuspatlas.current_tenant_id(), r, $1, tstzrange($2::timestamptz, $3::timestamptz, '[)'),
                       'time_block', $4, cuspatlas.current_actor_id()
                     FROM unnest($5::uuid[]) AS r`,
                    [location.id, startsAt, endsAt, block.id, resources.map((r) => r.id)],
                  ),
                );
              } catch (err) {
                if (!isPgError(err, '23P01')) throw err;
                const post = await overlapping();
                // Never an empty conflict list: name the contended resources when no occupant is visible.
                throw conflicts(
                  post.rows.length > 0
                    ? post.rows.map((b) => busyConflict(b, 'resource_overlap', canRead))
                    : resources.map(
                        (r): Conflict => ({
                          kind: 'resource_overlap',
                          resourceRef: { kind: r.kind, resourceRef: r.id },
                          explanation:
                            'A concurrent booking or hold is contending for the resource in this window.',
                          overrideable: false,
                        }),
                      ),
                );
              }
            }
            await recordCommand(
              tx,
              {
                operation: 'scheduling.timeBlocks.create',
                resourceType: 'timeBlock',
                resourceRef: block.id,
                resourceVersion: block.version,
              },
              { changedFields: ['locationRef', 'startsAt', 'endsAt', 'reasonCode', 'resources'] },
            );
            return { data: { timeBlockRef: block.id }, version: block.version };
          });
        });
      });
    },

    stateLabelledResources(ctx: ActorContext): Promise<StateLabelReport> {
      return guarded(ctx, 'scheduling.resources.dataQuality', async () => {
        const decision = await authorize(ctx, 'scheduling.resources.dataQuality');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const checked = await tx.query<{ n: number; at: Date }>(
            `SELECT count(*)::int AS n, now() AS at FROM cuspatlas.scheduling_resources r
             JOIN cuspatlas.scheduling_locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id
             WHERE ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[]))`,
            [decision.locationRefs],
          );
          const flagged = await tx.query<{
            id: string;
            kind: ResourceKind;
            location_ref: string;
            term: string;
          }>(
            `SELECT r.id, r.kind, l.location_ref, cuspatlas.scheduling_resembles_state_label(r.display_label) AS term
             FROM cuspatlas.scheduling_resources r
             JOIN cuspatlas.scheduling_locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id
             WHERE ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[]))
               AND cuspatlas.scheduling_resembles_state_label(r.display_label) IS NOT NULL
             ORDER BY r.id`,
            [decision.locationRefs],
          );
          const first = checked.rows[0];
          return {
            vocabularyVersion: STATE_LABEL_VOCABULARY_VERSION,
            checkedAt: (first?.at ?? new Date()).toISOString(),
            resourcesChecked: first?.n ?? 0,
            stateLabelledCount: flagged.rows.length,
            stateLabelled: flagged.rows.slice(0, 100).map((f) => ({
              resourceRef: f.id,
              kind: f.kind,
              locationRef: f.location_ref,
              matchedTerm: f.term,
            })),
          };
        });
      });
    },

    /** S9: read-only, advisory availability search (packages/domain/src/scheduling/availability.ts). */
    searchAvailability(ctx: ActorContext, query: unknown): Promise<AvailabilitySearchResult> {
      return guarded(ctx, 'scheduling.availability.search', async () => {
        const decision = await authorize(ctx, 'scheduling.availability.search');
        assertAvailabilitySearch(query);
        assertLocation(decision.locationRefs, query.locationRef);
        return deps.withTenantTransaction(ctx, (tx) =>
          searchAvailabilityIn(tx, ctx, decision, query, cursors, deps.availabilityMaxWindowDays),
        );
      });
    },
  };
}

export type SchedulingResourceService = ReturnType<typeof createSchedulingResourceService>;
