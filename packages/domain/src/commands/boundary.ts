import {
  DENIAL_CODES,
  isRefusalError,
  type RefusalCode,
  RefusalError,
  type SecurityAttemptSink,
  type SecurityReasonCode,
} from '@cuspatlas/contracts';

export interface AttemptRecordingDeps {
  readonly sink: SecurityAttemptSink;
  /** Emits a safe operational alert line; receives a fixed code, never request data. */
  readonly alert: (code: 'security_attempt_sink_unavailable') => void;
}

export interface AttemptIdentity {
  readonly correlationId: string;
  /** Only authenticated/established values; null when unknown. Never fabricated. */
  readonly tenantId: string | null;
  readonly actorId: string | null;
  readonly operation: string;
}

const DEFAULT_REASON: Partial<Record<RefusalCode, SecurityReasonCode>> = {
  unauthenticated: 'token_invalid',
  forbidden: 'scope_missing',
  not_found: 'resource_hidden_or_missing',
};

/** Persists the attempt for a denial and marks it recorded. Sink failure keeps the denial closed. */
export async function recordDenial(
  deps: AttemptRecordingDeps,
  who: AttemptIdentity,
  err: RefusalError,
): Promise<void> {
  if (err.attemptRecorded || !DENIAL_CODES.has(err.code)) return;
  try {
    await deps.sink.record({
      correlationId: who.correlationId,
      tenantId: who.tenantId,
      actorId: who.actorId,
      operation: who.operation,
      reasonCode: err.reasonCode ?? DEFAULT_REASON[err.code] ?? 'scope_missing',
    });
    err.attemptRecorded = true;
  } catch {
    deps.alert('security_attempt_sink_unavailable');
    const unavailable = new RefusalError({ code: 'service_unavailable', retryable: true });
    unavailable.attemptRecorded = true;
    throw unavailable;
  }
}

/**
 * Command boundary for denials: runs `work` (whose tenant transaction has already rolled back by the
 * time an error reaches here) and records a SecurityAttemptEvent through the independent sink.
 */
export async function withAttemptRecording<T>(
  deps: AttemptRecordingDeps,
  who: AttemptIdentity,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isRefusalError(err)) await recordDenial(deps, who, err);
    throw err;
  }
}

/** Internal reason for a non-denial refusal of a proposal operation. Never sent to the caller. */
const REFUSAL_REASON: Partial<Record<RefusalCode, SecurityReasonCode>> = {
  ...DEFAULT_REASON,
  self_approval_denied: 'self_approval_denied',
  payload_mismatch: 'payload_mismatch',
  proposal_expired: 'proposal_expired',
  stale_version: 'stale_version',
  policy_changed: 'policy_changed',
  approval_invalid: 'approval_invalid',
  conflict: 'proposal_state_conflict',
  invalid_request: 'request_invalid',
  validation_failed: 'request_invalid',
  idempotency_conflict: 'idempotency_conflict',
};

/**
 * Proposal boundary (F Task 7a): like `withAttemptRecording`, but EVERY typed refusal, not only
 * denials, produces a security attempt row, because a refused proposal step (altered payload,
 * expiry, stale resource, changed policy) is a security-relevant event in its own right. A sink
 * outage still keeps the operation refused (503) and is never itself recorded in a loop.
 */
export async function withRefusalRecording<T>(
  deps: AttemptRecordingDeps,
  who: AttemptIdentity,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (!isRefusalError(err) || err.attemptRecorded || err.code === 'service_unavailable') throw err;
    try {
      await deps.sink.record({
        correlationId: who.correlationId,
        tenantId: who.tenantId,
        actorId: who.actorId,
        operation: who.operation,
        reasonCode: err.reasonCode ?? REFUSAL_REASON[err.code] ?? 'proposal_refused',
      });
      err.attemptRecorded = true;
    } catch {
      deps.alert('security_attempt_sink_unavailable');
      const unavailable = new RefusalError({ code: 'service_unavailable', retryable: true });
      unavailable.attemptRecorded = true;
      throw unavailable;
    }
    throw err;
  }
}
