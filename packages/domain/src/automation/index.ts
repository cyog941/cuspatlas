import { type AutomationBaseDeps, createAutomationBase } from './base';
import { createWebhookOperations, type WebhookDeps } from './webhooks';

export * from './webhook-catalog';
export * from './webhook-guard';
export * from './webhook-signing';
export {
  AUTOMATION_WEBHOOK_CODECS,
  resolveWebhookPort,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookDeliveryPort,
  type WebhookDeliveryView,
  type WebhookDeps,
  type WebhookSendRequest,
  type WebhookSendResult,
  type WebhookSubscriptionView,
} from './webhooks';

export interface AutomationDeps extends AutomationBaseDeps {
  readonly webhooks?: WebhookDeps;
}

/** Workstream A batch 4: A14 webhooks (and A15 exports), one service for REST, MCP and the worker. */
export function createAutomationService(deps: AutomationDeps) {
  const base = createAutomationBase(deps);
  return {
    ...createWebhookOperations(base, deps.webhooks ?? {}),
  };
}
export type AutomationService = ReturnType<typeof createAutomationService>;
