import type { TenantTransaction } from '@cuspatlas/contracts';

/**
 * Outbox leasing (F Task 6). Every statement runs inside a tenant transaction opened for the worker's
 * own service principal, so RLS limits it to that one tenant, and the runtime role may update only the
 * delivery-state columns (state, attempt, leased_until, next_attempt_at, last_outcome,
 * dead_letter_reason, updated_at). Leasing increments `attempt`, which is also the fencing token: a
 * worker may finalize an event only while it is still `leased` at the attempt it leased, so a worker
 * whose lease expired can never overwrite the outcome recorded by its successor.
 */

export type PriorState = 'pending' | 'retry' | 'reconciliation' | 'leased';

export const DEAD_LETTER_REASONS = [
  'membership_revoked',
  'authorization_denied',
  'max_attempts_exhausted',
  'provider_rejected',
  'reconciliation_exhausted',
  // F Task 7a: deferred execution of an approved proposal was refused at execution time.
  'proposal_refused',
] as const;
export type DeadLetterReason = (typeof DEAD_LETTER_REASONS)[number];

export interface LeasedEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly operation: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly correlationId: string;
  /** Classified field-names-only payload. Handed to the adapter, never logged. */
  readonly payload: unknown;
  /** Attempt number of this lease (1-based); the fencing token for finalization. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /**
   * State before this lease. `leased` means an earlier lease expired without acknowledgement and
   * `reconciliation` means an earlier attempt ended with an unknown outcome: in both cases the
   * provider may already have acted, so the dispatcher reconciles before it may send again.
   */
  readonly priorState: PriorState;
}

interface LeaseRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  actor_id: string;
  operation: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  correlation_id: string;
  payload: unknown;
  attempt: number;
  max_attempts: number;
  prior_state: PriorState;
}

/**
 * Leases up to `limit` ready events of the current tenant: pending/retry/reconciliation rows whose
 * `next_attempt_at` has passed, and leased rows whose lease expired. `FOR UPDATE SKIP LOCKED` lets
 * concurrent workers split the work without waiting; a row another worker leased and committed is
 * re-evaluated against the predicate and skipped.
 */
export async function leaseReady(
  tx: TenantTransaction,
  opts: {
    readonly limit: number;
    readonly leaseSeconds: number;
    /** An expired lease is taken over only this many seconds after it expired (default 0). */
    readonly quietSeconds?: number;
  },
): Promise<LeasedEvent[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), 100);
  if (!(opts.leaseSeconds > 0 && opts.leaseSeconds <= 3600)) throw new Error('leaseSeconds out of range');
  const quiet = opts.quietSeconds ?? 0;
  if (!(quiet >= 0 && quiet <= 3600)) throw new Error('quietSeconds out of range');
  const { rows } = await tx.query<LeaseRow>(
    `WITH ready AS (
       SELECT id, state AS prior_state FROM cuspatlas.outbox_events
       WHERE (state IN ('pending', 'retry', 'reconciliation') AND next_attempt_at <= now())
          OR (state = 'leased' AND leased_until + make_interval(secs => $3) <= now())
       ORDER BY next_attempt_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE cuspatlas.outbox_events o
     SET state = 'leased', attempt = o.attempt + 1, leased_until = now() + make_interval(secs => $2),
       updated_at = now()
     FROM ready WHERE o.id = ready.id
     RETURNING o.id, o.tenant_id, o.actor_id, o.operation, o.aggregate_type, o.aggregate_id,
       o.aggregate_version, o.correlation_id, o.payload, o.attempt, o.max_attempts, ready.prior_state`,
    [limit, opts.leaseSeconds, quiet],
  );
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    actorId: r.actor_id,
    operation: r.operation,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    aggregateVersion: r.aggregate_version,
    correlationId: r.correlation_id,
    payload: r.payload,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    priorState: r.prior_state,
  }));
}

/**
 * True while this worker still holds the lease (same attempt, still `leased`) with at least
 * `seconds` left on the database clock. Checked immediately before every send.
 */
