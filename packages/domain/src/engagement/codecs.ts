import type { ReplayCodec } from '../commands/execute-once';
import { flatCodec } from '../scheduling/ext-codecs';

/**
 * Replay projections of the E commands. Every E command result is a flat object of server
 * references, server enumerations, instants, counts and flags; the shared flat codec checks that
 * value by value and fails closed on anything else (no caller text reaches the idempotency table).
 */
const E_OPERATIONS = [
  'portal.principals.enroll',
  'portal.principals.verify',
  'portal.principals.revoke',
  'communications.consents.record',
  'communications.consents.optOut',
  'communications.contacts.verify',
  'portal.consents.record',
  'communications.channelPolicies.define',
  'communications.templates.define',
  'communications.templates.withdraw',
  'communications.recall.enroll',
  'communications.deliveries.resolve',
  'communications.receipts.record',
  'intake.forms.publish',
  'intake.forms.retire',
  'intake.submissions.submit',
  'portal.forms.submit',
  'intake.reviews.resolve',
  'messaging.threads.open',
  'messaging.messages.post',
  'messaging.threads.close',
  'messaging.threads.assign',
  'messaging.threads.hold',
  'portal.threads.open',
  'portal.threads.post',
  'telephony.config.define',
  'telephony.calls.record',
  'telephony.calls.link',
] as const;

// biome-ignore lint/suspicious/noExplicitAny: codecs are heterogeneous per operation.
export const ENGAGEMENT_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<any>>> = Object.fromEntries(
  E_OPERATIONS.map((op) => [op, flatCodec]),
);
