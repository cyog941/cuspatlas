import { randomUUID } from 'node:crypto';
import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  foundationDef,
  LIST_OPERATIONS,
  RefusalError,
  SYNTHETIC_TASK_PROPERTIES,
  type TenantTransaction,
  validateIdempotencyKey,
} from '@cuspatlas/contracts';
import catalog from '@cuspatlas/contracts/catalog/operations.json' with { type: 'json' };
import type { ReplayCodec, StoredResult } from '../commands/execute-once';
import type { CommandExecutor } from '../commands/executor';
import type { ComposerBase } from '../composers/framework';
import { recordCommand } from '../events/record-command';

/**
 * A22 (OR-12, OR-D5 accepted): per-user saved views, favourite reports and recently opened patients.
 * Every row is the caller's own in the caller's tenant (RLS on tenant AND actor). Saved views hold
 * filters only: the target must be a registered list operation the caller may call, and a filter the
 * list registry marks identifying (name, birth date, phone) or a cursor is refused, as is a name with
 * digits or symbols (the database pattern), so no patient identity is stored in a view. Recent patients
 * are references only, kept 7 days (expired rows are never returned and are purged on every access),
 * clearable by the user.
 */
export const RECENT_PATIENT_RETENTION_DAYS = 7;
export const RECENT_PATIENTS_MAX = 50;
export const SAVED_VIEWS_MAX = 100;
const OPERATIONS = new Map(
  (catalog as unknown as { operation: string; kind: string; action: string | null }[]).map((o) => [
    o.operation,
    o,
  ]),
);
const RESOURCE = {
  view: 'userSavedView',
  favourite: 'userFavouriteReport',
  recent: 'userRecentPatient',
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const v = {
  save: foundationDef('SavedViewSave'),
  favourite: foundationDef('FavouriteReportChange'),
  record: foundationDef('RecentPatientRecord'),
  empty: foundationDef('EmptyCommand'),
};
const notFound = () => new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
const failed = (reason: string) => new RefusalError({ code: 'validation_failed', detail: { reason } });

const ENVELOPE = (rows: number, key: string, tieBreak: string, limit: number) => ({
  asOf: new Date().toISOString(),
  appliedFilters: {},
  scope: { kind: 'tenant_wide' as const },
  limit,
  truncated: false,
  nextCursor: null,
  ordering: { key, direction: 'asc' as const, tieBreak },
  count: { exact: rows },
});

export interface PreferenceDeps {
  readonly execute: CommandExecutor;
}

export function createPreferenceOperations(base: ComposerBase, deps: PreferenceDeps) {
  const tx = base.deps.withTenantTransaction;
  const check = (envelope: CommandEnvelope<unknown>, operation: string) => {
    if (envelope.operation !== operation) throw new RefusalError({ code: 'invalid_request' });
    assertValid(validateIdempotencyKey, envelope.idempotencyKey, SYNTHETIC_TASK_PROPERTIES);
  };
  const purge = (t: TenantTransaction) => t.query('SELECT cuspatlas.purge_expired_recent_patients()');

  /** Runs one preference command: authorize, validate, then execute once with its audit row. */
  function command<T>(
    ctx: ActorContext,
    op: Parameters<ComposerBase['authorize']>[1],
    envelope: CommandEnvelope<unknown>,
    validate: (payload: unknown) => void,
    work: (t: TenantTransaction) => Promise<{ data: T; version: number }>,
    also?: Parameters<ComposerBase['authorize']>[1],
  ): Promise<CommandResult<T>> {
    return base.guarded(ctx, op, async () => {
      await base.authorize(ctx, op);
      if (also) await base.authorize(ctx, also);
      check(envelope, op);
      validate(envelope.payload);
      return tx(ctx, (t) => deps.execute<T>(ctx, envelope, t, () => work(t)));
    });
  }

  return {
    listSavedViews(ctx: ActorContext) {
      const op = 'preferences.savedViews.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return tx(ctx, async (t) => {
          const { rows } = await t.query<{
            id: string;
            name: string;
            operation: string;
            filters: Record<string, unknown>;
            version: number;
            updated_at: Date;
          }>(
            `SELECT id, name, operation, filters, version, updated_at FROM cuspatlas.user_saved_views
             ORDER BY name, id LIMIT ${SAVED_VIEWS_MAX}`,
          );
          return {
            data: rows.map((r) => ({
              viewRef: r.id,
              name: r.name,
              operation: r.operation,
              filters: r.filters,
              version: r.version,
              updatedAt: r.updated_at.toISOString(),
            })),
            envelope: ENVELOPE(rows.length, 'name', 'viewRef', SAVED_VIEWS_MAX),
          };
        });
      });
    },

    saveView(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'preferences.savedViews.save';
      type P = { name: string; operation: string; filters: Record<string, unknown> };
      return command<{ viewRef: string; name: string; operation: string; version: number }>(
        ctx,
        op,
        envelope,
        (p) => {
          assertValid<P>(v.save, p, SYNTHETIC_TASK_PROPERTIES);
          const list = LIST_OPERATIONS[p.operation];
          if (!list || !OPERATIONS.has(p.operation)) throw failed('not_a_list_operation');
          const sensitive = new Set([...(list.sensitiveFilters ?? []), 'cursor']);
          if (Object.keys(p.filters).some((k) => sensitive.has(k))) throw failed('identifying_filter');
        },
        async (t) => {
          const p = envelope.payload as P;
          const { rows } = await t.query<{ id: string; version: number }>(
            `INSERT INTO cuspatlas.user_saved_views (tenant_id, principal_id, operation, name, filters)
             VALUES (cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $1, $2, $3::jsonb)
             ON CONFLICT (tenant_id, principal_id, name) DO UPDATE SET operation = EXCLUDED.operation,
               filters = EXCLUDED.filters, version = cuspatlas.user_saved_views.version + 1, updated_at = now()
             RETURNING id, version`,
            [p.operation, p.name, JSON.stringify(p.filters)],
          );
          const r = rows[0] as { id: string; version: number };
          await recordCommand(
            t,
            { operation: op, resourceType: RESOURCE.view, resourceRef: r.id, resourceVersion: r.version },
            { changedFields: ['name', 'operation', 'filters'] },
          );
          return {
            data: { viewRef: r.id, name: p.name, operation: p.operation, version: r.version },
            version: r.version,
          };
        },
      );
    },

    deleteView(ctx: ActorContext, viewRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'preferences.savedViews.delete';
      return command<{ viewRef: string; deleted: boolean }>(
        ctx,
        op,
        envelope,
        (p) => assertValid(v.empty, p ?? {}, SYNTHETIC_TASK_PROPERTIES),
        async (t) => {
          if (!UUID.test(viewRef)) throw notFound();
          const { rows } = await t.query<{ version: number }>(
            'DELETE FROM cuspatlas.user_saved_views WHERE id = $1 RETURNING version',
            [viewRef],
          );
          const r = rows[0];
          if (!r) throw notFound();
          await recordCommand(
            t,
            {
              operation: op,
              resourceType: RESOURCE.view,
              resourceRef: viewRef,
              resourceVersion: r.version + 1,
            },
            { changedFields: ['deleted'] },
          );
          return { data: { viewRef, deleted: true }, version: r.version + 1 };
        },
      );
    },

    listFavourites(ctx: ActorContext) {
      const op = 'preferences.favourites.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return tx(ctx, async (t) => {
          const { rows } = await t.query<{ operation: string; created_at: Date }>(
            'SELECT operation, created_at FROM cuspatlas.user_favourite_reports ORDER BY operation LIMIT 100',
          );
          return {
            data: rows.map((r) => ({ operation: r.operation, addedAt: r.created_at.toISOString() })),
            envelope: ENVELOPE(rows.length, 'operation', 'operation', 100),
          };
        });
      });
    },

    changeFavourite(ctx: ActorContext, add: boolean, envelope: CommandEnvelope<unknown>) {
      const op = add ? 'preferences.favourites.add' : 'preferences.favourites.remove';
      return command<{ operation: string; favourite: boolean }>(
        ctx,
        op,
        envelope,
        (p) => {
          assertValid<{ operation: string }>(v.favourite, p, SYNTHETIC_TASK_PROPERTIES);
          const o = OPERATIONS.get(p.operation);
          // A favourite report is a catalog query (a read), never a command.
          if (!o || o.kind !== 'query') throw failed('not_a_report_operation');
        },
        async (t) => {
          const { operation } = envelope.payload as { operation: string };
          if (add)
            await t.query(
              `INSERT INTO cuspatlas.user_favourite_reports (tenant_id, principal_id, operation)
               VALUES (cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $1) ON CONFLICT DO NOTHING`,
              [operation],
            );
          else
            await t.query('DELETE FROM cuspatlas.user_favourite_reports WHERE operation = $1', [operation]);
          await recordCommand(
            t,
            {
              operation: op,
              resourceType: RESOURCE.favourite,
              resourceRef: randomUUID(),
              resourceVersion: 1,
            },
            { changedFields: ['operation'] },
          );
          return { data: { operation, favourite: add }, version: 1 };
        },
      );
    },

    listRecentPatients(ctx: ActorContext) {
      const op = 'preferences.recentPatients.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return tx(ctx, async (t) => {
          await purge(t);
          const { rows } = await t.query<{ patient_id: string; opened_at: Date }>(
            `SELECT patient_id, opened_at FROM cuspatlas.user_recent_patients
             WHERE opened_at >= now() - make_interval(days => $1) ORDER BY opened_at DESC, patient_id LIMIT $2`,
            [RECENT_PATIENT_RETENTION_DAYS, RECENT_PATIENTS_MAX],
          );
          return {
            data: rows.map((r) => ({ patientRef: r.patient_id, openedAt: r.opened_at.toISOString() })),
            retentionDays: RECENT_PATIENT_RETENTION_DAYS,
            envelope: {
              ...ENVELOPE(rows.length, 'openedAt', 'patientRef', RECENT_PATIENTS_MAX),
              ordering: { key: 'openedAt', direction: 'desc' as const, tieBreak: 'patientRef' },
            },
          };
        });
      });
    },

    recordRecentPatient(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'preferences.recentPatients.record';
      // Remembering a patient needs the right to read that patient.
      return command<{ patientRef: string; openedAt: string }>(
        ctx,
        op,
        envelope,
        (p) => assertValid(v.record, p, SYNTHETIC_TASK_PROPERTIES),
        async (t) => {
          const { patientRef } = envelope.payload as { patientRef: string };
          await purge(t);
          const { rows: exists } = await t.query('SELECT 1 FROM cuspatlas.patients WHERE id = $1', [
            patientRef,
          ]);
          if (exists.length === 0) throw notFound();
          const { rows } = await t.query<{ opened_at: Date }>(
            `INSERT INTO cuspatlas.user_recent_patients (tenant_id, principal_id, patient_id)
               VALUES (cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $1)
               ON CONFLICT (tenant_id, principal_id, patient_id) DO UPDATE SET opened_at = now()
               RETURNING opened_at`,
            [patientRef],
          );
          // Keep the newest entries only (bounded per user).
          await t.query(
            `DELETE FROM cuspatlas.user_recent_patients WHERE patient_id IN (
                 SELECT patient_id FROM cuspatlas.user_recent_patients ORDER BY opened_at DESC, patient_id OFFSET $1)`,
            [RECENT_PATIENTS_MAX],
          );
          await recordCommand(
            t,
            { operation: op, resourceType: RESOURCE.recent, resourceRef: randomUUID(), resourceVersion: 1 },
            { changedFields: ['openedAt'] },
          );
          const at = (rows[0] as { opened_at: Date }).opened_at.toISOString();
          return { data: { patientRef, openedAt: at }, version: 1 };
        },
        'patients.read',
      );
    },

    clearRecentPatients(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'preferences.recentPatients.clear';
      return command<{ cleared: number }>(
        ctx,
        op,
        envelope,
        (p) => assertValid(v.empty, p ?? {}, SYNTHETIC_TASK_PROPERTIES),
        async (t) => {
          const { rowCount } = await t.query('DELETE FROM cuspatlas.user_recent_patients');
          await recordCommand(
            t,
            { operation: op, resourceType: RESOURCE.recent, resourceRef: randomUUID(), resourceVersion: 1 },
            { changedFields: ['cleared'] },
          );
          return { data: { cleared: rowCount ?? 0 }, version: 1 };
        },
      );
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: results are flat records of server values.
function flat<T extends Record<string, any>>(
  stored: readonly string[],
  fromPayload: readonly string[] = [],
): ReplayCodec<T> {
  return {
    persist: (data): StoredResult => {
      const out: Record<string, string | number | boolean | null> = { kind: 'success' };
      for (const k of stored) out[k] = data[k] as string | number | boolean | null;
      return out;
    },
    restore(s, payload) {
      if (s.kind !== 'success') throw new Error('Stored result is malformed');
      const out: Record<string, unknown> = {};
      for (const k of stored) {
        if (!(k in s)) throw new Error('Stored result is malformed');
        out[k] = s[k];
      }
      for (const k of fromPayload) out[k] = (payload as Record<string, unknown> | null)?.[k];
      return out as T;
    },
  };
}

/** Replay projections: server values only; caller input (name, operation) comes back from the payload. */
// biome-ignore lint/suspicious/noExplicitAny: codecs are heterogeneous per operation.
export const PREFERENCE_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<any>>> = {
  'preferences.savedViews.save': flat(['viewRef', 'version'], ['name', 'operation']),
  'preferences.savedViews.delete': flat(['viewRef', 'deleted']),
  'preferences.favourites.add': flat(['favourite'], ['operation']),
  'preferences.favourites.remove': flat(['favourite'], ['operation']),
  'preferences.recentPatients.record': flat(['patientRef', 'openedAt']),
  'preferences.recentPatients.clear': flat(['cleared']),
};
