import { randomBytes, randomUUID } from 'node:crypto';
import {
  type ActorContext,
  CATALOG_INDEX,
  type CommandEnvelope,
  type CommandResult,
  listEnvelope,
  MEMORY_STRUCTURED_KINDS,
  memoryInstantFloorOk,
  memoryValueMatches,
  parseMemoryKey,
  RefusalError,
  type TenantTransaction,
  validateAgentMemoryDelete,
  validateAgentMemoryListQuery,
  validateAgentMemoryPolicySet,
  validateAgentMemoryQuery,
  validateAgentMemoryWrite,
  validateAgentSessionEnd,
  validateAgentSessionListQuery,
  validateAgentSessionQuery,
  validateAgentTaskCancel,
  validateAgentTaskListQuery,
  validateAgentTaskPolicyListQuery,
  validateAgentTaskPolicyRecord,
  validateAgentTaskPolicyRevoke,
  validateAgentTaskRunListQuery,
  validateAgentTaskSchedule,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { createMatchKeyer, MATCH_KEY, normalizeText } from '../patients/model';
import type { ActionName } from '../policy/authorize';
import { carriesContact, carriesDobPhrase } from './ai-port';
import { type AgentBase, checkEnvelope, conflict, failed, notFound, pgCode, stale, validate } from './base';
import { presentSession, SESSION_SELECT, type SessionRow } from './sessions';

/**
 * A23 / OR-13 agent workspace: sessions (history = references to agent_tool_calls and the agent-audit
 * stream), scoped memory (per agent, tenant-bound, classified; a phi classification needs the tenant
 * policy, enforced in the database; Closeout D5 and its review fixes: any other note is accepted only
 * from a positive allowlist (a namespaced key from registered prefixes and suffixes; a value of a
 * structured kind from registered codes, catalog operations or bounded grammars), in the domain and in
 * the database, with the best-effort PHI heuristic and the contact/DOB regex backstop as extra refusal
 * layers. Not guaranteed: a short counter, a UUID or an instant can still carry a deliberately encoded
 * identifier (see packages/contracts/src/agent-memory.ts); 30-day retention,
 * deletion by the sponsor or an agent manager, every agent read and write in the agent-audit stream and
 * metered by the MCP budget gate) and scheduled tasks under a human-owned standing policy, rechecked by
 * the worker at execution. An agent reaches only its own workspace; a human reaches an agent's workspace
 * only as its current sponsor or holding agents.manage (otherwise the same 404 as a missing agent).
 * Every limit is recommended-pending-approval.
 */
export const MEMORY_RETENTION_DAYS = 30;
/** Operations a standing task policy may name besides reads: preparing a proposal, never executing one. */
const TASK_PREPARE_OPERATIONS = new Set(['actions.proposals.prepare']);

const iso = (d: Date | null) => (d === null ? null : d.toISOString());
const uuids = (text: string) =>
  text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
const forbidden = (reasonCode: 'principal_kind_denied') =>
  new RefusalError({ code: 'forbidden', reasonCode });
/** The one memory write refusal: no reason distinguishes a name, DOB, ref, pattern or policy. */
const refusedValue = () => failed('memory_value_refused', '/value');

/**
 * Closeout D5 and the Closeout D review fixes: the positive allowlist of structured, non-PHI memory value
 * kinds, registered codes and catalog operations, and the namespaced key grammar, all from
 * @cuspatlas/contracts (agent-memory.ts) and enforced again by the database (the value_structured and
 * key_namespaced constraints and the agent_memory_registry_guard trigger). `text` is not a structured
 * kind: free text is accepted only classified phi under the tenant PHI policy. The lookup is a Map, so an
 * inherited name (`constructor`, `__proto__`) is never a kind.
 */
export function structuredMemoryValueAccepted(kind: string, value: string): boolean {
  return memoryValueMatches(kind, value);
}
export const MEMORY_VALUE_KINDS = [...MEMORY_STRUCTURED_KINDS, 'text'] as const;
const MRN_LIKE =
  /\b(?:mrn|medical\s+record(?:\s+(?:number|no\.?))?|chart\s*(?:number|no\.?|#))\s*[:#.-]?\s*[A-Za-z0-9-]*\d/i;

interface MemoryRow extends Record<string, unknown> {
  id: string;
  agent_ref: string;
  key: string;
  value: string;
  classification: 'operational' | 'reference' | 'phi';
  value_kind: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  version: number;
}
const presentMemory = (r: MemoryRow, withValue: boolean) => ({
  memoryRef: r.id,
  agentRef: r.agent_ref,
  key: r.key,
  classification: r.classification,
  kind: r.value_kind ?? null,
  ...(withValue ? { value: r.value } : {}),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  version: r.version,
});

interface PolicyRow extends Record<string, unknown> {
  id: string;
  agent_ref: string;
  owner_ref: string;
  deployment: string;
  operations: string[];
  min_interval_seconds: number;
  max_runs_per_day: number;
  created_at: Date;
  expires_at: Date;
  state: 'active' | 'revoked';
  live: boolean;
  version: number;
}
const POLICY_SELECT = `SELECT id, agent_ref, owner_ref, deployment, operations, min_interval_seconds, max_runs_per_day,
    created_at, expires_at, state, (state = 'active' AND expires_at > now()) AS live, version
  FROM cuspatlas.agent_task_policies`;
const presentPolicy = (r: PolicyRow) => ({
  policyRef: r.id,
  agentRef: r.agent_ref,
  ownerRef: r.owner_ref,
  deployment: r.deployment,
  operations: [...r.operations],
  minIntervalSeconds: r.min_interval_seconds,
  maxRunsPerDay: r.max_runs_per_day,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  state: r.state,
  live: r.live,
  version: r.version,
});

interface TaskRow extends Record<string, unknown> {
  id: string;
  agent_ref: string;
  policy_ref: string;
  operation: string;
  arguments: Record<string, unknown>;
  interval_seconds: number;
  next_run_at: Date;
  state: 'active' | 'cancelled' | 'stopped';
  stop_reason: string | null;
  last_run_at: Date | null;
  last_outcome: string | null;
  version: number;
}
const presentTask = (r: TaskRow) => ({
  taskRef: r.id,
  agentRef: r.agent_ref,
  policyRef: r.policy_ref,
  operation: r.operation,
  arguments: r.arguments,
  intervalSeconds: r.interval_seconds,
  nextRunAt: r.next_run_at.toISOString(),
  state: r.state,
  stopReason: r.stop_reason,
  lastRunAt: iso(r.last_run_at),
  lastOutcome: r.last_outcome,
  version: r.version,
});

/** One claimed task run the worker executes as the agent through the MCP admission path. */
export interface AgentTaskClaim {
  readonly runRef: string;
  readonly taskRef: string;
  readonly agentRef: string;
  readonly operation: string;
  readonly arguments: Record<string, unknown>;
  readonly correlationId: string;
}
/** The MCP tool path the worker uses for scheduled runs (consent, budgets and authorization). */
export interface AgentToolInvoker {
  /** The MCP deployment (resource identifier) the invoker admits calls on. */
  readonly deployment: string;
  invoke(
    actor: ActorContext,
    operation: string,
    args: Record<string, unknown>,
  ): Promise<{ readonly ok: boolean; readonly code: string }>;
}

/** An access record in the audit stream (copied to agent_audit_events for an agent actor); no outbox. */
async function recordAccess(
  tx: TenantTransaction,
  operation: string,
  resourceType: string,
  resourceRef: string,
  resourceVersion: number,
): Promise<void> {
  const { ctx } = tx;
  await tx.query(
    `INSERT INTO cuspatlas.audit_events (event_ref, event_version, tenant_id, actor_id, principal, operation,
       resource_type, resource_ref, resource_version, correlation_id, trace_id, span_id, occurred_at)
     VALUES ($1, 1, cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $2, $3, $4, $5, $6, $7, $8, $9,
       clock_timestamp())`,
    [
      randomUUID(),
      ctx.principal,
      operation,
      resourceType,
      resourceRef,
      resourceVersion,
      ctx.correlationId,
      ctx.correlationId.replaceAll('-', ''),
      randomBytes(8).toString('hex'),
    ],
  );
}

export function createAgentWorkspace(base: AgentBase) {
  const { deps, execute } = base;
  const pepper = deps.matchKeyPepper;

  /** The agent a call targets: an agent itself, or the agentRef a human names. */
  function targetOf(ctx: ActorContext, agentRef: string | undefined): string {
    if (ctx.agent) {
      if (agentRef !== undefined && agentRef !== ctx.actorId) throw notFound();
      return ctx.actorId;
    }
    if (agentRef === undefined) throw failed('agent_ref_required', '/agentRef');
    return agentRef;
  }
  /** Reach rule: the agent itself, its current sponsor, or a human holding agents.manage; else 404. */
  async function assertReach(tx: TenantTransaction, ctx: ActorContext, agentRef: string): Promise<void> {
    if (ctx.agent) {
      if (agentRef !== ctx.actorId) throw notFound();
      return;
    }
    if (ctx.principal !== 'human') throw forbidden('principal_kind_denied');
    const r = (
      await tx.query<{ sponsor_ref: string }>(
        `SELECT s.sponsor_ref FROM cuspatlas.agent_principals a
         JOIN cuspatlas.agent_sponsorships s ON s.id = a.sponsorship_ref WHERE a.principal_id = $1`,
        [agentRef],
      )
    ).rows[0];
    if (!r || (r.sponsor_ref !== ctx.actorId && !ctx.scopes.includes('agents.manage'))) throw notFound();
  }
  const requireAgent = (ctx: ActorContext) => {
    if (!ctx.agent) throw forbidden('principal_kind_denied');
  };
  const at = async (tx: TenantTransaction) =>
    (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();

  /** Paged list of one agent's rows (OR-01 envelope). */
  async function pageOf<R extends Record<string, unknown>, T>(
    ctx: ActorContext,
    tx: TenantTransaction,
    q: { limit?: number; cursor?: string },
    sql: { count: string; rows: string; params: unknown[] },
    filters: Record<string, unknown>,
    ordering: { key: string; direction: 'asc' | 'desc'; tieBreak: string },
    locationRefs: readonly string[] | null,
    map: (r: R) => T,
  ) {
    const pg = base.page(ctx, q);
    const total = Number((await tx.query<{ n: string }>(sql.count, sql.params)).rows[0]?.n ?? 0);
    const n = sql.params.length;
    const { rows } = await tx.query<R>(`${sql.rows} LIMIT $${n + 1} OFFSET $${n + 2}`, [
      ...sql.params,
      pg.limit,
      pg.offset,
    ]);
    return {
      ...listEnvelope({
        asOf: await at(tx),
        appliedFilters: filters,
        locationRefs,
        limit: pg.limit,
        nextCursor: pg.next(rows.length, total),
        ordering,
        total,
      }),
      items: rows.map(map),
    };
  }

  /**
   * Best-effort PHI screening (a heuristic, not de-identification). Closeout D5: an extra refusal layer
   * behind the default-deny structured-kind allowlist; `allTokens` matches every letter token of three
   * or more letters (not only capitalized ones) against patient family names. Text is NFKC-normalized
   * with zero-width characters removed and spacing collapsed, then
   * checked for contacts, DOB phrases, SSN/MRN-like patterns, long digit runs once separators are dropped,
   * patient refs, S4 name/birth match keys, and capitalized tokens (3+ letters) equal to a patient's
   * family name. Free-text identifiers outside these patterns can pass; the database backstop
   * (agent_memory_entries_value_screen) independently refuses contact and DOB patterns.
   */
  async function carriesPhi(
    tx: TenantTransaction,
    ctx: ActorContext,
    raw: string,
    opts: { readonly allTokens?: boolean; readonly strictGrammar?: boolean } = {},
  ): Promise<boolean> {
    const text = raw.normalize('NFKC').replace(/[​-‍⁠﻿­]/g, '').replace(/\s+/g, ' ');
    // A strict UTC instant or UUID reference (the D5 grammars) can read as a phone-like digit run; an
    // instant's date is still matched against patient birth dates and a reference against patients below.
    if ((!opts.strictGrammar && carriesContact(text)) || carriesDobPhrase(text)) return true;
    if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return true;
    if (MRN_LIKE.test(text)) return true;
    const withoutRefs = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ' ');
    if (/\d{9,}/.test(withoutRefs.replace(/[\s.()/_-]/g, ''))) return true;
    if (!pepper)
      throw new RefusalError({ code: 'service_unavailable', detail: { reason: 'phi_detector_unavailable' } });
    const keyer = createMatchKeyer(pepper, ctx.tenantId);
    const words = normalizeText(text.replace(/[^\p{L}\s'-]/gu, ' '))
      .split(' ')
      .filter((w) => w.length >= 2);
    const keys = new Set<string>();
    for (let i = 0; i + 1 < words.length; i++) {
      keys.add(keyer.key(MATCH_KEY.name, `${words[i]}|${words[i + 1]}`));
      keys.add(keyer.key(MATCH_KEY.name, `${words[i + 1]}|${words[i]}`));
    }
    for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g))
      keys.add(keyer.key(MATCH_KEY.birthDate, m[0]));
    for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
      const d = `${m[3]}-${(m[1] as string).padStart(2, '0')}-${(m[2] as string).padStart(2, '0')}`;
      keys.add(keyer.key(MATCH_KEY.birthDate, d));
    }
    const surnames = [
      ...new Set(
        [...text.matchAll(opts.allTokens ? /\p{L}[\p{L}'-]{2,}/gu : /(?<!\p{L})\p{Lu}[\p{L}'-]{2,}/gu)].map(
          (m) => normalizeText(m[0]),
        ),
      ),
    ];
    const refs = uuids(text);
    if (keys.size === 0 && refs.length === 0 && surnames.length === 0) return false;
    const hit = await tx.query(
      `SELECT 1 FROM cuspatlas.patients WHERE id = ANY ($1::uuid[]) OR match_keys && $2::text[]
         OR ((legal_name ->> 'known')::boolean AND lower(legal_name ->> 'family') = ANY ($3::text[])) LIMIT 1`,
      [refs, [...keys], surnames],
    );
    return (hit.rowCount ?? 0) > 0;
  }

  function command<D>(
    ctx: ActorContext,
    envelope: CommandEnvelope<unknown>,
    op: ActionName,
    validator: Parameters<typeof validate>[0],
    pre: (p: Record<string, unknown>) => void,
    work: (tx: TenantTransaction, p: Record<string, unknown>) => Promise<{ data: D; version: number }>,
  ): Promise<CommandResult<D>> {
    return base.guarded(ctx, op, async () => {
      await base.authorize(ctx, op);
      checkEnvelope(envelope, op);
      const p = envelope.payload;
      validate<Record<string, unknown>>(validator, p);
      pre(p);
      return deps.withTenantTransaction(ctx, (tx) => execute<D>(ctx, envelope, tx, () => work(tx, p)));
    });
  }

  return {
    // ---- Sessions ----
    listAgentSessions(ctx: ActorContext, query: unknown) {
      const op = 'agents.sessions.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        validate<{ agentRef?: string; limit?: number; cursor?: string }>(
          validateAgentSessionListQuery,
          query,
        );
        const agentRef = targetOf(ctx, query.agentRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          await assertReach(tx, ctx, agentRef);
          return pageOf<SessionRow, ReturnType<typeof presentSession>>(
            ctx,
            tx,
            query,
            {
              count: 'SELECT count(*) AS n FROM cuspatlas.agent_sessions WHERE agent_ref = $1',
              rows: `${SESSION_SELECT} WHERE s.agent_ref = $1 ORDER BY s.started_at, s.id`,
              params: [agentRef],
            },
            { agentRef },
            { key: 'startedAt', direction: 'asc', tieBreak: 'sessionRef' },
            decision.locationRefs,
            presentSession,
          );
        });
      });
    },

    readAgentSession(ctx: ActorContext, query: unknown) {
      const op = 'agents.sessions.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ sessionRef: string }>(validateAgentSessionQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const s = (await tx.query<SessionRow>(`${SESSION_SELECT} WHERE s.id = $1`, [query.sessionRef]))
            .rows[0];
          if (!s) throw notFound();
          await assertReach(tx, ctx, s.agent_ref);
          const calls = await tx.query<{
            id: string;
            operation: string;
            outcome: string;
            records: number;
            phi_fields: number;
            correlation_id: string;
            occurred_at: Date;
          }>(
            `SELECT id, operation, outcome, records, phi_fields, correlation_id, occurred_at
             FROM cuspatlas.agent_tool_calls WHERE session_ref = $1 ORDER BY occurred_at, id LIMIT 200`,
            [s.id],
          );
          const audit = await tx.query<{
            event_ref: string;
            operation: string;
            resource_type: string;
            occurred_at: Date;
          }>(
            `SELECT event_ref, operation, resource_type, occurred_at FROM cuspatlas.agent_audit_events
             WHERE agent_ref = $1 AND correlation_id = ANY ($2::uuid[]) ORDER BY occurred_at, event_ref LIMIT 200`,
            [s.agent_ref, calls.rows.map((c) => c.correlation_id)],
          );
          return {
            ...presentSession(s),
            toolCalls: calls.rows.map((c) => ({
              callRef: c.id,
              operation: c.operation,
              outcome: c.outcome,
              records: c.records,
              phiFields: c.phi_fields,
              correlationId: c.correlation_id,
              occurredAt: c.occurred_at.toISOString(),
            })),
            auditEvents: audit.rows.map((e) => ({
              eventRef: e.event_ref,
              operation: e.operation,
              resourceType: e.resource_type,
              occurredAt: e.occurred_at.toISOString(),
            })),
          };
        });
      });
    },

    endAgentSession(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'agents.sessions.end';
      return command(
        ctx,
        envelope,
        op,
        validateAgentSessionEnd,
        () => {
          if (!ctx.agent && ctx.principal !== 'human') throw forbidden('principal_kind_denied');
        },
        async (tx, p) => {
          await tx.query('SELECT 1 FROM cuspatlas.agent_sessions WHERE id = $1 FOR UPDATE', [p.sessionRef]);
          const s = (await tx.query<SessionRow>(`${SESSION_SELECT} WHERE s.id = $1`, [p.sessionRef])).rows[0];
          if (!s) throw notFound();
          await assertReach(tx, ctx, s.agent_ref);
          if (s.end_reason !== null) throw conflict('session_ended');
          const reason = ctx.agent ? 'ended_by_agent' : 'ended_by_human';
          const { rows } = await tx.query<{ ended_at: Date }>(
            `UPDATE cuspatlas.agent_sessions SET ended_at = now(), end_reason = $2, ended_by = cuspatlas.current_actor_id()
             WHERE id = $1 RETURNING ended_at`,
            [s.id, reason],
          );
          await recordCommand(
            tx,
            { operation: op, resourceType: 'agentSession', resourceRef: s.id, resourceVersion: 2 },
            { changedFields: ['endedAt', 'endReason'] },
          );
          return {
            data: {
              sessionRef: s.id,
              state: 'ended' as const,
              endedAt: (rows[0] as { ended_at: Date }).ended_at.toISOString(),
              endReason: reason,
            },
            version: 2,
          };
        },
      );
    },

    // ---- Scoped memory ----
    writeAgentMemory(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'agents.memory.write';
      return command(
        ctx,
        envelope,
        op,
        validateAgentMemoryWrite,
        () => requireAgent(ctx),
        async (tx, raw) => {
          const p = raw as {
            key: string;
            value: string;
            classification: MemoryRow['classification'];
            kind?: string;
            retentionDays?: number;
          };
          // One uniform refusal for every reason, so writes cannot probe names, DOBs or refs. The phi
          // guard trigger share-locks the policy row: a concurrent flip to off waits for this write and
          // then removes it, or commits first and the insert is refused.
          const policy = (
            await tx.query<{ phi_allowed: boolean }>(
              'SELECT phi_allowed FROM cuspatlas.agent_memory_policies',
            )
          ).rows[0];
          // Closeout D5 and its review fixes: phi needs the explicit tenant policy; anything else needs a
          // positive allowlist classification (a structured kind whose value is registered or matches a
          // bounded grammar), and the PHI heuristic stays as an extra refusal layer over the key and the
          // value. Not a proof: a short counter, a UUID or an instant can still encode an identifier.
          const kind = p.kind ?? (p.classification === 'phi' ? 'text' : null);
          // Review fix S1: every key (phi included, since keys are listed without values) is a registered
          // prefix plus a registered suffix, and the suffix is screened like a value of its kind.
          const parts = parseMemoryKey(p.key);
          if (parts === null) throw refusedValue();
          if (
            await carriesPhi(tx, ctx, parts.suffix, {
              allTokens: true,
              strictGrammar: parts.suffixKind === 'reference',
            })
          )
            throw refusedValue();
          if (p.classification === 'phi') {
            if (!policy?.phi_allowed) throw refusedValue();
          } else {
            if (kind === null || !memoryValueMatches(kind, p.value)) throw refusedValue();
            // An instant is not earlier than the tenant's creation, so a birth date before it is refused.
            if (kind === 'instant') {
              const t = (
                await tx.query<{ created_at: Date }>(
                  'SELECT created_at FROM cuspatlas.tenants WHERE id = cuspatlas.current_tenant_id()',
                )
              ).rows[0];
              if (!t || !memoryInstantFloorOk(p.value, t.created_at)) throw refusedValue();
            }
            if (
              await carriesPhi(tx, ctx, p.value, {
                allTokens: true,
                strictGrammar: kind === 'instant' || kind === 'reference',
              })
            )
              throw refusedValue();
          }
          await tx.query(
            'DELETE FROM cuspatlas.agent_memory_entries WHERE agent_ref = $1 AND expires_at <= now()',
            [ctx.actorId],
          );
          const days = p.retentionDays ?? MEMORY_RETENTION_DAYS;
          let row: { id: string; version: number; expires_at: Date } | undefined;
          try {
            row = (
              await tx.query<{ id: string; version: number; expires_at: Date }>(
                `INSERT INTO cuspatlas.agent_memory_entries (tenant_id, agent_ref, key, value, classification, expires_at,
                   value_kind)
                 VALUES (cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $1, $2, $3, now() + make_interval(days => $4), $5)
                 ON CONFLICT (agent_ref, key) DO UPDATE SET value = EXCLUDED.value, value_kind = EXCLUDED.value_kind,
                   classification = EXCLUDED.classification, updated_at = now(), expires_at = EXCLUDED.expires_at,
                   version = cuspatlas.agent_memory_entries.version + 1
                 RETURNING id, version, expires_at`,
                [p.key, p.value, p.classification, days, kind],
              )
            ).rows[0];
          } catch (err) {
            if (pgCode(err) === 'P0422' || pgCode(err) === '23514') throw refusedValue();
            throw err;
          }
          if (!row) throw new Error('memory write returned no row');
          await recordCommand(
            tx,
            { operation: op, resourceType: 'agentMemory', resourceRef: row.id, resourceVersion: row.version },
            { changedFields: ['value', 'classification', 'expiresAt'] },
          );
          return {
            data: {
              memoryRef: row.id,
              agentRef: ctx.actorId,
              key: p.key,
              state: 'stored' as const,
              classification: p.classification,
              kind,
              expiresAt: row.expires_at.toISOString(),
            },
            version: row.version,
          };
        },
      );
    },

    readAgentMemory(ctx: ActorContext, query: unknown) {
      const op = 'agents.memory.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ agentRef?: string; key: string }>(validateAgentMemoryQuery, query);
        const agentRef = targetOf(ctx, query.agentRef);
        const read = await deps.withTenantTransaction(ctx, async (tx) => {
          await assertReach(tx, ctx, agentRef);
          const row = (
            await tx.query<MemoryRow>(
              `SELECT * FROM cuspatlas.agent_memory_entries WHERE agent_ref = $1 AND key = $2 AND expires_at > now()`,
              [agentRef, query.key],
            )
          ).rows[0];
          if (!row) throw notFound();
          if (row.classification === 'phi') {
            // Re-check the policy: a phi value is never returned while the tenant policy denies PHI.
            const policy = (
              await tx.query<{ phi_allowed: boolean }>(
                'SELECT phi_allowed FROM cuspatlas.agent_memory_policies',
              )
            ).rows[0];
            if (!policy?.phi_allowed) {
              if (ctx.agent) await recordAccess(tx, op, 'agentMemoryReadRefused', row.id, row.version);
              else {
                await recordSensitiveRead(tx, {
                  operation: op,
                  resourceType: 'agentMemoryReadRefused',
                  resourceRefs: [row.id],
                  queryFields: ['agentRef', 'key'],
                });
              }
              return null;
            }
          }
          if (ctx.agent) {
            // The agent-audit stream gets one row per read (resource version = the read count).
            const n = (
              await tx.query<{ read_count: number }>(
                'UPDATE cuspatlas.agent_memory_entries SET read_count = read_count + 1 WHERE id = $1 RETURNING read_count',
                [row.id],
              )
            ).rows[0]?.read_count as number;
            await recordAccess(tx, op, 'agentMemoryRead', row.id, n);
          } else {
            await recordSensitiveRead(tx, {
              operation: op,
              resourceType: 'agentMemory',
              resourceRefs: [row.id],
              queryFields: ['agentRef', 'key'],
            });
          }
          return presentMemory(row, true);
        });
        // Refused after the commit, so the refusal's audit row is kept (the read count is not bumped).
        if (read === null)
          throw new RefusalError({ code: 'forbidden', detail: { reason: 'phi_not_permitted' } });
        return read;
      });
    },

    listAgentMemory(ctx: ActorContext, query: unknown) {
      const op = 'agents.memory.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        validate<{ agentRef?: string; limit?: number; cursor?: string }>(validateAgentMemoryListQuery, query);
        const agentRef = targetOf(ctx, query.agentRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          await assertReach(tx, ctx, agentRef);
          if (ctx.agent) {
            await tx.query(
              'DELETE FROM cuspatlas.agent_memory_entries WHERE agent_ref = $1 AND expires_at <= now()',
              [agentRef],
            );
          }
          const policy = (
            await tx.query<{ phi_allowed: boolean }>(
              'SELECT phi_allowed FROM cuspatlas.agent_memory_policies',
            )
          ).rows[0];
          const listed = await pageOf<MemoryRow, ReturnType<typeof presentMemory>>(
            ctx,
            tx,
            query,
            {
              count:
                'SELECT count(*) AS n FROM cuspatlas.agent_memory_entries WHERE agent_ref = $1 AND expires_at > now()',
              rows: `SELECT * FROM cuspatlas.agent_memory_entries WHERE agent_ref = $1 AND expires_at > now()
                     ORDER BY created_at, id`,
              params: [agentRef],
            },
            { agentRef },
            { key: 'createdAt', direction: 'asc', tieBreak: 'memoryRef' },
            decision.locationRefs,
            (r) => presentMemory(r, false),
          );
          return { ...listed, phiPolicy: { phiAllowed: policy?.phi_allowed === true } };
        });
      });
    },

    deleteAgentMemory(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'agents.memory.delete';
      return command(
        ctx,
        envelope,
        op,
        validateAgentMemoryDelete,
        () => undefined,
        async (tx, raw) => {
          const p = raw as { agentRef: string; key: string };
          await assertReach(tx, ctx, p.agentRef);
          const row = (
            await tx.query<{ id: string; version: number }>(
              'DELETE FROM cuspatlas.agent_memory_entries WHERE agent_ref = $1 AND key = $2 RETURNING id, version',
              [p.agentRef, p.key],
            )
          ).rows[0];
          if (!row) throw notFound();
          await recordCommand(
            tx,
            {
              operation: op,
              resourceType: 'agentMemory',
              resourceRef: row.id,
              resourceVersion: row.version + 1,
            },
            { changedFields: ['value'] },
          );
          return {
            data: { memoryRef: row.id, agentRef: p.agentRef, key: p.key, state: 'deleted' as const },
            version: row.version + 1,
          };
        },
      );
    },

    setAgentMemoryPolicy(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'agents.memory.policy.set';
      return command(
        ctx,
        envelope,
        op,
        validateAgentMemoryPolicySet,
        () => undefined,
        async (tx, raw) => {
          const p = raw as { phiAllowed: boolean };
          const { rows } = await tx.query<{ version: number }>(
            `INSERT INTO cuspatlas.agent_memory_policies (tenant_id, phi_allowed, set_by)
             VALUES (cuspatlas.current_tenant_id(), $1, cuspatlas.current_actor_id())
             ON CONFLICT (tenant_id) DO UPDATE SET phi_allowed = EXCLUDED.phi_allowed, set_by = EXCLUDED.set_by,
               set_at = now(), version = cuspatlas.agent_memory_policies.version + 1
             RETURNING version`,
            [p.phiAllowed],
          );
          const version = rows[0]?.version as number;
          await recordCommand(
            tx,
            {
              operation: op,
              resourceType: 'agentMemoryPolicy',
              resourceRef: ctx.tenantId,
              resourceVersion: version,
            },
            { changedFields: ['phiAllowed'] },
          );
          return { data: { phiAllowed: p.phiAllowed }, version };
        },
      );
    },

    // ---- Standing task policies ----
    recordAgentTaskPolicy(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'agents.taskPolicies.record';
      return command(
        ctx,
        envelope,
        op,
        validateAgentTaskPolicyRecord,
        (raw) => {
          const expires = Date.parse(raw.expiresAt as string);
          if (!Number.isFinite(expires) || expires <= Date.now())
            throw failed('expiry_not_future', '/expiresAt');
          if (expires > Date.now() + 90 * 86_400_000) throw failed('expiry_beyond_maximum', '/expiresAt');
        },
        async (tx, raw) => {
          const p = raw as {
            agentRef: string;
            deployment: string;
            operations: string[];
            minIntervalSeconds: number;
            maxRunsPerDay: number;
            expiresAt: string;
          };
          const agent = (
            await tx.query<{ scope_set: string[]; state: string; expires_at: Date }>(
              'SELECT scope_set, state, expires_at FROM cuspatlas.agent_principals WHERE principal_id = $1',
              [p.agentRef],
            )
          ).rows[0];
          if (!agent) throw notFound();
          if (agent.state === 'revoked') throw conflict('agent_revoked');
          if (Date.parse(p.expiresAt) > agent.expires_at.getTime())
            throw failed('policy_outlives_agent', '/expiresAt');
          p.operations.forEach((name, i) => {
            const o = CATALOG_INDEX.get(name);
            const permitted =
              o !== undefined &&
              o.transports.includes('mcp') &&
              o.principals.includes('service') &&
              (o.kind === 'query' || TASK_PREPARE_OPERATIONS.has(name)) &&
              (o.scope === null || agent.scope_set.includes(o.scope));
            if (!permitted) throw failed('task_operation_not_permitted', `/operations/${i}`);
          });
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO cuspatlas.agent_task_policies (tenant_id, agent_ref, owner_ref, deployment, operations,
               min_interval_seconds, max_runs_per_day, expires_at)
             VALUES (cuspatlas.current_tenant_id(), $1, cuspatlas.current_actor_id(), $2, $3, $4, $5, $6) RETURNING id`,
            [p.agentRef, p.deployment, p.operations, p.minIntervalSeconds, p.maxRunsPerDay, p.expiresAt],
          );
          const policyRef = rows[0]?.id as string;
          await recordCommand(
            tx,
            { operation: op, resourceType: 'agentTaskPolicy', resourceRef: policyRef, resourceVersion: 1 },
            { changedFields: ['operations', 'limits', 'expiresAt'] },
          );
          return {
            data: {
              policyRef,
              agentRef: p.agentRef,
              state: 'active' as const,
              expiresAt: new Date(p.expiresAt).toISOString(),
            },
            version: 1,
          };
        },
      );
    },

    revokeAgentTaskPolicy(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'agents.taskPolicies.revoke';
      return command(
        ctx,
        envelope,
        op,
        validateAgentTaskPolicyRevoke,
        () => undefined,
        async (tx, raw) => {
          const p = raw as { policyRef: string; expectedVersion: number };
          const cur = (await tx.query<PolicyRow>(`${POLICY_SELECT} WHERE id = $1 FOR UPDATE`, [p.policyRef]))
            .rows[0];
          if (!cur) throw notFound();
          if (cur.version !== p.expectedVersion) throw stale(cur.version);
          if (cur.state === 'revoked') throw conflict('policy_revoked');
          await tx.query(
            `UPDATE cuspatlas.agent_task_policies SET state = 'revoked', revoked_at = now(),
               revoked_by = cuspatlas.current_actor_id(), version = version + 1 WHERE id = $1`,
            [cur.id],
          );
          await recordCommand(
            tx,
            {
              operation: op,
              resourceType: 'agentTaskPolicy',
              resourceRef: cur.id,
              resourceVersion: cur.version + 1,
            },
            { changedFields: ['state'] },
          );
          return {
            data: {
              policyRef: cur.id,
              agentRef: cur.agent_ref,
              state: 'revoked' as const,
              expiresAt: cur.expires_at.toISOString(),
            },
            version: cur.version + 1,
          };
        },
      );
    },

    listAgentTaskPolicies(ctx: ActorContext, query: unknown) {
      const op = 'agents.taskPolicies.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        validate<{ agentRef?: string; limit?: number; cursor?: string }>(
          validateAgentTaskPolicyListQuery,
          query,
        );
        const agentRef = targetOf(ctx, query.agentRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          await assertReach(tx, ctx, agentRef);
          return pageOf<PolicyRow, ReturnType<typeof presentPolicy>>(
            ctx,
            tx,
            query,
            {
              count: 'SELECT count(*) AS n FROM cuspatlas.agent_task_policies WHERE agent_ref = $1',
              rows: `${POLICY_SELECT} WHERE agent_ref = $1 ORDER BY created_at, id`,
              params: [agentRef],
            },
            { agentRef },
            { key: 'createdAt', direction: 'asc', tieBreak: 'policyRef' },
            decision.locationRefs,
            presentPolicy,
          );
        });
      });
    },

    // ---- Scheduled tasks ----
    scheduleAgentTask(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'agents.tasks.schedule';
      return command(
        ctx,
        envelope,
        op,
        validateAgentTaskSchedule,
        (raw) => {
          requireAgent(ctx);
          const entry = CATALOG_INDEX.get(raw.operation as string);
          // A human-only operation is a policy refusal whatever any standing policy says.
          if (entry && !entry.principals.includes('service')) throw forbidden('principal_kind_denied');
          if (raw.firstRunAt !== undefined && !(Date.parse(raw.firstRunAt as string) > Date.now())) {
            throw failed('first_run_not_future', '/firstRunAt');
          }
        },
        async (tx, raw) => {
          const p = raw as {
            policyRef: string;
            operation: string;
            arguments: Record<string, unknown>;
            intervalSeconds: number;
            firstRunAt?: string;
          };
          const pol = (
            await tx.query<PolicyRow>(`${POLICY_SELECT} WHERE id = $1 AND agent_ref = $2`, [
              p.policyRef,
              ctx.actorId,
            ])
          ).rows[0];
          if (!pol) throw notFound();
          if (!pol.live) throw conflict('policy_not_live');
          if (!pol.operations.includes(p.operation))
            throw failed('task_operation_not_in_policy', '/operation');
          if (p.intervalSeconds < pol.min_interval_seconds) {
            throw failed('interval_below_policy_minimum', '/intervalSeconds');
          }
          const { rows } = await tx.query<{ id: string; next_run_at: Date }>(
            `INSERT INTO cuspatlas.agent_scheduled_tasks (tenant_id, agent_ref, policy_ref, operation, arguments,
               interval_seconds, next_run_at)
             VALUES (cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $1, $2, $3::jsonb, $4::int,
               coalesce($5::timestamptz, now() + make_interval(secs => $4::int)))
             RETURNING id, next_run_at`,
            [pol.id, p.operation, JSON.stringify(p.arguments), p.intervalSeconds, p.firstRunAt ?? null],
          );
          const row = rows[0] as { id: string; next_run_at: Date };
          await recordCommand(
            tx,
            { operation: op, resourceType: 'agentScheduledTask', resourceRef: row.id, resourceVersion: 1 },
            { changedFields: ['operation', 'arguments', 'intervalSeconds', 'nextRunAt'] },
          );
          return {
            data: {
              taskRef: row.id,
              agentRef: ctx.actorId,
              state: 'active' as const,
              nextRunAt: row.next_run_at.toISOString(),
            },
            version: 1,
          };
        },
      );
    },

    cancelAgentTask(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'agents.tasks.cancel';
      return command(
        ctx,
        envelope,
        op,
        validateAgentTaskCancel,
        () => {
          if (!ctx.agent && ctx.principal !== 'human') throw forbidden('principal_kind_denied');
        },
        async (tx, raw) => {
          const p = raw as { taskRef: string; expectedVersion: number };
          const t = (
            await tx.query<TaskRow>(
              'SELECT * FROM cuspatlas.agent_scheduled_tasks WHERE id = $1 FOR UPDATE',
              [p.taskRef],
            )
          ).rows[0];
          if (!t) throw notFound();
          await assertReach(tx, ctx, t.agent_ref);
          if (t.version !== p.expectedVersion) throw stale(t.version);
          if (t.state !== 'active') throw conflict('task_not_active');
          await tx.query(
            `UPDATE cuspatlas.agent_scheduled_tasks SET state = 'cancelled', version = version + 1 WHERE id = $1`,
            [t.id],
          );
          await recordCommand(
            tx,
            {
              operation: op,
              resourceType: 'agentScheduledTask',
              resourceRef: t.id,
              resourceVersion: t.version + 1,
            },
            { changedFields: ['state'] },
          );
          return {
            data: {
              taskRef: t.id,
              agentRef: t.agent_ref,
              state: 'cancelled' as const,
              nextRunAt: t.next_run_at.toISOString(),
            },
            version: t.version + 1,
          };
        },
      );
    },

    listAgentTasks(ctx: ActorContext, query: unknown) {
      const op = 'agents.tasks.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        validate<{ agentRef?: string; limit?: number; cursor?: string }>(validateAgentTaskListQuery, query);
        const agentRef = targetOf(ctx, query.agentRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          await assertReach(tx, ctx, agentRef);
          return pageOf<TaskRow, ReturnType<typeof presentTask>>(
            ctx,
            tx,
            query,
            {
              count: 'SELECT count(*) AS n FROM cuspatlas.agent_scheduled_tasks WHERE agent_ref = $1',
              rows: 'SELECT * FROM cuspatlas.agent_scheduled_tasks WHERE agent_ref = $1 ORDER BY created_at, id',
              params: [agentRef],
            },
            { agentRef },
            { key: 'createdAt', direction: 'asc', tieBreak: 'taskRef' },
            decision.locationRefs,
            presentTask,
          );
        });
      });
    },

    listAgentTaskRuns(ctx: ActorContext, query: unknown) {
      const op = 'agents.tasks.runs.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        validate<{ taskRef: string; limit?: number; cursor?: string }>(validateAgentTaskRunListQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const t = (
            await tx.query<{ agent_ref: string }>(
              'SELECT agent_ref FROM cuspatlas.agent_scheduled_tasks WHERE id = $1',
              [query.taskRef],
            )
          ).rows[0];
          if (!t) throw notFound();
          await assertReach(tx, ctx, t.agent_ref);
          return pageOf<
            {
              id: string;
              task_ref: string;
              started_at: Date;
              finished_at: Date | null;
              outcome: string | null;
              correlation_id: string;
            },
            unknown
          >(
            ctx,
            tx,
            query,
            {
              count: 'SELECT count(*) AS n FROM cuspatlas.agent_task_runs WHERE task_ref = $1',
              rows: `SELECT id, task_ref, started_at, finished_at, outcome, correlation_id
                     FROM cuspatlas.agent_task_runs WHERE task_ref = $1 ORDER BY started_at, id`,
              params: [query.taskRef],
            },
            { taskRef: query.taskRef },
            { key: 'startedAt', direction: 'asc', tieBreak: 'runRef' },
            decision.locationRefs,
            (r) => ({
              runRef: r.id,
              taskRef: r.task_ref,
              startedAt: r.started_at.toISOString(),
              finishedAt: iso(r.finished_at),
              outcome: r.outcome,
              correlationId: r.correlation_id,
            }),
          );
        });
      });
    },

    // ---- Worker (its own principal; never an MCP or REST operation) ----
    /**
     * Claims the due tasks of one deployment in the caller's tenant, rechecking the standing policy and
     * the agent at execution: a revoked or expired policy, an operation the policy no longer names, a
     * revoked or expired agent, a policy owner who is no longer a live member holding agents.manage or
     * sponsoring the agent, or a revoked consent stops the task (recorded as a finished run). Over the policy's daily
     * run limit the run is skipped and recorded. Each claim advances next_run_at by the interval.
     */
    claimDueAgentTasks(ctx: ActorContext, deployment: string, limit = 20) {
      const op = 'agents.tasks.dispatch';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<
            TaskRow & {
              p_state: string;
              p_expired: boolean;
              operations: string[];
              max_runs_per_day: number;
              runs_today: number;
              a_live: boolean;
              owner_live: boolean;
              consent_live: boolean;
            }
          >(
            `SELECT t.*, p.state AS p_state, p.expires_at <= now() AS p_expired, p.operations, p.max_runs_per_day,
               (SELECT count(*)::int FROM cuspatlas.agent_task_runs r
                  WHERE r.task_ref = t.id AND r.started_at > now() - interval '1 day') AS runs_today,
               (a.state <> 'revoked' AND a.expires_at > now()) AS a_live,
               cuspatlas.agent_task_owner_live(p.owner_ref, t.agent_ref) AS owner_live,
               cuspatlas.agent_task_consent_live(t.agent_ref, p.deployment) AS consent_live
             FROM cuspatlas.agent_scheduled_tasks t
             JOIN cuspatlas.agent_task_policies p ON p.id = t.policy_ref
             JOIN cuspatlas.agent_principals a ON a.principal_id = t.agent_ref
             WHERE t.state = 'active' AND t.next_run_at <= now() AND p.deployment = $1
             ORDER BY t.next_run_at, t.id LIMIT $2 FOR UPDATE OF t SKIP LOCKED`,
            [deployment, limit],
          );
          const claims: AgentTaskClaim[] = [];
          const settled: { taskRef: string; outcome: string }[] = [];
          for (const t of rows) {
            const correlationId = randomUUID();
            const stop =
              t.p_state === 'revoked'
                ? 'policy_revoked'
                : t.p_expired
                  ? 'policy_expired'
                  : !t.operations.includes(t.operation)
                    ? 'operation_not_in_policy'
                    : !t.a_live
                      ? 'agent_inactive'
                      : !t.owner_live
                        ? 'policy_owner_inactive'
                        : !t.consent_live
                          ? 'consent_revoked'
                          : null;
            const skip = stop === null && t.runs_today >= t.max_runs_per_day ? 'run_limit_reached' : null;
            const finished = stop ?? skip;
            const run = (
              await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.agent_task_runs (tenant_id, task_ref, agent_ref, correlation_id, finished_at, outcome)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, CASE WHEN $4::text IS NULL THEN NULL ELSE clock_timestamp() END, $4)
                 RETURNING id`,
                [t.id, t.agent_ref, correlationId, finished],
              )
            ).rows[0] as { id: string };
            if (stop) {
              await tx.query(
                `UPDATE cuspatlas.agent_scheduled_tasks SET state = 'stopped', stop_reason = $2, last_run_at = now(),
                   last_outcome = $2, version = version + 1 WHERE id = $1`,
                [t.id, stop],
              );
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: 'agentScheduledTask',
                  resourceRef: t.id,
                  resourceVersion: t.version + 1,
                },
                { changedFields: ['state', 'stopReason'] },
              );
            } else {
              await tx.query(
                `UPDATE cuspatlas.agent_scheduled_tasks SET next_run_at = now() + make_interval(secs => interval_seconds),
                   last_run_at = now(), last_outcome = $2 WHERE id = $1`,
                [t.id, skip],
              );
            }
            if (finished) settled.push({ taskRef: t.id, outcome: finished });
            else
              claims.push({
                runRef: run.id,
                taskRef: t.id,
                agentRef: t.agent_ref,
                operation: t.operation,
                arguments: t.arguments,
                correlationId,
              });
          }
          return { claims, settled };
        });
      });
    },

    /** Records the outcome of a claimed run (the refusal code of the MCP gate, or ok). */
    finishAgentTaskRun(ctx: ActorContext, runRef: string, outcome: string) {
      const op = 'agents.tasks.dispatch';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        const code = /^[a-z_]{1,64}$/.test(outcome) ? outcome : 'failed';
        await deps.withTenantTransaction(ctx, async (tx) => {
          const r = await tx.query<{ task_ref: string }>(
            `UPDATE cuspatlas.agent_task_runs SET finished_at = clock_timestamp(), outcome = $2
             WHERE id = $1 AND finished_at IS NULL RETURNING task_ref`,
            [runRef, code],
          );
          const taskRef = r.rows[0]?.task_ref;
          if (taskRef) {
            await tx.query('UPDATE cuspatlas.agent_scheduled_tasks SET last_outcome = $2 WHERE id = $1', [
              taskRef,
              code,
            ]);
          }
        });
      });
    },
  };
}
