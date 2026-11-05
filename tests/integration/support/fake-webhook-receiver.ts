import { isIP } from 'node:net';
import type { WebhookDeliveryPort, WebhookSendRequest, WebhookSendResult } from '@cuspatlas/domain';

/** One request the in-process receiver saw (synthetic-test only; nothing leaves the process). */
export interface ReceivedWebhook {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly eventId: string;
  /** The address the sender pinned (the guard-checked IP); the fake never resolves names itself. */
  readonly connectAddress: string | undefined;
  /** True when the receiver had already processed this event identity (consumer dedupe). */
  readonly repeat: boolean;
}

/**
 * A14 fake consumer: records every request, answers per URL path (default 200), deduplicates on the
 * event identity header the way a consumer must, and can simulate "acted, then the acknowledgement was
 * lost" (`dropAckOnce`), which the sender sees as a network error. It models the transport contract:
 * a request without a pinned IP `connectAddress` or without `redirect: 'error'` is a contract
 * violation (recorded), and a 3xx answer to a request that did not refuse redirects is "followed" the
 * way a naive client would, so a test can prove the sender never lets that happen.
 */
export function createFakeWebhookReceiver() {
  const received: ReceivedWebhook[] = [];
  const violations: string[] = [];
  const processed = new Set<string>();
  const statusByPath = new Map<string, { status: number; location?: string }>();
  const dropAck = new Set<string>();
  const record = (req: WebhookSendRequest, url: string, repeat: boolean) =>
    received.push({
      url,
      headers: { ...req.headers },
      body: req.body,
      eventId: req.headers['cuspatlas-event-id'] ?? '',
      connectAddress: req.connectAddress,
      repeat,
    });
  const port: WebhookDeliveryPort = {
    egress: 'in_process_fake',
    async send(req: WebhookSendRequest): Promise<WebhookSendResult> {
      if (typeof req.connectAddress !== 'string' || isIP(req.connectAddress) === 0)
        violations.push(`unpinned:${req.url}`);
      if (req.redirect !== 'error') violations.push(`redirect_not_refused:${req.url}`);
      if (req.hostHeader !== new URL(req.url).hostname.replace(/^\[|\]$/g, ''))
        violations.push(`host_header:${req.url}`);
      const eventId = req.headers['cuspatlas-event-id'] ?? '';
      const path = new URL(req.url).pathname;
      const answer = statusByPath.get(path) ?? { status: 200 };
      // One consumer per endpoint path: it deduplicates on the event identity it has processed.
      const seenKey = `${path} ${eventId}`;
      const repeat = processed.has(seenKey);
      record(req, req.url, repeat);
      if (answer.status >= 200 && answer.status < 300) processed.add(seenKey);
      if (dropAck.delete(path)) return { outcome: 'network_error' };
      if (answer.status >= 300 && answer.status < 400 && answer.location && req.redirect !== 'error') {
        record(req, answer.location, false);
        return { outcome: 'response', status: 200 };
      }
      return { outcome: 'response', status: answer.status };
    },
  };
  return {
    port,
    received,
    violations,
    respond(path: string, status: number, location?: string) {
      statusByPath.set(path, location ? { status, location } : { status });
    },
    dropAckOnce(path: string) {
      dropAck.add(path);
    },
    to(path: string) {
      return received.filter((r) => new URL(r.url).pathname === path);
    },
  };
}
