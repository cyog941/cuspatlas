import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  CommitThenRefuse,
  isRefusalError,
  REFUSAL_CODES,
  type RefusalCode,
  type RefusalDetail,
  RefusalError,
  SECURITY_REASON_CODES,
  type SecurityReasonCode,
  type TenantTransaction,
} from '@cuspatlas/contracts';
import { ADMINISTRATION_REPLAY_CODECS } from '../administration/administration';
import { AGENT_REPLAY_CODECS } from '../agents/codecs';
import { AUTOMATION_EXPORT_CODECS } from '../automation/exports';
import { AUTOMATION_WEBHOOK_CODECS } from '../automation/webhooks';
import { BILLING_REPLAY_CODECS } from '../billing/codecs';
import { CLINICAL_REPLAY_CODECS } from '../clinical/codecs';
import { ENGAGEMENT_REPLAY_CODECS } from '../engagement/codecs';
import { IMAGING_REPLAY_CODECS } from '../imaging/codecs';
import { MIGRATION_REPLAY_CODECS } from '../migration/codecs';
import { PATIENT_REPLAY_CODECS } from '../patients/replay-codecs';
import { PREFERENCE_REPLAY_CODECS } from '../preferences/preferences';
import { APPOINTMENT_REPLAY_CODECS, SCHEDULING_REPLAY_CODECS } from '../scheduling/codecs';
import { EXTENDED_SCHEDULING_CODECS } from '../scheduling/ext-codecs';
import {
  configuredIdempotencyDigestKey,
  IDEMPOTENCY_DIGEST_SCHEME,
  idempotencyKeyDigest,
  idempotencyPayloadDigest,
  payloadDigest,
} from './digest';
import type { CommandExecutor } from './executor';
import { SYNTHETIC_TASK_REPLAY_CODECS } from './replay-codecs';

/** JSON object persisted as the replayable result. Holds server references and versions only. */
export type StoredResult = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Per-operation projection between a command's data and the safe stored result. `persist` keeps only
 * server-issued references; `restore` rebuilds the data from that projection plus the replay
 * request's payload, which has the same canonical digest as the original request.
 */
export interface ReplayCodec<T> {
  persist(data: T): StoredResult;
  restore(stored: StoredResult, payload: unknown): T;
}

export interface ExecuteOnceOptions {
  // biome-ignore lint/suspicious/noExplicitAny: codecs are heterogeneous per operation.
  readonly codecs: Readonly<Record<string, ReplayCodec<any>>>;
  /** A pending reservation older than this is treated as abandoned and taken over (frozen: 60 s). */
  readonly inFlightTimeoutSec?: number;
  /**
   * Server secret of the keyed payload digest. Absent: the process key set by
   * `configureIdempotencyDigestKey` (the API and MCP builders set it); with neither, commands refuse.
   */
  readonly digestKey?: Uint8Array;
}

/** Terminal domain refusals are recorded and replayed. Denials and retryable refusals never are. */
const TERMINAL: ReadonlySet<RefusalCode> = new Set([
  'stale_version',
  'validation_failed',
  'conflict',
  'invalid_request',
]);

interface ReservationRow extends Record<string, unknown> {
  state: 'pending' | 'committed' | 'failed';
  payload_digest: string;
  /** 2: keyed (HMAC) digest; 1: legacy unkeyed rows written before the integration change. */
  payload_digest_scheme: number;
  result: Record<string, unknown> | null;
  aggregate_version: number | null;
  abandoned: boolean;
  expired: boolean;
}

/** SQLSTATE 55P03: the db layer's transaction-local lock_timeout expired while waiting. */
const isLockTimeout = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '55P03';

const SCOPE = `tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id()
  AND operation = $1 AND key_digest = $2`;

function refusalFrom(result: Record<string, unknown>): RefusalError {
  const code = result.code;
  if (
    result.kind !== 'refusal' ||
    typeof code !== 'string' ||
    !(REFUSAL_CODES as readonly string[]).includes(code)
  ) {
    throw new Error('Stored refusal is malformed');
  }
  const detail = result.detail as RefusalDetail | undefined;
  return new RefusalError({
    code: code as RefusalCode,
    retryable: result.retryable === true,
    ...(typeof result.reasonCode === 'string' &&
    (SECURITY_REASON_CODES as readonly string[]).includes(result.reasonCode)
      ? { reasonCode: result.reasonCode as SecurityReasonCode }
      : {}),
    ...(detail === undefined ? {} : { detail }),
  });
}

