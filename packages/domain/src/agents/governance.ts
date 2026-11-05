import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ActorContext,
  type AgentBudget,
  CATALOG_INDEX,
  type CommandEnvelope,
  type CommandResult,
  listEnvelope,
  RefusalError,
  type TenantTransaction,
  validateAgentBudgetQuery,
  validateAgentConsentListQuery,
  validateAgentConsentRecord,
  validateAgentConsentRevoke,
} from '@cuspatlas/contracts';
import { transactionNow } from '../clock';
import { recordDenial } from '../commands/boundary';
import { recordCommand } from '../events/record-command';
import { PROPOSAL_REQUIRED_FOR_AGENTS } from '../policy/authorize';
import { type AgentBase, checkEnvelope, conflict, failed, notFound, stale, validate } from './base';
import { openAgentSession } from './sessions';

/**
 * A9 consent and budgets. A consent (granted by a human holding agents.manage) admits one agent to
 * named catalog operations on one MCP deployment, within a budget, until an expiry. The MCP transport
 * calls `admitToolCall` before any handler runs (consent present, call budget reserved atomically in
 * the agent's own transaction) and `settleToolCall` after (records and PHI fields counted; a query
 * result over a per-call or per-period budget is refused rather than shortened). A failed accounting
 * write aborts the call. Every admitted agent call is appended to agent_tool_calls.
 */
export const AGENT_CONSENT_RESOURCE = 'agentConsent';
const ENVELOPE_KEYS = new Set([
  'asOf',
  'appliedFilters',
  'scope',
  'limit',
  'truncated',
  'nextCursor',
  'ordering',
  'count',
  'vocabularies',
]);

export interface ConsentCommandData {
  readonly consentRef: string;
  readonly agentRef: string;
  readonly state: 'active' | 'revoked';
  readonly expiresAt: string;
}

export interface BudgetMeasure {
  records: number;
  phiFields: number;
}
/** A budget warning on a command whose effect already happened (never a refusal of that effect). */
export interface BudgetWarning {
  readonly reason: 'budget_exceeded_after_effect' | 'budget_settlement_failed';
  readonly limit?: { readonly name: string; readonly value: number };
}

/**
 * H3: PHI weight of one scalar. Free text counts one field per 500 characters (at least one), so a
 * single long text field cannot move a whole note under a small per-call field budget.
 */
export const fieldWeight = (v: unknown): number =>
  typeof v === 'string' ? Math.max(1, Math.ceil(v.length / 500)) : 1;
/** PHI weight of minimized `key: value` source text (one weighted field per line). */
export const textWeight = (text: string): number =>
  text
    .split('\n')
    .filter((l) => l.length > 0)
    .reduce((n, l) => n + fieldWeight(l.slice(l.indexOf(':') + 1).trim()), 0);

const METER = new AsyncLocalStorage<(m: BudgetMeasure) => Promise<void>>();
/** Runs an admitted agent call with its budget meter (the MCP transport). */
export const runWithBudgetMeter = <T>(charge: (m: BudgetMeasure) => Promise<void>, run: () => Promise<T>) =>
  METER.run(charge, run);
/**
 * Charges content a handler is about to read or move on behalf of an admitted agent call, BEFORE the
 * effect (e.g. AI source content before generation); refused with 429 over budget. A no-op outside an
 * agent call (humans and REST have no agent budget).
 */
export async function chargeBudget(m: BudgetMeasure): Promise<void> {
  const charge = METER.getStore();
  if (charge) await charge(m);
}

export interface BudgetTicket {
  readonly consentRef: string;
  readonly deployment: string;
  readonly operation: string;
  readonly budget: AgentBudget;
  /** Content already charged during this call (before its result was measured). */
  readonly charged: BudgetMeasure;
  /** A23: the agent session (per consent) this call belongs to. */
  readonly sessionRef: string | null;
}

interface ConsentRow extends Record<string, unknown> {
  id: string;
  agent_ref: string;
  deployment: string;
  operations: string[];
  period_seconds: number;
  calls_per_period: number;
  records_per_period: number;
  phi_fields_per_period: number;
  records_per_call: number;
  phi_fields_per_call: number;
  state: 'active' | 'revoked';
  granted_by: string;
  granted_at: Date;
  expires_at: Date;
  version: number;
}

