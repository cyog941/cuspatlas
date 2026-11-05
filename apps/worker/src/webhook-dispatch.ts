import { randomUUID } from 'node:crypto';
import type { ActorContext } from '@cuspatlas/contracts';
import type { AutomationService } from '@cuspatlas/domain';

/**
 * A14 webhook stage of the worker: one dispatch per tenant per tick under the worker's own service
 * principal (the domain authorizes it freshly for `webhooks.deliveries.dispatch`, scope
 * `outbox.deliver`). Fan-out, leasing, the send-time endpoint guard, signing and outcome recording
 * all happen in the domain; without a delivery port the due deliveries become
 * `adapter_not_configured` and stay in the failures worklist.
 */
export function createWebhookDispatcher(automation: AutomationService, principalId: string) {
  const ctx = (tenantId: string): ActorContext => ({
    tenantId,
    actorId: principalId,
    principal: 'service',
    sessionId: randomUUID(),
    scopes: ['outbox.deliver'],
    correlationId: randomUUID(),
  });
  return {
    async runOnce(tenantId: string) {
      const r = await automation.dispatchWebhookDeliveries(ctx(tenantId), {
        operation: 'webhooks.deliveries.dispatch',
        idempotencyKey: randomUUID(),
        payload: {},
      });
      return r.data;
    },
  };
}
