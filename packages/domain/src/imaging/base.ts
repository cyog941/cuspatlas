import type { KeyObject } from 'node:crypto';
import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  isObjectStoreError,
  isRefusalError,
  type MalwareScannerPort,
  type ObjectStorePort,
  type RefusalCode,
  type RefusalDetail,
  RefusalError,
  type SecurityReasonCode,
  validateImagingEntityRef,
  validateImagingIdempotencyKey,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, withAttemptRecording } from '../commands/boundary';
import { executeOnce } from '../commands/execute-once';
import type { CommandExecutor } from '../commands/executor';
import type { ActionName, AuthorizationDecision, Authorize } from '../policy/authorize';

/** Fixed operational alert codes of the imaging boundary; never carry request data. */
export type ImagingAlert =
  | 'imaging_object_integrity_failed'
  | 'imaging_object_store_unavailable'
  | 'imaging_token_secret_missing'
  | 'imaging_bridge_signing_key_missing';

export interface ImagingLimits {
  /** Largest accepted object in bytes (default 32 MiB). */
  readonly maxObjectBytes?: number;
  /** I-D8 (pending approval): an unmatched object escalates after this many hours (default 48). */
  readonly unmatchedEscalationHours?: number;
  /** I6: lease of a claimed bridge job in seconds (default 300). */
  readonly bridgeLeaseSeconds?: number;
  /** I7: a device without a heartbeat for this long is stale (default 120 s), then offline (default 600 s). */
  readonly bridgeStaleSeconds?: number;
  readonly bridgeOfflineSeconds?: number;
  /** I7: most deferred acquisitions a tenant may hold (default 25). */
  readonly maxDeferredAcquisitions?: number;
}

/** Maintenance interface (not on the object store port, which has no listing): old staged keys. */
export interface StagingMaintenance {
  listStagedOlderThan(tenantId: string, olderThanMs: number): Promise<string[]>;
}

export interface ImagingDeps {
  readonly authorize: Authorize;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly recording: AttemptRecordingDeps;
  /** Defaults to the durable executeOnce. */
  readonly execute?: CommandExecutor;
  /** Object store; absent means every byte path is a typed 503 (never an empty or fabricated result). */
  readonly objectStore?: ObjectStorePort;
  /** Maintenance-only listing for the orphan-staging sweep (never handed to a request path). */
  readonly stagingMaintenance?: StagingMaintenance;
  /** Malware scanner; absent means every verdict is `unknown`, so nothing becomes available. */
  readonly scanner?: MalwareScannerPort;
  /** HMAC secret of read grants (>= 32 bytes); null disables grants (503). See resolveImagingTokenSecret. */
  readonly tokenSecret: Uint8Array | null;
  /** Tenant-bound match-key pepper shared with S (CUSPATLAS_MATCH_KEY_PEPPER). */
  readonly matchKeyPepper: Uint8Array;
  readonly limits?: ImagingLimits;
  /**
   * I6 server bridge signing key (Ed25519 private key) for job envelopes; null disables claims (503).
   * See resolveBridgeSigningKey.
   */
  readonly bridgeSigningKey?: KeyObject | null;
  /** Emits a fixed alert line (integrity failure, store outage). */
  readonly alert?: (code: ImagingAlert) => void;
}

/** Attempt reason of an imaging refusal that names no explicit internal reason. */
const REASON: Partial<Record<RefusalCode, SecurityReasonCode>> = {
  unauthenticated: 'token_invalid',
  forbidden: 'scope_missing',
  not_found: 'resource_hidden_or_missing',
  stale_version: 'stale_version',
  invalid_request: 'request_invalid',
  validation_failed: 'request_invalid',
  idempotency_conflict: 'idempotency_conflict',
};

export interface ImagingBase {
  readonly deps: ImagingDeps;
  readonly execute: CommandExecutor;
  readonly maxObjectBytes: number;
  /** Denials leave an attempt row (reads). */
  guarded<T>(ctx: ActorContext, op: ActionName, work: () => Promise<T>): Promise<T>;
  /** Every typed refusal leaves an attempt row (commands, uploads, content reads). */
  recorded<T>(ctx: ActorContext, op: ActionName, work: () => Promise<T>): Promise<T>;
  authorize(ctx: ActorContext, op: ActionName): Promise<AuthorizationDecision>;
  can(ctx: ActorContext, op: ActionName): Promise<boolean>;
  store(): ObjectStorePort;
  /** The read-grant secret, or a typed 503 (with an alert) when none is configured. */
  secret(): Uint8Array;
  alert(code: ImagingAlert): void;
}

