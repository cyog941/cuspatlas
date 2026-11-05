import { randomBytes } from 'node:crypto';
import {
  type ActorContext,
  AGENT_MAX_LIFETIME_DAYS,
  AGENT_SCOPE_CEILING,
  type AgentState,
  type CommandEnvelope,
  type CommandResult,
  listEnvelope,
  RefusalError,
  type TenantTransaction,
  validateAgentAuditQuery,
  validateAgentCreate,
  validateAgentListQuery,
  validateAgentQuery,
  validateAgentSponsorChange,
  validateAgentTransition,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import type { ActionName } from '../policy/authorize';
import {
  type AgentBase,
  assertRef,
  checkEnvelope,
  conflict,
  failed,
  notFound,
  pgCode,
  stale,
  validate,
} from './base';

/**
 * A8 agent principals: one principal per agent, a named human sponsor (the creating human, changed
 * only by a recorded sponsorship), a purpose, a scope set inside the agent ceiling and the sponsor's
 * own scopes, an expiry, a rotatable credential reference and terminal revocation. The checked
 * database functions write the principal, membership and agent rows; the membership source folds the
 * agent state, expiry and the sponsor's live membership into every authorization (no cached
 * authority), so suspension, revocation and sponsor loss apply at the next call, queued work included.
 */
export const AGENT_RESOURCE = 'agentPrincipal';

export interface AgentCommandData {
  readonly agentRef: string;
  readonly state: AgentState;
  readonly expiresAt: string;
  readonly credentialRef?: string;
  readonly sponsorRef?: string;
}

interface AgentRow extends Record<string, unknown> {
  principal_id: string;
  purpose: string;
  scope_set: string[];
  state: AgentState;
  expires_at: Date;
  sponsor_ref: string;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
  version: number;
  live: boolean;
}

const newCredential = () => `agc-${randomBytes(16).toString('hex')}`;

const SELECT_AGENT = `SELECT a.principal_id, a.purpose, a.scope_set, a.state, a.expires_at, s.sponsor_ref,
    a.created_by, a.created_at, a.revoked_at, a.version, (a.state <> 'revoked' AND a.expires_at > now()) AS live
  FROM cuspatlas.agent_principals a JOIN cuspatlas.agent_sponsorships s ON s.id = a.sponsorship_ref`;

function present(r: AgentRow) {
  const effective = r.live ? r.scope_set.filter((x) => r.state === 'active' || x.endsWith('.read')) : [];
  return {
    agentRef: r.principal_id,
    purpose: r.purpose,
    scopes: [...r.scope_set],
    state: r.state,
    expiresAt: r.expires_at.toISOString(),
    sponsorRef: r.sponsor_ref,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    revokedAt: r.revoked_at === null ? null : r.revoked_at.toISOString(),
    version: r.version,
    grants: { effectiveScopes: effective, live: r.live },
  };
}

type TransitionAction = 'suspend' | 'resume' | 'revoke' | 'rotate' | 'sponsor';

async function now(tx: TenantTransaction): Promise<Date> {
  return (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
}

function mapTransitionError(err: unknown): unknown {
  const code = pgCode(err);
  const detail = (err as { detail?: string }).detail;
  if (code === 'P0404') return notFound();
  if (code === 'P0409') {
    if (detail !== undefined && /^\d+$/.test(detail)) return stale(Number(detail));
    return conflict(detail ?? 'agent_state_conflict');
  }
  if (code === 'P0422') return failed('sponsor_invalid', '/sponsorRef');
  if (code === '42501') return new RefusalError({ code: 'forbidden', reasonCode: 'scope_missing' });
  return err;
}

export function createAgentPrincipals(base: AgentBase) {
  const { deps, execute } = base;

  function transition(
    ctx: ActorContext,
    envelope: CommandEnvelope<unknown>,
    op: ActionName,
    action: TransitionAction,
  ): Promise<CommandResult<AgentCommandData>> {
    return base.guarded(ctx, op, async () => {
      await base.authorize(ctx, op);
      checkEnvelope(envelope, op);
      const p = envelope.payload as {
        agentRef: string;
        expectedVersion: number;
        reason?: string;
        sponsorRef?: string;
      };
      if (action === 'sponsor') validate(validateAgentSponsorChange, p);
      else validate(validateAgentTransition, p);
      return deps.withTenantTransaction(ctx, (tx) =>
        execute<AgentCommandData>(ctx, envelope, tx, async () => {
          const credential = action === 'rotate' ? newCredential() : null;
          let version: number;
          try {
            const { rows } = await tx.query<{ v: number }>(
              'SELECT cuspatlas.agent_transition($1, $2, $3, $4, $5, $6) AS v',
              [
                p.agentRef,
                action,
                p.expectedVersion,
                credential,
                p.sponsorRef ?? null,
                p.reason ?? 'unspecified',
              ],
            );
            version = rows[0]?.v as number;
          } catch (err) {
            throw mapTransitionError(err);
          }
          const row = (await tx.query<AgentRow>(`${SELECT_AGENT} WHERE a.principal_id = $1`, [p.agentRef]))
            .rows[0];
          if (!row) throw new Error('agent transition returned no row');
          await recordCommand(
            tx,
            {
              operation: op,
              resourceType: AGENT_RESOURCE,
              resourceRef: p.agentRef,
              resourceVersion: version,
            },
            {
              changedFields: [
                action === 'rotate' ? 'credential' : action === 'sponsor' ? 'sponsor' : 'state',
              ],
            },
          );
          return {
            data: {
              agentRef: row.principal_id,
              state: row.state,
              expiresAt: row.expires_at.toISOString(),
              ...(credential ? { credentialRef: credential } : {}),
              ...(action === 'sponsor' ? { sponsorRef: row.sponsor_ref } : {}),
            },
            version,
          };
        }),
      );
    });
  }

  return {
    /** createAgentPrincipal: sponsor = the calling human; refused for human-only or unheld scopes. */
    createAgentPrincipal(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<AgentCommandData>> {
      const op = 'agents.principals.create';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ purpose: string; scopes: string[]; expiresAt: string }>(validateAgentCreate, p);
        const expires = Date.parse(p.expiresAt);
        if (!Number.isFinite(expires) || expires <= Date.now())
          throw failed('expiry_not_future', '/expiresAt');
        if (expires > Date.now() + AGENT_MAX_LIFETIME_DAYS * 86_400_000) {
          throw failed('expiry_beyond_maximum_lifetime', '/expiresAt');
        }
        const index = p.scopes.findIndex((x) => !AGENT_SCOPE_CEILING.has(x));
        if (index >= 0) throw failed('human_only_scope', `/scopes/${index}`);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute<AgentCommandData>(ctx, envelope, tx, async () => {
            const credential = newCredential();
            let agentRef: string;
            try {
              const { rows } = await tx.query<{ id: string }>(
                'SELECT cuspatlas.agent_create($1, $2, $3, $4) AS id',
                [p.purpose, p.scopes, new Date(expires).toISOString(), credential],
              );
              agentRef = rows[0]?.id as string;
            } catch (err) {
              if (pgCode(err) === 'P0422') throw failed('sponsor_scope_exceeded', '/scopes');
              if (pgCode(err) === '42501') {
                throw new RefusalError({ code: 'forbidden', reasonCode: 'scope_missing' });
              }
              throw err;
            }
            await recordCommand(
              tx,
              { operation: op, resourceType: AGENT_RESOURCE, resourceRef: agentRef, resourceVersion: 1 },
              { changedFields: ['purpose', 'scopes', 'expiresAt', 'sponsor', 'credential'] },
            );
            return {
              data: {
                agentRef,
                state: 'active' as const,
                expiresAt: new Date(expires).toISOString(),
                credentialRef: credential,
                sponsorRef: ctx.actorId,
              },
              version: 1,
            };
          }),
        );
      });
    },
    suspendAgentPrincipal: (ctx: ActorContext, e: CommandEnvelope<unknown>) =>
      transition(ctx, e, 'agents.principals.suspend', 'suspend'),
    resumeAgentPrincipal: (ctx: ActorContext, e: CommandEnvelope<unknown>) =>
      transition(ctx, e, 'agents.principals.resume', 'resume'),
    revokeAgentPrincipal: (ctx: ActorContext, e: CommandEnvelope<unknown>) =>
      transition(ctx, e, 'agents.principals.revoke', 'revoke'),
    rotateAgentCredential: (ctx: ActorContext, e: CommandEnvelope<unknown>) =>
      transition(ctx, e, 'agents.credentials.rotate', 'rotate'),
    changeAgentSponsor: (ctx: ActorContext, e: CommandEnvelope<unknown>) =>
      transition(ctx, e, 'agents.sponsors.change', 'sponsor'),

    /** readAgentPrincipal + describeAgentGrants. An agent may read only its own record. */
    readAgentPrincipal(ctx: ActorContext, query: unknown) {
      const op = 'agents.principals.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ agentRef: string }>(validateAgentQuery, query);
        assertRef(query.agentRef);
        if (ctx.agent && query.agentRef !== ctx.actorId) throw notFound();
        const row = await deps.withTenantTransaction(
          ctx,
          async (tx) =>
            (await tx.query<AgentRow>(`${SELECT_AGENT} WHERE a.principal_id = $1`, [query.agentRef])).rows[0],
        );
        if (!row) throw notFound();
        return present(row);
      });
    },

    listAgentPrincipals(ctx: ActorContext, query: unknown) {
      const op = 'agents.principals.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        validate<{ limit?: number; cursor?: string; state?: AgentState }>(validateAgentListQuery, query);
        const pg = base.page(ctx, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const at = await now(tx);
          const state = query.state ?? null;
          const total = Number(
            (
              await tx.query<{ n: string }>(
                'SELECT count(*) AS n FROM cuspatlas.agent_principals WHERE ($1::text IS NULL OR state = $1)',
                [state],
              )
            ).rows[0]?.n ?? 0,
          );
          const { rows } = await tx.query<AgentRow>(
            `${SELECT_AGENT} WHERE ($1::text IS NULL OR a.state = $1)
             ORDER BY a.created_at, a.principal_id LIMIT $2 OFFSET $3`,
            [state, pg.limit, pg.offset],
          );
          return {
            ...listEnvelope({
              asOf: at,
              appliedFilters: { state },
              locationRefs: decision.locationRefs,
              limit: pg.limit,
              nextCursor: pg.next(rows.length, total),
              ordering: { key: 'createdAt', direction: 'asc', tieBreak: 'agentRef' },
              total,
            }),
            items: rows.map(present),
          };
        });
      });
    },

    listAgentAudit(ctx: ActorContext, query: unknown) {
      const op = 'agents.audit.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        validate<{ agentRef: string; limit?: number; cursor?: string }>(validateAgentAuditQuery, query);
        const pg = base.page(ctx, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const at = await now(tx);
          const exists = await tx.query('SELECT 1 FROM cuspatlas.agent_principals WHERE principal_id = $1', [
            query.agentRef,
          ]);
          if (exists.rowCount !== 1) throw notFound();
          const total = Number(
            (
              await tx.query<{ n: string }>(
                'SELECT count(*) AS n FROM cuspatlas.agent_audit_events WHERE agent_ref = $1',
                [query.agentRef],
              )
            ).rows[0]?.n ?? 0,
          );
          const { rows } = await tx.query<{
            event_ref: string;
            agent_ref: string;
            sponsor_ref: string;
            operation: string;
            resource_type: string;
            resource_ref: string;
            resource_version: number;
            correlation_id: string;
            occurred_at: Date;
          }>(
            `SELECT event_ref, agent_ref, sponsor_ref, operation, resource_type, resource_ref, resource_version,
               correlation_id, occurred_at
             FROM cuspatlas.agent_audit_events WHERE agent_ref = $1
             ORDER BY occurred_at, event_ref LIMIT $2 OFFSET $3`,
            [query.agentRef, pg.limit, pg.offset],
          );
          return {
            ...listEnvelope({
              asOf: at,
              appliedFilters: { agentRef: query.agentRef },
              locationRefs: decision.locationRefs,
              limit: pg.limit,
              nextCursor: pg.next(rows.length, total),
              ordering: { key: 'occurredAt', direction: 'asc', tieBreak: 'eventRef' },
              total,
            }),
            items: rows.map((r) => ({
              eventRef: r.event_ref,
              agentRef: r.agent_ref,
              sponsorRef: r.sponsor_ref,
              operation: r.operation,
              resourceType: r.resource_type,
              resourceRef: r.resource_ref,
              resourceVersion: r.resource_version,
              correlationId: r.correlation_id,
              occurredAt: r.occurred_at.toISOString(),
            })),
          };
        });
      });
    },
  };
}
