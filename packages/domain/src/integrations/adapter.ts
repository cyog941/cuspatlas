/**
 * Outbound integration adapter contract (F Task 6). Synthetic foundation only: the only
 * implementation is the in-memory fake provider under tests/. A real provider needs its own reviewed
 * plan, qualification and build authorization.
 *
 * Delivery key = outbox event id (frozen). A provider must treat it as an idempotency key: a second
 * request with the same key performs no second external action and answers `duplicate` with the
 * receipt of the first. The worker never logs the request payload.
 */

export interface DeliveryRequest {
  /** Stable across every attempt for one event; the outbox event id. */
  readonly deliveryKey: string;
  readonly tenantId: string;
  readonly operation: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  /** Lease attempt number that sent this request (diagnostic; not part of the idempotency key). */
  readonly attempt: number;
  /** Classified, minimized outbox payload (field names only). Never logged. */
  readonly payload: unknown;
}

/** Provider-issued receipt reference: opaque, bounded, never caller text. */
export const RECEIPT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export type DeliveryReceipt =
  /** The provider performed the external action for this key now. */
  | { readonly outcome: 'delivered'; readonly receiptId: string }
  /** The provider had already performed it for this key; nothing new happened. */
  | { readonly outcome: 'duplicate'; readonly receiptId: string }
  /** The request may or may not have been accepted (for example a timeout after sending). */
  | { readonly outcome: 'unknown' }
  /** The provider definitively did not perform the action. */
  | { readonly outcome: 'failed'; readonly retryable: boolean };

export type ReceiptLookup =
  | { readonly status: 'found'; readonly receiptId: string }
  | { readonly status: 'not_found' }
  /** The provider could not answer; the outcome stays unknown. */
  | { readonly status: 'unavailable' };

export interface DeliveryAdapter {
  /** Performs (at most once per delivery key) the external action. */
  deliver(request: DeliveryRequest): Promise<DeliveryReceipt>;
  /** Side-effect-free reconciliation: what does the provider know about this delivery key? */
  lookup(deliveryKey: string): Promise<ReceiptLookup>;
}
