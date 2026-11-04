import { createHash } from 'node:crypto';
import type { Money } from '@cuspatlas/contracts';

/**
 * Payment provider port (B2; B-S1 payment processor qualification is blocked-on-discovery). The port
 * accepts a stable idempotency key and answers `confirmed`, `declined` or `unknown`; it never sees or
 * returns card data, and no detail with PHI crosses it. An `unknown` answer (for example a timeout)
 * is recorded as an open reconciliation item and is never retried as a new charge: reconciliation
 * asks `lookup` with the same key. Providers must deduplicate by key (frozen adapter rule).
 */
export interface CaptureRequest {
  /** sha256 hex of the caller's idempotency scope; identical for every retry of one request. */
  readonly providerKey: string;
  readonly amount: Money;
  /** Synthetic opaque instrument reference (`syn-card-...`). Never a PAN or provider token. */
  readonly instrumentRef: string;
}

export interface ProviderAnswer {
  readonly outcome: 'confirmed' | 'declined' | 'unknown';
  /** Present exactly when confirmed (`syn-rcpt-...`). */
  readonly receiptId?: string;
}

export interface PaymentProviderPort {
  capture(request: CaptureRequest): Promise<ProviderAnswer>;
  /** Side-effect-free status by key. */
  lookup(request: Omit<CaptureRequest, 'amount'>): Promise<ProviderAnswer>;
}

/**
 * The only provider implementation: synthetic, in-process, deterministic and stateless. Behavior is
 * chosen by the synthetic instrument reference so REST, MCP and tests observe the same outcomes:
 * `syn-card-decline...` declines; `syn-card-timeout-captured...` answers unknown, then confirmed on
 * lookup; `syn-card-timeout-absent...` unknown, then declined (never captured); `syn-card-timeout-
 * pending...` unknown on both; anything else confirms. Not a model of any real processor.
 */
export function createSyntheticPaymentProvider(): PaymentProviderPort {
  const receipt = (key: string) =>
    `syn-rcpt-${createHash('sha256').update(`synthetic-receipt:${key}`).digest('hex').slice(0, 32)}`;
  const settled = (instrumentRef: string, key: string): ProviderAnswer => {
    if (instrumentRef.startsWith('syn-card-decline')) return { outcome: 'declined' };
    if (instrumentRef.startsWith('syn-card-timeout-captured'))
      return { outcome: 'confirmed', receiptId: receipt(key) };
    if (instrumentRef.startsWith('syn-card-timeout-absent')) return { outcome: 'declined' };
    if (instrumentRef.startsWith('syn-card-timeout-pending')) return { outcome: 'unknown' };
    return { outcome: 'confirmed', receiptId: receipt(key) };
  };
  return {
    async capture(request) {
      if (request.instrumentRef.startsWith('syn-card-timeout')) return { outcome: 'unknown' };
      return settled(request.instrumentRef, request.providerKey);
    },
    async lookup(request) {
      return settled(request.instrumentRef, request.providerKey);
    },
  };
}
