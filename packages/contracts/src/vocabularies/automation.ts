import { vocabularyEntry as e, type ModuleVocabularies } from './types';

/**
 * OR-02 automation state vocabularies (owner A, workstream A batch 4: A14 webhook subscriptions and
 * deliveries, A15 export requests). Labels are synthetic operator-facing plain English pending
 * workflow validation; no colour or layout.
 */
export const AUTOMATION_VOCABULARIES: ModuleVocabularies = {
  module: 'automation',
  owner: 'A',
  version: 'automation-state-labels.1',
  vocabularies: [
    {
      name: 'webhook_subscription',
      sources: ['webhook_subscriptions.state', 'schema:automation:WebhookSubscriptionState'],
      entries: [
        e('active', 'ACT', 'Active', 'lifecycle', false),
        e('revoked', 'REV', 'Revoked', 'lifecycle', true),
      ],
    },
    {
      name: 'webhook_delivery',
      sources: ['webhook_deliveries.state', 'schema:automation:WebhookDeliveryState'],
      entries: [
        e('pending', 'PEN', 'Waiting to send', 'lifecycle', false),
        e('delivering', 'DLV', 'Sending', 'lifecycle', false),
        e('retrying', 'RTY', 'Will retry', 'exception', false),
        e('delivered', 'DON', 'Delivered', 'lifecycle', true),
        e('dead_lettered', 'DLQ', 'Gave up after retries', 'exception', true),
        e('adapter_not_configured', 'NAD', 'Waiting for a delivery adapter', 'exception', false),
        e('paused', 'PAU', 'Paused by the endpoint check', 'exception', false),
        e('cancelled', 'CAN', 'Cancelled (subscription revoked)', 'lifecycle', true),
      ],
    },
  ],
};
