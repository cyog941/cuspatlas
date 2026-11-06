import { randomUUID } from 'node:crypto';
import {
  ACTION_PROPOSAL_PROPERTIES,
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  CommitThenRefuse,
  type CreateProposalPayload,
  type MembershipRecord,
  type MembershipSource,
  type Proposal,
  type ProposalApprove,
  type ProposalCommit,
  type ProposalOperation,
  type ProposalPayload,
  type ProposalPrepare,
  type ProposalState,
  type ProposalSummary,
  RefusalError,
  type RelabelProposalPayload,
  type TenantTransaction,
  validateCreateProposalPayload,
  validateIdempotencyKey,
  validateProposalApprove,
  validateProposalCommit,
  validateProposalPrepare,
  validateProposalRef,
  validateRelabelProposalPayload,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import {
  type Authorize,
  assertLocation,
  membershipAllows,
  PROPOSAL_POLICY_VERSION,
} from '../policy/authorize';
import { type AttemptRecordingDeps, withRefusalRecording } from './boundary';
import { payloadDigest } from './digest';
import { executeOnce } from './execute-once';
import type { CommandExecutor } from './executor';

/**
 * Server-owned action proposals over the synthetic task domain (F Task 7a): prepare -> approve ->
 * commit, with no live model and no outbound side effect. REST, MCP and the worker call these
 * functions; none of them takes a tenant, proposer or approver from its input.
 *
 * Rules (see docs/adr/0010-automation-policy.md):
 * - A proposal binds tenant, operation, the payload and its canonical digest, the target resource
 *   version, the policy version, the proposer (principal and kind) and an expiry (default 15 min).
 * - Approval: a human with `syntheticTasks.approve`, over the digest the approver states it reviewed.
 *   A service principal can never approve its own proposal (`self_approval_denied`); a human
 *   proposer approving its own proposal is allowed by the frozen rule for this synthetic operation.
 * - Commit reauthorizes the executor for the operation, rechecks the proposer's and approver's live
 *   memberships, the payload digest, the approval record, the policy version, the expiry and the
 *   resource version, and then runs the mutation through `executeOnce` with the proposal id as the
 *   idempotency key. The proposal row (locked FOR UPDATE) is the durable once-only guard; a committed
 *   proposal returns its recorded result with `replayed: true` to any authorized committer.
 * - Refusals that make a proposal permanently unusable close it (`expired` or `rejected` with a
 *   reason) and are committed before the refusal is returned; every refusal writes a security attempt.
 */
export interface ProposalDeps {
  readonly authorize: Authorize;
  /** Live membership lookups for the proposer and approver (never inside a tenant transaction). */
  readonly memberships: MembershipSource;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly recording: AttemptRecordingDeps;
  readonly execute?: CommandExecutor;
  /** Policy version bound into new proposals and required at approval and commit. */
  readonly policyVersion?: string;
  /** Proposal lifetime (default 900 s, at most one day). */
  readonly ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 15 * 60;
const RESOURCE_TYPE = 'syntheticTask';

type DispositionReason =
  | 'payload_mismatch'
  | 'expired'
  | 'stale_version'
  | 'policy_changed'
  | 'approval_invalid'
  | 'approver_unauthorized'
  | 'proposer_unauthorized';

interface ProposalRow extends Record<string, unknown> {
  id: string;
  operation: ProposalOperation;
  payload: ProposalPayload;
  payload_digest: string;
  resource_ref: string | null;
  resource_version: number | null;
  policy_version: string;
  proposer_id: string;
  proposer_kind: 'human' | 'service';
  expires_at: Date;
  state: ProposalState;
  version: number;
  approver_id: string | null;
  approved_at: Date | null;
  approval_policy_version: string | null;
  approval_digest: string | null;
  execution: 'manual' | 'deferred' | null;
  committed_by: string | null;
  result_ref: string | null;
  result_version: number | null;
  disposition_reason: DispositionReason | null;
  expired: boolean;
  location_ref: string | null;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  label: string;
  location_ref: string | null;
  version: number;
}

type TaskSummary = { readonly taskRef: string; readonly label: string };

const SELECT_PROPOSAL = `SELECT p.id, p.operation, p.payload, p.payload_digest, p.resource_ref,
    p.resource_version, p.policy_version, p.proposer_id, p.proposer_kind, p.expires_at, p.state,
    p.version, p.approver_id, p.approved_at, p.approval_policy_version, p.approval_digest, p.execution,
    p.committed_by, p.result_ref, p.result_version, p.disposition_reason,
    (p.expires_at <= now()) AS expired,
    CASE WHEN p.resource_ref IS NULL THEN p.payload ->> 'locationRef' ELSE t.location_ref END AS location_ref
  FROM cuspatlas.action_proposals p
  LEFT JOIN cuspatlas.synthetic_tasks t ON t.id = p.resource_ref
  WHERE p.id = $1`;

const notFound = () => new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });

