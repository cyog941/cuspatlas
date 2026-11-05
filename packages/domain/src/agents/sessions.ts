import type { TenantTransaction } from '@cuspatlas/contracts';

/** A23 (pending approval): a session with no admitted call for 30 minutes is ended (idle_timeout). */
export const AGENT_SESSION_IDLE_SECONDS = 1800;

/**
 * A23: the session an admitted agent call belongs to, in the agent's own admission transaction. One
 * open session per agent and consent; an ended or idle session is never reused (a new one starts).
 */
export async function openAgentSession(
  tx: TenantTransaction,
  consentRef: string,
  deployment: string,
): Promise<string> {
  const open = (
    await tx.query<{ id: string }>(
      `SELECT id FROM cuspatlas.agent_sessions
       WHERE agent_ref = cuspatlas.current_actor_id() AND consent_ref = $1 AND ended_at IS NULL
         AND last_call_at > now() - make_interval(secs => $2)
       ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [consentRef, AGENT_SESSION_IDLE_SECONDS],
    )
  ).rows[0];
  if (open) {
    await tx.query('UPDATE cuspatlas.agent_sessions SET last_call_at = clock_timestamp() WHERE id = $1', [
      open.id,
    ]);
    return open.id;
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.agent_sessions (tenant_id, agent_ref, consent_ref, deployment)
     VALUES (cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $1, $2) RETURNING id`,
    [consentRef, deployment],
  );
  return rows[0]?.id as string;
}

/** Sessions with their effective end (explicit, agent inactive, consent ended or idle) computed live. */
export const SESSION_SELECT = `SELECT s.id, s.agent_ref, s.consent_ref, s.deployment, s.started_at, s.last_call_at,
    CASE WHEN s.ended_at IS NOT NULL THEN s.end_reason
         WHEN a.state = 'revoked' OR a.expires_at <= now() THEN 'agent_inactive'
         WHEN c.state <> 'active' OR c.expires_at <= now() THEN 'consent_ended'
         WHEN s.last_call_at <= now() - make_interval(secs => ${AGENT_SESSION_IDLE_SECONDS}) THEN 'idle_timeout'
    END AS end_reason,
    CASE WHEN s.ended_at IS NOT NULL THEN s.ended_at
         WHEN a.state = 'revoked' OR a.expires_at <= now() THEN coalesce(a.revoked_at, a.expires_at)
         WHEN c.state <> 'active' OR c.expires_at <= now() THEN coalesce(c.revoked_at, c.expires_at)
         WHEN s.last_call_at <= now() - make_interval(secs => ${AGENT_SESSION_IDLE_SECONDS})
           THEN s.last_call_at + make_interval(secs => ${AGENT_SESSION_IDLE_SECONDS})
    END AS ended_at,
    (SELECT count(*)::int FROM cuspatlas.agent_tool_calls t WHERE t.session_ref = s.id) AS call_count
  FROM cuspatlas.agent_sessions s
  JOIN cuspatlas.agent_principals a ON a.principal_id = s.agent_ref
  JOIN cuspatlas.agent_consents c ON c.id = s.consent_ref`;

export interface SessionRow extends Record<string, unknown> {
  id: string;
  agent_ref: string;
  consent_ref: string;
  deployment: string;
  started_at: Date;
  last_call_at: Date;
  end_reason: string | null;
  ended_at: Date | null;
  call_count: number;
}

export const presentSession = (r: SessionRow) => ({
  sessionRef: r.id,
  agentRef: r.agent_ref,
  consentRef: r.consent_ref,
  deployment: r.deployment,
  startedAt: r.started_at.toISOString(),
  lastCallAt: r.last_call_at.toISOString(),
  state: r.end_reason === null ? ('open' as const) : ('ended' as const),
  endedAt: r.ended_at === null ? null : r.ended_at.toISOString(),
  endReason: r.end_reason,
  callCount: r.call_count,
});
