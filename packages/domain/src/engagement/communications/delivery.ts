import { createHash } from 'node:crypto';
import type { TenantTransaction } from '@cuspatlas/contracts';
import { recordCommand } from '../../events/record-command';
import {
  CONTACT_CHANNEL,
  decideSuppression,
  type IntentPurpose,
  type MessageChannel,
  type SubjectRef,
  VERIFIED_POINTS_SQL,
} from './suppression';

/**
 * E7 delivery against the F6 worker/adapter contract with a synthetic provider only (E-S1 is
 * blocked-on-discovery). One outbound message per S14 intent E6 allowed; the intent's stable delivery
 * key is the provider idempotency key. Every send is preceded by a fresh E6 decision (stage `send`);
 * every uncertain outcome (timeout, thrown adapter, expired lease) is reconciled by a side-effect-free
 * lookup and is never resent blind: a lookup that finds nothing leaves the message `unknown` in the
 * staff worklist, where a person decides to resend (same key) or abandon.
 */
export const DELIVERY_POLICY_VERSION = 'delivery.pending-approval.1';
export const OUTBOUND_MESSAGE_RESOURCE = 'outboundMessage';

/** What the provider port receives: notice-only template text and the resolved recipient. Never logged. */
export interface MessagingSendRequest {
  readonly deliveryKey: string;
  readonly tenantId: string;
  readonly channel: MessageChannel;
  readonly recipient: string;
  readonly templateRef: string;
  readonly templateVersion: number;
  readonly body: string;
  readonly attempt: number;
}
export type MessagingSendResult =
  | { readonly outcome: 'accepted'; readonly providerRef: string }
  | { readonly outcome: 'duplicate'; readonly providerRef: string }
  | { readonly outcome: 'rejected'; readonly retryable: boolean; readonly reasonClass: string }
  | { readonly outcome: 'unknown' };
export type MessagingLookup =
  | { readonly status: 'found'; readonly providerRef: string }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable' };
/** Messaging adapter port (E7). The only implementation is the synthetic fake under tests/. */
export interface MessagingPort {
  send(request: MessagingSendRequest): Promise<MessagingSendResult>;
  lookup(deliveryKey: string): Promise<MessagingLookup>;
}
export const PROVIDER_REF = /^[A-Za-z0-9._:-]{1,128}$/;

export type MessageState =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'suppressed'
  | 'unknown'
  | 'abandoned';

export interface LeasedMessage {
  readonly messageRef: string;
  readonly tenantId: string;
  readonly deliveryKey: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** `sending` (an earlier lease expired) or `unknown`: reconcile before any send. */
  readonly priorState: 'queued' | 'sending' | 'unknown';
}

async function attemptRow(
  tx: TenantTransaction,
  messageRef: string,
  attempt: number,
  outcome: string,
  extra: { decisionId?: string | null; providerRef?: string | null } = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO cuspatlas.delivery_attempts (tenant_id, message_id, attempt, outcome, decision_id, provider_ref, actor_id)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, cuspatlas.current_actor_id())`,
    [messageRef, attempt, outcome, extra.decisionId ?? null, extra.providerRef ?? null],
  );
}

async function audit(
  tx: TenantTransaction,
  messageRef: string,
  version: number,
  fields: string[],
): Promise<void> {
  await recordCommand(
    tx,
    {
      operation: 'communications.deliver',
      resourceType: OUTBOUND_MESSAGE_RESOURCE,
      resourceRef: messageRef,
      resourceVersion: version,
    },
    { changedFields: fields },
  );
}

/** Enqueues one message per allowed, not yet enqueued intent (idempotent on the intent). */
export async function enqueueAllowed(tx: TenantTransaction, maxAttempts: number): Promise<number> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.outbound_messages (tenant_id, intent_id, patient_id, purpose, channel, template_id, delivery_key,
       intent_decision_id, state, send_after, next_attempt_at, max_attempts, created_by)
     SELECT i.tenant_id, i.id, d.subject_patient_id, i.purpose, d.channel, d.template_id, i.delivery_key, d.id, 'queued',
       s.at, s.at, $1, cuspatlas.current_actor_id()
     FROM cuspatlas.notification_intents i
     JOIN cuspatlas.suppression_decisions d ON d.id = i.suppression_decision_ref AND d.tenant_id = i.tenant_id
     LEFT JOIN cuspatlas.channel_policies p ON p.id = d.channel_policy_id
     CROSS JOIN LATERAL (SELECT CASE WHEN i.purpose = 'reminder' AND i.due_at IS NOT NULL
         THEN i.due_at - make_interval(mins => coalesce(p.reminder_lead_minutes, 0)) ELSE i.created_at END AS at) s
     WHERE d.outcome = 'allowed' AND d.channel <> 'none' AND d.template_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM cuspatlas.outbound_messages m WHERE m.intent_id = i.id)
     ORDER BY i.created_at, i.id LIMIT 100
     ON CONFLICT DO NOTHING RETURNING id`,
    [maxAttempts],
  );
  for (const r of rows) await audit(tx, r.id, 1, ['intent', 'state']);
  return rows.length;
}

