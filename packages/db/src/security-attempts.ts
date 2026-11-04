import { randomUUID } from 'node:crypto';
import {
  type SecurityAttemptEvent,
  type SecurityAttemptInput,
  type SecurityAttemptSink,
  validateSecurityAttemptEvent,
} from '@cuspatlas/contracts';
import type pg from 'pg';

/**
 * Minimal durable sink for denied/failed attempts (Task 4 hardens it). Must be given a pool that is
 * independent of the one running domain transactions, so the write survives their rollback. Each
 * call inserts one schema-validated, minimized event in its own transaction, with the attempt tenant
 * set transaction-locally so the RLS insert policy can check attribution.
 */
export function createSecurityAttemptSink(pool: pg.Pool): SecurityAttemptSink {
  return {
    async record(attempt: SecurityAttemptInput): Promise<SecurityAttemptEvent> {
      const event: SecurityAttemptEvent = {
        attemptRef: randomUUID(),
        correlationId: attempt.correlationId,
        tenantId: attempt.tenantId,
        actorId: attempt.actorId,
        operation: attempt.operation,
        reasonCode: attempt.reasonCode,
        occurredAt: new Date().toISOString(),
      };
      if (!validateSecurityAttemptEvent(event)) throw new Error('Security attempt event failed its schema');
      const client = await pool.connect();
      let destroy: Error | undefined;
      try {
        await client.query('BEGIN');
        try {
          // Transaction-local attribution: the insert policy accepts a tenant only when it matches.
          await client.query(`SELECT set_config('cuspatlas.attempt_tenant_id', $1, true)`, [
            event.tenantId ?? '',
          ]);
          await client.query(
            `INSERT INTO cuspatlas.security_attempt_events
               (attempt_ref, correlation_id, tenant_id, actor_id, operation, reason_code, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              event.attemptRef,
              event.correlationId,
              event.tenantId,
              event.actorId,
              event.operation,
              event.reasonCode,
              event.occurredAt,
            ],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch((e: Error) => {
            destroy = e;
          });
          throw err;
        }
      } finally {
        await client.query('DISCARD ALL').catch((e: Error) => {
          destroy = e;
        });
        client.release(destroy ?? false);
      }
      return event;
    },
  };
}
