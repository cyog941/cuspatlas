import {
  type DomainRefusal,
  isRefusalError,
  REFUSAL_HTTP_STATUS,
  type RefusalCode,
} from '@cuspatlas/contracts';

export interface SafeErrorResponse {
  readonly status: number;
  readonly body: DomainRefusal;
}

function statusOf(err: unknown): number | undefined {
  if (err !== null && typeof err === 'object' && 'statusCode' in err) {
    const s = Number((err as { statusCode: unknown }).statusCode);
    if (Number.isInteger(s)) return s;
  }
  return undefined;
}

function refusal(code: RefusalCode, correlationId: string, retryable = false): SafeErrorResponse {
  return { status: REFUSAL_HTTP_STATUS[code], body: { code, retryable, correlationId } };
}

/**
 * Maps anything thrown during a request to a typed, safe refusal. Messages, stacks, SQL and request
 * content are never copied: only the typed code, retryability, server correlation id and the
 * server-authored detail of a RefusalError survive.
 */
export function mapErrorToRefusal(err: unknown, correlationId: string): SafeErrorResponse {
  if (isRefusalError(err)) {
    return { status: REFUSAL_HTTP_STATUS[err.code], body: err.toRefusal(correlationId) };
  }
  const status = statusOf(err);
  if (status === 404 || status === 405) return refusal('not_found', correlationId);
  if (status === 429) return refusal('rate_limited', correlationId, true);
  if (status === 503) return refusal('service_unavailable', correlationId, true);
  if (status !== undefined && status >= 400 && status < 500) return refusal('invalid_request', correlationId);
  return refusal('internal_error', correlationId, true);
}

/** A log-safe classification of an unexpected error: its constructor name and framework code only. */
export function safeErrorKind(err: unknown): { errType: string; errCode?: string } {
  const errType =
    err instanceof Error && /^[A-Za-z]{1,64}$/.test(err.name)
      ? err.name
      : typeof err === 'object'
        ? 'object'
        : typeof err;
  const code =
    err !== null && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
    ? { errType, errCode: code }
    : { errType };
}
