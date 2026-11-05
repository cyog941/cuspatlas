import { randomUUID } from 'node:crypto';
import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  ENGAGEMENT_PROPERTIES,
  listEnvelope,
  RefusalError,
  type TenantTransaction,
  validateEmptyQuery,
  validateMessagePost,
  validateReplyPolicySet,
  validateThreadAssign,
  validateThreadClose,
  validateThreadLegalHold,
  validateThreadListQuery,
  validateThreadOpen,
} from '@cuspatlas/contracts';
import { transactionNow } from '../../clock';
import { executeOnce } from '../../commands/execute-once';
import { recordCommand } from '../../events/record-command';
import { recordSensitiveRead } from '../../events/record-sensitive-read';
import type { AuthorizationDecision } from '../../policy/authorize';
import { AVAILABLE, workItem, workList } from '../../work-items';
import {
  type AttachmentRefResolver,
  assertAttachmentRefs,
  assertRef,
  checkEnvelope,
  conflict,
  type EngagementBase,
  failedAt,
  notFound,
} from '../common';
import { decideSuppression } from '../communications/suppression';
import { requirePortalAccess } from '../portal/access';
import { boundMessages, boundThreads, lockForBounds, recordLimited } from '../portal/bounds';
import { addBusinessDays } from './reply-due';

/**
 * E5 secure messaging. Threads belong to one patient and one location and are worked by a staff
 * queue (front desk, billing, clinical team) with an optional assignee and an exception-first work
 * item while the practice owes a reply. Messages are immutable once posted (append-only; no edit or
 * delete path exists, and the database refuses both). Attachments are image or object references
 * only, authorized separately when opened (I owns the bytes). Every read of a thread, staff or
 * portal, is access-audited in the read's transaction. Bodies never reach logs, audit, outbox,
 * attempts, idempotency rows or a notification.
 *
 * A staff reply is noticed through E6/E7 only: E6 decides (purpose `message_notice`, consent purpose
 * `messaging`) and E7 delivers a notice-only template; a suppressed notice leaves the message
 * readable in the portal and reported `unnotified` with E6's reason.
 *
 * Retention (E-D5, legal review pending): the policy is data with no period decided, so no thread is
 * ever eligible; a legal-hold placeholder marks threads that must outlive any future period. Nothing
 * here deletes.
 */
export const MESSAGING_POLICY_VERSION = 'messaging.pending-approval.1';
export const RETENTION_POLICY = {
  recordClass: 'secure_messaging_administrative',
  retainDays: null,
  status: 'pending_legal_review',
  version: 'retention.pending-approval.1',
} as const;
const QUEUE: Readonly<Record<string, 'front_desk' | 'billing' | 'clinical_team'>> = {
  appointment: 'front_desk',
  forms: 'front_desk',
  general: 'front_desk',
  billing: 'billing',
};
const WORK_QUEUE = {
  front_desk: 'front_desk',
  billing: 'practice_manager',
  clinical_team: 'practice_manager',
} as const;
/**
 * E10 / OR-D4: the reply-due time of a thread awaiting the practice is a per-queue policy in business
 * days (messaging_reply_policies); a queue with no row uses this default.
 */
export const DEFAULT_REPLY_DUE_BUSINESS_DAYS = 1;
export type ThreadQueue = 'front_desk' | 'billing' | 'clinical_team';
const THREAD_QUEUES: readonly ThreadQueue[] = ['front_desk', 'billing', 'clinical_team'];
const PAGE_DEFAULT = 50;
const ESCALATION_QUEUE = 'practice_manager';

export type PolicyMap = Readonly<
  Record<ThreadQueue, { replyDueBusinessDays: number; source: 'default' | 'configured' }>
>;

export async function loadPolicies(tx: TenantTransaction): Promise<PolicyMap> {
  const { rows } = await tx.query<{ queue: ThreadQueue; reply_due_business_days: number }>(
    'SELECT queue, reply_due_business_days FROM cuspatlas.messaging_reply_policies',
  );
  const out = Object.fromEntries(
    THREAD_QUEUES.map((q) => [
      q,
      { replyDueBusinessDays: DEFAULT_REPLY_DUE_BUSINESS_DAYS, source: 'default' as const },
    ]),
  ) as Record<ThreadQueue, { replyDueBusinessDays: number; source: 'default' | 'configured' }>;
  for (const r of rows)
    out[r.queue] = { replyDueBusinessDays: r.reply_due_business_days, source: 'configured' };
  return out;
}

export const replyDueAt = (lastMessageAt: Date, queue: ThreadQueue, zone: string, policies: PolicyMap) =>
  addBusinessDays(lastMessageAt, policies[queue].replyDueBusinessDays, zone);

/**
 * The staff reader's read receipt (a fact per thread and staff principal, no content): the newest
 * message of the thread is now read. Idempotent and monotonic.
 */