/** Leases due messages of the current tenant; the attempt number is the fencing token. */
export async function leaseDue(
  tx: TenantTransaction,
  opts: { limit: number; leaseSeconds: number; quietSeconds: number },
): Promise<LeasedMessage[]> {
  const { rows } = await tx.query<{
    id: string;
    tenant_id: string;
    delivery_key: string;
    attempt: number;
    max_attempts: number;
    prior: 'queued' | 'sending' | 'unknown';
  }>(
    `WITH due AS (
       SELECT id, state FROM cuspatlas.outbound_messages
       WHERE (state = 'queued' AND next_attempt_at <= now())
          OR (state = 'sending' AND leased_until < now() - make_interval(secs => $3))
          OR (state = 'unknown' AND reconcile_after IS NOT NULL AND reconcile_after <= now())
       ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE cuspatlas.outbound_messages m SET state = 'sending', attempt = m.attempt + 1,
       leased_until = now() + make_interval(secs => $2), reconcile_after = NULL, version = m.version + 1, updated_at = now()
     FROM due WHERE m.id = due.id
     RETURNING m.id, m.tenant_id, m.delivery_key, m.attempt, m.max_attempts, due.state AS prior`,
    [Math.min(Math.max(opts.limit, 1), 100), opts.leaseSeconds, opts.quietSeconds],
  );
  return rows.map((r) => ({
    messageRef: r.id,
    tenantId: r.tenant_id,
    deliveryKey: r.delivery_key,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    priorState: r.prior,
  }));
}

/** Locks the message if this lease still owns it (state sending at this attempt), else null. */
async function owned(tx: TenantTransaction, m: LeasedMessage, minRemainingSeconds = 0) {
  const { rows } = await tx.query<{
    id: string;
    version: number;
    intent_id: string;
    purpose: IntentPurpose;
    channel: MessageChannel;
    patient_id: string;
    template_id: string;
    ok: boolean;
  }>(
    `SELECT id, version, intent_id, purpose, channel, patient_id, template_id,
       leased_until > now() + make_interval(secs => $3) AS ok
     FROM cuspatlas.outbound_messages WHERE id = $1 AND state = 'sending' AND attempt = $2 FOR UPDATE`,
    [m.messageRef, m.attempt, minRemainingSeconds],
  );
  const r = rows[0];
  return r && r.ok ? r : null;
}

