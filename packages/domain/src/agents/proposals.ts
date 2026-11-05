import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  CommitThenRefuse,
  isRefusalError,
  listEnvelope,
  type MembershipRecord,
  RefusalError,
  type TenantTransaction,
  validateActionAbandon,
  validateActionApprove,
  validateActionCommit,
  validateActionListQuery,
  validateActionPrepare,
  validateActionQuery,
} from '@cuspatlas/contracts';
import type { BillingService } from '../billing/service';
import { transactionNow } from '../clock';
import { payloadDigest } from '../commands/digest';
import type { EngagementService } from '../engagement/service';
import { recordCommand } from '../events/record-command';
import type { PatientService } from '../patients/service';
import { ACTION_POLICIES, type ActionName, membershipAllows, proposerAllows } from '../policy/authorize';
import { type AgentBase, checkEnvelope, conflict, notFound, stale, validate } from './base';

/**
 * A10 prepare/commit generalized to the catalog operations whose approval mode is `proposal` (A-D4,
 * pending approval). A proposal binds the operation, the payload and its canonical digest, the affected
 * resource versions, the policy version, the proposer (and an agent's sponsor of record) and an expiry.
 * Approval: a human holding actions.approve and authorized for the operation, never the proposer and
 * never the agent proposer's sponsor (self-approval by proxy). Commit: a human; the proposer's and
 * approver's live memberships, the digest, the expiry, the policy version and the resource versions
 * are rechecked, then the owning command runs as the committing human with the proposal id as its
 * idempotency key (one effect however many commits). Any permanent mismatch closes the proposal.
 */
export const ACTION_PROPOSAL_POLICY_VERSION = 'actions.1';
/** A-D4 (open): proposal lifetime. Recommended one hour. */
export const ACTION_PROPOSAL_TTL_SECONDS = 3600;
export const PROPOSAL_RESOURCE = 'operationProposal';

export interface ProposalOwners {
  readonly patients?: PatientService;
  readonly engagement?: EngagementService;
  readonly billing?: BillingService;
}

type Bound = { kind: string; ref: string; version: number };
interface ElevatedSpec {
  readonly pathRef: string | null;
  readonly resourceType: string;
  bind(tx: TenantTransaction, payload: Record<string, unknown>): Promise<Bound[]>;
  run(
    o: ProposalOwners,
    ctx: ActorContext,
    ref: string,
    env: CommandEnvelope<unknown>,
  ): Promise<CommandResult<unknown>>;
}

const unavailable = () =>
  new RefusalError({
    code: 'service_unavailable',
    retryable: false,
    detail: { reason: 'owner_not_configured' },
  });
