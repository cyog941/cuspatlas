import { randomUUID } from 'node:crypto';
import {
  type ActorContext,
  isRefusalError,
  type MembershipSource,
  type SecurityAttemptSink,
  type TenantTransaction,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import {
  type Authorize,
  createContactDigester,
  enqueueAllowed,
  failClosed,
  finalizeReconciliation,
  finalizeSend,
  type LeasedMessage,
  leaseDue,
  logRef,
  type MessageState,
  type MessagingLookup,
  type MessagingPort,
  type MessagingSendResult,
  PROVIDER_REF,
  prepareSend,
} from '@cuspatlas/domain';
import { backoffSeconds } from './backoff';

/**
 * E7 outbound sender on the F6 worker contract, against a messaging port (only a synthetic fake
 * exists: E-S1 is blocked-on-discovery, there is no network egress). Per tenant, under the sender's
 * own service principal (`communications.deliver`, authorized freshly for every batch):
 *
 * 1. enqueue one message per intent E6 allowed (idempotent on the intent);
 * 2. lease due messages (fenced on the attempt number, `FOR UPDATE SKIP LOCKED`);
 * 3. a message whose earlier attempt is uncertain (expired lease after a crash, or `unknown`) is
 *    reconciled by lookup of its delivery key and is never resent blind;
 * 4. otherwise E6 decides again at send time (consent, opt-out, template, contact, subject, quiet
 *    hours) and, only when allowed, the port is called with the intent's stable delivery key, bounded
 *    by a timeout; a timeout or a thrown adapter is `unknown`, never "not sent".
 *
 * No tenant transaction is held during a port call. Log lines carry fixed codes and a hashed message
 * reference only: never a recipient, a body, a patient or a delivery key.
 */
export type SendResult = MessageState | 'lease_lost';

export type SenderLogLine =
  | {
      readonly msg: 'outbound_dispatch';
      readonly ref: string;
      readonly attempt: number;
      readonly result: SendResult;
    }
  | { readonly msg: 'outbound_enqueued'; readonly count: number }
  | { readonly msg: 'security_attempt_sink_unavailable' };

export interface OutboundSenderDeps {
  readonly workerPrincipalId: string;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly authorize: Authorize;
  readonly memberships: MembershipSource;
  readonly attempts: SecurityAttemptSink;
  readonly port: MessagingPort;
  /** S4 match-key pepper: send-time contact verification compares keyed digests, never plain hashes. */
  readonly matchKeyPepper: Uint8Array;
  /** The instant E6 evaluates quiet hours for (default: now). */
  readonly clock?: () => Date;
  readonly log?: (line: SenderLogLine) => void;
  readonly backoffSeconds?: (attempt: number) => number;
  readonly leaseSeconds?: number;
  /** Upper bound on one port call; shorter than the lease (default 10 s). */
  readonly sendTimeoutSeconds?: number;
  readonly batchSize?: number;
  /** Attempts per message (default 5). */
  readonly maxAttempts?: number;
}

const OPERATION = 'communications.deliver';

async function bounded<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createOutboundSender(deps: OutboundSenderDeps) {
  const leaseSeconds = deps.leaseSeconds ?? 30;
  const sendTimeout = deps.sendTimeoutSeconds ?? 10;
  if (!(sendTimeout > 0 && sendTimeout < leaseSeconds)) {
    throw new Error('sendTimeoutSeconds must be positive and shorter than leaseSeconds');
  }
  const delay = deps.backoffSeconds ?? ((attempt: number) => backoffSeconds(attempt));
  const log = deps.log ?? (() => undefined);
  const clock = deps.clock ?? (() => new Date());

  const ctxFor = (tenantId: string): ActorContext => ({
    tenantId,
    actorId: deps.workerPrincipalId,
    principal: 'service',
    sessionId: randomUUID(),
    scopes: [OPERATION],
    correlationId: randomUUID(),
  });

  async function authorizeBatch(ctx: ActorContext): Promise<void> {
    try {
      await deps.authorize(ctx, OPERATION, { tenantId: ctx.tenantId, id: 'outbound' });
    } catch (err) {
      if (isRefusalError(err)) {
        const m = await deps.memberships.load(deps.workerPrincipalId, ctx.tenantId).catch(() => null);
        await deps.attempts
          .record({
            correlationId: ctx.correlationId,
            tenantId: m ? ctx.tenantId : null,
            actorId: deps.workerPrincipalId,
            operation: OPERATION,
            reasonCode: err.reasonCode ?? 'scope_missing',
          })
          .catch(() => log({ msg: 'security_attempt_sink_unavailable' }));
      }
      throw err;
    }
  }

  async function safeSend(request: Parameters<MessagingPort['send']>[0]): Promise<MessagingSendResult> {
    const call = (async (): Promise<MessagingSendResult> => {
      try {
        const r = await deps.port.send(request);
        if ((r.outcome === 'accepted' || r.outcome === 'duplicate') && !PROVIDER_REF.test(r.providerRef)) {
          return { outcome: 'unknown' };
        }
        return r;
      } catch {
        // The request may have reached the provider: a thrown adapter is never "not sent".
        return { outcome: 'unknown' };
      }
    })();
    return bounded(call, sendTimeout * 1000, { outcome: 'unknown' });
  }

  async function safeLookup(deliveryKey: string): Promise<MessagingLookup> {
    const call = (async (): Promise<MessagingLookup> => {
      try {
        const r = await deps.port.lookup(deliveryKey);
        if (r.status === 'found' && !PROVIDER_REF.test(r.providerRef)) return { status: 'unavailable' };
        return r;
      } catch {
        return { status: 'unavailable' };
      }
    })();
    return bounded(call, sendTimeout * 1000, { status: 'unavailable' });
  }

  const sender = {
    /** Enqueues allowed intents of one tenant (fresh worker authorization). */
    async enqueue(tenantId: string): Promise<number> {
      const ctx = ctxFor(tenantId);
      await authorizeBatch(ctx);
      const n = await deps.withTenantTransaction(ctx, (tx) => enqueueAllowed(tx, deps.maxAttempts ?? 5));
      log({ msg: 'outbound_enqueued', count: n });
      return n;
    },

    /** Leases due messages of one tenant (fresh worker authorization). */
    async leaseBatch(tenantId: string): Promise<LeasedMessage[]> {
      const ctx = ctxFor(tenantId);
      await authorizeBatch(ctx);
      return deps.withTenantTransaction(ctx, (tx) =>
        leaseDue(tx, { limit: deps.batchSize ?? 10, leaseSeconds, quietSeconds: sendTimeout }),
      );
    },

    /** Dispatches one leased message. Throws only on infrastructure failure (treated as a crash). */
    async dispatch(m: LeasedMessage): Promise<SendResult> {
      const run = <T>(work: (tx: TenantTransaction) => Promise<T>) =>
        deps.withTenantTransaction(ctxFor(m.tenantId), work);
      const result = await (async (): Promise<SendResult> => {
        if (m.priorState !== 'queued') {
          const found = await safeLookup(m.deliveryKey);
          return run((tx) =>
            finalizeReconciliation(tx, m, found, { reconcileAfterSeconds: delay(m.attempt) }),
          );
        }
        let prepared: Awaited<ReturnType<typeof prepareSend>>;
        try {
          prepared = await run((tx) =>
            prepareSend(tx, m, clock(), sendTimeout, createContactDigester(deps.matchKeyPepper, m.tenantId)),
          );
        } catch (err) {
          if (isRefusalError(err) && err.code === 'forbidden') throw err;
          // The decision could not be made: fail closed, never send by default.
          return run((tx) => failClosed(tx, m, delay(m.attempt)));
        }
        if (prepared.action === 'lease_lost') return 'lease_lost';
        if (prepared.action === 'done') return 'suppressed';
        const sent = await safeSend(prepared.request);
        return run((tx) =>
          finalizeSend(tx, m, sent, {
            backoffSeconds: delay(m.attempt),
            reconcileAfterSeconds: Math.max(delay(m.attempt), sendTimeout),
          }),
        );
      })();
      log({ msg: 'outbound_dispatch', ref: logRef(m.messageRef), attempt: m.attempt, result });
      return result;
    },

    /** Enqueue, lease and dispatch one batch of one tenant, sequentially. */
    async runOnce(tenantId: string): Promise<{ readonly messageRef: string; readonly result: SendResult }[]> {
      await sender.enqueue(tenantId);
      const leased = await sender.leaseBatch(tenantId);
      const out: { messageRef: string; result: SendResult }[] = [];
      for (const m of leased) out.push({ messageRef: m.messageRef, result: await sender.dispatch(m) });
      return out;
    },
  };
  return sender;
}

export type OutboundSender = ReturnType<typeof createOutboundSender>;
