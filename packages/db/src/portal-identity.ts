import type { PortalPrincipalRow, PortalPrincipalSource } from '@cuspatlas/contracts';
import type pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * E1: live portal-enrolment lookup for a token subject whose signature was already verified. Like
 * the membership source it runs in its own read-only transaction with only
 * `cuspatlas.auth_principal_id` set, so RLS limits it to the subject's own rows. It reports the
 * principal kind (a staff subject is never a portal principal) and the enrolment state in the token's
 * tenant; another tenant's enrolment is indistinguishable from none.
 */
export function createPortalPrincipalSource(pool: pg.Pool): PortalPrincipalSource {
  return {
    async load(principalId: string, tenantId: string): Promise<PortalPrincipalRow | null> {
      if (!UUID.test(principalId) || !UUID.test(tenantId)) return null;
      const client = await pool.connect();
      let destroy: Error | undefined;
      try {
        await client.query('BEGIN READ ONLY');
        try {
          await client.query(`SELECT set_config('cuspatlas.auth_principal_id', $1, true)`, [principalId]);
          const { rows } = await client.query<{ kind: 'human' | 'service' | 'portal'; state: string | null }>(
            `SELECT p.kind, pp.state FROM cuspatlas.principals p
             LEFT JOIN cuspatlas.portal_principals pp ON pp.principal_id = p.id AND pp.tenant_id = $2
             WHERE p.id = $1`,
            [principalId, tenantId],
          );
          await client.query('COMMIT');
          const row = rows[0];
          if (!row) return null;
          return {
            principalId,
            tenantId,
            kind: row.kind,
            state: row.state === null ? null : (row.state as PortalPrincipalRow['state']),
          };
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
    },
  };
}
