import type { WebhookDeliveryPort, WebhookSendRequest, WebhookSendResult } from '@cuspatlas/domain';

/** One request the in-process receiver saw (synthetic-test only; nothing leaves the process). */
export interface ReceivedWebhook {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly eventId: string;
  /** True when the receiver had already processed this event identity (consumer dedupe). */
  readonly repeat: boolean;
}

/**
 * A14 fake consumer: records every request, answers per URL path (default 200), deduplicates on the
 * event identity header the way a consumer must, and can simulate "acted, then the acknowledgement was
 * lost" (`dropAckOnce`), which the sender sees as a network error.
 */
export function createFakeWebhookReceiver() {
  const received: ReceivedWebhook[] = [];
  const processed = new Set<string>();
  const statusByPath = new Map<string, number>();
  const dropAck = new Set<string>();
  const port: WebhookDeliveryPort = {
    async send(req: WebhookSendRequest): Promise<WebhookSendResult> {
      const eventId = req.headers['cuspatlas-event-id'] ?? '';
      const path = new URL(req.url).pathname;
      const status = statusByPath.get(path) ?? 200;
      // One consumer per endpoint path: it deduplicates on the event identity it has processed.
      const seenKey = `${path} ${eventId}`;
      const repeat = processed.has(seenKey);
      received.push({ url: req.url, headers: { ...req.headers }, body: req.body, eventId, repeat });
      if (status >= 200 && status < 300) processed.add(seenKey);
      if (dropAck.delete(path)) return { outcome: 'network_error' };
      return { outcome: 'response', status };
    },
  };
  return {
    port,
    received,
    respond(path: string, status: number) {
      statusByPath.set(path, status);
    },
    dropAckOnce(path: string) {
      dropAck.add(path);
    },
    to(path: string) {
      return received.filter((r) => new URL(r.url).pathname === path);
    },
  };
}
