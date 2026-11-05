import { RefusalError } from '@cuspatlas/contracts';

/**
 * External billing adapters (payment processor B2, clearinghouse B6/B7). The domain never constructs
 * a fake: a builder passes one explicitly (the API and MCP builders only under synthetic-test). An
 * absent adapter disables only the operations that need it, with a typed 503 `adapter_not_configured`
 * raised before anything is written.
 */
export type BillingAdapter = 'payment_processor' | 'clearinghouse';

export const ADAPTER_NOT_CONFIGURED = 'adapter_not_configured';

export function adapterNotConfigured(adapter: BillingAdapter): never {
  throw new RefusalError({
    code: 'service_unavailable',
    retryable: false,
    detail: { reason: ADAPTER_NOT_CONFIGURED, blockingRefs: [{ kind: 'adapter', ref: adapter }] },
  });
}

/** The adapter, or the typed refusal when it is not configured. */
export function requireAdapter<T>(port: T | null, adapter: BillingAdapter): T {
  return port === null ? adapterNotConfigured(adapter) : port;
}