export const notFound = () =>
  new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });

/** A refusal that depends on stored state: 409 with a server reason (and optional blocking refs). */
export const refused = (
  reason: string,
  extra: Omit<RefusalDetail, 'reason'> = {},
  init: { retryable?: boolean; replayable?: boolean; reasonCode?: SecurityReasonCode } = {},
) =>
  new RefusalError({
    code: 'conflict',
    reasonCode: init.reasonCode ?? 'imaging_refused',
    detail: { reason, ...extra },
    ...(init.retryable === undefined ? {} : { retryable: init.retryable }),
    ...(init.replayable === undefined ? {} : { replayable: init.replayable }),
  });

/** A domain-rule refusal (422) with a server reason. */
export const failed = (reason: string, extra: Omit<RefusalDetail, 'reason'> = {}) =>
  new RefusalError({
    code: 'validation_failed',
    reasonCode: 'imaging_refused',
    detail: { reason, ...extra },
  });

export const storeUnavailable = () => new RefusalError({ code: 'service_unavailable', retryable: true });

export function checkRef(ref: string): void {
  if (!validateImagingEntityRef(ref)) throw notFound();
}

export function checkEnvelope(envelope: CommandEnvelope<unknown>, operation: string): void {
  if (envelope.operation !== operation) throw new RefusalError({ code: 'invalid_request' });
  assertValid(validateImagingIdempotencyKey, envelope.idempotencyKey, new Set(['idempotencyKey']));
}

export function createImagingBase(deps: ImagingDeps): ImagingBase {
  const who = (ctx: ActorContext, operation: string) => ({
    correlationId: ctx.correlationId,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    operation,
  });
  const authorize = (ctx: ActorContext, action: ActionName) =>
    deps.authorize(ctx, action, { tenantId: ctx.tenantId, id: 'imaging' });
  const alert = (code: ImagingAlert) => deps.alert?.(code);
  /** Store outages surface as a retryable 503 with a fixed alert line, never as a raw error. */
  const mapStore = (err: unknown): never => {
    if (isObjectStoreError(err) && err.code === 'unavailable') {
      alert('imaging_object_store_unavailable');
      throw storeUnavailable();
    }
    throw err;
  };
  return {
    deps,
    execute: deps.execute ?? executeOnce,
    maxObjectBytes: deps.limits?.maxObjectBytes ?? 32 * 1024 * 1024,
    guarded: (ctx, op, work) =>
      withAttemptRecording(deps.recording, who(ctx, op), () => work().catch(mapStore)),
    async recorded(ctx, op, work) {
      try {
        return await work().catch(mapStore);
      } catch (err) {
        if (!isRefusalError(err) || err.attemptRecorded || err.code === 'service_unavailable') throw err;
        try {
          await deps.recording.sink.record({
            ...who(ctx, op),
            reasonCode: err.reasonCode ?? REASON[err.code] ?? 'imaging_refused',
          });
          err.attemptRecorded = true;
        } catch {
          deps.recording.alert('security_attempt_sink_unavailable');
          const unavailable = new RefusalError({ code: 'service_unavailable', retryable: true });
          unavailable.attemptRecorded = true;
          throw unavailable;
        }
        throw err;
      }
    },
    authorize,
    async can(ctx, op) {
      try {
        await authorize(ctx, op);
        return true;
      } catch (err) {
        if (err instanceof RefusalError && err.code === 'forbidden') return false;
        throw err;
      }
    },
    store() {
      if (!deps.objectStore) {
        alert('imaging_object_store_unavailable');
        throw storeUnavailable();
      }
      return deps.objectStore;
    },
    secret() {
      if (!deps.tokenSecret) {
        alert('imaging_token_secret_missing');
        throw storeUnavailable();
      }
      return deps.tokenSecret;
    },
    alert,
  };
}