const budgetOf = (c: ConsentRow): AgentBudget => ({
  periodSeconds: c.period_seconds,
  callsPerPeriod: c.calls_per_period,
  recordsPerPeriod: c.records_per_period,
  phiFieldsPerPeriod: c.phi_fields_per_period,
  recordsPerCall: c.records_per_call,
  phiFieldsPerCall: c.phi_fields_per_call,
});

const present = (c: ConsentRow) => ({
  consentRef: c.id,
  agentRef: c.agent_ref,
  deployment: c.deployment,
  operations: [...c.operations],
  budget: budgetOf(c),
  state: c.state,
  grantedBy: c.granted_by,
  grantedAt: c.granted_at.toISOString(),
  expiresAt: c.expires_at.toISOString(),
  version: c.version,
});

const exhausted = (name: string, value: number, earliestAllowedAt?: string) =>
  new RefusalError({
    code: 'rate_limited',
    retryable: true,
    reasonCode: 'budget_exhausted',
    detail: {
      reason: 'budget_exhausted',
      limit: { name, value },
      ...(earliestAllowedAt ? { earliestAllowedAt } : {}),
    },
  });

/** Records and PHI scalar fields a tool result returns (envelope metadata excluded). */
export function measureResult(operation: string, result: unknown): { records: number; phiFields: number } {
  const r = (result ?? {}) as Record<string, unknown>;
  let records = 0;
  if (Array.isArray(r.items)) records = r.items.length;
  else if (Array.isArray(r.data)) records = r.data.length;
  else if (r.data !== undefined && r.data !== null) records = 1;
  // A bare object result (no data/items wrapper) is one record.
  else if (Object.keys(r).some((k) => !ENVELOPE_KEYS.has(k))) records = 1;
  const sensitivity = CATALOG_INDEX.get(operation)?.sensitivity ?? 'phi';
  if (sensitivity !== 'phi' && sensitivity !== 'phiBulk') return { records, phiFields: 0 };
  let phiFields = 0;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    else if (v !== null && v !== undefined) phiFields += fieldWeight(v);
  };
  for (const [k, v] of Object.entries(r)) if (!ENVELOPE_KEYS.has(k)) walk(v);
  return { records, phiFields };
}