async function markRead(tx: TenantTransaction, threadId: string): Promise<void> {
  await tx.query(
    `INSERT INTO cuspatlas.thread_read_receipts (tenant_id, thread_id, principal_id, last_read_at)
     SELECT cuspatlas.current_tenant_id(), $1::uuid, cuspatlas.current_actor_id(), max(created_at)
     FROM cuspatlas.thread_messages WHERE thread_id = $1::uuid HAVING count(*) > 0
     ON CONFLICT (thread_id, principal_id)
     DO UPDATE SET last_read_at = greatest(cuspatlas.thread_read_receipts.last_read_at, EXCLUDED.last_read_at),
       updated_at = clock_timestamp()`,
    [threadId],
  );
}

/**
 * Overdue escalation, derived at read. Every read of the queue (list, worklist) first records, for each
 * visible thread whose reply is overdue, one escalation fact keyed by (thread, unanswered portal
 * message) with ON CONFLICT DO NOTHING, so the escalation happens exactly once per unanswered episode
 * however many readers, retries or concurrent workers there are. The worker also sweeps every served
 * tenant (`sweepReplyEscalations`, Closeout A4), so an episode escalates without a human read. A reply
 * and a later portal message start a new episode (a new key). The escalation moves the work item to the
 * practice manager queue; it never changes the thread and never records a read receipt.
 */
interface EscalationCandidate extends Record<string, unknown> {
  id: string;
  queue: ThreadQueue;
  version: number;
  episode_at: Date;
  time_zone: string;
  trigger_id: string;
}