export async function leaseHasAtLeast(
  tx: TenantTransaction,
  lease: Pick<LeasedEvent, 'id' | 'attempt'>,
  seconds: number,
): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT leased_until - now() >= make_interval(secs => $3) AS ok FROM cuspatlas.outbox_events
     WHERE id = $1 AND attempt = $2 AND state = 'leased'`,
    [lease.id, lease.attempt, seconds],
  );
  return rows[0]?.ok === true;
}

/** Server-chosen outcome codes stored in `last_outcome` (`^[a-z_]{1,64}$`). */
export type OutcomeCode =
  | 'delivered'
  | 'duplicate'
  | 'reconciled'
  | 'unknown'
  | 'failed'
  | 'rejected'
  | 'lookup_unavailable'
  | 'denied'
  | 'attempt_sink_unavailable'
  | 'exhausted'
  | 'executed'
  | 'proposal_refused'
  | 'executor_unavailable';

export type Transition =
  | { readonly state: 'delivered'; readonly outcome: OutcomeCode }
  | {
      readonly state: 'retry' | 'reconciliation';
      readonly delaySeconds: number;
      readonly outcome: OutcomeCode;
    }
  | { readonly state: 'dead_letter'; readonly reason: DeadLetterReason; readonly outcome: OutcomeCode };

/**
 * Fenced finalization: applies only while the event is still `leased` at `lease.attempt`. Returns
 * false when the lease was lost (expired and taken by another worker); the caller must then not
 * report its own outcome as the event's.
 */
export async function finalizeLease(
  tx: TenantTransaction,
  lease: Pick<LeasedEvent, 'id' | 'attempt'>,
  t: Transition,
): Promise<boolean> {
  const delay = t.state === 'retry' || t.state === 'reconciliation' ? t.delaySeconds : 0;
  if (!(delay >= 0 && delay <= 86_400)) throw new Error('delaySeconds out of range');
  const reason = t.state === 'dead_letter' ? t.reason : null;
  const { rowCount } = await tx.query(
    `UPDATE cuspatlas.outbox_events
     SET state = $3, last_outcome = $4, dead_letter_reason = $5, leased_until = NULL,
       next_attempt_at = now() + make_interval(secs => $6), updated_at = now()
     WHERE id = $1 AND attempt = $2 AND state = 'leased'`,
    [lease.id, lease.attempt, t.state, t.outcome, reason, delay],
  );
  return rowCount === 1;
}

export type ReceiptOutcome = 'delivered' | 'duplicate' | 'reconciled';

/**
 * Records a provider receipt for the event (delivery key). Receipts are facts reported by the
 * provider and are kept even when the lease was lost; `(event_id, provider_receipt_id)` is unique, so
 * the same receipt reported by two attempts, in any order, is stored once.
 */
export async function recordReceipt(
  tx: TenantTransaction,
  r: {
    readonly eventId: string;
    readonly receiptId: string;
    readonly outcome: ReceiptOutcome;
    readonly attempt: number;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO cuspatlas.delivery_receipts (event_id, tenant_id, provider_receipt_id, outcome, attempt)
     VALUES ($1, cuspatlas.current_tenant_id(), $2, $3, $4)
     ON CONFLICT (event_id, provider_receipt_id) DO NOTHING`,
    [r.eventId, r.receiptId, r.outcome, r.attempt],
  );
}

export interface DeadLetter {
  readonly id: string;
  readonly operation: string;
  readonly aggregateId: string;
  readonly attempt: number;
  readonly reason: DeadLetterReason;
  readonly lastOutcome: string | null;
  readonly receipts: number;
}

/**
 * Dead-letter review: dead-lettered events of the current tenant with reason, attempts and receipt
 * count. The rows keep their payload and receipts; nothing is deleted. Re-driving is a later operator
 * path (it must keep `attempt` monotonic, because `attempt` is the lease fence).
 */
export async function listDeadLetters(tx: TenantTransaction, limit = 100): Promise<DeadLetter[]> {
  const { rows } = await tx.query<{
    id: string;
    operation: string;
    aggregate_id: string;
    attempt: number;
    dead_letter_reason: DeadLetterReason;
    last_outcome: string | null;
    receipts: number;
  }>(
    `SELECT o.id, o.operation, o.aggregate_id, o.attempt, o.dead_letter_reason, o.last_outcome,
       (SELECT count(*)::int FROM cuspatlas.delivery_receipts r WHERE r.event_id = o.id) AS receipts
     FROM cuspatlas.outbox_events o WHERE o.state = 'dead_letter' ORDER BY o.updated_at, o.id LIMIT $1`,
    [Math.min(Math.max(Math.trunc(limit), 1), 100)],
  );
  return rows.map((r) => ({
    id: r.id,
    operation: r.operation,
    aggregateId: r.aggregate_id,
    attempt: r.attempt,
    reason: r.dead_letter_reason,
    lastOutcome: r.last_outcome,
    receipts: r.receipts,
  }));
}