export function createAgentGovernance(base: AgentBase) {
  const { deps, execute } = base;
  const deny = async (ctx: ActorContext, operation: string, err: RefusalError): Promise<never> => {
    await recordDenial(
      deps.recording,
      { correlationId: ctx.correlationId, tenantId: ctx.tenantId, actorId: ctx.actorId, operation },
      err,
    );
    throw err;
  };
  const logCall = (
    tx: TenantTransaction,
    ctx: ActorContext,
    t: { consentRef: string | null; deployment: string; operation: string; sessionRef?: string | null },
    outcome: string,
    m: { records: number; phiFields: number },
  ) =>
    tx.query(
      `INSERT INTO cuspatlas.agent_tool_calls (tenant_id, agent_ref, consent_ref, deployment, operation, outcome,
         records, phi_fields, correlation_id, session_ref)
       VALUES (cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        t.consentRef,
        t.deployment,
        t.operation,
        outcome,
        m.records,
        m.phiFields,
        ctx.correlationId,
        t.sessionRef ?? null,
      ],
    );

  return {
    recordConsent(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ConsentCommandData>> {
      const op = 'agents.consents.record';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{
          agentRef: string;
          deployment: string;
          operations: string[];
          budget: AgentBudget;
          expiresAt: string;
        }>(validateAgentConsentRecord, p);
        const expires = Date.parse(p.expiresAt);
        if (!Number.isFinite(expires) || expires <= Date.now())
          throw failed('expiry_not_future', '/expiresAt');
        return deps.withTenantTransaction(ctx, (tx) =>
          execute<ConsentCommandData>(ctx, envelope, tx, async () => {
            const agent = (
              await tx.query<{ scope_set: string[]; state: string; expires_at: Date }>(
                'SELECT scope_set, state, expires_at FROM cuspatlas.agent_principals WHERE principal_id = $1',
                [p.agentRef],
              )
            ).rows[0];
            if (!agent) throw notFound();
            if (agent.state === 'revoked') throw conflict('agent_revoked');
            if (expires > agent.expires_at.getTime()) throw failed('consent_outlives_agent', '/expiresAt');
            p.operations.forEach((name, i) => {
              const o = CATALOG_INDEX.get(name);
              if (!o || !o.transports.includes('mcp') || !o.principals.includes('service')) {
                throw failed('consent_operation_not_agent_callable', `/operations/${i}`);
              }
              if (o.scope !== null && !agent.scope_set.includes(o.scope)) {
                throw failed('consent_scope_exceeded', `/operations/${i}`);
              }
            });
            const b = p.budget;
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.agent_consents (tenant_id, agent_ref, deployment, operations, period_seconds,
                 calls_per_period, records_per_period, phi_fields_per_period, records_per_call, phi_fields_per_call,
                 granted_by, expires_at)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, cuspatlas.current_actor_id(), $10)
               RETURNING id`,
              [
                p.agentRef,
                p.deployment,
                p.operations,
                b.periodSeconds,
                b.callsPerPeriod,
                b.recordsPerPeriod,
                b.phiFieldsPerPeriod,
                b.recordsPerCall,
                b.phiFieldsPerCall,
                new Date(expires).toISOString(),
              ],
            );
            const consentRef = rows[0]?.id as string;
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: AGENT_CONSENT_RESOURCE,
                resourceRef: consentRef,
                resourceVersion: 1,
              },
              { changedFields: ['agent', 'deployment', 'operations', 'budget', 'expiresAt'] },
            );
            return {
              data: {
                consentRef,
                agentRef: p.agentRef,
                state: 'active' as const,
                expiresAt: new Date(expires).toISOString(),
              },
              version: 1,
            };
          }),
        );
      });
    },

    revokeConsent(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ConsentCommandData>> {
      const op = 'agents.consents.revoke';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ consentRef: string; expectedVersion: number }>(validateAgentConsentRevoke, p);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute<ConsentCommandData>(ctx, envelope, tx, async () => {
            const c = (
              await tx.query<ConsentRow>('SELECT * FROM cuspatlas.agent_consents WHERE id = $1 FOR UPDATE', [
                p.consentRef,
              ])
            ).rows[0];
            if (!c) throw notFound();
            if (c.version !== p.expectedVersion) throw stale(c.version);
            if (c.state === 'revoked') throw conflict('consent_revoked');
            await tx.query(
              `UPDATE cuspatlas.agent_consents SET state = 'revoked', revoked_at = now(),
                 revoked_by = cuspatlas.current_actor_id(), version = version + 1 WHERE id = $1`,
              [c.id],
            );
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: AGENT_CONSENT_RESOURCE,
                resourceRef: c.id,
                resourceVersion: c.version + 1,
              },
              { changedFields: ['state'] },
            );
            return {
              data: {
                consentRef: c.id,
                agentRef: c.agent_ref,
                state: 'revoked' as const,
                expiresAt: c.expires_at.toISOString(),
              },
              version: c.version + 1,
            };
          }),
        );
      });
    },

    listConsents(ctx: ActorContext, query: unknown) {
      const op = 'agents.consents.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        validate<{ agentRef?: string; limit?: number; cursor?: string }>(
          validateAgentConsentListQuery,
          query,
        );
        const pg = base.page(ctx, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const at = await transactionNow(tx);
          const agent = query.agentRef ?? null;
          const total = Number(
            (
              await tx.query<{ n: string }>(
                'SELECT count(*) AS n FROM cuspatlas.agent_consents WHERE ($1::uuid IS NULL OR agent_ref = $1)',
                [agent],
              )
            ).rows[0]?.n ?? 0,
          );
          const { rows } = await tx.query<ConsentRow>(
            `SELECT * FROM cuspatlas.agent_consents WHERE ($1::uuid IS NULL OR agent_ref = $1)
             ORDER BY granted_at DESC, id DESC LIMIT $2 OFFSET $3`,
            [agent, pg.limit, pg.offset],
          );
          return {
            ...listEnvelope({
              asOf: at,
              appliedFilters: { agentRef: agent },
              locationRefs: decision.locationRefs,
              limit: pg.limit,
              nextCursor: pg.next(rows.length, total),
              ordering: { key: 'grantedAt', direction: 'desc', tieBreak: 'consentRef' },
              total,
            }),
            items: rows.map(present),
          };
        });
      });
    },

    readBudget(ctx: ActorContext, query: unknown) {
      const op = 'agents.budgets.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ agentRef: string; deployment: string }>(validateAgentBudgetQuery, query);
        if (ctx.agent && query.agentRef !== ctx.actorId) throw notFound();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const c = (
            await tx.query<
              ConsentRow & {
                period_started_at: Date | null;
                calls: number | null;
                records: number | null;
                phi: number | null;
                live: boolean | null;
              }
            >(
              // The period is live by the same now() the meter resets it with (clock audit).
              `SELECT c.*, u.period_started_at, u.calls, u.records, u.phi_fields AS phi,
                 u.period_started_at + make_interval(secs => c.period_seconds) > now() AS live
               FROM cuspatlas.agent_consents c LEFT JOIN cuspatlas.agent_budget_usage u ON u.consent_ref = c.id
               WHERE c.agent_ref = $1 AND c.deployment = $2 AND c.state = 'active' AND c.expires_at > now()
               ORDER BY c.granted_at DESC LIMIT 1`,
              [query.agentRef, query.deployment],
            )
          ).rows[0];
          if (!c) throw notFound();
          const live = c.period_started_at !== null && c.live === true;
          return {
            consentRef: c.id,
            periodStartedAt: live ? (c.period_started_at as Date).toISOString() : null,
            calls: live ? (c.calls ?? 0) : 0,
            records: live ? (c.records ?? 0) : 0,
            phiFields: live ? (c.phi ?? 0) : 0,
            budget: budgetOf(c),
          };
        });
      });
    },

    /**
     * Pre-call gate for an agent on MCP: an active, unexpired consent for this deployment naming the
     * operation, then one call reserved against the period budget (refused 429 when exhausted).
     */
    async admitToolCall(ctx: ActorContext, deployment: string, operation: string): Promise<BudgetTicket> {
      if (!ctx.agent) throw new Error('admitToolCall is for agent principals only');
      // A10 / A-D4: a propose-only (human-only) operation is never an agent's direct call, whatever the
      // consent says (consent cannot name it); the agent is told to prepare a proposal instead.
      if (PROPOSAL_REQUIRED_FOR_AGENTS.has(operation))
        return deny(ctx, operation, new RefusalError({ code: 'forbidden', reasonCode: 'proposal_required' }));
      // H3: a human-only operation is a policy refusal (principal kind), not a missing consent.
      const entry = CATALOG_INDEX.get(operation);
      if (entry && !entry.principals.includes('service'))
        return deny(
          ctx,
          operation,
          new RefusalError({ code: 'forbidden', reasonCode: 'principal_kind_denied' }),
        );
      const outcome = await deps.withTenantTransaction(ctx, async (tx) => {
        const c = (
          await tx.query<ConsentRow>(
            `SELECT * FROM cuspatlas.agent_consents
             WHERE agent_ref = cuspatlas.current_actor_id() AND deployment = $1 AND $2 = ANY (operations)
               AND state = 'active' AND expires_at > now()
             ORDER BY granted_at DESC LIMIT 1`,
            [deployment, operation],
          )
        ).rows[0];
        if (!c) return { refusal: new RefusalError({ code: 'forbidden', reasonCode: 'consent_missing' }) };
        const budget = budgetOf(c);
        const sessionRef = await openAgentSession(tx, c.id, deployment);
        await tx.query(
          `INSERT INTO cuspatlas.agent_budget_usage (consent_ref, tenant_id, period_started_at)
           VALUES ($1, cuspatlas.current_tenant_id(), now()) ON CONFLICT (consent_ref) DO NOTHING`,
          [c.id],
        );
        const u = (
          await tx.query<{
            period_started_at: Date;
            calls: number;
            records: number;
            phi_fields: number;
            expired: boolean;
          }>(
            `SELECT period_started_at, calls, records, phi_fields,
               period_started_at + make_interval(secs => $2) <= now() AS expired
             FROM cuspatlas.agent_budget_usage WHERE consent_ref = $1 FOR UPDATE`,
            [c.id, c.period_seconds],
          )
        ).rows[0];
        if (!u) throw new Error('budget usage row missing');
        const ticket: BudgetTicket = {
          consentRef: c.id,
          deployment,
          operation,
          budget,
          charged: { records: 0, phiFields: 0 },
          sessionRef,
        };
        if (u.expired) {
          await tx.query(
            `UPDATE cuspatlas.agent_budget_usage SET period_started_at = now(), calls = 1, records = 0, phi_fields = 0
             WHERE consent_ref = $1`,
            [c.id],
          );
          return { ticket };
        }
        const until = new Date(u.period_started_at.getTime() + c.period_seconds * 1000).toISOString();
        if (u.calls >= budget.callsPerPeriod)
          return { refusal: exhausted('callsPerPeriod', budget.callsPerPeriod, until), ticket };
        // A spent period record or PHI budget refuses every further call (queries and commands alike).
        if (u.records >= budget.recordsPerPeriod)
          return { refusal: exhausted('recordsPerPeriod', budget.recordsPerPeriod, until), ticket };
        if (u.phi_fields >= budget.phiFieldsPerPeriod)
          return { refusal: exhausted('phiFieldsPerPeriod', budget.phiFieldsPerPeriod, until), ticket };
        await tx.query('UPDATE cuspatlas.agent_budget_usage SET calls = calls + 1 WHERE consent_ref = $1', [
          c.id,
        ]);
        return { ticket };
      });
      if ('refusal' in outcome && outcome.refusal) {
        if (outcome.ticket) {
          await deps.withTenantTransaction(ctx, (tx) =>
            logCall(tx, ctx, outcome.ticket as BudgetTicket, 'budget_exhausted', {
              records: 0,
              phiFields: 0,
            }),
          );
        }
        return deny(ctx, operation, outcome.refusal);
      }
      return outcome.ticket as BudgetTicket;
    },

    /**
     * H3: charges content a handler is about to read or move (before its effect) against the per-call
     * and per-period record and PHI budgets; over budget it is refused (429) and nothing is charged.
     */
    async chargeToolCall(ctx: ActorContext, ticket: BudgetTicket, m: BudgetMeasure): Promise<void> {
      const b = ticket.budget;
      const refusal = await deps.withTenantTransaction(ctx, async (tx) => {
        const u = (
          await tx.query<{ records: number; phi_fields: number }>(
            'SELECT records, phi_fields FROM cuspatlas.agent_budget_usage WHERE consent_ref = $1 FOR UPDATE',
            [ticket.consentRef],
          )
        ).rows[0];
        if (!u) throw new Error('budget usage row missing');
        const over = overBudget(b, u, ticket.charged, m);
        if (over) {
          await logCall(tx, ctx, ticket, 'budget_exhausted', { records: 0, phiFields: 0 });
          return over;
        }
        await tx.query(
          'UPDATE cuspatlas.agent_budget_usage SET records = records + $2, phi_fields = phi_fields + $3 WHERE consent_ref = $1',
          [ticket.consentRef, m.records, m.phiFields],
        );
        ticket.charged.records += m.records;
        ticket.charged.phiFields += m.phiFields;
        return null;
      });
      if (refusal) await deny(ctx, ticket.operation, refusal);
    },

    /**
     * Closeout B: post-call accounting of a query result that may be truncated. A list result over a
     * per-call record or PHI budget is shortened to the longest prefix within every budget and answered
     * with `truncated` (only what is returned is charged; the call is logged `truncated`). A result
     * that cannot fit even one record, or that would exceed a remaining period budget, is refused as
     * before (429). A single-record result is never truncated.
     */
    async settleQuery(
      ctx: ActorContext,
      ticket: BudgetTicket,
      result: unknown,
    ): Promise<{
      result: unknown;
      truncated: { returned: number; omitted: number; limit: { name: string; value: number } } | null;
    }> {
      const b = ticket.budget;
      const r = (result ?? {}) as Record<string, unknown>;
      const key = Array.isArray(r.items) ? 'items' : Array.isArray(r.data) ? 'data' : null;
      const out = await deps.withTenantTransaction(ctx, async (tx) => {
        const u = (
          await tx.query<{ records: number; phi_fields: number }>(
            'SELECT records, phi_fields FROM cuspatlas.agent_budget_usage WHERE consent_ref = $1 FOR UPDATE',
            [ticket.consentRef],
          )
        ).rows[0];
        if (!u) throw new Error('budget usage row missing');
        let value: unknown = result;
        let m = measureResult(ticket.operation, result);
        let over = overBudget(b, u, ticket.charged, m);
        let truncated: { returned: number; omitted: number; limit: { name: string; value: number } } | null =
          null;
        const perCall = (e: RefusalError | null) => {
          const name = (e?.detail as { limit?: { name: string } } | undefined)?.limit?.name;
          return name === 'recordsPerCall' || name === 'phiFieldsPerCall';
        };
        if (over && perCall(over) && key !== null) {
          const list = r[key] as unknown[];
          const limit = (over.detail as { limit: { name: string; value: number } }).limit;
          for (let k = list.length - 1; k >= 1; k -= 1) {
            const candidate = { ...r, [key]: list.slice(0, k) };
            const cm = measureResult(ticket.operation, candidate);
            const cover = overBudget(b, u, ticket.charged, cm);
            if (cover === null || !perCall(cover)) {
              value = candidate;
              m = cm;
              over = cover;
              truncated = { returned: k, omitted: list.length - k, limit };
              break;
            }
          }
        }
        if (over) {
          await logCall(tx, ctx, ticket, 'budget_exhausted', ticket.charged);
          return { refusal: over, value: null, truncated: null };
        }
        await tx.query(
          'UPDATE cuspatlas.agent_budget_usage SET records = records + $2, phi_fields = phi_fields + $3 WHERE consent_ref = $1',
          [ticket.consentRef, m.records, m.phiFields],
        );
        await logCall(tx, ctx, ticket, truncated ? 'truncated' : 'ok', {
          records: ticket.charged.records + m.records,
          phiFields: ticket.charged.phiFields + m.phiFields,
        });
        return { refusal: null, value, truncated };
      });
      if (out.refusal) await deny(ctx, ticket.operation, out.refusal);
      return { result: out.value, truncated: out.truncated };
    },

    /**
     * Post-call accounting of the result. A query over a per-call or remaining per-period budget is
     * refused (the result is never returned, never silently shortened). A command's effect has already
     * happened, so it is never refused here: it is counted (so the period budget refuses the next call)
     * and answered with a budget warning; commands that move content charge it before the effect
     * (`chargeBudget`).
     */
    async settleToolCall(
      ctx: ActorContext,
      ticket: BudgetTicket,
      kind: 'query' | 'command',
      result: unknown,
      outcome: string,
    ): Promise<BudgetWarning | null> {
      const m = outcome === 'ok' ? measureResult(ticket.operation, result) : { records: 0, phiFields: 0 };
      const b = ticket.budget;
      const { refusal, warning } = await deps.withTenantTransaction(ctx, async (tx) => {
        const u = (
          await tx.query<{ records: number; phi_fields: number }>(
            'SELECT records, phi_fields FROM cuspatlas.agent_budget_usage WHERE consent_ref = $1 FOR UPDATE',
            [ticket.consentRef],
          )
        ).rows[0];
        if (!u) throw new Error('budget usage row missing');
        const over = outcome === 'ok' ? overBudget(b, u, ticket.charged, m) : null;
        const total = {
          records: ticket.charged.records + m.records,
          phiFields: ticket.charged.phiFields + m.phiFields,
        };
        if (over && kind === 'query') {
          await logCall(tx, ctx, ticket, 'budget_exhausted', ticket.charged);
          return { refusal: over, warning: null };
        }
        await tx.query(
          'UPDATE cuspatlas.agent_budget_usage SET records = records + $2, phi_fields = phi_fields + $3 WHERE consent_ref = $1',
          [ticket.consentRef, m.records, m.phiFields],
        );
        await logCall(tx, ctx, ticket, outcome, total);
        const detail = over?.detail as { limit?: { name: string; value: number } } | undefined;
        return {
          refusal: null,
          warning: over
            ? ({
                reason: 'budget_exceeded_after_effect',
                ...(detail?.limit ? { limit: detail.limit } : {}),
              } as const)
            : null,
        };
      });
      if (refusal) await deny(ctx, ticket.operation, refusal);
      return warning;
    },
  };
}

/** The first record/PHI limit `m` would exceed on top of this call's charges and the period usage. */
function overBudget(
  b: AgentBudget,
  u: { records: number; phi_fields: number },
  charged: BudgetMeasure,
  m: BudgetMeasure,
): RefusalError | null {
  if (charged.records + m.records > b.recordsPerCall) return exhausted('recordsPerCall', b.recordsPerCall);
  if (charged.phiFields + m.phiFields > b.phiFieldsPerCall)
    return exhausted('phiFieldsPerCall', b.phiFieldsPerCall);
  if (u.records + m.records > b.recordsPerPeriod) return exhausted('recordsPerPeriod', b.recordsPerPeriod);
  if (u.phi_fields + m.phiFields > b.phiFieldsPerPeriod)
    return exhausted('phiFieldsPerPeriod', b.phiFieldsPerPeriod);
  return null;
}
