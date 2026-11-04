import { randomUUID } from 'node:crypto';
import type { TenantTransaction } from '@cuspatlas/contracts';

/** What a sensitive read says about itself: references and field names, never values. */
export interface SensitiveRead {
  readonly operation: string;
  readonly resourceType: string;
  /** Records returned to the caller (at most 100). */
  readonly resourceRefs: readonly string[];
  /** Names of the query filters used (for example `name`), never their values. */
  readonly queryFields: readonly string[];
}

const FIELD = /^[a-z][A-Za-z]{0,63}$/;

/**
 * Records a sensitive read (S4) through the caller's tenant transaction, so a read whose access log
 * cannot be written fails closed with the read itself. Tenant and actor come from the transaction
 * context and are rechecked by RLS. Unlike `recordCommand` it writes no outbox event and no
 * committed-change audit: nothing changed.
 */
export async function recordSensitiveRead(tx: TenantTransaction, read: SensitiveRead): Promise<void> {
  if (
    read.resourceRefs.length > 100 ||
    read.queryFields.length > 16 ||
    !read.queryFields.every((f) => FIELD.test(f))
  ) {
    throw new Error('Sensitive read record is not minimized');
  }
  await tx.query(
    `INSERT INTO cuspatlas.sensitive_read_events (event_ref, tenant_id, actor_id, principal, operation,
       resource_type, resource_refs, result_count, query_fields, correlation_id, occurred_at)
     VALUES ($1, cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $2, $3, $4, $5::uuid[], $6,
       $7::text[], $8, now())`,
    [
      randomUUID(),
      tx.ctx.principal,
      read.operation,
      read.resourceType,
      [...read.resourceRefs],
      read.resourceRefs.length,
      [...read.queryFields],
      tx.ctx.correlationId,
    ],
  );
}
