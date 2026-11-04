import {
  type ActorContext,
  assertValid,
  type NotificationIntentRecord,
  type NotificationPurpose,
  type NotificationWorklistQuery,
  SCHEDULING_PROPERTIES,
  type TenantTransaction,
  validateNotificationWorklistQuery,
  validateSchedulingEntityRef,
  type WorkItemListData,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { assertLocation } from '../policy/authorize';
import { AVAILABLE, workItem, workList } from '../work-items';
import { type AppointmentBase, assertVisibleLocation } from './appointment-base';
import { notFound } from './resources';

/**
 * S14: a notification intent is recorded inside the command transaction that causes it (booking,
 * cancel, reschedule, waitlist offer, recall task) and is never sent from scheduling. No channel is
 * verified (S-S2 / S-D5 pending), so the channel is always `none`. The suppression decision (consent,
 * opt-out, quiet hours, contact data, template) is E6's: scheduling reads no consent state, stores no
 * reason of its own and reports the decision as an `undecided` placeholder owned by E6. Delivery is
 * E7's outbox consumer; scheduling holds no delivery state.
 */
export const NOTIFICATION_INTENT_RESOURCE = 'notificationIntent';
export const NOTIFICATION_POLICY_REF = 'notification-intent-pending-approval-1';

export interface IntentInput {
  readonly subjectKind: 'appointment' | 'waitlist_offer' | 'recall_task';
  readonly subjectId: string;
  readonly locationId: string;
  readonly purpose: NotificationPurpose;
  readonly dueAt: Date | null;
  /** The earlier intent this one replaces (the subject's reminder on cancel or reschedule). */
  readonly supersedes?: string | null;
}

/** Records one intent with channel `none` in the caller's transaction (audit and outbox included). */
export async function recordNotificationIntent(
  tx: TenantTransaction,
  operation: string,
  i: IntentInput,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.notification_intents (tenant_id, subject_kind, subject_id, location_id, purpose, channel,
       delivery_key, policy_ref, superseded_intent_id, due_at, source_operation, actor_id)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, 'none', $5, $6, $7, $8, $9, cuspatlas.current_actor_id())
     RETURNING id`,
    [
      i.subjectKind,
      i.subjectId,
      i.locationId,
      i.purpose,
      `${i.purpose}:${i.subjectId}`,
      NOTIFICATION_POLICY_REF,
      i.supersedes ?? null,
      i.dueAt,
      operation,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('insert returned no row');
  await recordCommand(
    tx,
    { operation, resourceType: NOTIFICATION_INTENT_RESOURCE, resourceRef: id, resourceVersion: 1 },
    { changedFields: ['purpose', 'channel', 'subject'] },
  );
  return id;
}

/** The subject's current (not superseded) intent of one purpose, if any. */
export async function currentIntentOf(
  tx: TenantTransaction,
  subjectId: string,
  purpose: NotificationPurpose,
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT i.id FROM cuspatlas.notification_intents i WHERE i.subject_id = $1 AND i.purpose = $2
       AND NOT EXISTS (SELECT 1 FROM cuspatlas.notification_intents n WHERE n.superseded_intent_id = i.id)
     ORDER BY i.created_at DESC, i.id LIMIT 1`,
    [subjectId, purpose],
  );
  return rows[0]?.id ?? null;
}

interface IntentRow extends Record<string, unknown> {
  id: string;
  subject_kind: NotificationIntentRecord['subjectKind'];
  subject_id: string;
  location_ref: string;
  purpose: NotificationPurpose;
  channel: NotificationIntentRecord['channel'];
  delivery_key: string;
  policy_ref: string;
  template_ref: string | null;
  superseded_intent_id: string | null;
  superseded_by: string | null;
  due_at: Date | null;
  created_at: Date;
}

const INTENT_SELECT = `SELECT i.id, i.subject_kind, i.subject_id, l.location_ref, i.purpose, i.channel, i.delivery_key,
    i.policy_ref, i.template_ref, i.superseded_intent_id,
    (SELECT n.id FROM cuspatlas.notification_intents n WHERE n.superseded_intent_id = i.id LIMIT 1) AS superseded_by,
    i.due_at, i.created_at
  FROM cuspatlas.notification_intents i
  JOIN cuspatlas.scheduling_locations l ON l.id = i.location_id AND l.tenant_id = i.tenant_id`;

const NEXT_ACTION: Readonly<Record<NotificationPurpose, string>> = {
  reminder: 'contact_patient_manually',
  cancellation: 'inform_patient_manually',
  waitlist_offer: 'offer_slot_by_phone',
  recall: 'contact_for_recall',
};
const EXPLANATION: Readonly<Record<NotificationPurpose, string>> = {
  reminder:
    'A reminder is due for this booking, but no messaging channel is verified yet; nothing was sent. Contact the patient by phone or in person if needed.',
  cancellation:
    'The booking was cancelled. No messaging channel is verified yet; nothing was sent. Tell the patient by phone if they did not ask for the cancellation themselves.',
  waitlist_offer:
    'A held slot was offered to a waitlisted patient. No messaging channel is verified yet; nothing was sent. Call the patient before the offer expires.',
  recall:
    'A recall contact was requested. No messaging channel is verified yet; nothing was sent. Contact the patient through the practice process.',
};

