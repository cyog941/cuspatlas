import type { MembershipRecord, MembershipSource, PrincipalKind } from '@cuspatlas/contracts';
import type pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Live membership lookup for a principal whose identity was already verified. Runs in its own
 * read-only transaction with only `cuspatlas.auth_principal_id` set, so RLS limits it to that
 * principal's own rows. No tenant context is established here.
 */
export function createMembershipSource(pool: pg.Pool): MembershipSource {
  return {
    async load(principalId: string, tenantId: string): Promise<MembershipRecord | null> {
      if (!UUID.test(principalId) || !UUID.test(tenantId)) return null;
      const client = await pool.connect();
      let destroy: Error | undefined;
      try {
        await client.query('BEGIN READ ONLY');
        try {
          await client.query(`SELECT set_config('cuspatlas.auth_principal_id', $1, true)`, [principalId]);
          const { rows } = await client.query<{
            kind: PrincipalKind;
            scopes: string[];
            location_refs: string[] | null;
            active: boolean;
          }>(
            `SELECT p.kind, m.scopes, m.location_refs, (m.revoked_at IS NULL) AS active
             FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
             WHERE m.principal_id = $1 AND m.tenant_id = $2`,
            [principalId, tenantId],
          );
          await client.query('COMMIT');
          const row = rows[0];
          if (!row) return null;
          return {
            tenantId,
            principalId,
            principal: row.kind,
            scopes: Object.freeze([...row.scopes]),
            locationRefs: row.location_refs === null ? null : Object.freeze([...row.location_refs]),
            active: row.active,
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
