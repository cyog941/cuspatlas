import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  type FloorQuery,
  type FloorView,
  type FloorVisit,
  type PresenceRecord,
  type PresenceSet,
  type ProviderRequestAcknowledge,
  type ProviderRequestClear,
  type ProviderRequestCreate,
  type ProviderRequestRecord,
  RefusalError,
  SCHEDULING_PROPERTIES,
  type TenantTransaction,
  validateFloorQuery,
  validatePresenceListQuery,
  validatePresenceSet,
  validateProviderRequestAcknowledge,
  validateProviderRequestClear,
  validateProviderRequestCreate,
  validateProviderRequestListQuery,
  validateSchedulingEntityRef,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { type AuthorizationDecision, assertLocation } from '../policy/authorize';
import { type AppointmentBase, assertVisibleLocation } from './appointment-base';
import { attendanceSnapshotsOf, attendanceStateOf } from './attendance';
import { loadAppointment } from './booking';
import { checkEnvelope, failedAt, loadLocation, loadResource, notFound } from './resources';

export const PROVIDER_REQUEST_RESOURCE = 'schedulingProviderRequest';
export const PRESENCE_RESOURCE = 'schedulingStaffPresence';
const PRESENCE_DEFAULT_MINUTES = 240;
/** Attendance states in which a visit is on the floor (begun and not ended). */
const ON_FLOOR = new Set(['arrived', 'waiting', 'in_care']);
/** Operator-facing plain labels (OR-02 seam; A20 serves the versioned vocabulary). */
const LABELS: Readonly<Record<string, string>> = {
  scheduled: 'Scheduled',
  confirmed: 'Confirmed',
  late: 'Running late',
  arrived: 'Arrived',
  waiting: 'Waiting',
  in_care: 'In care',
  left_without_treatment: 'Left without treatment',
  no_show: 'No show',
  cancelled: 'Cancelled',
  rescheduled: 'Rescheduled',
};
const BOOKING_OWNED = new Set(['cancelled', 'rescheduled']);

const conflict = (reason: string) =>
  new RefusalError({ code: 'conflict', replayable: false, detail: { reason } });

interface RequestRow extends Record<string, unknown> {
  id: string;
  appointment_id: string;
  location_ref: string;
  state: 'open' | 'acknowledged' | 'cleared';
  reason_code: string;
  version: number;
  created_at: Date;
}
const REQUEST_SELECT = `SELECT r.id, r.appointment_id, l.location_ref, r.state, r.reason_code, r.version, r.created_at
  FROM cuspatlas.scheduling_provider_requests r
  JOIN cuspatlas.scheduling_locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id`;
const toRequest = (r: RequestRow): ProviderRequestRecord => ({
  requestRef: r.id,
  appointmentRef: r.appointment_id,
  locationRef: r.location_ref,
  state: r.state,
  reasonCode: r.reason_code,
  requestedAt: r.created_at.toISOString(),
  version: r.version,
});

interface PresenceRow extends Record<string, unknown> {
  id: string;
  principal_id: string;
  status: PresenceRecord['status'];
  operatory_resource_id: string | null;
  set_at: Date;
  expires_at: Date;
  version: number;
}
const toPresence = (r: PresenceRow): PresenceRecord => ({
  principalRef: r.principal_id,
  status: r.status,
  operatoryRef: r.operatory_resource_id,
  setAt: r.set_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
});

/** R5: default read caps (configurable through `SchedulingDeps.floorCaps`). */
export const FLOOR_DEFAULT_CAPS = { operatories: 100, providerRequests: 100 } as const;

/** R5: rows are read with `cap + 1`; more than `cap` means truncated, counted as at least that many. */
export function cappedCount(
  n: number,
  cap: number,
): { truncated: boolean; count: { exact: number } | { atLeast: number } } {
  return n > cap ? { truncated: true, count: { atLeast: n } } : { truncated: false, count: { exact: n } };
}

const envelopeOf = (
  locationRef: string,
  filters: Record<string, unknown>,
  ordering: { key: string; tieBreak: string },
  n: number,
  limit: number,
) => ({
  asOf: new Date().toISOString(),
  appliedFilters: { locationRef, ...filters },
  scope: { kind: 'location_set' as const, locationRefs: [locationRef] },
  limit,
  nextCursor: null,
  ordering: { ...ordering, direction: 'asc' as const },
  ...cappedCount(n, limit),
});

/**
 * S21 (OR-06): the per-operatory floor read (computed from S11 attendance, writes nothing), the
 * provider request facts (internal staff notification only: an audited outbox fact, never a
 * patient-facing intent) and expiring self-set staff presence.
 */
