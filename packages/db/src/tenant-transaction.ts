import {
  type ActorContext,
  CommitThenRefuse,
  RefusalError,
  type TenantTransaction,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import type pg from 'pg';
import { assertDomainStatement } from './statement-guard';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Creates `withTenantTransaction`. Callers must have run `authorize` first (domain services do so
 * structurally); this layer independently re-validates the context, sets tenant and actor as
 * transaction-local settings, rechecks the live membership inside the transaction, and returns the
 * connection to the pool only after `DISCARD ALL` (or destroys it).
 */
export function createTenantTransactionRunner(pool: pg.Pool): WithTenantTransaction {
  return async function withTenantTransaction<T>(
    ctx: ActorContext,
    work: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    if (!UUID.test(ctx.tenantId) || !UUID.test(ctx.actorId)) {
      throw new RefusalError({ code: 'forbidden', reasonCode: 'tenant_mismatch' });
    }
    const client = await pool.connect();
    let destroy: Error | undefined;
    try {
      await client.query('BEGIN');
      try {
        await client.query(
          `SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)`,
          [ctx.tenantId, ctx.actorId],
        );
        const member = await client.query(
          `SELECT 1 FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
           WHERE m.tenant_id = $1 AND m.principal_id = $2 AND m.revoked_at IS NULL AND p.kind = $3`,
          [ctx.tenantId, ctx.actorId, ctx.principal],
        );
        if (member.rowCount !== 1) {
          throw new RefusalError({ code: 'forbidden', reasonCode: 'membership_inactive' });
        }
        let depth = 0;
        const tx: TenantTransaction = {
          ctx,
          async query(text, values) {
            assertDomainStatement(text);
            const r = await client.query(text, values as unknown[] | undefined);
            return { rows: r.rows, rowCount: r.rowCount ?? 0 };
          },
          async savepoint(inner) {
            // Fixed, server-chosen names; never caller text. Depth makes nested use safe.
            depth += 1;
            const name = `cuspatlas_sp_${depth}`;
            await client.query(`SAVEPOINT ${name}`);
            try {
              const value = await inner();
              await client.query(`RELEASE SAVEPOINT ${name}`);
              return value;
            } catch (err) {
              await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
              await client.query(`RELEASE SAVEPOINT ${name}`);
              throw err;
            } finally {
              depth -= 1;
            }
          },
        };
        let result: T;
        try {
          result = await work(tx);
        } catch (err) {
          if (!(err instanceof CommitThenRefuse)) throw err;
          await client.query('COMMIT');
          throw err.refusal;
        }
        await client.query('COMMIT');
        return result;
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
  };
}
