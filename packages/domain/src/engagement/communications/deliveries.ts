import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  ENGAGEMENT_PROPERTIES,
  RefusalError,
  type TenantTransaction,
  validateDeliveryResolve,
  validateEmptyQuery,
  validateReceiptInput,
} from '@cuspatlas/contracts';
import { transactionNow } from '../../clock';
import { executeOnce } from '../../commands/execute-once';
import { recordCommand } from '../../events/record-command';
import { AVAILABLE, workItem, workList } from '../../work-items';
import { assertRef, checkEnvelope, conflict, type EngagementBase, notFound } from '../common';
import { OUTBOUND_MESSAGE_RESOURCE } from './delivery';

/**
 * E7 staff operations: the delivery worklist (failed and unknown deliveries as owned work items),
 * one message with its attempts, decisions and receipts, the staff resolution of an unresolved
 * delivery (resend with the same delivery key, or abandon), and provider receipt ingestion by the
 * receipts integration principal (deduplicated on the provider event, monotonic, tenant-bound).
 */
type ReceiptData = { deduplicated: boolean; applied: boolean; pending?: boolean; state: string };
const RANK: Readonly<Record<string, number>> = { sent: 1, delivered: 2, failed: 2 };

const EXPLANATION: Readonly<Record<string, string>> = {
  delivery_failed:
    'The message could not be delivered and will not be retried automatically. Check the contact on record with the patient, then resend or abandon it.',
  delivery_outcome_unknown:
    'It is not known whether the provider delivered this message, and the provider could not confirm it. It is never resent automatically; decide whether to resend (same delivery key) or abandon it.',
  decision_unavailable:
    'The consent and suppression decision could not be made at send time, so nothing was sent. It is retried; if it keeps failing, contact the patient through the practice process.',
};

