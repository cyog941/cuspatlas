import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  MIGRATION_PROPERTIES,
  RefusalError,
  type TenantTransaction,
  validateMigrationIdempotencyKey,
  validateMigrationRef,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, withAttemptRecording } from '../commands/boundary';
import { executeOnce } from '../commands/execute-once';
import type { CommandExecutor } from '../commands/executor';
import type { PatientService } from '../patients';
import type { ActionName, Authorize } from '../policy/authorize';
import { createSchedulingCursorCodec, type SchedulingCursorCodec } from '../scheduling/cursor';
import type { PracticeExportDeps } from './practice-export';

export interface MigrationDeps {
  readonly authorize: Authorize;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly recording: AttemptRecordingDeps;
  /** S4/S6: patients are created, linked and merged only through the patient service (never SQL). */
  readonly patients: PatientService;
  /** Same tenant-bound HMAC pepper S uses for match keys (M4 candidate scoring, no plaintext stored). */
  readonly matchKeyPepper: Uint8Array;
  readonly execute?: CommandExecutor;
  /** M1: the composed S/I/C/E/B exports, the private store and the delivery-grant secret. */
  readonly practiceExport?: PracticeExportDeps;
  /**
   * Closeout C: the signed list-cursor codec (the shared CUSPATLAS_CURSOR_KEY ring). Defaults to a
   * per-process random key for isolated domain tests; transports pass the configured ring.
   */
  readonly cursors?: SchedulingCursorCodec;
}

export interface MigrationBase {
  readonly deps: MigrationDeps;
  readonly execute: CommandExecutor;
  readonly cursors: SchedulingCursorCodec;
  guarded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T>;
  authorize(ctx: ActorContext, action: ActionName): Promise<void>;
}

/**
 * Shared plumbing of the migration service (M2-M6). Authorization runs first (inside the attempt
 * boundary), then validation, then the tenant transaction; the tenant always comes from the context.
 */
export function createMigrationBase(deps: MigrationDeps): MigrationBase {
  return {
    deps,
    execute: deps.execute ?? executeOnce,
    cursors: deps.cursors ?? createSchedulingCursorCodec(),
    guarded: (ctx, operation, work) =>
      withAttemptRecording(
        deps.recording,
        { correlationId: ctx.correlationId, tenantId: ctx.tenantId, actorId: ctx.actorId, operation },
        work,
      ),
    async authorize(ctx, action) {
      await deps.authorize(ctx, action, { tenantId: ctx.tenantId, id: 'migration' });
    },
  };
}

export const MIGRATION_PACKAGE_RESOURCE = 'migrationPackage';

export const notFound = () =>
  new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
/** Domain validation (422): the reason names the rule; caller text is never echoed. */
export const failed = (reason: string) => new RefusalError({ code: 'validation_failed', detail: { reason } });
export const conflict = (reason: string, blockingRefs?: readonly { kind: string; ref: string }[]) =>
  new RefusalError({
    code: 'conflict',
    detail: blockingRefs === undefined || blockingRefs.length === 0 ? { reason } : { reason, blockingRefs },
  });

export const isPgError = (err: unknown, code: string) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;

export function checkEnvelope(envelope: CommandEnvelope<unknown>, operation: string): void {
  if (envelope.operation !== operation) throw new RefusalError({ code: 'invalid_request' });
  assertValid(validateMigrationIdempotencyKey, envelope.idempotencyKey, new Set(['idempotencyKey']));
}

export function validate<T>(fn: Parameters<typeof assertValid>[0], value: unknown): asserts value is T {
  assertValid<T>(fn, value, MIGRATION_PROPERTIES);
}

export function assertRef(ref: string): void {
  if (!validateMigrationRef(ref)) throw notFound();
}

export interface PackageRow extends Record<string, unknown> {
  id: string;
  profile_id: string;
  source_system: string;
  format: string;
  practice_ref: string;
  package_digest: string;
  produced_at: Date;
  change_seq: number;
  cutover_state: 'reconciling' | 'readyForCutover';
  version: number;
}

/** A package of the current tenant (RLS); hidden and missing are one 404. */
export async function loadPackage(
  tx: TenantTransaction,
  packageRef: string,
  lock: '' | 'FOR UPDATE' = '',
): Promise<PackageRow> {
  assertRef(packageRef);
  const { rows } = await tx.query<PackageRow>(
    `SELECT p.id, p.profile_id, s.source_system, s.format, s.practice_ref, p.package_digest, p.produced_at,
       p.change_seq, p.cutover_state, p.version
     FROM cuspatlas.migration_packages p JOIN cuspatlas.migration_source_profiles s ON s.id = p.profile_id
     WHERE p.id = $1 ${lock === '' ? '' : 'FOR UPDATE OF p'}`,
    [packageRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * Records that the reconciliation changed (an apply batch, a review or identity decision): the
 * package leaves `readyForCutover`, and every sign-off bound to the previous report digest is stale.
 */
export async function bumpChange(tx: TenantTransaction, packageId: string): Promise<number> {
  const { rows } = await tx.query<{ version: number }>(
    `UPDATE cuspatlas.migration_packages SET change_seq = change_seq + 1, cutover_state = 'reconciling',
       version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
    [packageId],
  );
  return rows[0]?.version ?? 1;
}

/**
 * Closeout C: one keyset page of a migration or operations list. The cursor is signed (tenant-bound)
 * and bound to the listing and its filters; its position is the ordering instant in UTC microseconds
 * and the row id (`<instant>_<uuid>`). A page fetches `limit + 1` rows; the extra row only says that
 * another page exists. The SQL uses `position` (see POSITION_SQL) and the after-instant/after-id pair.
 */
export interface KeysetPage {
  readonly limit: number;
  readonly afterAt: string | null;
  readonly afterId: string | null;
  next<R extends { id: string; position: string }>(
    rows: readonly R[],
  ): { rows: R[]; nextCursor: string | null };
}

/** The ordering instant of a row as a cursor position (UTC, microseconds). */
export const positionSql = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS position`;

export function keysetPage(
  base: MigrationBase,
  ctx: ActorContext,
  listing: string,
  query: Readonly<Record<string, unknown>>,
  defaultLimit: number,
): KeysetPage {
  const filters = Object.keys(query)
    .filter((k) => k !== 'limit' && k !== 'cursor')
    .sort()
    .map((k) => [k, query[k]]);
  const scope = `${listing}:${JSON.stringify(filters)}`;
  const limit = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : defaultLimit;
  let afterAt: string | null = null;
  let afterId: string | null = null;
  if (typeof query.cursor === 'string') {
    const after = base.cursors.decode(ctx.tenantId, scope, query.cursor);
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})_([0-9a-f-]{36})$/.exec(after);
    if (!m) throw new RefusalError({ code: 'invalid_request' });
    afterAt = m[1] as string;
    afterId = m[2] as string;
  }
  return {
    limit,
    afterAt,
    afterId,
    next(rows) {
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        rows: page,
        nextCursor:
          rows.length > limit && last
            ? base.cursors.encode(ctx.tenantId, scope, `${last.position}_${last.id}`)
            : null,
      };
    },
  };
}