async function escalateOverdue(
  tx: TenantTransaction,
  decision: AuthorizationDecision,
  policies: PolicyMap,
  now: Date,
): Promise<number> {
  let escalated = 0;
  // R7: the cutoff is each queue's own policy (business days are never shorter than calendar days, so
  // an episode younger than the policy in days cannot be due); batches walk the whole set, so a queue
  // with a long policy never starves another.
  const queues = THREAD_QUEUES.map((q) => q as string);
  const days = THREAD_QUEUES.map((q) => policies[q].replyDueBusinessDays);
  // The keyset is the millisecond instant a JavaScript Date carries: ordering and comparing by the
  // microsecond created_at would re-read the last row of every batch (clock audit, precision).
  let after = null as { at: Date; id: string } | null;
  for (let batch = 0; batch < 20; batch += 1) {
    const { rows }: { rows: EscalationCandidate[] } = await tx.query<EscalationCandidate>(
      `SELECT t.id, t.queue, t.version, ep.created_at AS episode_at, l.time_zone, ep.id AS trigger_id
       FROM cuspatlas.message_threads t
       JOIN cuspatlas.scheduling_locations l ON l.id = t.location_id AND l.tenant_id = t.tenant_id
       JOIN LATERAL (SELECT m.id, m.created_at FROM cuspatlas.thread_messages m
       WHERE m.thread_id = t.id AND m.author_kind = 'portal'
         AND m.created_at > coalesce((SELECT max(s.created_at) FROM cuspatlas.thread_messages s
                                      WHERE s.thread_id = t.id AND s.author_kind = 'staff'), '-infinity'::timestamptz)
       ORDER BY m.created_at, m.id LIMIT 1) ep ON true
       JOIN unnest($3::text[], $4::int[]) AS pol(queue, days) ON pol.queue = t.queue
       WHERE t.state = 'open' AND t.awaiting = 'practice'
         AND ep.created_at <= $2::timestamptz - make_interval(days => pol.days)
         AND ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[]))
         AND ($5::timestamptz IS NULL OR (date_trunc('milliseconds', ep.created_at), t.id) > ($5::timestamptz, $6::uuid))
         AND NOT EXISTS (SELECT 1 FROM cuspatlas.thread_reply_escalations e
           WHERE e.thread_id = t.id AND e.trigger_message_id = ep.id)
       ORDER BY date_trunc('milliseconds', ep.created_at), t.id LIMIT 500`,
      [decision.locationRefs, now, queues, days, after?.at ?? null, after?.id ?? null],
    );
    for (const t of rows) {
      const due = replyDueAt(t.episode_at, t.queue, t.time_zone, policies);
      if (due.getTime() > now.getTime()) continue;
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO cuspatlas.thread_reply_escalations (tenant_id, thread_id, trigger_message_id, due_at, escalated_to_queue)
         VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4)
         ON CONFLICT (thread_id, trigger_message_id) DO NOTHING RETURNING id`,
        [t.id, t.trigger_id, due, ESCALATION_QUEUE],
      );
      if (ins.rows[0]) {
        escalated += 1;
        await recordCommand(
          tx,
          {
            operation: 'messaging.threads.escalate',
            resourceType: 'messageThread',
            resourceRef: t.id,
            resourceVersion: t.version,
          },
          { changedFields: ['escalation'] },
        );
      }
    }
    const last: EscalationCandidate | undefined = rows[rows.length - 1];
    if (rows.length < 500 || !last) break;
    after = { at: last.episode_at, id: last.id };
  }
  return escalated;
}

interface QueueRow extends ThreadRow {
  time_zone: string;
  unread: boolean;
  needs_reply: boolean;
  escalated_at: Date | null;
  /** R7: the first portal message after the last staff message (the episode start), or null. */
  episode_at: Date | null;
}

/** The thread set the queue reads: E5 threads plus the caller's receipt and the escalation of the episode. */
const QUEUE_BASE = `WITH base AS (
  SELECT t.id, t.patient_id, l.location_ref, l.time_zone, t.topic, t.queue, t.state, t.awaiting, t.assigned_to,
    t.retention_class, t.legal_hold, t.legal_hold_reason, t.opened_via, t.close_reason, t.last_message_at, t.version,
    t.created_at,
    coalesce(lp.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz), false) AS unread,
    (t.state = 'open' AND t.awaiting = 'practice') AS needs_reply,
    e.escalated_at,
    ep.created_at AS episode_at
  FROM cuspatlas.message_threads t
  JOIN cuspatlas.scheduling_locations l ON l.id = t.location_id AND l.tenant_id = t.tenant_id
  LEFT JOIN LATERAL (SELECT m.id, m.created_at FROM cuspatlas.thread_messages m
    WHERE m.thread_id = t.id AND m.author_kind = 'portal' ORDER BY m.created_at DESC, m.id DESC LIMIT 1) lp ON true
  LEFT JOIN LATERAL (SELECT m.id, m.created_at FROM cuspatlas.thread_messages m
    WHERE m.thread_id = t.id AND m.author_kind = 'portal'
      AND m.created_at > coalesce((SELECT max(s.created_at) FROM cuspatlas.thread_messages s
                                   WHERE s.thread_id = t.id AND s.author_kind = 'staff'), '-infinity'::timestamptz)
    ORDER BY m.created_at, m.id LIMIT 1) ep ON true
  LEFT JOIN cuspatlas.thread_read_receipts r
    ON r.thread_id = t.id AND r.principal_id = cuspatlas.current_actor_id()
  LEFT JOIN cuspatlas.thread_reply_escalations e ON e.thread_id = t.id AND e.trigger_message_id = ep.id
  WHERE ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[]))
    AND ($2::text IS NULL OR t.queue = $2::text)
    AND ($3::uuid IS NULL OR t.assigned_to = $3::uuid))`;

function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const m = /^o:(\d{1,6})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!m) throw failedAt('/cursor', 'invalid');
  return Number(m[1]);
}
const cursorOf = (offset: number) => Buffer.from(`o:${offset}`, 'utf8').toString('base64url');

interface ThreadRow extends Record<string, unknown> {
  id: string;
  patient_id: string;
  location_ref: string;
  topic: string;
  queue: 'front_desk' | 'billing' | 'clinical_team';
  state: 'open' | 'closed';
  awaiting: 'practice' | 'patient';
  assigned_to: string | null;
  retention_class: string;
  legal_hold: boolean;
  legal_hold_reason: string | null;
  opened_via: string;
  close_reason: string | null;
  last_message_at: Date;
  version: number;
  created_at: Date;
}
type Attachment = { kind: 'imageRef' | 'objectRef'; ref: string };

const THREAD_SELECT = `SELECT t.id, t.patient_id, l.location_ref, t.topic, t.queue, t.state, t.awaiting, t.assigned_to,
  t.retention_class, t.legal_hold, t.legal_hold_reason, t.opened_via, t.close_reason, t.last_message_at, t.version,
  t.created_at
  FROM cuspatlas.message_threads t
  JOIN cuspatlas.scheduling_locations l ON l.id = t.location_id AND l.tenant_id = t.tenant_id`;

async function loadThread(
  tx: TenantTransaction,
  threadRef: string,
  decision: AuthorizationDecision | null,
  lock = false,
): Promise<ThreadRow> {
  assertRef(threadRef);
  const { rows } = await tx.query<ThreadRow>(
    `${THREAD_SELECT} WHERE t.id = $1${lock ? ' FOR UPDATE OF t' : ''}`,
    [threadRef],
  );
  const t = rows[0];
  if (!t) throw notFound();
  // A location-restricted member sees only threads of its locations (indistinguishable from missing).
  if (decision?.locationRefs && !decision.locationRefs.includes(t.location_ref)) throw notFound();
  return t;
}

async function insertMessage(
  tx: TenantTransaction,
  operation: string,
  resolver: AttachmentRefResolver | undefined,
  m: {
    thread: { id: string; patient_id: string };
    authorKind: 'portal' | 'staff';
    via: string | null;
    body: string;
    attachments: Attachment[];
  },
): Promise<{
  messageRef: string;
  notice: { decisionRef: string; outcome: string; reason: string | null } | null;
}> {
  // Attachment references must exist for this patient in this tenant (I's reference read, via the port).
  await assertAttachmentRefs(resolver, tx, m.thread.patient_id, m.attachments);
  // E6 decides the notice of a staff reply in the same transaction (fail closed on any error).
  const decision =
    m.authorKind === 'staff'
      ? await decideSuppression(tx, {
          stage: 'intent',
          purpose: 'message_notice',
          subject: { kind: 'message_thread', id: m.thread.id },
          patientRef: m.thread.patient_id,
        })
      : null;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.thread_messages (tenant_id, thread_id, author_id, author_kind, via_relationship_id, body,
       attachments, notice_decision_id)
     VALUES (cuspatlas.current_tenant_id(), $1, cuspatlas.current_actor_id(), $2, $3, $4, $5::jsonb, $6) RETURNING id`,
    [m.thread.id, m.authorKind, m.via, m.body, JSON.stringify(m.attachments), decision?.decisionRef ?? null],
  );
  const id = rows[0]?.id as string;
  await recordCommand(
    tx,
    { operation, resourceType: 'threadMessage', resourceRef: id, resourceVersion: 1 },
    { changedFields: ['body', 'attachments'] },
  );
  return {
    messageRef: id,
    notice: decision
      ? { decisionRef: decision.decisionRef, outcome: decision.outcome, reason: decision.reason }
      : null,
  };
}