/** The caller-facing refusal for a closed proposal, replayed on every later step. */
function refusalFor(reason: DispositionReason, currentVersion?: number): RefusalError {
  switch (reason) {
    case 'expired':
      return new RefusalError({ code: 'proposal_expired' });
    case 'payload_mismatch':
      return new RefusalError({ code: 'payload_mismatch' });
    case 'stale_version':
      return new RefusalError({
        code: 'stale_version',
        ...(currentVersion === undefined ? {} : { detail: { currentVersion } }),
      });
    case 'policy_changed':
      return new RefusalError({ code: 'policy_changed' });
    case 'approval_invalid':
      return new RefusalError({ code: 'approval_invalid' });
    case 'approver_unauthorized':
      return new RefusalError({ code: 'forbidden', reasonCode: 'approver_unauthorized' });
    case 'proposer_unauthorized':
      return new RefusalError({ code: 'forbidden', reasonCode: 'proposer_unauthorized' });
  }
}

const effectiveState = (p: ProposalRow): ProposalState =>
  (p.state === 'prepared' || p.state === 'approved') && p.expired ? 'expired' : p.state;

function summary(p: ProposalRow): ProposalSummary {
  return {
    proposalRef: p.id,
    operation: p.operation,
    state: effectiveState(p),
    payloadDigest: p.payload_digest,
    policyVersion: p.policy_version,
    expiresAt: p.expires_at.toISOString(),
    resourceRef: p.resource_ref,
    resourceVersion: p.resource_version,
  };
}

function view(p: ProposalRow): Proposal {
  return {
    ...summary(p),
    payload: p.payload,
    proposerRef: p.proposer_id,
    proposerKind: p.proposer_kind,
    approval:
      p.approver_id !== null &&
      p.approved_at !== null &&
      p.approval_policy_version !== null &&
      p.approval_digest !== null &&
      p.execution !== null
        ? {
            approverRef: p.approver_id,
            approvedAt: p.approved_at.toISOString(),
            policyVersion: p.approval_policy_version,
            payloadDigest: p.approval_digest,
            execution: p.execution,
          }
        : null,
    result:
      p.result_ref !== null && p.result_version !== null
        ? { taskRef: p.result_ref, version: p.result_version }
        : null,
    version: p.version,
  };
}

/**
 * Who may see a proposal's contents: a member with read access (location rules apply) who is its
 * proposer, approver or committer, or who could approve it (human with approve scope) or execute it
 * (write scope). Everyone else gets the same 404 as for a missing or another tenant's proposal.
 */
function canSee(ctx: ActorContext, locationRefs: readonly string[] | null, p: ProposalRow): boolean {
  if (p.location_ref !== null && locationRefs !== null && !locationRefs.includes(p.location_ref))
    return false;
  if (p.proposer_id === ctx.actorId || p.approver_id === ctx.actorId || p.committed_by === ctx.actorId) {
    return true;
  }
  if (ctx.principal === 'human' && ctx.scopes.includes('syntheticTasks.approve')) return true;
  return ctx.scopes.includes('syntheticTasks.write');
}