export function createDeliveryOperations(base: EngagementBase) {
  const { deps } = base;
  const execute = deps.execute ?? executeOnce;
  return {
    deliveryWorklist(ctx: ActorContext, query: unknown) {
      const op = 'communications.deliveries.worklist';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            state: string;
            state_reason: string | null;
            subject_kind: string;
            subject_id: string;
            due_at: Date | null;
            updated_at: Date;
          }>(
            `SELECT m.id, m.state, m.state_reason, coalesce(i.subject_kind, 'message_thread') AS subject_kind,
               coalesce(i.subject_id, t.id) AS subject_id, i.due_at, m.updated_at
             FROM cuspatlas.outbound_messages m
             LEFT JOIN cuspatlas.notification_intents i ON i.id = m.intent_id AND i.tenant_id = m.tenant_id
             LEFT JOIN cuspatlas.thread_messages tm ON tm.id = m.thread_message_id AND tm.tenant_id = m.tenant_id
             LEFT JOIN cuspatlas.message_threads t ON t.id = tm.thread_id AND t.tenant_id = tm.tenant_id
             JOIN cuspatlas.scheduling_locations l ON l.id = coalesce(i.location_id, t.location_id) AND l.tenant_id = m.tenant_id
             WHERE (m.state IN ('failed', 'unknown') OR (m.state = 'queued' AND m.state_reason = 'decision_unavailable'))
               AND ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[]))
             ORDER BY m.updated_at, m.id LIMIT 500`,
            [decision.locationRefs],
          );
          const now = await transactionNow(tx);
          return workList(
            now,
            AVAILABLE,
            rows.map((r) => {
              const reasonCode =
                r.state === 'failed'
                  ? r.state_reason === 'decision_unavailable'
                    ? 'decision_unavailable'
                    : 'delivery_failed'
                  : r.state === 'unknown'
                    ? 'delivery_outcome_unknown'
                    : 'decision_unavailable';
              // Due: the visit the message is about, else one hour after the outcome was recorded.
              const due = r.due_at ?? new Date(r.updated_at.getTime() + 3_600_000);
              return workItem({
                workItemRef: r.id,
                kind: 'delivery_exception',
                reasonCode,
                explanation: EXPLANATION[reasonCode] as string,
                evidenceRefs: [
                  { kind: 'outboundMessage', ref: r.id },
                  {
                    kind:
                      r.subject_kind === 'appointment'
                        ? 'appointment'
                        : r.subject_kind === 'waitlist_offer'
                          ? 'waitlistOffer'
                          : r.subject_kind === 'message_thread'
                            ? 'messageThread'
                            : 'recallTask',
                    ref: r.subject_id,
                  },
                ],
                dueAt: due.toISOString(),
                suggestedNextAction:
                  reasonCode === 'delivery_failed'
                    ? 'verify_contact_then_resend'
                    : reasonCode === 'delivery_outcome_unknown'
                      ? 'decide_resend_or_abandon'
                      : 'contact_patient_manually',
                blockingDependencies: ['E-S1'],
                ...(reasonCode === 'delivery_outcome_unknown'
                  ? { priority: 'soon' as const, priorityRationale: 'outcome_unknown' }
                  : {}),
              });
            }),
          );
        });
      });
    },

    readDelivery(ctx: ActorContext, messageRef: string) {
      const op = 'communications.deliveries.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          assertRef(messageRef);
          const { rows } = await tx.query<{
            id: string;
            intent_id: string | null;
            intent_decision_id: string;
            thread_message_id: string | null;
            purpose: string;
            channel: string;
            delivery_key: string;
            state: string;
            state_reason: string | null;
            suppression_reason: string | null;
            provider_ref: string | null;
            attempt: number;
            version: number;
            location_ref: string;
            created_at: Date;
          }>(
            `SELECT m.id, m.intent_id, m.intent_decision_id, m.thread_message_id, m.purpose, m.channel, m.delivery_key, m.state, m.state_reason, m.suppression_reason,
               m.provider_ref, m.attempt, m.version, l.location_ref, m.created_at
             FROM cuspatlas.outbound_messages m
             LEFT JOIN cuspatlas.notification_intents i ON i.id = m.intent_id AND i.tenant_id = m.tenant_id
             LEFT JOIN cuspatlas.thread_messages tm ON tm.id = m.thread_message_id AND tm.tenant_id = m.tenant_id
             LEFT JOIN cuspatlas.message_threads t ON t.id = tm.thread_id AND t.tenant_id = tm.tenant_id
             JOIN cuspatlas.scheduling_locations l ON l.id = coalesce(i.location_id, t.location_id) AND l.tenant_id = m.tenant_id
             WHERE m.id = $1`,
            [messageRef],
          );
          const m = rows[0];
          if (!m) throw notFound();
          if (decision.locationRefs !== null && !decision.locationRefs.includes(m.location_ref))
            throw notFound();
          const attempts = await tx.query<{ attempt: number; outcome: string; occurred_at: Date }>(
            'SELECT attempt, outcome, occurred_at FROM cuspatlas.delivery_attempts WHERE message_id = $1 ORDER BY occurred_at, id LIMIT 100',
            [m.id],
          );
          const decisions = await tx.query<{
            id: string;
            stage: string;
            outcome: string;
            reason: string | null;
            deferred_until: Date | null;
            decided_at: Date;
          }>(
            `SELECT id, stage, outcome, reason, deferred_until, decided_at FROM cuspatlas.suppression_decisions
             WHERE intent_id = $1 OR message_id = $2 OR id = $3 ORDER BY decided_at, id LIMIT 100`,
            [m.intent_id, m.id, m.intent_decision_id],
          );
          const receipts = await tx.query<{
            state: string;
            occurred_at: Date;
            applied: boolean;
            pending: boolean;
          }>(
            'SELECT state, occurred_at, applied, pending FROM cuspatlas.message_receipts WHERE message_id = $1 ORDER BY received_at, id LIMIT 100',
            [m.id],
          );
          return {
            messageRef: m.id,
            intentRef: m.intent_id,
            threadMessageRef: m.thread_message_id,
            purpose: m.purpose,
            channel: m.channel,
            deliveryKey: m.delivery_key,
            state: m.state,
            stateReason: m.state_reason,
            suppressionReason: m.suppression_reason,
            providerRef: m.provider_ref,
            version: m.version,
            createdAt: m.created_at.toISOString(),
            attempts: attempts.rows.map((a) => ({
              attempt: a.attempt,
              outcome: a.outcome,
              occurredAt: a.occurred_at.toISOString(),
            })),
            decisions: decisions.rows.map((d) => ({
              decisionRef: d.id,
              stage: d.stage,
              outcome: d.outcome,
              reason: d.reason,
              deferredUntil: d.deferred_until === null ? null : d.deferred_until.toISOString(),
              decidedAt: d.decided_at.toISOString(),
            })),
            receipts: receipts.rows.map((r) => ({
              state: r.state,
              occurredAt: r.occurred_at.toISOString(),
              applied: r.applied,
              pending: r.pending,
            })),
          };
        });
      });
    },

    resolveDelivery(ctx: ActorContext, messageRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'communications.deliveries.resolve';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateDeliveryResolve, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as { expectedVersion: number; action: 'resend' | 'abandon' };
        return deps.withTenantTransaction(ctx, async (tx) => {
          assertRef(messageRef);
          const { rows } = await tx.query<{ id: string; state: string; version: number; attempt: number }>(
            'SELECT id, state, version, attempt FROM cuspatlas.outbound_messages WHERE id = $1 FOR UPDATE',
            [messageRef],
          );
          const m = rows[0];
          if (!m) throw notFound();
          return execute(ctx, { ...envelope, payload: { messageRef, ...p } }, tx, async () => {
            if (m.version !== p.expectedVersion)
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: m.version } });
            if (m.state !== 'unknown' && m.state !== 'failed') throw conflict('delivery_not_unresolved');
            // A resend keeps the delivery key: a provider that did accept the first one answers duplicate.
            const to = p.action === 'resend' ? 'queued' : 'abandoned';
            const updated = await tx.query<{ version: number }>(
              `UPDATE cuspatlas.outbound_messages SET state = $2, state_reason = $3, next_attempt_at = now(),
                 reconcile_after = NULL, version = version + 1, updated_at = now()
               WHERE id = $1 RETURNING version`,
              [m.id, to, p.action === 'resend' ? 'staff_resend' : 'staff_abandoned'],
            );
            const version = updated.rows[0]?.version as number;
            await tx.query(
              `INSERT INTO cuspatlas.delivery_attempts (tenant_id, message_id, attempt, outcome, actor_id)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id())`,
              [m.id, m.attempt, p.action === 'resend' ? 'resolved_resend' : 'resolved_abandon'],
            );
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: OUTBOUND_MESSAGE_RESOURCE,
                resourceRef: m.id,
                resourceVersion: version,
              },
              { changedFields: ['state'] },
            );
            return { data: { messageRef: m.id, state: to }, version };
          });
        });
      });
    },

    recordReceipt(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'communications.receipts.record';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateReceiptInput, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as {
          providerRef: string;
          providerEventId: string;
          state: 'delivered' | 'failed' | 'bounced';
          occurredAt: string;
          deliveryKey?: string;
        };
        const deduplicated = async (tx: TenantTransaction) => {
          const dup = await tx.query<{ state: string }>(
            `SELECT m.state FROM cuspatlas.message_receipts r JOIN cuspatlas.outbound_messages m ON m.id = r.message_id
             WHERE r.dedupe_key = $1`,
            [p.providerEventId],
          );
          // A replayed provider event changes nothing and creates no second event.
          return dup.rows[0]
            ? {
                data: { deduplicated: true, applied: false, state: dup.rows[0].state },
                version: 1,
                correlationId: ctx.correlationId,
                replayed: true,
              }
            : null;
        };
        return deps.withTenantTransaction(ctx, async (tx) => {
          const early = await deduplicated(tx);
          if (early) return early;
          let { rows } = await tx.query<{
            id: string;
            state: string;
            version: number;
            last: Date | null;
            provider_ref: string | null;
          }>(
            `SELECT id, state, version, last_receipt_at AS last, provider_ref FROM cuspatlas.outbound_messages
             WHERE provider_ref = $1 FOR UPDATE`,
            [p.providerRef],
          );
          if (!rows[0] && p.deliveryKey !== undefined) {
            // An early receipt: the provider answered before the send was recorded. It is matched by
            // the delivery key of a message that has no provider reference yet and stored pending.
            ({ rows } = await tx.query(
              `SELECT id, state, version, last_receipt_at AS last, provider_ref FROM cuspatlas.outbound_messages
               WHERE delivery_key = $1 AND provider_ref IS NULL AND state IN ('sending', 'unknown') FOR UPDATE`,
              [p.deliveryKey],
            ));
          }
          const m = rows[0];
          if (!m) throw notFound();
          // Re-checked under the message lock: a concurrent duplicate committed while this one waited.
          const late = await deduplicated(tx);
          if (late) return late;
          return execute<ReceiptData>(ctx, { ...envelope, payload: p }, tx, async () => {
            const at = new Date(p.occurredAt);
            const target = p.state === 'delivered' ? 'delivered' : 'failed';
            if (m.provider_ref === null) {
              try {
                await tx.savepoint(() =>
                  tx.query(
                    `INSERT INTO cuspatlas.message_receipts (tenant_id, message_id, dedupe_key, state, occurred_at, applied,
                       provider_ref, pending, recorded_by)
                     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, false, $5, true, cuspatlas.current_actor_id())`,
                    [m.id, p.providerEventId, p.state, at, p.providerRef],
                  ),
                );
              } catch (err) {
                if ((err as { code?: unknown }).code === '23505')
                  return { data: { deduplicated: true, applied: false, state: m.state }, version: m.version };
                throw err;
              }
              const u = await tx.query<{ version: number }>(
                `UPDATE cuspatlas.outbound_messages SET version = version + 1, updated_at = now() WHERE id = $1
                 RETURNING version`,
                [m.id],
              );
              const version = u.rows[0]?.version as number;
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: OUTBOUND_MESSAGE_RESOURCE,
                  resourceRef: m.id,
                  resourceVersion: version,
                },
                { changedFields: ['receiptPending'] },
              );
              return {
                data: { deduplicated: false, applied: false, pending: true, state: m.state },
                version,
              };
            }
            // Monotonic: only a sent or delivered message moves, never backwards in time or rank, and a
            // suppressed, abandoned or unknown message is never resurrected by a receipt.
            const movable = m.state === 'sent' || m.state === 'delivered';
            const newer = m.last === null || at.getTime() > m.last.getTime();
            const higher = (RANK[target] ?? 0) > (RANK[m.state] ?? 0);
            const apply = movable && newer && higher;
            try {
              await tx.savepoint(() =>
                tx.query(
                  `INSERT INTO cuspatlas.message_receipts (tenant_id, message_id, dedupe_key, state, occurred_at, applied,
                     provider_ref, recorded_by)
                   VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id())`,
                  [m.id, p.providerEventId, p.state, at, apply, p.providerRef],
                ),
              );
            } catch (err) {
              // A concurrent duplicate of the same provider event: the deduplicated answer, never a 500.
              if ((err as { code?: unknown }).code === '23505')
                return { data: { deduplicated: true, applied: false, state: m.state }, version: m.version };
              throw err;
            }
            // Every recorded receipt is a new message version (its own audit row), applied or not.
            const u = await tx.query<{ version: number; state: string }>(
              `UPDATE cuspatlas.outbound_messages SET state = CASE WHEN $2::boolean THEN $3 ELSE state END,
                 state_reason = CASE WHEN $2::boolean THEN $4 ELSE state_reason END,
                 last_receipt_at = GREATEST(coalesce(last_receipt_at, $5::timestamptz), $5::timestamptz),
                 version = version + 1, updated_at = now()
               WHERE id = $1 RETURNING version, state`,
              [m.id, apply, target, target === 'failed' ? `receipt_${p.state}` : null, at],
            );
            const version = u.rows[0]?.version as number;
            const state = u.rows[0]?.state as string;
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: OUTBOUND_MESSAGE_RESOURCE,
                resourceRef: m.id,
                resourceVersion: version,
              },
              { changedFields: apply ? ['state', 'receipt'] : ['receipt'] },
            );
            return { data: { deduplicated: false, applied: apply, state }, version };
          });
        });
      });
    },
  };
}