function need<T>(x: T | undefined): T {
  if (x === undefined) throw unavailable();
  return x;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function patientBind(field: string) {
  return async (tx: TenantTransaction, payload: Record<string, unknown>): Promise<Bound[]> => {
    const ref = payload[field];
    if (typeof ref !== 'string' || !UUID.test(ref)) throw notFound();
    const row = (
      await tx.query<{ version: number }>('SELECT version FROM cuspatlas.patients WHERE id = $1', [ref])
    ).rows[0];
    if (!row) throw notFound();
    return [{ kind: 'patient', ref, version: row.version }];
  };
}

/** The approval: proposal registry. The catalog marks exactly these operations `approval: proposal`. */
export const ELEVATED_OPERATIONS: Readonly<Record<string, ElevatedSpec>> = {
  'patients.relationships.add': {
    pathRef: 'patientRef',
    resourceType: 'patientRelationship',
    bind: patientBind('patientRef'),
    run: (o, ctx, ref, env) =>
      need(o.patients).addRelationship(ctx, ref, env) as Promise<CommandResult<unknown>>,
  },
  'communications.consents.record': {
    pathRef: 'patientRef',
    resourceType: 'consentFact',
    bind: patientBind('patientRef'),
    run: (o, ctx, ref, env) =>
      need(o.engagement).recordConsent(ctx, ref, env) as Promise<CommandResult<unknown>>,
  },
  'portal.principals.enroll': {
    pathRef: null,
    resourceType: 'portalPrincipal',
    bind: patientBind('personRef'),
    run: (o, ctx, _ref, env) =>
      need(o.engagement).enrollPortalPrincipal(ctx, env) as Promise<CommandResult<unknown>>,
  },
  'billing.plans.authorize': {
    pathRef: 'planRef',
    resourceType: 'paymentPlan',
    async bind(tx, payload) {
      const ref = payload.planRef;
      const version = payload.expectedVersion;
      if (typeof ref !== 'string' || !UUID.test(ref)) throw notFound();
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        throw new RefusalError({ code: 'invalid_request' });
      }
      // H3: bind the LIVE plan version (not only the payload's claim): prepare refuses a stale claim,
      // and commit compares the live version with the one bound at prepare.
      const row = (
        await tx.query<{ version: number }>(
          'SELECT version FROM cuspatlas.billing_payment_plans WHERE id = $1',
          [ref],
        )
      ).rows[0];
      if (!row) throw notFound();
      if (row.version !== version) throw stale(row.version);
      return [{ kind: 'paymentPlan', ref, version: row.version }];
    },
    run: (o, ctx, ref, env) =>
      need(o.billing).authorizePlan(ctx, ref, env) as Promise<CommandResult<unknown>>,
  },
};
export const ELEVATED_OPERATION_NAMES: ReadonlySet<string> = new Set(Object.keys(ELEVATED_OPERATIONS));

interface Row extends Record<string, unknown> {
  id: string;
  operation: ActionName;
  payload: Record<string, unknown>;
  payload_digest: string;
  resource_versions: Bound[];
  policy_version: string;
  proposer_id: string;
  proposer_kind: 'human' | 'service';
  sponsor_id: string | null;
  state: 'prepared' | 'approved' | 'committing' | 'committed' | 'rejected' | 'expired' | 'abandoned';
  approver_id: string | null;
  committer_id: string | null;
  result_type: string | null;
  result_ref: string | null;
  result_version: number | null;
  disposition_reason: string | null;
  expires_at: Date;
  expired: boolean;
  version: number;
}
const SELECT = 'SELECT *, expires_at <= now() AS expired FROM cuspatlas.operation_proposals';

const present = (r: Row) => ({
  proposalRef: r.id,
  operation: r.operation,
  state: r.state === 'committing' ? ('approved' as const) : r.state,
  payloadDigest: r.payload_digest,
  policyVersion: r.policy_version,
  expiresAt: r.expires_at.toISOString(),
  proposerRef: r.proposer_id,
  proposerKind: r.proposer_kind,
  sponsorRef: r.sponsor_id,
  approverRef: r.approver_id,
  resourceVersions: r.resource_versions,
  result: r.result_ref === null ? null : { kind: r.result_type ?? 'resource', ref: r.result_ref },
  dispositionReason: r.disposition_reason,
  version: r.version,
});
type Presented = ReturnType<typeof present>;

const REFUSAL_FOR: Record<string, () => RefusalError> = {
  expired: () => new RefusalError({ code: 'proposal_expired', reasonCode: 'proposal_expired' }),
  payload_mismatch: () => new RefusalError({ code: 'payload_mismatch', reasonCode: 'payload_mismatch' }),
  policy_changed: () => new RefusalError({ code: 'policy_changed', reasonCode: 'policy_changed' }),
  stale_version: () => new RefusalError({ code: 'stale_version', reasonCode: 'stale_version' }),
  proposer_unauthorized: () =>
    new RefusalError({ code: 'approval_invalid', reasonCode: 'proposer_unauthorized' }),
  approver_unauthorized: () =>
    new RefusalError({ code: 'approval_invalid', reasonCode: 'approver_unauthorized' }),
};
const refusalFor = (reason: string | null): RefusalError =>
  (reason === null ? undefined : REFUSAL_FOR[reason]?.()) ??
  new RefusalError({ code: 'approval_invalid', reasonCode: 'approval_invalid' });

