import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  RefusalError,
  type TenantTransaction,
  validateDowntimeEnd,
  validateDowntimeEntryListQuery,
  validateDowntimeEntryResolve,
  validateDowntimeLog,
  validateDowntimeStart,
  validateDowntimeWindowListQuery,
} from '@cuspatlas/contracts';
import { databaseNow } from '../clock';
import { recordCommand } from '../events/record-command';
import type { ActionName, AuthorizationDecision } from '../policy/authorize';
import {
  checkEnvelope,
  conflict,
  failed,
  isPgError,
  keysetPage,
  type MigrationBase,
  notFound,
  positionSql,
  validate,
} from './base';

/**
 * Closeout A2 downtime log (M8 runbook gap; synthetic only). A window records that the tenant or some
 * locations ran on paper; entries are the paper records transcribed afterwards. The log never applies an
 * entry: a human reviewer applies it through the owning command (S, C, B) and then links that committed
 * command here (operation, resource, correlation), or rejects or supersedes it. The database enforces one
 * open window per scope, the capture bounds, append-only entries and the one review transition.
 */
export const DOWNTIME_LOG_GRACE_DAYS = 14;
export const DOWNTIME_LIST_LIMIT = 500;
export const DOWNTIME_PAYLOAD_MAX_BYTES = 8192;

/** The owning operations an entry of each kind may be applied through (operation id prefixes). */
export const DOWNTIME_APPLY_PREFIXES: Readonly<Record<string, readonly string[] | null>> = {
  appointment_booking: ['scheduling.appointments.'],
  attendance: ['scheduling.attendance.'],
  payment: ['billing.payments.'],
  clinical_note: ['clinical.notes.'],
  patient_registration: ['patients.'],
  other: null,
};

type Scope = 'tenant' | 'locations';
interface WindowRow extends Record<string, unknown> {
  id: string;
  scope_kind: Scope;
  location_refs: string[];
  reason_code: string;
  state: 'open' | 'ended';
  started_at: Date;
  ended_at: Date | null;
  version: number;
}
interface EntryRow extends Record<string, unknown> {
  id: string;
  window_id: string;
  entry_kind: string;
  review_state: string;
  logged_at: Date;
  version: number;
}

const forbiddenLocation = () => new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });

/** A location-restricted member acts only on windows wholly inside its locations, never tenant-wide. */
function assertScopeAllowed(decision: AuthorizationDecision, scope: Scope, locationRefs: readonly string[]) {
  if (decision.locationRefs === null) return;
  if (scope === 'tenant' || !locationRefs.every((l) => decision.locationRefs?.includes(l)))
    throw forbiddenLocation();
}

