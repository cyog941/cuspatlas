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