async function loadProposal(tx: TenantTransaction, ref: string, lock: boolean): Promise<ProposalRow | null> {
  const { rows } = await tx.query<ProposalRow>(
    lock ? `${SELECT_PROPOSAL} FOR UPDATE OF p` : SELECT_PROPOSAL,
    [ref],
  );
  return rows[0] ?? null;
}

async function provenance(
  tx: TenantTransaction,
  p: Pick<ProposalRow, 'id' | 'payload_digest'>,
  step: ProposalState,
  policyVersion: string,
  extra: { reason?: DispositionReason; resultRef?: string; resultVersion?: number } = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO cuspatlas.action_proposal_provenance (proposal_id, tenant_id, step, actor_id, actor_kind,
       policy_version, payload_digest, reason, result_ref, result_version, correlation_id)
     VALUES ($1, cuspatlas.current_tenant_id(), $2, cuspatlas.current_actor_id(), $3, $4, $5, $6, $7, $8, $9)`,
    [
      p.id,
      step,
      tx.ctx.principal,
      policyVersion,
      p.payload_digest,
      extra.reason ?? null,
      extra.resultRef ?? null,
      extra.resultVersion ?? null,
      tx.ctx.correlationId,
    ],
  );
}

function validatePayloadFor(operation: ProposalOperation, payload: unknown): ProposalPayload {
  if (operation === 'syntheticTasks.create') {
    assertValid<CreateProposalPayload>(validateCreateProposalPayload, payload, ACTION_PROPOSAL_PROPERTIES);
    return payload;
  }
  assertValid<RelabelProposalPayload>(validateRelabelProposalPayload, payload, ACTION_PROPOSAL_PROPERTIES);
  return payload;
}

/** Canonical digest of the payload a committer submitted. */
function submittedDigest(body: ProposalCommit): string {
  return payloadDigest(body.payload);
}

export function createProposalService(deps: ProposalDeps) {
  const execute = deps.execute ?? executeOnce;
  const policyVersion = deps.policyVersion ?? PROPOSAL_POLICY_VERSION;
  const ttl = deps.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86_400) throw new Error('ttlSeconds out of range');
  if (!/^[a-z0-9.-]{1,64}$/.test(policyVersion)) throw new Error('policyVersion is malformed');

  function guarded<T>(ctx: ActorContext, operation: string, work: () => Promise<T>): Promise<T> {
    return withRefusalRecording(
      deps.recording,
      { correlationId: ctx.correlationId, tenantId: ctx.tenantId, actorId: ctx.actorId, operation },
      work,
    );
  }

  /** Closes the proposal, records provenance, commits, and then surfaces the refusal. */
  async function close(
    tx: TenantTransaction,
    p: ProposalRow,
    step: 'expired' | 'rejected',
    reason: DispositionReason,
    currentVersion?: number,
  ): Promise<never> {
    const { rowCount } = await tx.query(
      `UPDATE cuspatlas.action_proposals SET state = $2, version = version + 1, disposition_reason = $3,
         updated_at = now()
       WHERE id = $1 AND state = $4`,
      [p.id, step, reason, p.state],
    );
    if (rowCount !== 1) throw new RefusalError({ code: 'conflict', retryable: true });
    await provenance(tx, p, step, policyVersion, { reason });
    throw new CommitThenRefuse(refusalFor(reason, currentVersion));
  }

  /** Validated proposal reference and the caller's read decision (visibility baseline). */
  async function readAccess(ctx: ActorContext, ref: string) {
    const decision = await deps.authorize(ctx, 'syntheticTasks.proposals.read', {
      tenantId: ctx.tenantId,
      id: ref,
    });
    if (!validateProposalRef(ref)) throw notFound();
    return decision;
  }

  async function visibleProposal(ctx: ActorContext, ref: string): Promise<ProposalRow> {
    const decision = await readAccess(ctx, ref);
    const p = await deps.withTenantTransaction(ctx, (tx) => loadProposal(tx, ref, false));
    if (!p || !canSee(ctx, decision.locationRefs, p)) throw notFound();
    return p;
  }

  function replayCommitted(ctx: ActorContext, p: ProposalRow): CommandResult<TaskSummary> {
    if (p.result_ref === null || p.result_version === null)
      throw new Error('committed proposal has no result');
    return {
      data: { taskRef: p.result_ref, label: p.payload.label },
      version: p.result_version,
      correlationId: ctx.correlationId,
      replayed: true,
    };
  }

  /** Shared commit path. `body` is the caller's commit request; undefined for deferred (worker) execution. */
  async function commit(
    ctx: ActorContext,
    ref: string,
    body: unknown | undefined,
    deferred: boolean,
  ): Promise<CommandResult<TaskSummary>> {
    const seen = await visibleProposal(ctx, ref);
    // The executor must be allowed to perform the proposal's own operation, here and now.
    const decision = await deps.authorize(ctx, seen.operation, {
      tenantId: ctx.tenantId,
      id: seen.resource_ref ?? 'new',
      locationId: seen.location_ref,
    });
    let submitted: string | null = null;
    if (!deferred) {
      assertValid<ProposalCommit>(validateProposalCommit, body, ACTION_PROPOSAL_PROPERTIES);
      submitted = submittedDigest(body);
    }
    // Fresh membership of the other principals, loaded before (never inside) the tenant transaction.
    const proposerM: MembershipRecord | null = await deps.memberships.load(seen.proposer_id, ctx.tenantId);
    const approverM: MembershipRecord | null =
      seen.approver_id === null ? null : await deps.memberships.load(seen.approver_id, ctx.tenantId);

    return deps.withTenantTransaction(ctx, async (tx) => {
      const p = await loadProposal(tx, ref, true);
      if (!p) throw notFound();
      // The approval changed between the read and the lock: the loaded approver may be stale.
      if (p.approver_id !== seen.approver_id) throw new RefusalError({ code: 'conflict', retryable: true });

      if (p.state === 'committed') {
        if (submitted !== null && submitted !== p.payload_digest) {
          throw new RefusalError({ code: 'payload_mismatch' });
        }
        return replayCommitted(ctx, p);
      }
      if (p.state === 'expired' || p.state === 'rejected') {
        throw refusalFor(p.disposition_reason ?? 'approval_invalid');
      }
      if (p.expired) return close(tx, p, 'expired', 'expired');
      if (p.state === 'prepared') {
        throw new RefusalError({ code: 'conflict', reasonCode: 'proposal_state_conflict' });
      }

      // Approved. Any mismatch from here on closes the proposal: a new one must be prepared.
      if (submitted !== null && submitted !== p.payload_digest)
        return close(tx, p, 'rejected', 'payload_mismatch');
      if (
        payloadDigest(p.payload) !== p.payload_digest ||
        p.approval_digest !== p.payload_digest ||
        p.approval_policy_version !== p.policy_version ||
        (p.proposer_kind === 'service' && p.approver_id === p.proposer_id)
      ) {
        return close(tx, p, 'rejected', 'approval_invalid');
      }
      if (p.policy_version !== policyVersion) return close(tx, p, 'rejected', 'policy_changed');
      if (membershipAllows(approverM, 'human', 'syntheticTasks.proposals.approve', p.location_ref) !== null) {
        return close(tx, p, 'rejected', 'approver_unauthorized');
      }
      if (
        membershipAllows(proposerM, p.proposer_kind, 'syntheticTasks.proposals.prepare', p.location_ref) !==
        null
      ) {
        return close(tx, p, 'rejected', 'proposer_unauthorized');
      }

      let task: TaskRow | undefined;
      if (p.operation === 'syntheticTasks.relabel') {
        const found = await tx.query<TaskRow>(
          'SELECT id, label, location_ref, version FROM cuspatlas.synthetic_tasks WHERE id = $1 FOR UPDATE',
          [p.resource_ref],
        );
        task = found.rows[0];
        if (!task) return close(tx, p, 'rejected', 'stale_version');
        assertLocation(decision.locationRefs, task.location_ref);
        if (task.version !== p.resource_version) {
          return close(tx, p, 'rejected', 'stale_version', task.version);
        }
      }

      const envelope: CommandEnvelope<unknown> = {
        operation: 'syntheticTasks.proposals.commit',
        idempotencyKey: p.id,
        payload: p.payload,
      };
      const result = await execute<TaskSummary>(ctx, envelope, tx, async () => {
        if (p.operation === 'syntheticTasks.create') {
          const payload = p.payload as CreateProposalPayload;
          const { rows } = await tx.query<TaskRow>(
            `INSERT INTO cuspatlas.synthetic_tasks (tenant_id, label, location_ref, created_by)
             VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id())
             RETURNING id, label, location_ref, version`,
            [payload.label, payload.locationRef ?? null],
          );
          const row = rows[0];
          if (!row) throw new Error('insert returned no row');
          await recordCommand(
            tx,
            {
              operation: 'syntheticTasks.create',
              resourceType: RESOURCE_TYPE,
              resourceRef: row.id,
              resourceVersion: row.version,
            },
            { changedFields: ['label', 'locationRef'] },
          );
          return { data: { taskRef: row.id, label: row.label }, version: row.version };
        }
        const payload = p.payload as RelabelProposalPayload;
        const { rows } = await tx.query<TaskRow>(
          `UPDATE cuspatlas.synthetic_tasks SET label = $1, version = version + 1, updated_at = now()
           WHERE id = $2 AND version = $3 RETURNING id, label, location_ref, version`,
          [payload.label, payload.taskRef, payload.expectedVersion],
        );
        const row = rows[0];
        if (!row) throw new RefusalError({ code: 'stale_version' });
        await recordCommand(
          tx,
          {
            operation: 'syntheticTasks.relabel',
            resourceType: RESOURCE_TYPE,
            resourceRef: row.id,
            resourceVersion: row.version,
          },
          { changedFields: ['label'] },
        );
        return { data: { taskRef: row.id, label: row.label }, version: row.version };
      });
      // The proposal row was approved and locked, so a stored reservation here means the two guards
      // disagree. Fail closed instead of reporting someone else's execution.
      if (result.replayed) throw new Error('commit reservation exists for an uncommitted proposal');

      const { rowCount } = await tx.query(
        `UPDATE cuspatlas.action_proposals SET state = 'committed', version = version + 1,
           committed_by = cuspatlas.current_actor_id(), committed_at = now(), result_ref = $2,
           result_version = $3, updated_at = now()
         WHERE id = $1 AND state = 'approved'`,
        [p.id, result.data.taskRef, result.version],
      );
      if (rowCount !== 1) throw new Error('proposal changed under its row lock');
      await provenance(tx, p, 'committed', policyVersion, {
        resultRef: result.data.taskRef,
        resultVersion: result.version,
      });
      return result;
    });
  }

  return {
    /** POST /v1/synthetic-tasks/proposals. Never touches the synthetic task or the outbox. */
    prepareProposal(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ProposalSummary>> {
      return guarded(ctx, 'syntheticTasks.proposals.prepare', async () => {
        const decision = await deps.authorize(ctx, 'syntheticTasks.proposals.prepare', {
          tenantId: ctx.tenantId,
          id: 'new',
        });
        if (envelope.operation !== 'syntheticTasks.proposals.prepare') {
          throw new RefusalError({ code: 'invalid_request' });
        }
        assertValid(validateIdempotencyKey, envelope.idempotencyKey, ACTION_PROPOSAL_PROPERTIES);
        const body = envelope.payload;
        assertValid<ProposalPrepare>(validateProposalPrepare, body, ACTION_PROPOSAL_PROPERTIES);
        const payload = validatePayloadFor(body.operation, body.payload);

        if (body.operation === 'syntheticTasks.create') {
          const locationRef = (payload as CreateProposalPayload).locationRef ?? null;
          assertLocation(decision.locationRefs, locationRef);
          if (decision.locationRefs !== null && locationRef === null) {
            throw new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });
          }
        }

        return deps.withTenantTransaction(ctx, async (tx) => {
          let task: TaskRow | undefined;
          if (body.operation === 'syntheticTasks.relabel') {
            const relabel = payload as RelabelProposalPayload;
            const found = await tx.query<TaskRow>(
              'SELECT id, label, location_ref, version FROM cuspatlas.synthetic_tasks WHERE id = $1',
              [relabel.taskRef],
            );
            task = found.rows[0];
            if (!task) throw notFound();
            assertLocation(decision.locationRefs, task.location_ref);
          }
          return execute<ProposalSummary>(ctx, envelope, tx, async () => {
            const relabel =
              body.operation === 'syntheticTasks.relabel' ? (payload as RelabelProposalPayload) : null;
            if (relabel && task && task.version !== relabel.expectedVersion) {
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: task.version } });
            }
            const { rows } = await tx.query<ProposalRow>(
              `INSERT INTO cuspatlas.action_proposals (id, tenant_id, operation, payload, payload_digest,
                 resource_type, resource_ref, resource_version, policy_version, proposer_id, proposer_kind,
                 correlation_id, expires_at)
               VALUES ($1, cuspatlas.current_tenant_id(), $2, $3::jsonb, $4, $5, $6, $7, $8,
                 cuspatlas.current_actor_id(), $9, $10, now() + make_interval(secs => $11))
               RETURNING id, operation, payload_digest, resource_ref, resource_version, policy_version,
                 expires_at, state, false AS expired`,
              [
                randomUUID(),
                body.operation,
                JSON.stringify(payload),
                payloadDigest(payload),
                relabel ? RESOURCE_TYPE : null,
                relabel ? relabel.taskRef : null,
                relabel ? relabel.expectedVersion : null,
                policyVersion,
                ctx.principal,
                ctx.correlationId,
                ttl,
              ],
            );
            const row = rows[0];
            if (!row) throw new Error('insert returned no row');
            await provenance(tx, row, 'prepared', policyVersion);
            return { data: summary(row), version: 1 };
          });
        });
      });
    },

    /** GET /v1/synthetic-tasks/proposals/{proposalRef}. Read-only; never changes any state. */
    getProposal(ctx: ActorContext, ref: string): Promise<Proposal> {
      return guarded(ctx, 'syntheticTasks.proposals.read', async () => view(await visibleProposal(ctx, ref)));
    },

    /** POST /v1/synthetic-tasks/proposals/{proposalRef}/approve. */
    approveProposal(ctx: ActorContext, ref: string, body: unknown): Promise<CommandResult<ProposalSummary>> {
      return guarded(ctx, 'syntheticTasks.proposals.approve', async () => {
        const seen = await visibleProposal(ctx, ref);
        // Frozen rule: automation never approves its own action. Decided on the stored proposer.
        if (seen.proposer_kind === 'service' && seen.proposer_id === ctx.actorId) {
          throw new RefusalError({ code: 'self_approval_denied', reasonCode: 'self_approval_denied' });
        }
        const decision = await deps.authorize(ctx, 'syntheticTasks.proposals.approve', {
          tenantId: ctx.tenantId,
          id: ref,
          locationId: seen.location_ref,
        });
        assertValid<ProposalApprove>(validateProposalApprove, body, ACTION_PROPOSAL_PROPERTIES);
        const execution = body.execution ?? 'manual';

        return deps.withTenantTransaction(ctx, async (tx) => {
          const p = await loadProposal(tx, ref, true);
          if (!p) throw notFound();
          assertLocation(decision.locationRefs, p.location_ref);
          if (p.state === 'approved' && p.approver_id === ctx.actorId) {
            if (body.payloadDigest !== p.payload_digest) throw new RefusalError({ code: 'payload_mismatch' });
            return { data: summary(p), version: p.version, correlationId: ctx.correlationId, replayed: true };
          }
          if (p.state === 'expired' || p.state === 'rejected') {
            throw refusalFor(p.disposition_reason ?? 'approval_invalid');
          }
          if (p.state === 'prepared' && p.expired) return close(tx, p, 'expired', 'expired');
          if (p.state !== 'prepared') {
            throw new RefusalError({ code: 'conflict', reasonCode: 'proposal_state_conflict' });
          }
          // The approver must have reviewed exactly the bound payload.
          if (body.payloadDigest !== p.payload_digest) throw new RefusalError({ code: 'payload_mismatch' });
          if (p.policy_version !== policyVersion) return close(tx, p, 'rejected', 'policy_changed');
          // Hardening (review of 6540a56): never approve a relabel whose target already moved. This
          // read takes no lock; the commit path still locks the task and rechecks the version, which
          // remains the authoritative guard against a change between approval and commit.
          if (p.operation === 'syntheticTasks.relabel') {
            const live = await tx.query<{ version: number }>(
              'SELECT version FROM cuspatlas.synthetic_tasks WHERE id = $1',
              [p.resource_ref],
            );
            const current = live.rows[0]?.version;
            if (current !== p.resource_version) return close(tx, p, 'rejected', 'stale_version', current);
          }

          return execute<ProposalSummary>(
            ctx,
            {
              operation: 'syntheticTasks.proposals.approve',
              idempotencyKey: p.id,
              payload: { proposalRef: p.id, payloadDigest: body.payloadDigest, execution },
            },
            tx,
            async () => {
              const { rows } = await tx.query<ProposalRow>(
                `UPDATE cuspatlas.action_proposals SET state = 'approved', version = version + 1,
                   approver_id = cuspatlas.current_actor_id(), approver_kind = 'human', approved_at = now(),
                   approval_policy_version = $2, approval_digest = payload_digest, execution = $3,
                   updated_at = now()
                 WHERE id = $1 AND state = 'prepared'
                 RETURNING id, operation, payload_digest, resource_ref, resource_version, policy_version,
                   expires_at, state, version, false AS expired`,
                [p.id, policyVersion, execution],
              );
              const row = rows[0];
              if (!row) throw new RefusalError({ code: 'conflict', retryable: true });
              await provenance(tx, row, 'approved', policyVersion);
              if (execution === 'deferred') {
                // The durable execution request: an outbox event on the proposal, executed by the
                // worker internally (never sent to an adapter). recordCommand writes its audit twin.
                await recordCommand(
                  tx,
                  {
                    operation: 'syntheticTasks.proposals.approve',
                    resourceType: 'actionProposal',
                    resourceRef: row.id,
                    resourceVersion: row.version,
                  },
                  { changedFields: ['state', 'approval'] },
                );
              }
              return { data: summary(row), version: row.version };
            },
          );
        });
      });
    },

    /** POST /v1/synthetic-tasks/proposals/{proposalRef}/commit. */
    commitProposal(ctx: ActorContext, ref: string, body: unknown): Promise<CommandResult<TaskSummary>> {
      return guarded(ctx, 'syntheticTasks.proposals.commit', () => commit(ctx, ref, body, false));
    },

    /**
     * Deferred execution of an approved proposal by the worker. `ctx` is the worker's own service
     * principal (the executor), built from its live membership. Same rechecks as a commit, except
     * that there is no submitted payload: the stored payload must still match the bound digest.
     */
    executeApprovedProposal(ctx: ActorContext, ref: string): Promise<CommandResult<TaskSummary>> {
      return guarded(ctx, 'syntheticTasks.proposals.commit', () => commit(ctx, ref, undefined, true));
    },
  };
}

export type ProposalService = ReturnType<typeof createProposalService>;