export function createFloorOperations(
  base: AppointmentBase,
  caps: { readonly operatories?: number; readonly providerRequests?: number } = {},
) {
  const { deps, execute } = base;
  const opCap = caps.operatories ?? FLOOR_DEFAULT_CAPS.operatories;
  const requestCap = caps.providerRequests ?? FLOOR_DEFAULT_CAPS.providerRequests;

  async function loadRequest(tx: TenantTransaction, decision: AuthorizationDecision, ref: string) {
    if (!validateSchedulingEntityRef(ref)) throw notFound();
    const { rows } = await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1 FOR UPDATE OF r`, [ref]);
    const row = rows[0];
    if (!row) throw notFound();
    assertVisibleLocation(decision, row.location_ref);
    return row;
  }

  async function advance(
    ctx: ActorContext,
    op: 'scheduling.floor.acknowledgeProviderRequest' | 'scheduling.floor.clearProviderRequest',
    requestRef: string,
    envelope: CommandEnvelope<unknown>,
  ): Promise<CommandResult<ProviderRequestRecord>> {
    return base.recorded(ctx, op, async () => {
      const decision = await base.authorize(ctx, op);
      checkEnvelope(envelope, op);
      const clearing = op === 'scheduling.floor.clearProviderRequest';
      const p = envelope.payload as ProviderRequestClear;
      if (clearing) assertValid<ProviderRequestClear>(validateProviderRequestClear, p, SCHEDULING_PROPERTIES);
      else
        assertValid<ProviderRequestAcknowledge>(validateProviderRequestAcknowledge, p, SCHEDULING_PROPERTIES);
      return deps.withTenantTransaction(ctx, async (tx) => {
        const r = await loadRequest(tx, decision, requestRef);
        return execute<ProviderRequestRecord>(
          ctx,
          { ...envelope, payload: { requestRef, ...p } },
          tx,
          async () => {
            if (r.version !== p.expectedVersion)
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: r.version } });
            if (r.state === 'cleared' || (!clearing && r.state !== 'open'))
              throw conflict(`provider_request_${r.state}`);
            if (clearing) {
              await tx.query(
                `UPDATE cuspatlas.scheduling_provider_requests SET state = 'cleared', cleared_by = cuspatlas.current_actor_id(),
                 cleared_at = now(), clear_reason = $1, version = version + 1, updated_at = now() WHERE id = $2`,
                [p.reasonCode, r.id],
              );
            } else {
              await tx.query(
                `UPDATE cuspatlas.scheduling_provider_requests SET state = 'acknowledged',
                 acknowledged_by = cuspatlas.current_actor_id(), acknowledged_at = now(), version = version + 1,
                 updated_at = now() WHERE id = $1`,
                [r.id],
              );
            }
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: PROVIDER_REQUEST_RESOURCE,
                resourceRef: r.id,
                resourceVersion: r.version + 1,
              },
              { changedFields: ['state'] },
            );
            const { rows } = await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [r.id]);
            return { data: toRequest(rows[0] as RequestRow), version: r.version + 1 };
          },
        );
      });
    });
  }

  return {
    readFloor(ctx: ActorContext, query: unknown): Promise<FloorView> {
      const op = 'scheduling.floor.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        assertValid<FloorQuery>(validateFloorQuery, query, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, query.locationRef);
        const projection = query.projection ?? 'standard';
        const canReadPatients = projection === 'standard' && (await base.can(ctx, 'patients.read'));
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, query.locationRef);
          const opRows = (
            await tx.query<{ id: string; display_label: string | null }>(
              `SELECT id, display_label FROM cuspatlas.scheduling_resources
               WHERE location_id = $1 AND kind = 'operatory' AND status = 'active' ORDER BY display_order, id LIMIT $2`,
              [location.id, opCap + 1],
            )
          ).rows;
          const ops = opRows.slice(0, opCap);
          // R5: a visit with attendance activity in the last day stays on the floor, however long it runs.
          const booked = (
            await tx.query<{ resource_id: string; id: string; subject_patient_id: string; starts_at: Date }>(
              `SELECT o.resource_id, a.id, a.subject_patient_id, a.starts_at
               FROM cuspatlas.scheduling_occupancy o
               JOIN cuspatlas.appointments a ON a.id = o.source_id AND a.tenant_id = o.tenant_id
               WHERE o.source_kind = 'appointment' AND o.released_at IS NULL AND o.location_id = $1
                 AND a.status = 'booked' AND o.resource_id = ANY ($2::uuid[])
                 AND (o.during && tstzrange(now() - interval '1 day', now() + interval '1 day')
                   OR EXISTS (SELECT 1 FROM cuspatlas.appointment_attendance_transitions t
                              WHERE t.tenant_id = a.tenant_id AND t.appointment_id = a.id
                                AND t.occurred_at > now() - interval '1 day'))
               ORDER BY a.starts_at, a.id`,
              [location.id, ops.map((o) => o.id)],
            )
          ).rows;
          const snapshots = await attendanceSnapshotsOf(tx, [...new Set(booked.map((b) => b.id))]);
          const live = (
            await tx.query<{ id: string; appointment_id: string; state: 'open' | 'acknowledged' }>(
              `SELECT id, appointment_id, state FROM cuspatlas.scheduling_provider_requests
               WHERE location_id = $1 AND state <> 'cleared'`,
              [location.id],
            )
          ).rows;
          const now = Date.now();
          const operatories = ops.map((o) => {
            const visit = booked.find(
              (b) => b.resource_id === o.id && ON_FLOOR.has(snapshots.get(b.id)?.state ?? 'scheduled'),
            );
            if (!visit) return { operatoryRef: o.id, label: o.display_label, currentVisit: null };
            const snap = snapshots.get(visit.id) as NonNullable<ReturnType<typeof snapshots.get>>;
            const req = live.find((r) => r.appointment_id === visit.id);
            const currentVisit: FloorVisit = {
              ...(projection === 'standard' ? { appointmentRef: visit.id } : {}),
              attendanceState: snap.state,
              label: LABELS[snap.state] ?? snap.state,
              since: snap.since?.toISOString() ?? null,
              elapsedMinutes: snap.since
                ? Math.max(0, Math.floor((now - snap.since.getTime()) / 60_000))
                : null,
              nextActions: [
                ...snap.next.filter((k) => !BOOKING_OWNED.has(k)),
                ...(req === undefined
                  ? ['request_provider']
                  : req.state === 'open'
                    ? ['acknowledge_provider_request', 'clear_provider_request']
                    : ['clear_provider_request']),
              ],
              patient:
                projection === 'anonymized'
                  ? 'anonymized'
                  : canReadPatients
                    ? { patientRef: visit.subject_patient_id }
                    : 'restricted',
              providerRequest:
                req === undefined
                  ? null
                  : projection === 'anonymized'
                    ? { state: req.state }
                    : { requestRef: req.id, state: req.state },
            };
            return { operatoryRef: o.id, label: o.display_label, currentVisit };
          });
          return {
            locationRef: location.location_ref,
            projection,
            operatories,
            envelope: envelopeOf(
              location.location_ref,
              { projection },
              { key: 'displayOrder', tieBreak: 'operatoryRef' },
              opRows.length,
              opCap,
            ),
          };
        });
      });
    },

    listProviderRequests(ctx: ActorContext, query: unknown) {
      const op = 'scheduling.floor.providerRequests';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        assertValid<{ locationRef: string }>(validateProviderRequestListQuery, query, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, query.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, query.locationRef);
          const { rows } = await tx.query<RequestRow>(
            `${REQUEST_SELECT} WHERE r.location_id = $1 AND r.state <> 'cleared' ORDER BY r.created_at, r.id LIMIT $2`,
            [location.id, requestCap + 1],
          );
          return {
            items: rows.slice(0, requestCap).map(toRequest),
            envelope: envelopeOf(
              location.location_ref,
              { state: ['open', 'acknowledged'] },
              { key: 'requestedAt', tieBreak: 'requestRef' },
              rows.length,
              requestCap,
            ),
          };
        });
      });
    },

    requestProvider(
      ctx: ActorContext,
      appointmentRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ProviderRequestRecord>> {
      const op = 'scheduling.floor.requestProvider';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as ProviderRequestCreate;
        assertValid<ProviderRequestCreate>(validateProviderRequestCreate, p, SCHEDULING_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const appt = await loadAppointment(tx, decision, appointmentRef, 'FOR UPDATE OF a');
          return execute<ProviderRequestRecord>(
            ctx,
            { ...envelope, payload: { appointmentRef, ...p } },
            tx,
            async () => {
              if (!ON_FLOOR.has(await attendanceStateOf(tx, appt.id)))
                throw conflict('visit_not_in_progress');
              const dup = await tx.query(
                `SELECT 1 FROM cuspatlas.scheduling_provider_requests WHERE appointment_id = $1 AND state <> 'cleared'`,
                [appt.id],
              );
              if ((dup.rowCount ?? 0) > 0) throw conflict('provider_request_open');
              const provider = await tx.query<{ resource_id: string }>(
                `SELECT o.resource_id FROM cuspatlas.scheduling_occupancy o
               JOIN cuspatlas.scheduling_resources r ON r.id = o.resource_id AND r.tenant_id = o.tenant_id
               WHERE o.source_kind = 'appointment' AND o.source_id = $1 AND o.released_at IS NULL AND r.kind = 'provider'
               LIMIT 1`,
                [appt.id],
              );
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.scheduling_provider_requests (tenant_id, appointment_id, location_id,
                 provider_resource_id, reason_code, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id()) RETURNING id`,
                [appt.id, appt.location_id, provider.rows[0]?.resource_id ?? null, p.reasonCode],
              );
              const id = (rows[0] as { id: string }).id;
              // The outbox fact is the internal staff notification seam (E internal notice); no
              // notification intent is recorded, so nothing can reach the patient.
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: PROVIDER_REQUEST_RESOURCE,
                  resourceRef: id,
                  resourceVersion: 1,
                },
                { changedFields: ['state'] },
              );
              const created = await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
              return { data: toRequest(created.rows[0] as RequestRow), version: 1 };
            },
          );
        });
      });
    },

    acknowledgeProviderRequest: (ctx: ActorContext, requestRef: string, envelope: CommandEnvelope<unknown>) =>
      advance(ctx, 'scheduling.floor.acknowledgeProviderRequest', requestRef, envelope),
    clearProviderRequest: (ctx: ActorContext, requestRef: string, envelope: CommandEnvelope<unknown>) =>
      advance(ctx, 'scheduling.floor.clearProviderRequest', requestRef, envelope),

    setPresence(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PresenceRecord>> {
      const op = 'scheduling.presence.set';
      return base.recorded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload as PresenceSet;
        assertValid<PresenceSet>(validatePresenceSet, p, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, p.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, p.locationRef);
          let operatory: string | null = null;
          if (p.operatoryRef !== undefined) {
            const r = await loadResource(tx, p.operatoryRef);
            if (r.kind !== 'operatory') throw failedAt('/operatoryRef', 'kindMismatch');
            if (r.location_id !== location.id) throw failedAt('/operatoryRef', 'locationMismatch');
            operatory = r.id;
          }
          return execute<PresenceRecord>(ctx, envelope, tx, async () => {
            const minutes = p.expiresInMinutes ?? PRESENCE_DEFAULT_MINUTES;
            // Always the caller's own row: the principal comes from the transaction context (RLS too).
            const { rows } = await tx.query<PresenceRow>(
              `INSERT INTO cuspatlas.scheduling_staff_presence (tenant_id, principal_id, location_id, status,
                 operatory_resource_id, set_at, expires_at)
               VALUES (cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $1, $2, $3, now(),
                 now() + make_interval(mins => $4))
               ON CONFLICT (tenant_id, principal_id) DO UPDATE SET location_id = EXCLUDED.location_id,
                 status = EXCLUDED.status, operatory_resource_id = EXCLUDED.operatory_resource_id,
                 set_at = EXCLUDED.set_at, expires_at = EXCLUDED.expires_at,
                 version = cuspatlas.scheduling_staff_presence.version + 1
               RETURNING id, principal_id, status, operatory_resource_id, set_at, expires_at, version`,
              [location.id, p.status, operatory, minutes],
            );
            const row = rows[0] as PresenceRow;
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: PRESENCE_RESOURCE,
                resourceRef: row.id,
                resourceVersion: row.version,
              },
              { changedFields: ['status', 'operatory', 'expiresAt'] },
            );
            return { data: toPresence(row), version: row.version };
          });
        });
      });
    },

    listPresence(ctx: ActorContext, query: unknown) {
      const op = 'scheduling.presence.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        assertValid<{ locationRef: string }>(validatePresenceListQuery, query, SCHEDULING_PROPERTIES);
        assertLocation(decision.locationRefs, query.locationRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const location = await loadLocation(tx, query.locationRef);
          const { rows } = await tx.query<PresenceRow>(
            `SELECT id, principal_id, status, operatory_resource_id, set_at, expires_at, version
             FROM cuspatlas.scheduling_staff_presence WHERE location_id = $1 AND expires_at > now()
             ORDER BY set_at, principal_id LIMIT 200`,
            [location.id],
          );
          return {
            items: rows.map(toPresence),
            envelope: envelopeOf(
              location.location_ref,
              { unexpiredOnly: true },
              { key: 'setAt', tieBreak: 'principalRef' },
              rows.length,
              200,
            ),
          };
        });
      });
    },
  };
}