const firstRef = (data: unknown): string | null => {
  if (data === null || typeof data !== 'object') return null;
  for (const [k, v] of Object.entries(data))
    if (k.endsWith('Ref') && typeof v === 'string' && UUID.test(v)) return v;
  return null;
};

export function createActionProposals(base: AgentBase, owners: ProposalOwners) {
  const { deps, execute } = base;
  const load = async (tx: TenantTransaction, ref: string, lock: boolean) =>
    (await tx.query<Row>(`${SELECT} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [ref])).rows[0];
  const audit = (tx: TenantTransaction, op: string, r: { id: string }, version: number, field: string) =>
    recordCommand(
      tx,
      { operation: op, resourceType: PROPOSAL_RESOURCE, resourceRef: r.id, resourceVersion: version },
      {
        changedFields: [field],
      },
    );
  /** Closes the proposal with a reason, commits that, then surfaces the refusal. */
  async function close(
    tx: TenantTransaction,
    p: Row,
    state: 'rejected' | 'expired',
    reason: string,
  ): Promise<never> {
    await tx.query(
      `UPDATE cuspatlas.operation_proposals SET state = $2, disposition_reason = $3, version = version + 1,
         updated_at = now() WHERE id = $1`,
      [p.id, state, reason],
    );
    await audit(tx, 'actions.proposals.commit', p, p.version + 1, 'state');
    throw new CommitThenRefuse(refusalFor(reason));
  }
  async function membership(principal: string, tenant: string): Promise<MembershipRecord | null> {
    if (!deps.memberships) throw unavailable();
    return deps.memberships.load(principal, tenant);
  }
  const replayOf =
    (ctx: ActorContext) =>
    async (ref: string, version: number): Promise<CommandResult<Presented>> => {
      const row = await deps.withTenantTransaction(ctx, (tx) => load(tx, ref, false));
      if (!row) throw notFound();
      return { data: present(row), version, correlationId: ctx.correlationId, replayed: true };
    };
  /** executeOnce stores only the reference; a replay re-reads the proposal. */
  async function once(
    ctx: ActorContext,
    envelope: CommandEnvelope<unknown>,
    work: (tx: TenantTransaction) => Promise<{ row: Row; version: number }>,
  ): Promise<CommandResult<Presented>> {
    const r = await deps.withTenantTransaction(ctx, (tx) =>
      execute<{ proposalRef: string }>(ctx, envelope, tx, async () => {
        const { row, version } = await work(tx);
        return { data: { proposalRef: row.id }, version };
      }),
    );
    return replayOf(ctx)(r.data.proposalRef, r.version).then((x) => ({ ...x, replayed: r.replayed }));
  }

  return {
    prepareProposal(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Presented>> {
      const op = 'actions.proposals.prepare';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ operation: ActionName; payload: Record<string, unknown> }>(validateActionPrepare, p);
        const spec = ELEVATED_OPERATIONS[p.operation];
        if (!spec) throw new RefusalError({ code: 'invalid_request' });
        // The proposer must hold the proposed operation's own authority (kind and scope).
        const m = await membership(ctx.actorId, ctx.tenantId);
        const reason = proposerAllows(m, ctx.principal, p.operation);
        if (reason !== null || !ctx.scopes.includes(ACTION_POLICIES[p.operation].scope ?? '')) {
          throw new RefusalError({ code: 'forbidden', reasonCode: reason ?? 'scope_missing' });
        }
        const digest = payloadDigest(p.payload);
        return once(ctx, envelope, async (tx) => {
          const bound = await spec.bind(tx, p.payload);
          const { rows } = await tx.query<Row>(
            `INSERT INTO cuspatlas.operation_proposals (tenant_id, operation, payload, payload_digest,
               resource_versions, policy_version, proposer_id, proposer_kind, sponsor_id, expires_at)
             VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, cuspatlas.current_actor_id(), $6, $7,
               now() + make_interval(secs => $8))
             RETURNING *, false AS expired`,
            [
              p.operation,
              JSON.stringify(p.payload),
              digest,
              JSON.stringify(bound),
              ACTION_PROPOSAL_POLICY_VERSION,
              ctx.principal === 'human' ? 'human' : 'service',
              ctx.agent?.sponsorRef ?? null,
              ACTION_PROPOSAL_TTL_SECONDS,
            ],
          );
          const row = rows[0] as Row;
          await audit(tx, op, row, 1, 'proposal');
          return { row, version: 1 };
        });
      });
    },

    approveProposal(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Presented>> {
      const op = 'actions.proposals.approve';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ proposalRef: string; payloadDigest: string; expectedVersion: number }>(
          validateActionApprove,
          p,
        );
        const seen = await deps.withTenantTransaction(ctx, (tx) => load(tx, p.proposalRef, false));
        if (!seen) throw notFound();
        // The approver must be allowed to perform the proposed operation now (never an agent).
        await deps.authorize(ctx, seen.operation, { tenantId: ctx.tenantId, id: p.proposalRef });
        return once(ctx, envelope, async (tx) => {
          const row = await load(tx, p.proposalRef, true);
          if (!row) throw notFound();
          const currentSponsor = (
            await tx.query<{ sponsor_ref: string }>(
              `SELECT s.sponsor_ref FROM cuspatlas.agent_principals a
               JOIN cuspatlas.agent_sponsorships s ON s.id = a.sponsorship_ref WHERE a.principal_id = $1`,
              [row.proposer_id],
            )
          ).rows[0]?.sponsor_ref;
          if (
            ctx.actorId === row.proposer_id ||
            ctx.actorId === row.sponsor_id ||
            ctx.actorId === currentSponsor
          ) {
            throw new RefusalError({ code: 'self_approval_denied', reasonCode: 'self_approval_denied' });
          }
          if (row.version !== p.expectedVersion) throw stale(row.version);
          if (row.state !== 'prepared') throw conflict('proposal_state_conflict');
          if (row.expired) return close(tx, row, 'expired', 'expired');
          if (p.payloadDigest !== row.payload_digest) {
            throw new RefusalError({ code: 'payload_mismatch', reasonCode: 'payload_mismatch' });
          }
          await tx.query(
            `UPDATE cuspatlas.operation_proposals SET state = 'approved', approver_id = cuspatlas.current_actor_id(),
               approved_at = now(), version = version + 1, updated_at = now() WHERE id = $1`,
            [row.id],
          );
          await audit(tx, op, row, row.version + 1, 'approval');
          return { row, version: row.version + 1 };
        });
      });
    },

    commitProposal(ctx: ActorContext, envelope: CommandEnvelope<unknown>): Promise<CommandResult<Presented>> {
      const op = 'actions.proposals.commit';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ proposalRef: string; payloadDigest: string }>(validateActionCommit, p);
        const seen = await deps.withTenantTransaction(ctx, (tx) => load(tx, p.proposalRef, false));
        if (!seen) throw notFound();
        const spec = ELEVATED_OPERATIONS[seen.operation] as ElevatedSpec;
        // Fresh memberships of the proposer and approver, loaded before the transaction.
        const proposerM = await membership(seen.proposer_id, ctx.tenantId);
        const approverM = seen.approver_id === null ? null : await membership(seen.approver_id, ctx.tenantId);

        const claimed = await deps.withTenantTransaction(ctx, async (tx) => {
          const row = await load(tx, p.proposalRef, true);
          if (!row) throw notFound();
          if (row.state === 'committed') {
            if (p.payloadDigest !== row.payload_digest) {
              throw new RefusalError({ code: 'payload_mismatch', reasonCode: 'payload_mismatch' });
            }
            return { row, replay: true };
          }
          if (row.state === 'rejected' || row.state === 'expired' || row.state === 'abandoned') {
            throw refusalFor(row.state === 'expired' ? 'expired' : row.disposition_reason);
          }
          if (row.state === 'prepared') throw conflict('proposal_state_conflict');
          if (row.state === 'committing' && row.committer_id !== ctx.actorId) {
            throw new RefusalError({
              code: 'conflict',
              retryable: true,
              detail: { reason: 'commit_in_progress' },
            });
          }
          if (row.expired && row.state === 'approved') return close(tx, row, 'expired', 'expired');
          if (p.payloadDigest !== row.payload_digest) return close(tx, row, 'rejected', 'payload_mismatch');
          if (payloadDigest(row.payload) !== row.payload_digest)
            return close(tx, row, 'rejected', 'approval_invalid');
          if (row.policy_version !== ACTION_PROPOSAL_POLICY_VERSION)
            return close(tx, row, 'rejected', 'policy_changed');
          if (proposerAllows(proposerM, row.proposer_kind, row.operation) !== null) {
            return close(tx, row, 'rejected', 'proposer_unauthorized');
          }
          // H3: the approver must still hold approval AND the proposed operation's own authority.
          if (
            membershipAllows(approverM, 'human', 'actions.proposals.approve') !== null ||
            membershipAllows(approverM, 'human', row.operation) !== null
          ) {
            return close(tx, row, 'rejected', 'approver_unauthorized');
          }
          // H3: the sponsor/proposer exclusion is rechecked at commit (the sponsor may have changed
          // since approval): neither the approver nor the committer may be the proposer or its
          // sponsor of record or current sponsor.
          const currentSponsor = (
            await tx.query<{ sponsor_ref: string }>(
              `SELECT s.sponsor_ref FROM cuspatlas.agent_principals a
               JOIN cuspatlas.agent_sponsorships s ON s.id = a.sponsorship_ref WHERE a.principal_id = $1`,
              [row.proposer_id],
            )
          ).rows[0]?.sponsor_ref;
          const excluded = new Set([row.proposer_id, row.sponsor_id, currentSponsor].filter(Boolean));
          if (excluded.has(row.approver_id ?? '') || ctx.actorId === row.proposer_id) {
            return close(tx, row, 'rejected', 'approver_unauthorized');
          }
          const now = await spec.bind(tx, row.payload).catch(() => null);
          const same =
            now !== null &&
            now.length === row.resource_versions.length &&
            now.every(
              (b, i) =>
                b.ref === row.resource_versions[i]?.ref && b.version === row.resource_versions[i]?.version,
            );
          if (!same) return close(tx, row, 'rejected', 'stale_version');
          if (row.state === 'approved') {
            await tx.query(
              `UPDATE cuspatlas.operation_proposals SET state = 'committing', committer_id = cuspatlas.current_actor_id(),
                 updated_at = now() WHERE id = $1 AND state = 'approved'`,
              [row.id],
            );
          }
          return { row, replay: false };
        });
        if (claimed.replay) {
          return {
            data: present(claimed.row),
            version: claimed.row.version,
            correlationId: ctx.correlationId,
            replayed: true,
          };
        }

        const row = claimed.row;
        const body = { ...row.payload };
        const pathRef = spec.pathRef === null ? '' : String(body[spec.pathRef]);
        if (spec.pathRef !== null) delete body[spec.pathRef];
        let result: CommandResult<unknown>;
        try {
          // The owning command, as the committing human, once per proposal (its idempotency key).
          result = await spec.run(owners, ctx, pathRef, {
            operation: row.operation,
            idempotencyKey: `proposal:${row.id}`,
            payload: body,
          });
        } catch (err) {
          if (
            isRefusalError(err) &&
            ['stale_version', 'conflict', 'validation_failed', 'invalid_request', 'not_found'].includes(
              err.code,
            )
          ) {
            await deps.withTenantTransaction(ctx, async (tx) => {
              const r = await load(tx, row.id, true);
              if (r?.state === 'committing') {
                await tx.query(
                  `UPDATE cuspatlas.operation_proposals SET state = 'rejected', disposition_reason = $2,
                     version = version + 1, updated_at = now() WHERE id = $1`,
                  [row.id, `owner_${err.code}`],
                );
                await audit(tx, op, r, r.version + 1, 'state');
              }
            });
          }
          throw err;
        }
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rowCount } = await tx.query(
            `UPDATE cuspatlas.operation_proposals SET state = 'committed', result_type = $2, result_ref = $3,
               result_version = $4, version = version + 1, updated_at = now()
             WHERE id = $1 AND state = 'committing'`,
            [row.id, spec.resourceType, firstRef(result.data) ?? row.id, result.version],
          );
          const after = (await load(tx, row.id, false)) as Row;
          if (rowCount === 1) {
            await audit(tx, op, after, after.version, 'commit');
            return {
              data: present(after),
              version: after.version,
              correlationId: ctx.correlationId,
              replayed: false,
            };
          }
          return {
            data: present(after),
            version: after.version,
            correlationId: ctx.correlationId,
            replayed: true,
          };
        });
      });
    },

    abandonProposal(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<Presented>> {
      const op = 'actions.proposals.abandon';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ proposalRef: string; expectedVersion: number; reason: string }>(validateActionAbandon, p);
        return once(ctx, envelope, async (tx) => {
          const row = await load(tx, p.proposalRef, true);
          if (!row) throw notFound();
          // The proposer, or any human with the scope, may abandon; another service may not.
          if (ctx.principal !== 'human' && ctx.actorId !== row.proposer_id) throw notFound();
          if (row.version !== p.expectedVersion) throw stale(row.version);
          if (row.state !== 'prepared' && row.state !== 'approved') throw conflict('proposal_state_conflict');
          await tx.query(
            `UPDATE cuspatlas.operation_proposals SET state = 'abandoned', disposition_reason = $2,
               version = version + 1, updated_at = now() WHERE id = $1`,
            [row.id, p.reason],
          );
          await audit(tx, op, row, row.version + 1, 'state');
          return { row, version: row.version + 1 };
        });
      });
    },

    readProposal(ctx: ActorContext, query: unknown) {
      const op = 'actions.proposals.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ proposalRef: string }>(validateActionQuery, query);
        const row = await deps.withTenantTransaction(ctx, (tx) => load(tx, query.proposalRef, false));
        if (!row || (ctx.agent && row.proposer_id !== ctx.actorId)) throw notFound();
        return present(row);
      });
    },

    listProposals(ctx: ActorContext, query: unknown) {
      const op = 'actions.proposals.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        validate<{ state?: string; limit?: number; cursor?: string }>(validateActionListQuery, query);
        const pg = base.page(ctx, query);
        // An agent sees only its own proposals.
        const mine = ctx.agent ? ctx.actorId : null;
        const state = query.state ?? null;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const at = await transactionNow(tx);
          const where = `WHERE ($1::text IS NULL OR state = $1) AND ($2::uuid IS NULL OR proposer_id = $2)`;
          const total = Number(
            (
              await tx.query<{ n: string }>(
                `SELECT count(*) AS n FROM cuspatlas.operation_proposals ${where}`,
                [state, mine],
              )
            ).rows[0]?.n ?? 0,
          );
          const { rows } = await tx.query<Row>(
            `${SELECT} ${where} ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
            [state, mine, pg.limit, pg.offset],
          );
          return {
            ...listEnvelope({
              asOf: at,
              appliedFilters: { state },
              locationRefs: decision.locationRefs,
              limit: pg.limit,
              nextCursor: pg.next(rows.length, total),
              ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'proposalRef' },
              total,
            }),
            items: rows.map(present),
          };
        });
      });
    },
  };
}