async function touchThread(
  tx: TenantTransaction,
  operation: string,
  t: ThreadRow,
  set: { awaiting?: 'practice' | 'patient' },
): Promise<number> {
  const { rows } = await tx.query<{ version: number }>(
    `UPDATE cuspatlas.message_threads SET awaiting = coalesce($2, awaiting), last_message_at = clock_timestamp(),
       version = version + 1 WHERE id = $1 RETURNING version`,
    [t.id, set.awaiting ?? null],
  );
  const version = rows[0]?.version as number;
  await recordCommand(
    tx,
    { operation, resourceType: 'messageThread', resourceRef: t.id, resourceVersion: version },
    { changedFields: ['lastMessage', 'awaiting'] },
  );
  return version;
}

async function locationId(
  tx: TenantTransaction,
  locationRef: string,
  decision: AuthorizationDecision | null,
) {
  if (decision?.locationRefs && !decision.locationRefs.includes(locationRef)) throw notFound();
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM cuspatlas.scheduling_locations WHERE location_ref = $1',
    [locationRef],
  );
  if (!rows[0]) throw notFound();
  return rows[0].id;
}

/** The notice state of each staff message: E7's delivery, else E6's suppression (unnotified). */
async function messagesOf(tx: TenantTransaction, threadRef: string) {
  const { rows } = await tx.query<{
    id: string;
    author_id: string;
    author_kind: 'portal' | 'staff';
    body: string;
    attachments: Attachment[];
    created_at: Date;
    decision_outcome: string | null;
    decision_reason: string | null;
    delivery_state: string | null;
    delivery_reason: string | null;
  }>(
    `SELECT tm.id, tm.author_id, tm.author_kind, tm.body, tm.attachments, tm.created_at, d.outcome AS decision_outcome,
       d.reason AS decision_reason, o.state AS delivery_state, o.suppression_reason AS delivery_reason
     FROM cuspatlas.thread_messages tm
     LEFT JOIN cuspatlas.suppression_decisions d ON d.id = tm.notice_decision_id AND d.tenant_id = tm.tenant_id
     LEFT JOIN cuspatlas.outbound_messages o ON o.thread_message_id = tm.id AND o.tenant_id = tm.tenant_id
     WHERE tm.thread_id = $1 ORDER BY tm.created_at, tm.id LIMIT 500`,
    [threadRef],
  );
  return rows.map((r) => {
    const notice =
      r.author_kind !== 'staff'
        ? null
        : r.delivery_state !== null
          ? {
              state: r.delivery_state === 'suppressed' ? 'unnotified' : r.delivery_state,
              reason: r.delivery_reason,
            }
          : r.decision_outcome === 'suppressed'
            ? { state: 'unnotified', reason: r.decision_reason }
            : { state: 'pending', reason: null };
    return { ...r, notice };
  });
}

const attachmentsOut = (a: Attachment[]) =>
  a.map((x) => ({ kind: x.kind, ref: x.ref, authorization: 'separate_grant_required' }));

