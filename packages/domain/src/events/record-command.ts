import { randomBytes, randomUUID } from 'node:crypto';
import { type AuditEvent, type TenantTransaction, validateAuditEvent } from '@cuspatlas/contracts';

/** What the domain says about a committed change. Tenant, actor and correlation come from `tx.ctx`. */
export interface CommittedChange {
  readonly operation: string;
  readonly resourceType: string;
  readonly resourceRef: string;
  readonly resourceVersion: number;
}

/**
 * Minimized outbox payload. Classified `field-names-only`: it names which fields changed and never
 * carries their values, so labels and other caller text cannot reach the outbox or a worker log.
 */
export interface OutboxPayload {
  readonly changedFields: readonly string[];
}

export const AUDIT_EVENT_VERSION = 1;
export const OUTBOX_EVENT_VERSION = 1;

const FIELD_NAME = /^[a-z][A-Za-z]{0,63}$/;

function assertMinimized(payload: OutboxPayload): void {
  const keys = Object.keys(payload);
  if (
    keys.length !== 1 ||
    keys[0] !== 'changedFields' ||
    !Array.isArray(payload.changedFields) ||
    payload.changedFields.length > 16 ||
    !payload.changedFields.every((f) => typeof f === 'string' && FIELD_NAME.test(f))
  ) {
    throw new Error('Outbox payload is not minimized');
  }
}

/** Server-side trace identifiers: the trace is the request correlation, the span is per event. */
function traceOf(correlationId: string): { traceId: string; spanId: string } {
  return { traceId: correlationId.replaceAll('-', ''), spanId: randomBytes(8).toString('hex') };
}

/**
 * Records a committed change: one append-only audit row and one outbox row, inserted through the
 * caller's tenant transaction so they commit or roll back with the domain change. Any failure throws
 * and therefore aborts the whole transaction (fail closed: no unaudited mutation can commit).
 */
export async function recordCommand(
  tx: TenantTransaction,
  audit: CommittedChange,
  event: OutboxPayload,
): Promise<void> {
  const { ctx } = tx;
  const occurredAt = new Date().toISOString();
  const auditEvent: AuditEvent = {
    eventRef: randomUUID(),
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    principal: ctx.principal,
    operation: audit.operation,
    resourceType: audit.resourceType,
    resourceRef: audit.resourceRef,
    resourceVersion: audit.resourceVersion,
    correlationId: ctx.correlationId,
    occurredAt,
  };
  if (!validateAuditEvent(auditEvent)) throw new Error('Audit event failed its schema');
  assertMinimized(event);
  const { traceId, spanId } = traceOf(ctx.correlationId);

  // Tenant and actor are re-derived from the transaction-local context by the database, and RLS
  // checks them again; the values above are only for schema validation.
  await tx.query(
    `INSERT INTO cuspatlas.audit_events (event_ref, event_version, tenant_id, actor_id, principal,
       operation, resource_type, resource_ref, resource_version, correlation_id, trace_id, span_id,
       occurred_at)
     VALUES ($1, $2, cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $3, $4, $5, $6, $7,
       $8, $9, $10, $11)`,
    [
      auditEvent.eventRef,
      AUDIT_EVENT_VERSION,
      auditEvent.principal,
      auditEvent.operation,
      auditEvent.resourceType,
      auditEvent.resourceRef,
      auditEvent.resourceVersion,
      auditEvent.correlationId,
      traceId,
      spanId,
      occurredAt,
    ],
  );
  await tx.query(
    `INSERT INTO cuspatlas.outbox_events (id, event_version, tenant_id, actor_id, operation,
       aggregate_type, aggregate_id, aggregate_version, correlation_id, trace_id, span_id, occurred_at,
       payload_class, payload)
     VALUES ($1, $2, cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $3, $4, $5, $6, $7,
       $8, $9, $10, 'field-names-only', $11::jsonb)`,
    [
      randomUUID(),
      OUTBOX_EVENT_VERSION,
      audit.operation,
      audit.resourceType,
      audit.resourceRef,
      audit.resourceVersion,
      ctx.correlationId,
      traceId,
      spanId,
      occurredAt,
      JSON.stringify({ changedFields: [...event.changedFields] }),
    ],
  );
}
