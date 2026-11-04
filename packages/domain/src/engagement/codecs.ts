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
  'portal.consents.record',
  'communications.channelPolicies.define',
  'communications.templates.define',
  'communications.templates.withdraw',
  'communications.recall.enroll',
  'communications.deliveries.resolve',
  'communications.receipts.record',
] as const;

// biome-ignore lint/suspicious/noExplicitAny: codecs are heterogeneous per operation.
export const ENGAGEMENT_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<any>>> = Object.fromEntries(
  E_OPERATIONS.map((op) => [op, flatCodec]),
);
