/**
 * A14 published event catalog: a closed, versioned list derived from outbox aggregate types. A
 * subscription names event types from this list only. Each event version fixes the payload shape:
 *
 * version 1 = `{ id, type, version, occurredAt, operation, resource: { type, ref, version },
 * changedFields }` where `id` is the outbox event identity (the consumer's deduplication key),
 * `changedFields` are field names only (never values) and no patient name, note text or credential is
 * ever carried. Consumers fetch the resource through the API with their own authorization.
 *
 * Internal aggregates (proposal execution, rendered procedures, claim timers, grants, exports) are not
 * published. A new payload shape is a new version; earlier versions keep delivering to subscriptions
 * that selected them.
 */
export const WEBHOOK_EVENT_CATALOG_VERSION = 'cuspatlas-webhook-events.1';

export interface WebhookEventTypeEntry {
  readonly eventType: string;
  readonly aggregateType: string;
  readonly versions: readonly number[];
  readonly description: string;
}

const entry = (aggregateType: string, description: string): WebhookEventTypeEntry => ({
  eventType: `${aggregateType}.changed`,
  aggregateType,
  versions: [1],
  description,
});

export const WEBHOOK_EVENT_CATALOG: readonly WebhookEventTypeEntry[] = [
  entry('availabilityVersion', 'A scheduling availability version was published or changed.'),
  entry('consentFact', 'A communication consent fact was recorded.'),
  entry('intakeReview', 'An intake submission review was recorded.'),
  entry('journalEntry', 'A billing journal entry was posted or reversed.'),
  entry('messageThread', 'A message thread was opened or changed.'),
  entry('patient', 'A patient identity record was created or changed.'),
  entry('patientRelationship', 'A patient relationship was recorded or ended.'),
  entry('paymentPlan', 'A payment plan was created or changed.'),
  entry('recallEnrollment', 'A recall enrollment was created or changed.'),
  entry('schedulingLocation', 'A scheduling location was created or changed.'),
  entry('schedulingResource', 'A scheduling resource was created or changed.'),
  entry('threadMessage', 'A message was posted in a thread.'),
  entry('timeBlock', 'A schedule time block was created or changed.'),
];

export const WEBHOOK_EVENT_BY_TYPE: ReadonlyMap<string, WebhookEventTypeEntry> = new Map(
  WEBHOOK_EVENT_CATALOG.map((e) => [e.eventType, e]),
);

/** Version-1 body bytes, fixed at fan-out so every retry and replay sends identical bytes. */
export function webhookBodyV1(e: {
  id: string;
  type: string;
  occurredAt: Date;
  operation: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  changedFields: readonly string[];
}): string {
  return JSON.stringify({
    id: e.id,
    type: e.type,
    version: 1,
    occurredAt: e.occurredAt.toISOString(),
    operation: e.operation,
    resource: { type: e.aggregateType, ref: e.aggregateId, version: e.aggregateVersion },
    changedFields: e.changedFields.filter((f) => /^[a-zA-Z][A-Za-z0-9_]{0,63}$/.test(f)).slice(0, 32),
  });
}