export function createMessagingOperations(base: EngagementBase) {
  const { deps } = base;
  const execute = deps.execute ?? executeOnce;

  function threadOut(t: ThreadRow) {
    return {
      threadRef: t.id,
      patientRef: t.patient_id,
      locationRef: t.location_ref,
      topic: t.topic,
      queue: t.queue,
      state: t.state,
      awaiting: t.awaiting,
      assigneeRef: t.assigned_to,
      retentionClass: t.retention_class,
      legalHold: t.legal_hold,
      openedVia: t.opened_via,
      closeReason: t.close_reason,
      lastMessageAt: t.last_message_at.toISOString(),
      version: t.version,
    };
  }

  async function openThreadIn(
    tx: TenantTransaction,
    op: string,
    o: {
      patientRef: string;
      via: 'portal' | 'staff';
      viaRelationship: string | null;
      locationId: string;
      topic: string;
      body: string;
      attachments: Attachment[];
    },
  ) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cuspatlas.message_threads (tenant_id, patient_id, location_id, topic, queue, awaiting, opened_via,
         opened_by, via_relationship_id)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id(), $7) RETURNING id`,
      [
        o.patientRef,
        o.locationId,
        o.topic,
        QUEUE[o.topic] ?? 'front_desk',
        o.via === 'portal' ? 'practice' : 'patient',
        o.via,
        o.viaRelationship,
      ],
    );
    const threadId = rows[0]?.id as string;
    await recordCommand(
      tx,
      { operation: op, resourceType: 'messageThread', resourceRef: threadId, resourceVersion: 1 },
      { changedFields: ['patient', 'topic', 'queue'] },
    );
    const m = await insertMessage(tx, op, deps.attachmentRefs, {
      thread: { id: threadId, patient_id: o.patientRef },
      authorKind: o.via,
      via: o.viaRelationship,
      body: o.body,
      attachments: o.attachments,
    });
    return {
      data: {
        threadRef: threadId,
        messageRef: m.messageRef,
        state: 'open',
        noticeOutcome: m.notice?.outcome ?? null,
        noticeReason: m.notice?.reason ?? null,
      },
      version: 1,
    };
  }

  const portalVia = (access: Awaited<ReturnType<typeof requirePortalAccess>>) =>
    access.via === 'self'
      ? null
      : (access.access?.relationships.find((r) => r.status === 'active' && r.scopes.includes('consent'))
          ?.relationshipRef ?? null);

  return {
    // ---- staff ----
    openStaffThread(ctx: ActorContext, patientRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'messaging.threads.open';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateThreadOpen, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as {
          topic: string;
          locationRef: string;
          body: string;
          attachments?: Attachment[];
        };
        return deps.withTenantTransaction(ctx, async (tx) => {
          assertRef(patientRef);
          const pt = await tx.query<{ merged_into: string | null }>(
            'SELECT merged_into FROM cuspatlas.patients WHERE id = $1 FOR SHARE',
            [patientRef],
          );
          if (!pt.rows[0]) throw notFound();
          const loc = await locationId(tx, p.locationRef, decision);
          return execute(ctx, { ...envelope, payload: { patientRef, ...p } }, tx, async () => {
            if (pt.rows[0]?.merged_into !== null) throw conflict('patient_merged');
            return openThreadIn(tx, op, {
              patientRef,
              via: 'staff',
              viaRelationship: null,
              locationId: loc,
              topic: p.topic,
              body: p.body,
              attachments: p.attachments ?? [],
            });
          });
        });
      });
    },

    postStaffMessage(ctx: ActorContext, threadRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'messaging.messages.post';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateMessagePost, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as { body: string; attachments?: Attachment[] };
        return deps.withTenantTransaction(ctx, async (tx) => {
          const t = await loadThread(tx, threadRef, decision, true);
          return execute(ctx, { ...envelope, payload: { threadRef, ...p } }, tx, async () => {
            // Closing stops participant messages, not staff replies.
            const m = await insertMessage(tx, op, deps.attachmentRefs, {
              thread: t,
              authorKind: 'staff',
              via: null,
              body: p.body,
              attachments: p.attachments ?? [],
            });
            const version = await touchThread(tx, op, t, { awaiting: 'patient' });
            await markRead(tx, t.id);
            return {
              data: {
                threadRef: t.id,
                messageRef: m.messageRef,
                noticeOutcome: m.notice?.outcome ?? null,
                noticeReason: m.notice?.reason ?? null,
              },
              version,
            };
          });
        });
      });
    },

    readStaffThread(ctx: ActorContext, threadRef: string) {
      const op = 'messaging.threads.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const t = await loadThread(tx, threadRef, decision);
          const messages = await messagesOf(tx, t.id);
          await markRead(tx, t.id);
          // Access audit of every read (who read which thread of which patient, never the content).
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'messageThread',
            resourceRefs: [t.id, t.patient_id],
            queryFields: [],
          });
          return {
            ...threadOut(t),
            messages: messages.map((m) => ({
              messageRef: m.id,
              authorKind: m.author_kind,
              authorRef: m.author_id,
              body: m.body,
              attachments: attachmentsOut(m.attachments),
              postedAt: m.created_at.toISOString(),
              notice: m.notice,
            })),
          };
        });
      });
    },

    threadWorklist(ctx: ActorContext, query: unknown) {
      const op = 'messaging.threads.worklist';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        const mayEscalate = ctx.principal === 'human' && (await base.can(ctx, 'messaging.messages.post'));
        return deps.withTenantTransaction(ctx, async (tx) => {
          const now = await transactionNow(tx);
          const policies = await loadPolicies(tx);
          // R7: only staff who may reply record the escalation fact; other readers see it derived.
          if (mayEscalate) await escalateOverdue(tx, decision, policies, now);
          // The needs-reply queue (E10) and this work item share one predicate: open and awaiting the practice.
          const { rows } = await tx.query<QueueRow>(
            `${QUEUE_BASE} SELECT * FROM base WHERE needs_reply ORDER BY last_message_at, id LIMIT 500`,
            [decision.locationRefs, null, null],
          );
          return workList(
            now,
            AVAILABLE,
            rows.map((t) => {
              const due = replyDueAt(t.episode_at ?? t.last_message_at, t.queue, t.time_zone, policies);
              // R7: an overdue item is in the escalation queue for every reader, recorded or not yet.
              const escalated = t.escalated_at !== null || due.getTime() <= now.getTime();
              return workItem({
                workItemRef: t.id,
                kind: 'message_awaiting_reply',
                reasonCode: 'patient_message_unanswered',
                explanation:
                  'A patient or guardian wrote in a secure-message thread and the practice has not replied yet. Read the thread in the staff view and reply, or close it with a reason.',
                evidenceRefs: [
                  { kind: 'messageThread', ref: t.id },
                  { kind: 'patient', ref: t.patient_id },
                ],
                owner: {
                  queue: escalated ? ESCALATION_QUEUE : WORK_QUEUE[t.queue],
                  principalRef: t.assigned_to,
                },
                dueAt: due.toISOString(),
                suggestedNextAction: t.assigned_to === null ? 'assign_then_reply' : 'reply',
                blockingDependencies: [],
                priorityRationale: escalated ? 'reply_overdue_escalated' : 'reply_due_by_queue_policy',
              });
            }),
          );
        });
      });
    },

    /**
     * E10 / OR-08 thread list with the all, unread and needs_reply filters, counts per filter, the
     * per-queue reply-due policy and the OR-01 envelope. Reads no message body.
     */
    listThreads(ctx: ActorContext, query: unknown) {
      const op = 'messaging.threads.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        assertValid(validateThreadListQuery, query, ENGAGEMENT_PROPERTIES);
        const q = query as {
          filter?: 'all' | 'unread' | 'needs_reply';
          queue?: ThreadQueue;
          assigneeRef?: string;
          limit?: string;
          cursor?: string;
        };
        const filter = q.filter ?? 'all';
        const limit = q.limit === undefined ? PAGE_DEFAULT : Number(q.limit);
        const offset = offsetOf(q.cursor);
        const mayEscalate = ctx.principal === 'human' && (await base.can(ctx, 'messaging.messages.post'));
        return deps.withTenantTransaction(ctx, async (tx) => {
          const now = await transactionNow(tx);
          const policies = await loadPolicies(tx);
          // R7: only staff who may reply record the escalation fact; other readers see it derived.
          if (mayEscalate) await escalateOverdue(tx, decision, policies, now);
          const args = [decision.locationRefs, q.queue ?? null, q.assigneeRef ?? null];
          const counts = (
            await tx.query<{ all: string; unread: string; needs_reply: string }>(
              `${QUEUE_BASE} SELECT count(*) AS "all", count(*) FILTER (WHERE unread) AS unread,
                 count(*) FILTER (WHERE needs_reply) AS needs_reply FROM base`,
              args,
            )
          ).rows[0];
          const total = Number(counts?.[filter] ?? 0);
          // needs_reply works the oldest unanswered first; the other filters show the newest activity first.
          const direction = filter === 'needs_reply' ? 'asc' : 'desc';
          const { rows } = await tx.query<QueueRow>(
            `${QUEUE_BASE} SELECT * FROM base
             WHERE ($4::text = 'all' OR ($4::text = 'unread' AND unread) OR ($4::text = 'needs_reply' AND needs_reply))
             ORDER BY last_message_at ${direction}, id ${direction} LIMIT $5 OFFSET $6`,
            [...args, filter, limit, offset],
          );
          const next = offset + rows.length < total ? cursorOf(offset + rows.length) : null;
          return {
            ...listEnvelope({
              asOf: now,
              appliedFilters: { filter, queue: q.queue ?? null, assigneeRef: q.assigneeRef ?? null },
              locationRefs: decision.locationRefs,
              limit,
              nextCursor: next,
              ordering: { key: 'lastMessageAt', direction, tieBreak: 'threadRef' },
              total,
            }),
            counts: {
              all: Number(counts?.all ?? 0),
              unread: Number(counts?.unread ?? 0),
              needs_reply: Number(counts?.needs_reply ?? 0),
            },
            policies,
            items: rows.map((t) => {
              const due = t.needs_reply
                ? replyDueAt(t.episode_at ?? t.last_message_at, t.queue, t.time_zone, policies)
                : null;
              return {
                ...threadOut(t),
                unread: t.unread,
                needsReply: t.needs_reply,
                replyDueAt: due?.toISOString() ?? null,
                overdue: due !== null && due.getTime() <= now.getTime(),
                escalatedAt: t.needs_reply ? (t.escalated_at?.toISOString() ?? null) : null,
              };
            }),
          };
        });
      });
    },

    /**
     * E10 / OR-08 (Closeout A4): the worker's overdue-escalation sweep, as its own service principal
     * (service only). The same escalation as a staff read: each queue's reply-due policy is the
     * threshold, one append-only fact per unanswered episode (the unique key and ON CONFLICT make
     * repeated and concurrent sweeps escalate once), audited as `messaging.threads.escalate` with the
     * worker as actor. It records no read receipt and never changes the thread.
     */
    sweepReplyEscalations(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<{ escalated: number }> {
      const op = 'messaging.threads.escalate';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateEmptyQuery, envelope.payload, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const now = await transactionNow(tx);
          const policies = await loadPolicies(tx);
          return { escalated: await escalateOverdue(tx, decision, policies, now) };
        });
      });
    },

    /** E10 / OR-D4: set a staff queue's reply-due time in business days. Administration. */
    setReplyPolicy(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'messaging.replyPolicy.set';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateReplyPolicySet, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as { queue: ThreadQueue; replyDueBusinessDays: number };
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            const { rows } = await tx.query<{ version: number }>(
              `INSERT INTO cuspatlas.messaging_reply_policies (tenant_id, queue, reply_due_business_days, updated_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id())
               ON CONFLICT (tenant_id, queue) DO UPDATE SET reply_due_business_days = EXCLUDED.reply_due_business_days,
                 version = cuspatlas.messaging_reply_policies.version + 1, updated_by = EXCLUDED.updated_by,
                 updated_at = clock_timestamp()
               RETURNING version`,
              [p.queue, p.replyDueBusinessDays],
            );
            const version = rows[0]?.version as number;
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: 'messagingReplyPolicy',
                resourceRef: randomUUID(),
                resourceVersion: version,
              },
              { changedFields: ['replyDue'] },
            );
            return { data: { queue: p.queue, replyDueBusinessDays: p.replyDueBusinessDays }, version };
          }),
        );
      });
    },

    closeThread(ctx: ActorContext, threadRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'messaging.threads.close';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateThreadClose, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as { expectedVersion: number; reasonCode: string };
        return deps.withTenantTransaction(ctx, async (tx) => {
          const t = await loadThread(tx, threadRef, decision, true);
          return execute(ctx, { ...envelope, payload: { threadRef, ...p } }, tx, async () => {
            if (t.version !== p.expectedVersion)
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: t.version } });
            if (t.state === 'closed') throw conflict('thread_closed');
            const { rows } = await tx.query<{ version: number }>(
              `UPDATE cuspatlas.message_threads SET state = 'closed', close_reason = $2, closed_by = cuspatlas.current_actor_id(),
                 closed_at = now(), version = version + 1 WHERE id = $1 RETURNING version`,
              [t.id, p.reasonCode],
            );
            const version = rows[0]?.version as number;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'messageThread', resourceRef: t.id, resourceVersion: version },
              { changedFields: ['state'] },
            );
            return { data: { threadRef: t.id, state: 'closed' }, version };
          });
        });
      });
    },

    assignThread(ctx: ActorContext, threadRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'messaging.threads.assign';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateThreadAssign, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as { expectedVersion: number; assigneeRef: string | null };
        return deps.withTenantTransaction(ctx, async (tx) => {
          const t = await loadThread(tx, threadRef, decision, true);
          return execute(ctx, { ...envelope, payload: { threadRef, ...p } }, tx, async () => {
            if (t.version !== p.expectedVersion)
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: t.version } });
            if (p.assigneeRef !== null) {
              // The assignee must be a live human member of this tenant who may write messages.
              const m = await tx.query(
                `SELECT 1 FROM cuspatlas.memberships m JOIN cuspatlas.principals pr ON pr.id = m.principal_id
                 WHERE m.principal_id = $1 AND m.revoked_at IS NULL AND pr.kind = 'human'
                   AND 'messaging.write' = ANY (m.scopes)`,
                [p.assigneeRef],
              );
              if (m.rowCount === 0) throw failedAt('/assigneeRef', 'assigneeNotEligible');
            }
            const { rows } = await tx.query<{ version: number }>(
              'UPDATE cuspatlas.message_threads SET assigned_to = $2, version = version + 1 WHERE id = $1 RETURNING version',
              [t.id, p.assigneeRef],
            );
            const version = rows[0]?.version as number;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'messageThread', resourceRef: t.id, resourceVersion: version },
              { changedFields: ['assignee'] },
            );
            return { data: { threadRef: t.id, assigneeRef: p.assigneeRef }, version };
          });
        });
      });
    },

    setLegalHold(ctx: ActorContext, threadRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'messaging.threads.hold';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateThreadLegalHold, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as { expectedVersion: number; hold: boolean; reasonCode?: string };
        if (p.hold && p.reasonCode === undefined) throw failedAt('/reasonCode', 'required');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const t = await loadThread(tx, threadRef, decision, true);
          return execute(ctx, { ...envelope, payload: { threadRef, ...p } }, tx, async () => {
            if (t.version !== p.expectedVersion)
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: t.version } });
            const { rows } = await tx.query<{ version: number }>(
              `UPDATE cuspatlas.message_threads SET legal_hold = $2, legal_hold_reason = $3, version = version + 1
               WHERE id = $1 RETURNING version`,
              [t.id, p.hold, p.hold ? (p.reasonCode ?? null) : null],
            );
            const version = rows[0]?.version as number;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'messageThread', resourceRef: t.id, resourceVersion: version },
              { changedFields: ['legalHold'] },
            );
            return { data: { threadRef: t.id, legalHold: p.hold }, version };
          });
        });
      });
    },

    /** Names whether a thread is eligible under the retention policy, without deleting anything. */
    evaluateRetention(ctx: ActorContext, threadRef: string) {
      const op = 'messaging.retention.evaluate';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const t = await loadThread(tx, threadRef, decision);
          return {
            threadRef: t.id,
            retentionClass: t.retention_class,
            policy: RETENTION_POLICY,
            eligible: false,
            heldReason: t.legal_hold ? 'legal_hold' : 'retention_period_undecided',
            legalHoldReason: t.legal_hold_reason,
            evaluatedAt:
              (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at.toISOString() ?? null,
          };
        });
      });
    },

    // ---- portal ----
    openPortalThread(ctx: ActorContext, patientRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'portal.threads.open';
      return base.guarded(ctx, op, async () => {
        checkEnvelope(envelope, op);
        assertValid(validateThreadOpen, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as {
          topic: string;
          locationRef: string;
          body: string;
          attachments?: Attachment[];
        };
        try {
          return await deps.withTenantTransaction(ctx, async (tx) => {
            // Lock-free pre-check, bounds locks, then the full authority check with the locks held.
            await lockForBounds(tx, patientRef);
            const access = await requirePortalAccess(tx, patientRef, ['consent']);
            const loc = await locationId(tx, p.locationRef, null);
            return execute(ctx, { ...envelope, payload: { patientRef, ...p } }, tx, async () => {
              await boundThreads(tx, access.patientRef);
              return openThreadIn(tx, op, {
                patientRef: access.patientRef,
                via: 'portal',
                viaRelationship: portalVia(access),
                locationId: loc,
                topic: p.topic,
                body: p.body,
                attachments: p.attachments ?? [],
              });
            });
          });
        } catch (err) {
          await recordLimited(base, ctx, op, err);
          throw err;
        }
      });
    },

    postPortalMessage(
      ctx: ActorContext,
      patientRef: string,
      threadRef: string,
      envelope: CommandEnvelope<unknown>,
    ) {
      const op = 'portal.threads.post';
      return base.guarded(ctx, op, async () => {
        checkEnvelope(envelope, op);
        assertValid(validateMessagePost, envelope.payload, ENGAGEMENT_PROPERTIES);
        const p = envelope.payload as { body: string; attachments?: Attachment[] };
        try {
          return await deps.withTenantTransaction(ctx, async (tx) => {
            await lockForBounds(tx, patientRef);
            const access = await requirePortalAccess(tx, patientRef, ['consent']);
            const t = await loadThread(tx, threadRef, null, true);
            if (t.patient_id !== access.patientRef) throw notFound();
            return execute(ctx, { ...envelope, payload: { patientRef, threadRef, ...p } }, tx, async () => {
              if (t.state === 'closed') throw conflict('thread_closed');
              await boundMessages(tx);
              const m = await insertMessage(tx, op, deps.attachmentRefs, {
                thread: t,
                authorKind: 'portal',
                via: portalVia(access),
                body: p.body,
                attachments: p.attachments ?? [],
              });
              const version = await touchThread(tx, op, t, { awaiting: 'practice' });
              return { data: { threadRef: t.id, messageRef: m.messageRef }, version };
            });
          });
        } catch (err) {
          await recordLimited(base, ctx, op, err);
          throw err;
        }
      });
    },

    readPortalThread(ctx: ActorContext, patientRef: string, threadRef: string, query: unknown) {
      return base.guarded(ctx, 'portal.threads.read', async () => {
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const access = await requirePortalAccess(tx, patientRef, ['consent']);
          const t = await loadThread(tx, threadRef, null);
          if (t.patient_id !== access.patientRef) throw notFound();
          const messages = await messagesOf(tx, t.id);
          await recordSensitiveRead(tx, {
            operation: 'portal.threads.read',
            resourceType: 'messageThread',
            resourceRefs: [t.id, t.patient_id],
            queryFields: [],
          });
          // The portal never learns which staff member wrote, nor the notice internals.
          return {
            threadRef: t.id,
            topic: t.topic,
            state: t.state,
            lastMessageAt: t.last_message_at.toISOString(),
            messages: messages.map((m) => ({
              messageRef: m.id,
              from: m.author_kind === 'staff' ? 'practice' : 'patient_side',
              mine: m.author_id === ctx.actorId,
              body: m.body,
              attachments: attachmentsOut(m.attachments),
              postedAt: m.created_at.toISOString(),
            })),
          };
        });
      });
    },
  };
}

/** The E2 `messages` view producer: the patient's threads (no bodies). */
export async function messagesView(tx: TenantTransaction, patientRef: string) {
  const { rows } = await tx.query<{ id: string; topic: string; state: string; awaiting: string; last: Date }>(
    `SELECT id, topic, state, awaiting, last_message_at AS last FROM cuspatlas.message_threads
     WHERE patient_id = $1 ORDER BY last_message_at DESC, id LIMIT 50`,
    [patientRef],
  );
  return {
    threads: rows.map((r) => ({
      threadRef: r.id,
      topic: r.topic,
      state: r.state,
      awaitingReplyFrom: r.awaiting,
      lastMessageAt: r.last.toISOString(),
    })),
  };
}