/** S14 reads: one intent, and the staff-visible worklist of intents that no channel will deliver. */
export function createNotificationOperations(base: AppointmentBase) {
  const { deps } = base;
  return {
    readNotificationIntent(ctx: ActorContext, intentRef: string): Promise<NotificationIntentRecord> {
      const op = 'scheduling.notifications.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          if (!validateSchedulingEntityRef(intentRef)) throw notFound();
          const { rows } = await tx.query<IntentRow>(`${INTENT_SELECT} WHERE i.id = $1`, [intentRef]);
          const r = rows[0];
          if (!r) throw notFound();
          assertVisibleLocation(decision, r.location_ref);
          return {
            intentRef: r.id,
            subjectKind: r.subject_kind,
            subjectRef: r.subject_id,
            locationRef: r.location_ref,
            purpose: r.purpose,
            channel: r.channel,
            deliveryKey: r.delivery_key,
            policyRef: r.policy_ref,
            templateRef: r.template_ref,
            supersedes: r.superseded_intent_id,
            supersededBy: r.superseded_by,
            dueAt: r.due_at === null ? null : r.due_at.toISOString(),
            suppressionDecision: {
              ref: null,
              owner: 'E6',
              state: 'undecided',
              statement:
                'Consent, opt-out and suppression are decided by portal and communications (E6), which is not built; scheduling records no decision of its own.',
            },
            delivery: { owner: 'E7', state: 'not_sent_no_verified_channel' },
            createdAt: r.created_at.toISOString(),
          };
        });
      });
    },

    notificationWorklist(ctx: ActorContext, query: unknown): Promise<WorkItemListData> {
      const op = 'scheduling.notifications.worklist';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        const q = query as NotificationWorklistQuery;
        assertValid<NotificationWorklistQuery>(validateNotificationWorklistQuery, q, SCHEDULING_PROPERTIES);
        if (q.locationRef !== undefined) assertLocation(decision.locationRefs, q.locationRef);
        // Only intents whose subject is still open and not past due (a review finding): an attended or
        // past appointment, a decided or expired offer and a resolved recall task are history and must not
        // crowd newer intents out of the page.
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<IntentRow>(
            `${INTENT_SELECT}
             WHERE i.channel = 'none'
               AND NOT EXISTS (SELECT 1 FROM cuspatlas.notification_intents n WHERE n.superseded_intent_id = i.id)
               AND CASE i.subject_kind
                 WHEN 'appointment' THEN EXISTS (
                   SELECT 1 FROM cuspatlas.appointments a
                   WHERE a.id = i.subject_id AND a.tenant_id = i.tenant_id AND a.starts_at > now()
                     AND NOT EXISTS (SELECT 1 FROM cuspatlas.appointment_attendance_transitions t
                       WHERE t.appointment_id = a.id AND t.tenant_id = a.tenant_id
                         AND t.kind NOT IN ('cancelled', 'rescheduled')))
                 WHEN 'waitlist_offer' THEN EXISTS (
                   SELECT 1 FROM cuspatlas.waitlist_offers o
                   WHERE o.id = i.subject_id AND o.tenant_id = i.tenant_id AND o.outcome IS NULL AND o.expires_at > now())
                 WHEN 'recall_task' THEN EXISTS (
                   SELECT 1 FROM cuspatlas.recall_tasks r
                   WHERE r.id = i.subject_id AND r.tenant_id = i.tenant_id AND r.state = 'open')
                 ELSE false END
               AND ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[]))
               AND ($2::text IS NULL OR l.location_ref = $2)
             ORDER BY i.due_at NULLS LAST, i.id LIMIT 500`,
            [decision.locationRefs, q.locationRef ?? null],
          );
          const now = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          return workList(
            now,
            AVAILABLE,
            rows.map((r) =>
              workItem({
                workItemRef: r.id,
                kind: 'notification_without_channel',
                reasonCode: 'no_verified_channel',
                explanation: EXPLANATION[r.purpose],
                evidenceRefs: [
                  {
                    kind:
                      r.subject_kind === 'appointment'
                        ? 'appointment'
                        : r.subject_kind === 'waitlist_offer'
                          ? 'waitlistOffer'
                          : 'recallTask',
                    ref: r.subject_id,
                  },
                ],
                dueAt: r.due_at === null ? null : r.due_at.toISOString(),
                suggestedNextAction: NEXT_ACTION[r.purpose],
                blockingDependencies: ['S-S2', 'E6', 'E7'],
              }),
            ),
          );
        });
      });
    },
  };
}

export type NotificationOperations = ReturnType<typeof createNotificationOperations>;