/**
 * A stored refusal is replayed for 7 days to any reauthorized caller, whose visibility may have
 * narrowed since: conflict entries keep their kind, resource and explanation but never the
 * visibility-filtered `existingRef` (review hardening, batch 3).
 */
function withoutVisibilityRefs(detail: RefusalDetail): RefusalDetail {
  const strip = (list: NonNullable<RefusalDetail['conflicts']>) =>
    list.map(({ existingRef: _ref, ...c }) => c);
  return {
    ...detail,
    ...(detail.conflicts ? { conflicts: strip(detail.conflicts) } : {}),
    ...(detail.occurrences
      ? { occurrences: detail.occurrences.map((o) => ({ ...o, conflicts: strip(o.conflicts) })) }
      : {}),
  };
}

/**
 * Builds the durable `executeOnce` command executor. It has the `CommandExecutor` signature and runs
 * inside the caller's tenant transaction, after authorization, so every replay is reauthorized:
 *
 * 1. Reserve `(tenant, principal, operation, sha256(key))` with `INSERT .. ON CONFLICT DO NOTHING`;
 *    the payload digest stored with it is keyed (HMAC-SHA-256 under the server secret, tenant-bound).
 *    A concurrent duplicate blocks on the uncommitted unique entry until the first transaction ends,
 *    bounded by the tenant transaction's `lock_timeout` (10 s): on expiry it gets a retryable 409
 *    `conflict` and its transaction rolls back, so the caller retries instead of hanging.
 * 2. If a row exists, lock it (`FOR UPDATE`). Expired, or `pending` older than the in-flight timeout
 *    with the same digest: take it over. Different payload digest: 409 `idempotency_conflict`.
 *    `committed`: replay the stored result. `failed`: replay the stored refusal. Fresh `pending`
 *    (outcome unknown, still in flight): 409 `conflict`, retryable.
 * 3. Otherwise run the handler in a savepoint. Success: mark `committed` with the safe projection and
 *    aggregate version in the same transaction as the change. Terminal refusal: undo the handler's
 *    writes, mark `failed` with the typed refusal and commit only the reservation.
 */
