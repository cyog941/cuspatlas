import type { OutboxEvent, TenantTransaction } from '@cuspatlas/contracts';

/**
 * Outbox access for the delivery side (Task 6 builds leasing on it). Rows are written only by
 * `recordCommand` in the domain transaction. The runtime role may update exactly these columns;
 * identity, aggregate and payload columns are immutable to it (column-level grant).
 */
export const OUTBOX_MUTABLE_COLUMNS = [
  'state',
  'attempt',
  'leased_until',
  'next_attempt_at',
  'last_outcome',
  'updated_at',
] as const;

export const OUTBOX_STATES = [
  'pending',
  'leased',
  'delivered',
  'retry',
  'reconciliation',
  'dead_letter',
] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export interface OutboxRecord extends OutboxEvent {
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly correlationId: string;
  readonly traceId: string;
  readonly state: OutboxState;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leasedUntil: string | null;
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  event_version: number;
  tenant_id: string;
  actor_id: string;
  operation: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  correlation_id: string;
  trace_id: string;
  occurred_at: Date;
  payload: unknown;
  state: OutboxState;
  attempt: number;
  max_attempts: number;
  leased_until: Date | null;
}

/** Lists the current tenant's outbox events (RLS-scoped). Payloads are returned, never logged. */
export async function listOutboxEvents(tx: TenantTransaction, limit = 100): Promise<OutboxRecord[]> {
  const { rows } = await tx.query<OutboxRow>(
    `SELECT id, event_version, tenant_id, actor_id, operation, aggregate_type, aggregate_id,
       aggregate_version, correlation_id, trace_id, occurred_at, payload, state, attempt, max_attempts,
       leased_until
     FROM cuspatlas.outbox_events ORDER BY created_at, id LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map((r) => ({
    id: r.id,
    eventVersion: r.event_version,
    tenantId: r.tenant_id,
    actorId: r.actor_id,
    operation: r.operation,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    aggregateVersion: r.aggregate_version,
    correlationId: r.correlation_id,
    traceId: r.trace_id,
    occurredAt: r.occurred_at.toISOString(),
    payload: r.payload,
    state: r.state,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    leasedUntil: r.leased_until ? r.leased_until.toISOString() : null,
  }));
}