async function loadWindow(tx: TenantTransaction, windowRef: string, lock = false): Promise<WindowRow> {
  const { rows } = await tx.query<WindowRow>(
    `SELECT id, scope_kind, location_refs, reason_code, state, started_at, ended_at, version
     FROM cuspatlas.ops_downtime_windows WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [windowRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());
const stale = (currentVersion: number) =>
  new RefusalError({ code: 'stale_version', detail: { currentVersion } });

export function createDowntimeOperations(base: MigrationBase) {
  const { deps, execute } = base;
  const decide = (ctx: ActorContext, op: ActionName) =>
    deps.authorize(ctx, op, { tenantId: ctx.tenantId, id: 'migration' });

  return {
    /** Opens a downtime window; refused while any open window covers an overlapping scope. */
    startDowntime(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<
      CommandResult<{ windowRef: string; state: string; startedAt: string; endedAt: string | null }>
    > {
      const op = 'operations.downtime.start';
      return base.guarded(ctx, op, async () => {
        const decision = await decide(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ scope: Scope; locationRefs?: string[]; reasonCode: string; startedAt?: string }>(
          validateDowntimeStart,
          p,
        );
        const locations = p.locationRefs ?? [];
        if ((p.scope === 'tenant') !== (locations.length === 0)) throw failed('scope_locations_mismatch');
        assertScopeAllowed(decision, p.scope, locations);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            // Window and entry instants are checked against the database clock that stamps the
            // defaults (started_at, ended_at, logged_at = now()) (clock audit).
            if (p.startedAt !== undefined && Date.parse(p.startedAt) > (await databaseNow(tx)).getTime())
              throw failed('started_in_future');
            const sorted = [...locations].sort();
            const { rows: open } = await tx.query<{ id: string }>(
              `SELECT id FROM cuspatlas.ops_downtime_windows
               WHERE state = 'open' AND (scope_kind = 'tenant' OR $1 = 'tenant' OR location_refs && $2::text[])
               ORDER BY started_at, id`,
              [p.scope, sorted],
            );
            if (open.length > 0)
              throw conflict(
                'downtime_already_open',
                open.map((w) => ({ kind: 'downtimeWindow', ref: w.id })),
              );
            let row: { id: string; started_at: Date } | undefined;
            try {
              const { rows } = await tx.query<{ id: string; started_at: Date }>(
                `INSERT INTO cuspatlas.ops_downtime_windows (tenant_id, scope_kind, location_refs, reason_code,
                   started_at, started_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2::text[], $3, coalesce($4::timestamptz, now()),
                   cuspatlas.current_actor_id())
                 RETURNING id, started_at`,
                [p.scope, sorted, p.reasonCode, p.startedAt ?? null],
              );
              row = rows[0];
            } catch (err) {
              if (isPgError(err, '23505')) throw conflict('downtime_already_open');
              if (isPgError(err, '23514')) throw failed('started_in_future');
              throw err;
            }
            if (!row) throw new Error('downtime window insert returned no row');
            await recordCommand(
              tx,
              { operation: op, resourceType: 'downtimeWindow', resourceRef: row.id, resourceVersion: 1 },
              { changedFields: ['state'] },
            );
            return {
              data: {
                windowRef: row.id,
                state: 'open',
                startedAt: row.started_at.toISOString(),
                endedAt: null,
              },
              version: 1,
            };
          }),
        );
      });
    },

    /** Ends the open window at its expected version (optimistic); a window ends once. */
    endDowntime(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<
      CommandResult<{ windowRef: string; state: string; startedAt: string; endedAt: string | null }>
    > {
      const op = 'operations.downtime.end';
      return base.guarded(ctx, op, async () => {
        const decision = await decide(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ windowRef: string; expectedVersion: number; endedAt?: string }>(validateDowntimeEnd, p);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            const w = await loadWindow(tx, p.windowRef, true);
            assertScopeAllowed(decision, w.scope_kind, w.location_refs);
            if (w.state !== 'open') throw conflict('window_not_open');
            if (w.version !== p.expectedVersion) throw stale(w.version);
            const endedAt = p.endedAt === undefined ? null : new Date(p.endedAt);
            if (endedAt && (endedAt < w.started_at || endedAt.getTime() > (await databaseNow(tx)).getTime()))
              throw failed('ended_outside_window');
            const { rows } = await tx.query<{ ended_at: Date }>(
              `UPDATE cuspatlas.ops_downtime_windows SET state = 'ended', ended_at = coalesce($2::timestamptz, now()),
                 ended_by = cuspatlas.current_actor_id(), version = version + 1, updated_at = now()
               WHERE id = $1 RETURNING ended_at`,
              [w.id, endedAt],
            );
            const version = w.version + 1;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'downtimeWindow', resourceRef: w.id, resourceVersion: version },
              { changedFields: ['state', 'endedAt'] },
            );
            return {
              data: {
                windowRef: w.id,
                state: 'ended',
                startedAt: w.started_at.toISOString(),
                endedAt: iso(rows[0]?.ended_at ?? null),
              },
              version,
            };
          }),
        );
      });
    },

    /** Logs one transcribed paper record, pending review; never applied and never overwritten. */
    logDowntimeEntry(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<{ entryRef: string; windowRef: string; reviewState: string }>> {
      const op = 'operations.downtime.log';
      return base.guarded(ctx, op, async () => {
        const decision = await decide(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{
          windowRef: string;
          entryKind: string;
          summary: string;
          payload: { name: string; value: string }[];
          paperRef: string;
          capturedAt: string;
        }>(validateDowntimeLog, p);
        // Closed field list on the wire (no open request maps); stored as one object per entry.
        const fields: Record<string, string> = {};
        for (const f of p.payload) {
          if (Object.hasOwn(fields, f.name)) throw failed('duplicate_field');
          fields[f.name] = f.value;
        }
        const payload = JSON.stringify(fields);
        if (Buffer.byteLength(payload, 'utf8') > DOWNTIME_PAYLOAD_MAX_BYTES)
          throw failed('payload_too_large');
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            const w = await loadWindow(tx, p.windowRef);
            assertScopeAllowed(decision, w.scope_kind, w.location_refs);
            const now = (await databaseNow(tx)).getTime();
            if (w.ended_at && w.ended_at.getTime() < now - DOWNTIME_LOG_GRACE_DAYS * 86_400_000)
              throw conflict('window_closed_for_logging');
            const captured = Date.parse(p.capturedAt);
            if (
              captured < w.started_at.getTime() ||
              captured > (w.ended_at?.getTime() ?? now) ||
              captured > now
            )
              throw failed('captured_outside_window');
            let id: string | undefined;
            try {
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.ops_downtime_entries (tenant_id, window_id, entry_kind, summary, payload,
                   paper_ref, captured_at, logged_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4::jsonb, $5, $6, cuspatlas.current_actor_id())
                 RETURNING id`,
                [w.id, p.entryKind, p.summary, payload, p.paperRef, p.capturedAt],
              );
              id = rows[0]?.id;
            } catch (err) {
              if (isPgError(err, '23514')) throw failed('captured_outside_window');
              throw err;
            }
            if (!id) throw new Error('downtime entry insert returned no row');
            await recordCommand(
              tx,
              { operation: op, resourceType: 'downtimeEntry', resourceRef: id, resourceVersion: 1 },
              { changedFields: ['entry'] },
            );
            return { data: { entryRef: id, windowRef: w.id, reviewState: 'pending_review' }, version: 1 };
          }),
        );
      });
    },

    /**
     * A human reviewer resolves one pending entry: `applied` names the committed owning command (it must
     * exist in this tenant's audit record after the entry was logged, match the entry kind, and apply no
     * other entry); `rejected` names a reason code; `superseded` names the entry that replaces it.
     */
    resolveDowntimeEntry(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<{ entryRef: string; windowRef: string; reviewState: string }>> {
      const op = 'operations.downtime.entries.resolve';
      return base.guarded(ctx, op, async () => {
        const decision = await decide(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{
          entryRef: string;
          expectedVersion: number;
          decision: 'applied' | 'rejected' | 'superseded';
          appliedCommand?: { operation: string; resourceRef: string; correlationId: string };
          rejectionReason?: string;
          supersededByRef?: string;
        }>(validateDowntimeEntryResolve, p);
        const fields = {
          applied: p.appliedCommand !== undefined,
          rejected: p.rejectionReason !== undefined,
          superseded: p.supersededByRef !== undefined,
        };
        if (!fields[p.decision] || Object.values(fields).filter(Boolean).length !== 1)
          throw failed('decision_fields_mismatch');
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            const { rows } = await tx.query<EntryRow>(
              `SELECT id, window_id, entry_kind, review_state, logged_at, version
               FROM cuspatlas.ops_downtime_entries WHERE id = $1 FOR UPDATE`,
              [p.entryRef],
            );
            const e = rows[0];
            if (!e) throw notFound();
            const w = await loadWindow(tx, e.window_id);
            assertScopeAllowed(decision, w.scope_kind, w.location_refs);
            if (e.review_state !== 'pending_review') throw conflict('already_resolved');
            if (e.version !== p.expectedVersion) throw stale(e.version);
            const a = p.appliedCommand;
            if (a) {
              const prefixes = DOWNTIME_APPLY_PREFIXES[e.entry_kind];
              if (
                a.operation.startsWith('operations.downtime.') ||
                (prefixes && !prefixes.some((x) => a.operation.startsWith(x)))
              )
                throw failed('applied_operation_mismatch');
              const { rows: found } = await tx.query<{ ok: boolean }>(
                'SELECT cuspatlas.ops_downtime_command_exists($1, $2, $3, $4) AS ok',
                [a.operation, a.resourceRef, a.correlationId, e.logged_at],
              );
              if (found[0]?.ok !== true) throw failed('applied_command_not_found');
              const { rows: linked } = await tx.query<{ id: string }>(
                `SELECT id FROM cuspatlas.ops_downtime_entries WHERE review_state = 'applied'
                   AND applied_operation = $1 AND applied_resource_ref = $2 AND applied_correlation_id = $3`,
                [a.operation, a.resourceRef, a.correlationId],
              );
              if (linked[0])
                throw conflict('applied_command_already_linked', [
                  { kind: 'downtimeEntry', ref: linked[0].id },
                ]);
            }
            if (p.supersededByRef !== undefined) {
              const { rows: by } = await tx.query<{ review_state: string }>(
                'SELECT review_state FROM cuspatlas.ops_downtime_entries WHERE id = $1',
                [p.supersededByRef],
              );
              const state = by[0]?.review_state;
              if (p.supersededByRef === e.id || !state || state === 'rejected' || state === 'superseded')
                throw failed('superseding_entry_invalid');
            }
            try {
              await tx.query(
                `UPDATE cuspatlas.ops_downtime_entries SET review_state = $2, reviewed_by = cuspatlas.current_actor_id(),
                   reviewed_at = now(), applied_operation = $3, applied_resource_ref = $4, applied_correlation_id = $5,
                   rejection_reason = $6, superseded_by = $7, version = version + 1
                 WHERE id = $1`,
                [
                  e.id,
                  p.decision,
                  a?.operation ?? null,
                  a?.resourceRef ?? null,
                  a?.correlationId ?? null,
                  p.rejectionReason ?? null,
                  p.supersededByRef ?? null,
                ],
              );
            } catch (err) {
              if (isPgError(err, '23505')) throw conflict('applied_command_already_linked');
              if (isPgError(err, '23503')) throw failed('applied_command_not_found');
              throw err;
            }
            const version = e.version + 1;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'downtimeEntry', resourceRef: e.id, resourceVersion: version },
              { changedFields: ['reviewState'] },
            );
            return { data: { entryRef: e.id, windowRef: e.window_id, reviewState: p.decision }, version };
          }),
        );
      });
    },

    /** Downtime windows of the tenant, newest first, with their pending entry counts. */
    listDowntimeWindows(ctx: ActorContext, query: unknown) {
      const op = 'operations.downtime.windows.list';
      return base.guarded(ctx, op, async () => {
        await decide(ctx, op);
        const q = query ?? {};
        validate<{ state?: 'open' | 'ended' }>(validateDowntimeWindowListQuery, q);
        // Closeout C: signed keyset pages (newest start first, id ascending within one instant).
        const pg = keysetPage(base, ctx, op, q, DOWNTIME_LIST_LIMIT);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows: fetched } = await tx.query<WindowRow & { pending: number; position: string }>(
            `SELECT w.id, w.scope_kind, w.location_refs, w.reason_code, w.state, w.started_at, w.ended_at, w.version,
               (SELECT count(*)::int FROM cuspatlas.ops_downtime_entries e
                WHERE e.window_id = w.id AND e.review_state = 'pending_review') AS pending,
               ${positionSql('w.started_at')}
             FROM cuspatlas.ops_downtime_windows w
             WHERE ($1::text IS NULL OR w.state = $1)
               AND ($3::timestamp IS NULL OR w.started_at AT TIME ZONE 'UTC' < $3::timestamp
                 OR (w.started_at AT TIME ZONE 'UTC' = $3::timestamp AND w.id > $4::uuid))
             ORDER BY w.started_at DESC, w.id LIMIT $2`,
            [q.state ?? null, pg.limit + 1, pg.afterAt, pg.afterId],
          );
          const { rows, nextCursor } = pg.next(fetched);
          return {
            nextCursor,
            data: rows.map((w) => ({
              windowRef: w.id,
              scope: w.scope_kind,
              locationRefs: w.location_refs,
              reasonCode: w.reason_code,
              state: w.state,
              startedAt: w.started_at.toISOString(),
              endedAt: iso(w.ended_at),
              pendingEntries: w.pending,
              version: w.version,
            })),
          };
        });
      });
    },

    /** The reconciliation worklist: entries by window, review state and kind, oldest capture first. */
    listDowntimeEntries(ctx: ActorContext, query: unknown) {
      const op = 'operations.downtime.entries.list';
      return base.guarded(ctx, op, async () => {
        await decide(ctx, op);
        const q = query ?? {};
        validate<{ windowRef?: string; reviewState?: string; entryKind?: string }>(
          validateDowntimeEntryListQuery,
          q,
        );
        // Closeout C: signed keyset pages (oldest capture first, id ascending within one instant).
        const pg = keysetPage(base, ctx, op, q, DOWNTIME_LIST_LIMIT);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows: fetched } = await tx.query<{
            id: string;
            position: string;
            window_id: string;
            entry_kind: string;
            summary: string;
            payload: Record<string, unknown>;
            paper_ref: string;
            captured_at: Date;
            logged_at: Date;
            logged_by: string;
            review_state: string;
            reviewed_by: string | null;
            reviewed_at: Date | null;
            applied_operation: string | null;
            applied_resource_ref: string | null;
            applied_correlation_id: string | null;
            rejection_reason: string | null;
            superseded_by: string | null;
            version: number;
          }>(
            `SELECT id, window_id, entry_kind, summary, payload, paper_ref, captured_at, logged_at, logged_by,
               review_state, reviewed_by, reviewed_at, applied_operation, applied_resource_ref, applied_correlation_id,
               rejection_reason, superseded_by, version, ${positionSql('captured_at')}
             FROM cuspatlas.ops_downtime_entries
             WHERE ($1::uuid IS NULL OR window_id = $1) AND ($2::text IS NULL OR review_state = $2)
               AND ($3::text IS NULL OR entry_kind = $3)
               AND ($5::timestamp IS NULL OR (captured_at AT TIME ZONE 'UTC', id) > ($5::timestamp, $6::uuid))
             ORDER BY captured_at, id LIMIT $4`,
            [
              q.windowRef ?? null,
              q.reviewState ?? null,
              q.entryKind ?? null,
              pg.limit + 1,
              pg.afterAt,
              pg.afterId,
            ],
          );
          const { rows, nextCursor } = pg.next(fetched);
          return {
            nextCursor,
            data: rows.map((e) => ({
              entryRef: e.id,
              windowRef: e.window_id,
              entryKind: e.entry_kind,
              summary: e.summary,
              payload: e.payload,
              paperRef: e.paper_ref,
              capturedAt: e.captured_at.toISOString(),
              loggedAt: e.logged_at.toISOString(),
              loggedBy: e.logged_by,
              reviewState: e.review_state,
              review:
                e.reviewed_by === null || e.reviewed_at === null
                  ? null
                  : {
                      reviewedBy: e.reviewed_by,
                      reviewedAt: e.reviewed_at.toISOString(),
                      appliedCommand:
                        e.applied_operation === null
                          ? null
                          : {
                              operation: e.applied_operation,
                              resourceRef: e.applied_resource_ref,
                              correlationId: e.applied_correlation_id,
                            },
                      rejectionReason: e.rejection_reason,
                      supersededByRef: e.superseded_by,
                    },
              version: e.version,
            })),
          };
        });
      });
    },
  };
}