export function createExecuteOnce(options: ExecuteOnceOptions): CommandExecutor {
  const timeout = options.inFlightTimeoutSec ?? 60;

  async function reserve(
    tx: TenantTransaction,
    operation: string,
    keyDigest: string,
    digest: string,
    matches: (row: ReservationRow) => boolean,
    correlationId: string,
  ): Promise<ReservationRow | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inserted = await tx.query(
        `INSERT INTO cuspatlas.command_idempotency (tenant_id, principal_id, operation, key_digest,
           payload_digest, payload_digest_scheme, state, correlation_id, reserved_at, expires_at)
         VALUES (cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $1, $2, $3, $5, 'pending', $4,
           now(), now() + interval '7 days')
         ON CONFLICT (tenant_id, principal_id, operation, key_digest) DO NOTHING`,
        [operation, keyDigest, digest, correlationId, IDEMPOTENCY_DIGEST_SCHEME],
      );
      if (inserted.rowCount === 1) return null;
      const { rows } = await tx.query<ReservationRow>(
        `SELECT state, payload_digest, payload_digest_scheme, result, aggregate_version,
           (state = 'pending' AND reserved_at < now() - make_interval(secs => $3)) AS abandoned,
           (expires_at <= now()) AS expired
         FROM cuspatlas.command_idempotency WHERE ${SCOPE} FOR UPDATE`,
        [operation, keyDigest, timeout],
      );
      const row = rows[0];
      if (!row) continue; // purged between the two statements: reserve again
      if (row.expired || (row.abandoned && matches(row))) {
        await tx.query(
          `UPDATE cuspatlas.command_idempotency SET state = 'pending', result = NULL,
             aggregate_version = NULL, payload_digest = $3, payload_digest_scheme = $5, correlation_id = $4,
             reserved_at = now(),
             expires_at = now() + interval '7 days', updated_at = now()
           WHERE ${SCOPE}`,
          [operation, keyDigest, digest, correlationId, IDEMPOTENCY_DIGEST_SCHEME],
        );
        return null;
      }
      return row;
    }
    throw new RefusalError({ code: 'conflict', retryable: true });
  }

  return async function executeOnce<T>(
    ctx: ActorContext,
    envelope: CommandEnvelope<unknown>,
    tx: TenantTransaction,
    handler: () => Promise<{ data: T; version: number }>,
  ): Promise<CommandResult<T>> {
    const codec = options.codecs[envelope.operation] as ReplayCodec<T> | undefined;
    if (!codec) throw new Error('No replay codec registered for this operation');
    const keyDigest = idempotencyKeyDigest(envelope.idempotencyKey);
    // Keyed digest (scheme 2): HMAC-SHA-256 under the server secret, tenant-bound. A legacy scheme 1
    // row (unkeyed SHA-256, written before this change) is still compared by its own scheme until it
    // expires (7 days); every new or taken-over reservation is written with scheme 2.
    const digest = idempotencyPayloadDigest(
      options.digestKey ?? configuredIdempotencyDigestKey(),
      ctx.tenantId,
      envelope.payload,
    );
    const matches = (row: ReservationRow) =>
      row.payload_digest === (row.payload_digest_scheme === 1 ? payloadDigest(envelope.payload) : digest);

    let existing: ReservationRow | null;
    try {
      existing = await reserve(tx, envelope.operation, keyDigest, digest, matches, ctx.correlationId);
    } catch (err) {
      if (isLockTimeout(err)) throw new RefusalError({ code: 'conflict', retryable: true });
      throw err;
    }
    if (existing) {
      if (!matches(existing)) throw new RefusalError({ code: 'idempotency_conflict' });
      if (existing.state === 'pending') throw new RefusalError({ code: 'conflict', retryable: true });
      if (existing.state === 'failed' && existing.result) throw refusalFrom(existing.result);
      if (existing.state !== 'committed' || !existing.result || existing.aggregate_version === null) {
        throw new Error('Reservation is in an unexpected state');
      }
      return {
        data: codec.restore(existing.result as StoredResult, envelope.payload),
        version: existing.aggregate_version,
        correlationId: ctx.correlationId,
        replayed: true,
      };
    }

    let outcome: { data: T; version: number };
    try {
      outcome = await tx.savepoint(handler);
    } catch (err) {
      if (!isRefusalError(err) || !TERMINAL.has(err.code) || err.retryable || !err.replayable) throw err;
      const detail = err.detail === undefined ? undefined : withoutVisibilityRefs(err.detail);
      const stored = {
        kind: 'refusal',
        code: err.code,
        retryable: err.retryable,
        ...(err.reasonCode === undefined ? {} : { reasonCode: err.reasonCode }),
        ...(detail === undefined ? {} : { detail }),
      };
      await tx.query(
        `UPDATE cuspatlas.command_idempotency SET state = 'failed', result = $3::jsonb, updated_at = now()
         WHERE ${SCOPE}`,
        [envelope.operation, keyDigest, JSON.stringify(stored)],
      );
      throw new CommitThenRefuse(err);
    }
    await tx.query(
      `UPDATE cuspatlas.command_idempotency SET state = 'committed', result = $3::jsonb,
         aggregate_version = $4, updated_at = now()
       WHERE ${SCOPE}`,
      [envelope.operation, keyDigest, JSON.stringify(codec.persist(outcome.data)), outcome.version],
    );
    return {
      data: outcome.data,
      version: outcome.version,
      correlationId: ctx.correlationId,
      replayed: false,
    };
  };
}

// biome-ignore lint/suspicious/noExplicitAny: codecs are heterogeneous per operation.
const ALL_CODECS: Readonly<Record<string, ReplayCodec<any>>> = {
  ...SYNTHETIC_TASK_REPLAY_CODECS,
  ...PATIENT_REPLAY_CODECS,
  ...SCHEDULING_REPLAY_CODECS,
  ...APPOINTMENT_REPLAY_CODECS,
  ...BILLING_REPLAY_CODECS,
  ...CLINICAL_REPLAY_CODECS,
  ...EXTENDED_SCHEDULING_CODECS,
  ...ENGAGEMENT_REPLAY_CODECS,
  ...IMAGING_REPLAY_CODECS,
  ...MIGRATION_REPLAY_CODECS,
  ...AGENT_REPLAY_CODECS,
  ...PREFERENCE_REPLAY_CODECS,
  ...ADMINISTRATION_REPLAY_CODECS,
  ...AUTOMATION_WEBHOOK_CODECS,
  ...AUTOMATION_EXPORT_CODECS,
};

/**
 * The durable executor over every registered operation with an explicit digest key: what the API and
 * MCP builders run (with `resolveIdempotencyDigestKey` of their environment).
 */
export const createDurableExecutor = (digestKey: Uint8Array): CommandExecutor =>
  createExecuteOnce({ codecs: ALL_CODECS, digestKey });

/**
 * Fallback executor of domain services built without one: durable idempotency over every registered
 * operation with the process key (`configureIdempotencyDigestKey`); without a configured key it
 * refuses to execute (fail closed).
 */
export const executeOnce: CommandExecutor = createExecuteOnce({ codecs: ALL_CODECS });
