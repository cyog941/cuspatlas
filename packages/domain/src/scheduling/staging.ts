import {
  type ActorContext,
  assertValid,
  type BookingResult,
  type CommandEnvelope,
  type CommandResult,
  RefusalError,
  SCHEDULING_PROPERTIES,
  type StagingAdd,
  type StagingEntry,
  type StagingList,
  type StagingMove,
  type StagingMoveData,
  type StagingRemove,
  type StagingSettings,
  type TenantTransaction,
  validateSchedulingEntityRef,
  validateStagingAdd,
  validateStagingListQuery,
  validateStagingMove,
  validateStagingRemove,
  validateStagingSettings,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { type AuthorizationDecision, assertLocation } from '../policy/authorize';
import { type AppointmentBase, assertVisibleLocation } from './appointment-base';
import { loadAppointment } from './booking';
import { loadRequest } from './requests';
import { checkEnvelope, failedAt, loadLocation, notFound } from './resources';

export const STAGING_ENTRY_RESOURCE = 'schedulingStagingEntry';
export const STAGING_LIST_RESOURCE = 'schedulingStagingList';
/** OR-D2 (accepted 2026-11-04): default capacity per location, configurable. */
export const STAGING_DEFAULT_CAPACITY = 10;
export const STAGING_CAPACITY_LIMIT = 'stagingCapacity';

/** The S10 reschedule with an extra guard run inside its transaction (composed in appointments.ts). */
export type RescheduleWithGuard = (
  ctx: ActorContext,
  appointmentRef: string,
  envelope: CommandEnvelope<unknown>,
  guard: (tx: TenantTransaction) => Promise<void>,
) => Promise<CommandResult<BookingResult>>;

const conflict = (reason: string, extra: Record<string, unknown> = {}) =>
  new RefusalError({ code: 'conflict', replayable: false, detail: { reason, ...extra } });

interface EntryRow extends Record<string, unknown> {
  id: string;
  location_ref: string;
  subject_kind: 'appointment' | 'request';
  appointment_id: string | null;
  request_id: string | null;
  reason_code: string;
  state: 'staged' | 'moved' | 'removed';
  version: number;
  created_at: Date;
  appt_status: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  req_state: string | null;
}

const ENTRY_SELECT = `SELECT e.id, l.location_ref, e.subject_kind, e.appointment_id, e.request_id, e.reason_code,
    e.state, e.version, e.created_at, a.status AS appt_status, a.starts_at, a.ends_at, q.state AS req_state
  FROM cuspatlas.scheduling_staging_entries e
  JOIN cuspatlas.scheduling_staging_lists s ON s.id = e.list_id AND s.tenant_id = e.tenant_id
  JOIN cuspatlas.scheduling_locations l ON l.id = s.location_id AND l.tenant_id = s.tenant_id
  LEFT JOIN cuspatlas.appointments a ON a.id = e.appointment_id AND a.tenant_id = e.tenant_id
  LEFT JOIN cuspatlas.appointment_requests q ON q.id = e.request_id AND q.tenant_id = e.tenant_id`;

const toEntry = (r: EntryRow): StagingEntry => ({
  entryRef: r.id,
  locationRef: r.location_ref,
  subjectKind: r.subject_kind,
  subjectRef: (r.subject_kind === 'appointment' ? r.appointment_id : r.request_id) as string,
  state: r.state,
  reasonCode: r.reason_code,
  subjectStatus: (r.subject_kind === 'appointment' ? r.appt_status : r.req_state) ?? 'unknown',
  startsAt: r.starts_at?.toISOString() ?? null,
  endsAt: r.ends_at?.toISOString() ?? null,
  stagedAt: r.created_at.toISOString(),
  version: r.version,
});

async function loadEntry(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  entryRef: string,
  lock = '',
): Promise<EntryRow> {
  if (!validateSchedulingEntityRef(entryRef)) throw notFound();
  const { rows } = await tx.query<EntryRow>(`${ENTRY_SELECT} WHERE e.id = $1 ${lock}`, [entryRef]);
  const row = rows[0];
  if (!row) throw notFound();
  assertVisibleLocation(decision, row.location_ref);
  return row;
}

/** The list row of a location, created on first use and locked: every add serializes on it. */
async function lockList(tx: TenantTransaction, locationId: string) {
  await tx.query(
    `INSERT INTO cuspatlas.scheduling_staging_lists (tenant_id, location_id, created_by)
     VALUES (cuspatlas.current_tenant_id(), $1, cuspatlas.current_actor_id())
     ON CONFLICT (tenant_id, location_id) DO NOTHING`,
    [locationId],
  );
  const { rows } = await tx.query<{ id: string; capacity: number; version: number }>(
    'SELECT id, capacity, version FROM cuspatlas.scheduling_staging_lists WHERE location_id = $1 FOR UPDATE',
    [locationId],
  );
  return rows[0] as { id: string; capacity: number; version: number };
}

/**
 * S20 (OR-05): a bounded per-location staging list. Staging is not an appointment state: a staged
 * appointment keeps its booking and occupancy; a move is the S10 reschedule (atomic, same transaction
 * as the entry update); add, remove and move are each audited.
 */
export function createStagingOperations(base: AppointmentBase, reschedule: RescheduleWithGuard) {
  const { deps, execute } = base;
  return {
    listStaging(ctx: ActorContext, query: unknown): Promise<StagingList> {
      const op = 'scheduling.staging.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        assertValid<{ locationRef: string }>(validateStagingListQuery, query, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, query.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, query.locationRef);
          const list = await tx.query<{ capacity: number }>(
            'SELECT capacity FROM cuspatlas.scheduling_staging_lists WHERE location_id = $1',
            [location.id],
          );
          const { rows } = await tx.query<EntryRow>(
            `${ENTRY_SELECT} WHERE s.location_id = $1 AND e.state = 'staged' ORDER BY e.created_at, e.id LIMIT 101`,
            [location.id],
          );
          const items = rows.slice(0, 100).map(toEntry);
          const truncated = rows.length > 100;
          return {
            locationRef: location.location_ref,
            capacity: list.rows[0]?.capacity ?? STAGING_DEFAULT_CAPACITY,
            items,
            envelope: {
              asOf: new Date().toISOString(),
              appliedFilters: { locationRef: location.location_ref, state: 'staged' },
              scope: { kind: 'explicit_locations', locationRefs: [location.location_ref] },
              limit: 100,
              truncated,
              nextCursor: null,
              ordering: { key: 'stagedAt', direction: 'asc', tieBreak: 'entryRef' },
              count: truncated ? { atLeast: items.length } : { exact: items.length },
            },
          };
        });
      });
    },

    configureStaging(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<{ locationRef: string; capacity: number }>> {
      const op = 'scheduling.staging.configure';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as StagingSettings;
        assertValid<StagingSettings>(validateStagingSettings, p, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, p.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, p.locationRef);
          const list = await lockList(tx, location.id);
          return execute(ctx, envelope, tx, async () => {
            await tx.query(
              `UPDATE cuspatlas.scheduling_staging_lists SET capacity = $1, version = version + 1, updated_at = now()
               WHERE id = $2`,
              [p.capacity, list.id],
            );
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: STAGING_LIST_RESOURCE,
                resourceRef: list.id,
                resourceVersion: list.version + 1,
              },
              { changedFields: ['capacity'] },
            );
            return {
              data: { locationRef: location.location_ref, capacity: p.capacity },
              version: list.version + 1,
            };
          });
        });
      });
    },

    addStagingEntry(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<StagingEntry>> {
      const op = 'scheduling.staging.add';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as StagingAdd;
        assertValid<StagingAdd>(validateStagingAdd, p, SCHEDULING_PROPERTIES);
        if ((p.appointmentRef === undefined) === (p.requestRef === undefined)) {
          throw failedAt('/appointmentRef', 'exactlyOneSubject');
        }
        assertLocation(decision.locationRefs, p.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, p.locationRef);
          const subject =
            p.appointmentRef !== undefined
              ? await loadAppointment(tx, decision, p.appointmentRef, 'FOR SHARE OF a')
              : await loadRequest(tx, decision, p.requestRef as string);
          const list = await lockList(tx, location.id);
          return execute<StagingEntry>(ctx, envelope, tx, async () => {
            if (subject.location_ref !== location.location_ref) {
              throw failedAt(
                p.appointmentRef !== undefined ? '/appointmentRef' : '/requestRef',
                'locationMismatch',
              );
            }
            if (p.appointmentRef !== undefined && (subject as { status: string }).status !== 'booked') {
              throw conflict('appointment_not_booked');
            }
            if (p.requestRef !== undefined && (subject as { closed_at: Date | null }).closed_at !== null) {
              throw conflict('request_closed');
            }
            const column = p.appointmentRef !== undefined ? 'appointment_id' : 'request_id';
            const dup = await tx.query(
              `SELECT 1 FROM cuspatlas.scheduling_staging_entries WHERE ${column} = $1 AND state = 'staged'`,
              [subject.id],
            );
            if ((dup.rowCount ?? 0) > 0) throw conflict('already_staged');
            const staged = await tx.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM cuspatlas.scheduling_staging_entries WHERE list_id = $1 AND state = 'staged'`,
              [list.id],
            );
            if ((staged.rows[0]?.n ?? 0) >= list.capacity) {
              throw conflict('staging_capacity_reached', {
                limit: { name: STAGING_CAPACITY_LIMIT, value: list.capacity },
              });
            }
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.scheduling_staging_entries (tenant_id, list_id, subject_kind, ${column}, reason_code,
                 created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id()) RETURNING id`,
              [list.id, p.appointmentRef !== undefined ? 'appointment' : 'request', subject.id, p.reasonCode],
            );
            const id = (rows[0] as { id: string }).id;
            await recordCommand(
              tx,
              { operation: op, resourceType: STAGING_ENTRY_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['state'] },
            );
            return { data: toEntry(await loadEntry(tx, decision, id)), version: 1 };
          });
        });
      });
    },

    removeStagingEntry(
      ctx: ActorContext,
      entryRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<StagingEntry>> {
      const op = 'scheduling.staging.remove';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as StagingRemove;
        assertValid<StagingRemove>(validateStagingRemove, p, SCHEDULING_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const entry = await loadEntry(tx, decision, entryRef, 'FOR UPDATE OF e');
          return execute<StagingEntry>(ctx, { ...envelope, payload: { entryRef, ...p } }, tx, async () => {
            if (entry.state !== 'staged') throw conflict('staging_entry_not_staged');
            if (entry.version !== p.expectedVersion) {
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: entry.version } });
            }
            await tx.query(
              `UPDATE cuspatlas.scheduling_staging_entries SET state = 'removed', removal_reason = $1, resolved_at = now(),
                 version = version + 1, updated_at = now() WHERE id = $2`,
              [p.reasonCode, entry.id],
            );
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: STAGING_ENTRY_RESOURCE,
                resourceRef: entry.id,
                resourceVersion: entry.version + 1,
              },
              { changedFields: ['state'] },
            );
            return { data: toEntry(await loadEntry(tx, decision, entry.id)), version: entry.version + 1 };
          });
        });
      });
    },

    moveStagingEntry(
      ctx: ActorContext,
      entryRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<StagingMoveData>> {
      const op = 'scheduling.staging.move';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as StagingMove;
        assertValid<StagingMove>(validateStagingMove, p, SCHEDULING_PROPERTIES);
        const entry = await deps.withTenantTransaction(ctx, (tx) => loadEntry(tx, decision, entryRef));
        if (entry.subject_kind !== 'appointment') {
          throw conflict('staging_entry_is_request', { alternative: 'scheduling.appointments.book' });
        }
        const previous = entry.appointment_id as string;
        // The S10 reschedule itself: its version check is replaced by the entry version check inside
        // the same transaction (the payload keeps the entry version, so a same-key retry replays).
        const booked = await reschedule(
          ctx,
          previous,
          {
            operation: 'scheduling.appointments.reschedule',
            idempotencyKey: envelope.idempotencyKey,
            payload: p,
          },
          async (tx) => {
            const { rows } = await tx.query<{ state: string; version: number }>(
              'SELECT state, version FROM cuspatlas.scheduling_staging_entries WHERE id = $1 FOR UPDATE',
              [entry.id],
            );
            const now = rows[0];
            if (now?.state !== 'staged') throw conflict('staging_entry_not_staged');
            if (now.version !== p.expectedVersion) {
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: now.version } });
            }
            await tx.query(
              `UPDATE cuspatlas.scheduling_staging_entries SET state = 'moved', resolved_at = now(),
                 version = version + 1, updated_at = now() WHERE id = $1`,
              [entry.id],
            );
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: STAGING_ENTRY_RESOURCE,
                resourceRef: entry.id,
                resourceVersion: now.version + 1,
              },
              { changedFields: ['state', 'appointment'] },
            );
          },
        );
        return {
          ...booked,
          version: p.expectedVersion + 1,
          data: {
            entryRef: entry.id,
            state: 'moved',
            previousAppointmentRef: previous,
            appointmentRef: booked.data.appointmentRef as string,
          },
        };
      });
    },
  };
}

export type StagingOperations = ReturnType<typeof createStagingOperations>;
