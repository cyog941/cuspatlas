import { randomUUID } from 'node:crypto';
import {
  type ActorContext,
  isRefusalError,
  type MembershipSource,
  RefusalError,
  type SecurityAttemptSink,
  type SecurityReasonCode,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import {
  type ActionName,
  type Authorize,
  type DeliveryAdapter,
  type DeliveryReceipt,
  RECEIPT_ID,
  type ReceiptLookup,
} from '@cuspatlas/domain';
import { backoffSeconds } from './backoff';
import {
  finalizeLease,
  type LeasedEvent,
  leaseHasAtLeast,
  leaseReady,
  type ReceiptOutcome,
  recordReceipt,
  type Transition,
} from './lease';

/**
 * Result of one dispatch:
 * - `delivered`: a provider receipt (delivered, duplicate or reconciled) is recorded; terminal.
 * - `retry`: definitively not performed (or the attempt sink was down); retried after backoff.
 * - `reconciliation`: outcome unknown (timeout after sending, adapter error, crash); the next lease
 *   asks the provider by delivery key and never re-sends unless the provider says `not_found`.
 * - `denied`: fresh authorization of the event's actor failed; dead-lettered, no provider call.
 * - `dead-letter`: attempts exhausted or the provider rejected it; kept with its reason for review.
 * - `lease-lost`: this worker's lease expired and another worker owns the event; nothing recorded
 *   by this worker except provider receipts, which are facts and deduplicated.
 */
export type DispatchResult =
  | 'delivered'
  | 'retry'
  | 'reconciliation'
  | 'denied'
  | 'dead-letter'
  | 'lease-lost';

/** Worker log lines carry fixed codes and server ids only, never payloads or caller text. */
export type WorkerLogLine =
  | {
      readonly msg: 'outbox_dispatch';
      readonly eventId: string;
      readonly attempt: number;
      readonly result: DispatchResult;
    }
  | { readonly msg: 'security_attempt_sink_unavailable' };

export interface WorkerDeps {
  /** The worker's own service principal; it needs a live membership with `outbox.deliver`. */
  readonly workerPrincipalId: string;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly authorize: Authorize;
  readonly memberships: MembershipSource;
  /** Independent sink (own pool) for denials of queued work. */
  readonly attempts: SecurityAttemptSink;
  readonly log?: (line: WorkerLogLine) => void;
  /** Delay before the next attempt; defaults to exponential backoff with jitter. */
  readonly backoffSeconds?: (attempt: number) => number;
  /** Lease duration (default 30 s). */
  readonly leaseSeconds?: number;
  /**
   * Upper bound on one adapter call (default 10 s); must be shorter than the lease. A send starts
   * only while at least this much lease remains, an unknown outcome waits at least this long before
   * reconciliation, and an expired lease is re-leased only this long after it expired, so a
   * successor never looks up a delivery key while this worker's request can still be in flight.
   */
  readonly deliverTimeoutSeconds?: number;
  /** Events leased per batch (default 10). */
  readonly batchSize?: number;
  /**
   * Internal executor for deferred proposal execution (F Task 7a). Events on the `actionProposal`
   * aggregate are execution requests: they are run through this domain path, never sent to an
   * adapter. Without it such events are retried (and eventually dead-lettered), never delivered.
   */
  readonly proposals?: ProposalExecutor;
  /**
   * C14 -> B consumer (workstream B). Events on the `clinicalRenderedProcedure` aggregate are
   * consumed in-process by billing under the worker's own service principal (the domain authorizes
   * it freshly for `billing.procedures.consume`); they are never sent to an adapter. Without it such
   * events are retried (and eventually dead-lettered), never delivered.
   */
  readonly procedures?: ProcedureEventConsumer;
  /**
   * Closed-loop claims workflow timers (workstream B, CL-08). Events on the `rcmWorkflowTimer`
   * aggregate are fired in-process under the worker's own service principal (the domain authorizes it
   * freshly for `rcm.workflows.fireTimer`; a firing is recorded once per timer); they are never sent
   * to an adapter. Without it such events are retried (and eventually dead-lettered).
   */
  readonly claimWorkflows?: ClaimWorkflowTimerConsumer;
}

export interface ClaimWorkflowTimerConsumer {
  fireWorkflowTimer(ctx: ActorContext, timerRef: string): Promise<unknown>;
}

export interface ProcedureEventConsumer {
  consumeRenderedProcedure(ctx: ActorContext, procedureRef: string): Promise<unknown>;
}

export interface ProposalExecutor {
  executeApprovedProposal(ctx: ActorContext, proposalRef: string): Promise<unknown>;
}

const DEFAULT_LEASE_SECONDS = 30;
const DEFAULT_DELIVER_TIMEOUT_SECONDS = 10;

/**
 * Calls the adapter, bounded by `timeoutMs`. A timeout is an unknown outcome (the request may still
 * land), never "not sent": the event goes to reconciliation, it is not retried blind.
 */
async function safeDeliver(
  adapter: DeliveryAdapter,
  event: LeasedEvent,
  timeoutMs: number,
): Promise<DeliveryReceipt> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<DeliveryReceipt>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'unknown' }), timeoutMs);
  });
  try {
    return await Promise.race([deliverOnce(adapter, event), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function deliverOnce(adapter: DeliveryAdapter, event: LeasedEvent): Promise<DeliveryReceipt> {
  try {
    const r = await adapter.deliver({
      deliveryKey: event.id,
      tenantId: event.tenantId,
      operation: event.operation,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      attempt: event.attempt,
      payload: event.payload,
    });
    if ((r.outcome === 'delivered' || r.outcome === 'duplicate') && !RECEIPT_ID.test(r.receiptId)) {
      return { outcome: 'unknown' };
    }
    return r;
  } catch {
    // The request may have reached the provider: never treat a thrown adapter as "not sent".
    return { outcome: 'unknown' };
  }
}

async function safeLookup(adapter: DeliveryAdapter, deliveryKey: string): Promise<ReceiptLookup> {
  try {
    const r = await adapter.lookup(deliveryKey);
    if (r.status === 'found' && !RECEIPT_ID.test(r.receiptId)) return { status: 'unavailable' };
    return r;
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Builds the durable outbox worker for one deployment. It leases per tenant under the tenant context
 * of its own service principal (no cross-tenant role), reauthorizes every event's actor against the
 * live membership before every provider call, and records receipts and outcomes with a fenced
 * update. Statements run through `withTenantTransaction`; no tenant transaction is held while the
 * provider, the membership source or the attempt sink is called.
 */
export function createWorker(deps: WorkerDeps) {
  const leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const deliverTimeout = deps.deliverTimeoutSeconds ?? DEFAULT_DELIVER_TIMEOUT_SECONDS;
  if (!(deliverTimeout > 0 && deliverTimeout < leaseSeconds)) {
    throw new Error('deliverTimeoutSeconds must be positive and shorter than leaseSeconds');
  }
  const batchSize = deps.batchSize ?? 10;
  const delay = deps.backoffSeconds ?? ((attempt: number) => backoffSeconds(attempt));
  const log = deps.log ?? (() => undefined);

  const workerCtx = (tenantId: string): ActorContext => ({
    tenantId,
    actorId: deps.workerPrincipalId,
    principal: 'service',
    sessionId: randomUUID(),
    scopes: ['outbox.deliver'],
    correlationId: randomUUID(),
  });

  async function finalize(
    event: LeasedEvent,
    t: Transition,
    receipt?: { readonly receiptId: string; readonly outcome: ReceiptOutcome },
  ): Promise<boolean> {
    return deps.withTenantTransaction(workerCtx(event.tenantId), async (tx) => {
      if (receipt) {
        await recordReceipt(tx, {
          eventId: event.id,
          receiptId: receipt.receiptId,
          outcome: receipt.outcome,
          attempt: event.attempt,
        });
      }
      return finalizeLease(tx, event, t);
    });
  }

  /** Fresh policy: the event's actor must still hold the operation's scope in a live membership. */
  async function reauthorize(event: LeasedEvent): Promise<SecurityReasonCode | null> {
    const m = await deps.memberships.load(event.actorId, event.tenantId);
    if (!m?.active) return 'membership_inactive';
    const ctx: ActorContext = {
      tenantId: event.tenantId,
      actorId: event.actorId,
      principal: m.principal,
      sessionId: randomUUID(),
      scopes: m.scopes,
      correlationId: event.correlationId,
    };
    try {
      // Unknown operations are not in the policy table and are denied.
      await deps.authorize(ctx, event.operation as ActionName, {
        tenantId: event.tenantId,
        id: event.aggregateId,
      });
      return null;
    } catch (err) {
      if (isRefusalError(err)) return err.reasonCode ?? 'scope_missing';
      throw err;
    }
  }

  async function deny(event: LeasedEvent, reasonCode: SecurityReasonCode): Promise<DispatchResult> {
    try {
      await deps.attempts.record({
        correlationId: event.correlationId,
        tenantId: event.tenantId,
        actorId: event.actorId,
        operation: event.operation,
        reasonCode,
      });
    } catch {
      // Still denied and not delivered; keep the event so the denial is recorded on a later lease.
      log({ msg: 'security_attempt_sink_unavailable' });
      const kept = await finalize(event, {
        state: 'retry',
        delaySeconds: delay(event.attempt),
        outcome: 'attempt_sink_unavailable',
      });
      return kept ? 'retry' : 'lease-lost';
    }
    const done = await finalize(event, {
      state: 'dead_letter',
      reason: reasonCode === 'membership_inactive' ? 'membership_revoked' : 'authorization_denied',
      outcome: 'denied',
    });
    return done ? 'denied' : 'lease-lost';
  }

  /**
   * Deferred proposal execution. Fresh checks: the approver who requested it (the event actor) must
   * still be a human with approve scope; the worker principal is the executor and is authorized for
   * the proposal's operation by the domain, which also rechecks the proposer, approver, payload
   * digest, approval record, policy version, expiry and resource version. Execution is idempotent
   * (proposal row state plus executeOnce), so no provider-style reconciliation is needed after a crash.
   */
  async function settleProposal(event: LeasedEvent): Promise<DispatchResult> {
    if (event.attempt > event.maxAttempts) {
      const ok = await finalize(event, {
        state: 'dead_letter',
        reason: 'max_attempts_exhausted',
        outcome: 'exhausted',
      });
      return ok ? 'dead-letter' : 'lease-lost';
    }
    const denial = await reauthorize(event);
    if (denial) return deny(event, denial);
    if (!deps.proposals) {
      const ok = await finalize(event, {
        state: 'retry',
        delaySeconds: delay(event.attempt),
        outcome: 'executor_unavailable',
      });
      return ok ? 'retry' : 'lease-lost';
    }
    const m = await deps.memberships.load(deps.workerPrincipalId, event.tenantId);
    const executor: ActorContext = {
      tenantId: event.tenantId,
      actorId: deps.workerPrincipalId,
      principal: 'service',
      sessionId: randomUUID(),
      scopes: m?.active ? m.scopes : [],
      correlationId: randomUUID(),
    };
    try {
      await deps.proposals.executeApprovedProposal(executor, event.aggregateId);
    } catch (err) {
      if (!isRefusalError(err)) throw err;
      if (err.retryable || err.code === 'service_unavailable') {
        const ok = await finalize(event, {
          state: 'retry',
          delaySeconds: delay(event.attempt),
          outcome: 'proposal_refused',
        });
        return ok ? 'retry' : 'lease-lost';
      }
      // The domain already wrote the security attempt row for this refusal.
      const denied =
        err.code === 'forbidden' || err.code === 'not_found' || err.code === 'self_approval_denied';
      const ok = await finalize(event, {
        state: 'dead_letter',
        reason: denied
          ? err.reasonCode === 'membership_inactive'
            ? 'membership_revoked'
            : 'authorization_denied'
          : 'proposal_refused',
        outcome: denied ? 'denied' : 'proposal_refused',
      });
      if (!ok) return 'lease-lost';
      return denied ? 'denied' : 'dead-letter';
    }
    const ok = await finalize(event, { state: 'delivered', outcome: 'executed' });
    return ok ? 'delivered' : 'lease-lost';
  }

  /**
   * In-process execution of a domain consumer under the worker's own principal (shared by the C14
   * consumer and the CL workflow timers): retryable refusals back off, others dead-letter for review.
   */
  async function settleInProcess(
    event: LeasedEvent,
    run: ((ctx: ActorContext) => Promise<unknown>) | null,
  ): Promise<DispatchResult> {
    if (event.attempt > event.maxAttempts) {
      const ok = await finalize(event, {
        state: 'dead_letter',
        reason: 'max_attempts_exhausted',
        outcome: 'exhausted',
      });
      return ok ? 'dead-letter' : 'lease-lost';
    }
    if (!run) {
      const ok = await finalize(event, {
        state: 'retry',
        delaySeconds: delay(event.attempt),
        outcome: 'executor_unavailable',
      });
      return ok ? 'retry' : 'lease-lost';
    }
    const m = await deps.memberships.load(deps.workerPrincipalId, event.tenantId);
    const executor: ActorContext = {
      tenantId: event.tenantId,
      actorId: deps.workerPrincipalId,
      principal: 'service',
      sessionId: randomUUID(),
      scopes: m?.active ? m.scopes : [],
      correlationId: randomUUID(),
    };
    try {
      await run(executor);
    } catch (err) {
      if (!isRefusalError(err)) throw err;
      if (err.retryable || err.code === 'service_unavailable') {
        const ok = await finalize(event, {
          state: 'retry',
          delaySeconds: delay(event.attempt),
          outcome: 'failed',
        });
        return ok ? 'retry' : 'lease-lost';
      }
      const denied = err.code === 'forbidden' || err.code === 'unauthenticated';
      const ok = await finalize(event, {
        state: 'dead_letter',
        reason: denied
          ? err.reasonCode === 'membership_inactive'
            ? 'membership_revoked'
            : 'authorization_denied'
          : 'provider_rejected',
        outcome: denied ? 'denied' : 'rejected',
      });
      if (!ok) return 'lease-lost';
      return denied ? 'denied' : 'dead-letter';
    }
    const ok = await finalize(event, { state: 'delivered', outcome: 'executed' });
    return ok ? 'delivered' : 'lease-lost';
  }

  /**
   * In-process consumption of a rendered-procedure fact by billing. The clinical fact stands even if
   * its author's access later changes, so the event actor is not reauthorized; the worker principal is
   * authorized freshly by the billing domain for every attempt. Consumption is idempotent per
   * procedure event version (the billing consumption key), so a crash or a duplicate lease never
   * posts twice. A retryable refusal (fee not configured, an event before its dependency) is retried
   * with backoff; any other refusal is dead-lettered for review.
   */
  async function settleProcedure(event: LeasedEvent): Promise<DispatchResult> {
    if (event.attempt > event.maxAttempts) {
      const ok = await finalize(event, {
        state: 'dead_letter',
        reason: 'max_attempts_exhausted',
        outcome: 'exhausted',
      });
      return ok ? 'dead-letter' : 'lease-lost';
    }
    if (!deps.procedures) {
      const ok = await finalize(event, {
        state: 'retry',
        delaySeconds: delay(event.attempt),
        outcome: 'executor_unavailable',
      });
      return ok ? 'retry' : 'lease-lost';
    }
    const m = await deps.memberships.load(deps.workerPrincipalId, event.tenantId);
    const executor: ActorContext = {
      tenantId: event.tenantId,
      actorId: deps.workerPrincipalId,
      principal: 'service',
      sessionId: randomUUID(),
      scopes: m?.active ? m.scopes : [],
      correlationId: randomUUID(),
    };
    try {
      await deps.procedures.consumeRenderedProcedure(executor, event.aggregateId);
    } catch (err) {
      if (!isRefusalError(err)) throw err;
      if (err.retryable || err.code === 'service_unavailable') {
        const ok = await finalize(event, {
          state: 'retry',
          delaySeconds: delay(event.attempt),
          outcome: 'failed',
        });
        return ok ? 'retry' : 'lease-lost';
      }
      const denied = err.code === 'forbidden' || err.code === 'unauthenticated';
      const ok = await finalize(event, {
        state: 'dead_letter',
        reason: denied
          ? err.reasonCode === 'membership_inactive'
            ? 'membership_revoked'
            : 'authorization_denied'
          : 'provider_rejected',
        outcome: denied ? 'denied' : 'rejected',
      });
      if (!ok) return 'lease-lost';
      return denied ? 'denied' : 'dead-letter';
    }
    const ok = await finalize(event, { state: 'delivered', outcome: 'executed' });
    return ok ? 'delivered' : 'lease-lost';
  }

  async function settle(event: LeasedEvent, adapter: DeliveryAdapter): Promise<DispatchResult> {
    if (event.aggregateType === 'actionProposal') return settleProposal(event);
    if (event.aggregateType === 'clinicalRenderedProcedure') return settleProcedure(event);
    if (event.aggregateType === 'rcmWorkflowTimer') {
      const consumer = deps.claimWorkflows;
      return settleInProcess(
        event,
        consumer ? (ctx) => consumer.fireWorkflowTimer(ctx, event.aggregateId) : null,
      );
    }
    const exhausted = event.attempt >= event.maxAttempts;

    // 1. A previous attempt may have reached the provider: reconcile by delivery key, never re-send blind.
    if (event.priorState === 'leased' || event.priorState === 'reconciliation') {
      const found = await safeLookup(adapter, event.id);
      if (found.status === 'found') {
        const ok = await finalize(
          event,
          { state: 'delivered', outcome: 'reconciled' },
          { receiptId: found.receiptId, outcome: 'reconciled' },
        );
        return ok ? 'delivered' : 'lease-lost';
      }
      if (found.status === 'unavailable') {
        const ok = await finalize(
          event,
          exhausted
            ? { state: 'dead_letter', reason: 'reconciliation_exhausted', outcome: 'lookup_unavailable' }
            : { state: 'reconciliation', delaySeconds: delay(event.attempt), outcome: 'lookup_unavailable' },
        );
        if (!ok) return 'lease-lost';
        return exhausted ? 'dead-letter' : 'reconciliation';
      }
      // not_found: the provider confirms nothing happened for this key; sending is safe.
    }

    if (event.attempt > event.maxAttempts) {
      const ok = await finalize(event, {
        state: 'dead_letter',
        reason: 'max_attempts_exhausted',
        outcome: 'exhausted',
      });
      return ok ? 'dead-letter' : 'lease-lost';
    }

    // 2. Fresh authorization before every delivery.
    const denial = await reauthorize(event);
    if (denial) return deny(event, denial);

    // 3. Send only while the lease outlives the bounded deliver call (re-read under the fence), so
    //    no successor can lease, look up and resend while this request may still be in flight.
    const remaining = await deps.withTenantTransaction(workerCtx(event.tenantId), (tx) =>
      leaseHasAtLeast(tx, event, deliverTimeout),
    );
    if (!remaining) return 'lease-lost';

    // 4. Deliver with the stable delivery key, bounded by the deliver timeout.
    const receipt = await safeDeliver(adapter, event, deliverTimeout * 1000);
    switch (receipt.outcome) {
      case 'delivered':
      case 'duplicate': {
        const ok = await finalize(
          event,
          { state: 'delivered', outcome: receipt.outcome },
          { receiptId: receipt.receiptId, outcome: receipt.outcome },
        );
        return ok ? 'delivered' : 'lease-lost';
      }
      case 'unknown': {
        // Quiet period: the request may still land; look it up only after it can no longer be in flight.
        const ok = await finalize(event, {
          state: 'reconciliation',
          delaySeconds: Math.max(delay(event.attempt), deliverTimeout),
          outcome: 'unknown',
        });
        return ok ? 'reconciliation' : 'lease-lost';
      }
      case 'failed': {
        if (!receipt.retryable || exhausted) {
          const ok = await finalize(event, {
            state: 'dead_letter',
            reason: receipt.retryable ? 'max_attempts_exhausted' : 'provider_rejected',
            outcome: receipt.retryable ? 'failed' : 'rejected',
          });
          return ok ? 'dead-letter' : 'lease-lost';
        }
        const ok = await finalize(event, {
          state: 'retry',
          delaySeconds: delay(event.attempt),
          outcome: 'failed',
        });
        return ok ? 'retry' : 'lease-lost';
      }
    }
  }

  const worker = {
    /**
     * Leases ready events of one tenant. The worker principal itself is authorized freshly
     * (`outbox.deliver`, service only) and its membership is rechecked inside the transaction.
     */
    async leaseBatch(tenantId: string): Promise<LeasedEvent[]> {
      const ctx = workerCtx(tenantId);
      try {
        await deps.authorize(ctx, 'outbox.deliver', { tenantId, id: 'outbox' });
      } catch (err) {
        if (isRefusalError(err)) {
          // Attribute the tenant only when a (possibly revoked) membership row exists for it.
          const m = await deps.memberships.load(deps.workerPrincipalId, tenantId).catch(() => null);
          await deps.attempts
            .record({
              correlationId: ctx.correlationId,
              tenantId: m ? tenantId : null,
              actorId: deps.workerPrincipalId,
              operation: 'outbox.deliver',
              reasonCode: err.reasonCode ?? 'scope_missing',
            })
            .catch(() => log({ msg: 'security_attempt_sink_unavailable' }));
        }
        throw err;
      }
      return deps.withTenantTransaction(ctx, (tx) =>
        leaseReady(tx, { limit: batchSize, leaseSeconds, quietSeconds: deliverTimeout }),
      );
    },

    /** Dispatches one leased event. Throws only on infrastructure failure (treated as a crash). */
    async dispatchEvent(event: LeasedEvent, adapter: DeliveryAdapter): Promise<DispatchResult> {
      if (!(event.attempt >= 1)) throw new RefusalError({ code: 'invalid_request' });
      const result = await settle(event, adapter);
      log({ msg: 'outbox_dispatch', eventId: event.id, attempt: event.attempt, result });
      return result;
    },

    /** Leases one batch for the tenant and dispatches it sequentially. */
    async runOnce(
      tenantId: string,
      adapter: DeliveryAdapter,
    ): Promise<{ readonly eventId: string; readonly result: DispatchResult }[]> {
      const leased = await worker.leaseBatch(tenantId);
      const out: { eventId: string; result: DispatchResult }[] = [];
      for (const event of leased)
        out.push({ eventId: event.id, result: await worker.dispatchEvent(event, adapter) });
      return out;
    },
  };
  return worker;
}

export type Worker = ReturnType<typeof createWorker>;