async function moveTo(
  tx: TenantTransaction,
  m: LeasedMessage,
  version: number,
  to: MessageState,
  o: {
    reason?: string | null;
    suppression?: string | null;
    nextAttemptAt?: Date | null;
    providerRef?: string | null;
    reconcileAfter?: Date | null;
  } = {},
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE cuspatlas.outbound_messages SET state = $3, state_reason = $4, suppression_reason = $5,
       next_attempt_at = coalesce($6, next_attempt_at), provider_ref = coalesce($7, provider_ref),
       reconcile_after = $8, leased_until = NULL, version = version + 1, updated_at = now()
     WHERE id = $1 AND state = 'sending' AND attempt = $2`,
    [
      m.messageRef,
      m.attempt,
      to,
      o.reason ?? null,
      o.suppression ?? null,
      o.nextAttemptAt ?? null,
      o.providerRef ?? null,
      o.reconcileAfter ?? null,
    ],
  );
  if (rowCount !== 1) throw new Error('lease lost while finalizing');
  await audit(tx, m.messageRef, version + 1, ['state']);
}

export type PrepareResult =
  | { readonly action: 'send'; readonly request: MessagingSendRequest }
  | { readonly action: 'done' }
  | { readonly action: 'lease_lost' };

/**
 * The send-time recheck (E6 `decideSuppression`, stage `send`) and, when allowed, the request with
 * the recipient resolved from the patient record now. Suppression is terminal except quiet hours,
 * which defer the message to the end of the window (terminal if that is after the reminder's visit).
 */
export async function prepareSend(
  tx: TenantTransaction,
  m: LeasedMessage,
  sendAt: Date,
  minRemainingSeconds: number,
): Promise<PrepareResult> {
  const row = await owned(tx, m, minRemainingSeconds);
  if (!row) return { action: 'lease_lost' };
  const intent = await tx.query<{
    subject_kind: SubjectRef['kind'];
    subject_id: string;
    due_at: Date | null;
    time_zone: string;
  }>(
    `SELECT i.subject_kind, i.subject_id, i.due_at, l.time_zone FROM cuspatlas.notification_intents i
     JOIN cuspatlas.scheduling_locations l ON l.id = i.location_id AND l.tenant_id = i.tenant_id WHERE i.id = $1`,
    [row.intent_id],
  );
  const it = intent.rows[0];
  if (!it) throw new Error('intent missing');
  const d = await decideSuppression(tx, {
    stage: 'send',
    purpose: row.purpose,
    subject: { kind: it.subject_kind, id: it.subject_id },
    patientRef: row.patient_id,
    intentId: row.intent_id,
    messageId: row.id,
    sendAt,
    timeZone: it.time_zone,
    channelOverride: row.channel,
  });
  if (d.outcome === 'suppressed') {
    if (
      d.reason === 'quiet_hours' &&
      d.deferredUntil !== null &&
      (it.due_at === null || d.deferredUntil < it.due_at)
    ) {
      await attemptRow(tx, row.id, m.attempt, 'deferred', { decisionId: d.decisionRef });
      await tx.query(
        `UPDATE cuspatlas.outbound_messages SET state = 'queued', next_attempt_at = $3, attempt = attempt - 1,
           leased_until = NULL, version = version + 1, updated_at = now()
         WHERE id = $1 AND state = 'sending' AND attempt = $2`,
        [row.id, m.attempt, d.deferredUntil],
      );
      await audit(tx, row.id, row.version + 1, ['state', 'nextAttempt']);
      return { action: 'done' };
    }
    await attemptRow(tx, row.id, m.attempt, 'suppressed', { decisionId: d.decisionRef });
    await moveTo(tx, m, row.version, 'suppressed', { suppression: d.reason, reason: 'suppressed_at_send' });
    return { action: 'done' };
  }
  // Only a contact point whose current value carries a verification is ever addressed.
  const recipient = await tx.query<{ value: string }>(
    `SELECT v.value FROM (${VERIFIED_POINTS_SQL}) v ORDER BY v.preferred DESC LIMIT 1`,
    [row.patient_id, CONTACT_CHANNEL[row.channel]],
  );
  const template = await tx.query<{ template_ref: string; version: number; body: string; state: string }>(
    'SELECT template_ref, version, body, state FROM cuspatlas.message_templates WHERE id = $1',
    [d.templateId],
  );
  const to = recipient.rows[0]?.value;
  const t = template.rows[0];
  if (!to || !t) throw new Error('decision allowed without recipient or template');
  return {
    action: 'send',
    request: {
      deliveryKey: m.deliveryKey,
      tenantId: m.tenantId,
      channel: row.channel,
      recipient: to,
      templateRef: t.template_ref,
      templateVersion: t.version,
      body: t.body,
      attempt: m.attempt,
    },
  };
}

const RECEIPT_RANK: Readonly<Record<string, number>> = { sent: 1, delivered: 2, failed: 2 };

/**
 * Receipts that arrived while the message was still sending (stored pending against the message
 * found by its delivery key) are applied once the send is recorded with the same provider reference,
 * under the same monotonic rule as a live receipt. A pending receipt for another provider reference
 * stays unapplied.
 */
async function applyPendingReceipts(
  tx: TenantTransaction,
  messageRef: string,
  providerRef: string,
): Promise<MessageState> {
  const { rows } = await tx.query<{ state: 'delivered' | 'failed' | 'bounced'; occurred_at: Date }>(
    `SELECT state, occurred_at FROM cuspatlas.message_receipts
     WHERE message_id = $1 AND pending AND provider_ref = $2 ORDER BY occurred_at, id`,
    [messageRef, providerRef],
  );
  let state: MessageState = 'sent';
  let last: Date | null = null;
  let reason: string | null = null;
  for (const r of rows) {
    const target = r.state === 'delivered' ? 'delivered' : 'failed';
    if ((last === null || r.occurred_at > last) && (RECEIPT_RANK[target] ?? 0) > (RECEIPT_RANK[state] ?? 0)) {
      state = target;
      reason = target === 'failed' ? `receipt_${r.state}` : null;
    }
    if (last === null || r.occurred_at > last) last = r.occurred_at;
  }
  if (rows.length === 0) return 'sent';
  const u = await tx.query<{ version: number }>(
    `UPDATE cuspatlas.outbound_messages SET state = $2, state_reason = coalesce($3, state_reason),
       last_receipt_at = $4, version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
    [messageRef, state, reason, last],
  );
  await audit(tx, messageRef, u.rows[0]?.version as number, ['state', 'receipt']);
  return state;
}

