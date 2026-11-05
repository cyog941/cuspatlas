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
          const row = rows[0];
          // A8: an agent's authority is its record (state, expiry, sponsor's live membership) and its
          // recorded scope set, narrowed to reads while suspended. Read through the checked function.
          const agentRows =
            row?.kind === 'service'
              ? (
                  await client.query<{
                    agent_ref: string;
                    state: 'active' | 'suspended' | 'revoked';
                    live: boolean;
                    scope_set: string[];
                    sponsor_ref: string;
                    sponsorship_ref: string;
                    credential_ref: string;
                  }>('SELECT * FROM cuspatlas.agent_authority($1, $2)', [principalId, tenantId])
                ).rows
              : [];
          await client.query('COMMIT');
          if (!row) return null;
          const base = {
            tenantId,
            principalId,
            principal: row.kind,
            locationRefs: row.location_refs === null ? null : Object.freeze([...row.location_refs]),
          };
          const a = agentRows[0];
          if (!a) return { ...base, scopes: Object.freeze([...row.scopes]), active: row.active };
          const granted = row.scopes.filter(
            (sc) => a.scope_set.includes(sc) && (a.state === 'active' || sc.endsWith('.read')),
          );
          return {
            ...base,
            scopes: Object.freeze(granted),
            active: row.active && a.live,
            agent: Object.freeze({
              agentRef: a.agent_ref,
              sponsorRef: a.sponsor_ref,
              sponsorshipRef: a.sponsorship_ref,
              state: a.state,
              credentialRef: a.credential_ref,
            }),
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