/** Records a send outcome under the fence. */
export async function finalizeSend(
  tx: TenantTransaction,
  m: LeasedMessage,
  result: MessagingSendResult,
  o: { backoffSeconds: number; reconcileAfterSeconds: number },
): Promise<MessageState | 'lease_lost'> {
  const row = await owned(tx, m);
  if (!row) return 'lease_lost';
  switch (result.outcome) {
    case 'accepted':
    case 'duplicate':
      await attemptRow(tx, row.id, m.attempt, result.outcome, { providerRef: result.providerRef });
      await moveTo(tx, m, row.version, 'sent', { providerRef: result.providerRef });
      return applyPendingReceipts(tx, row.id, result.providerRef);
    case 'unknown':
      await attemptRow(tx, row.id, m.attempt, 'unknown');
      await moveTo(tx, m, row.version, 'unknown', {
        reason: 'outcome_unknown',
        reconcileAfter: new Date(Date.now() + o.reconcileAfterSeconds * 1000),
      });
      return 'unknown';
    case 'rejected': {
      const exhausted = !result.retryable || m.attempt >= m.maxAttempts;
      await attemptRow(tx, row.id, m.attempt, result.retryable ? 'rejected_transient' : 'rejected_permanent');
      if (exhausted) {
        await moveTo(tx, m, row.version, 'failed', {
          reason: result.retryable ? 'max_attempts_exhausted' : 'provider_rejected',
        });
        return 'failed';
      }
      await tx.query(
        `UPDATE cuspatlas.outbound_messages SET state = 'queued', next_attempt_at = now() + make_interval(secs => $3),
           leased_until = NULL, version = version + 1, updated_at = now()
         WHERE id = $1 AND state = 'sending' AND attempt = $2`,
        [row.id, m.attempt, o.backoffSeconds],
      );
      await audit(tx, row.id, row.version + 1, ['state', 'nextAttempt']);
      return 'queued';
    }
  }
}

/**
 * Reconciliation of an uncertain earlier attempt by delivery key (side-effect free). Found: sent.
 * Not found or unavailable: `unknown`, escalated to the worklist; never resent automatically.
 */
export async function finalizeReconciliation(
  tx: TenantTransaction,
  m: LeasedMessage,
  lookup: MessagingLookup,
  o: { reconcileAfterSeconds: number },
): Promise<MessageState | 'lease_lost'> {
  const row = await owned(tx, m);
  if (!row) return 'lease_lost';
  if (lookup.status === 'found') {
    await attemptRow(tx, row.id, m.attempt, 'reconciled_found', { providerRef: lookup.providerRef });
    await moveTo(tx, m, row.version, 'sent', { providerRef: lookup.providerRef });
    return applyPendingReceipts(tx, row.id, lookup.providerRef);
  }
  const unavailable = lookup.status === 'unavailable';
  await attemptRow(tx, row.id, m.attempt, unavailable ? 'lookup_unavailable' : 'reconciled_not_found');
  // An unavailable provider is asked again later; one that has no record waits for a person.
  await moveTo(tx, m, row.version, 'unknown', {
    reason: unavailable ? 'provider_lookup_unavailable' : 'provider_has_no_record',
    reconcileAfter:
      unavailable && m.attempt < m.maxAttempts ? new Date(Date.now() + o.reconcileAfterSeconds * 1000) : null,
  });
  return 'unknown';
}

/** A send-time decision that could not be made (consent read failure): never allowed by default. */
export async function failClosed(
  tx: TenantTransaction,
  m: LeasedMessage,
  backoffSeconds: number,
): Promise<MessageState | 'lease_lost'> {
  const row = await owned(tx, m);
  if (!row) return 'lease_lost';
  await attemptRow(tx, row.id, m.attempt, 'decision_unavailable');
  if (m.attempt >= m.maxAttempts) {
    await moveTo(tx, m, row.version, 'failed', { reason: 'decision_unavailable' });
    return 'failed';
  }
  await tx.query(
    `UPDATE cuspatlas.outbound_messages SET state = 'queued', state_reason = 'decision_unavailable',
       next_attempt_at = now() + make_interval(secs => $3), leased_until = NULL, version = version + 1, updated_at = now()
     WHERE id = $1 AND state = 'sending' AND attempt = $2`,
    [row.id, m.attempt, backoffSeconds],
  );
  await audit(tx, row.id, row.version + 1, ['state', 'nextAttempt']);
  return 'queued';
}

/** A stable, value-free digest for logs (never the delivery key's subject or any recipient). */
export const logRef = (messageRef: string) =>
  createHash('sha256').update(messageRef).digest('hex').slice(0, 16);
