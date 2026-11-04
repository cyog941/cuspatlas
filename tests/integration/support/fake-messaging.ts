import { randomUUID } from 'node:crypto';
import type {
  MessagingLookup,
  MessagingPort,
  MessagingSendRequest,
  MessagingSendResult,
} from '@cuspatlas/domain';

/**
 * SYNTHETIC fake messaging provider (E7). In-memory, no network, no real integration, no real
 * recipients. It counts every external "effect" (a message it would have delivered), so tests can
 * assert exactly one send per intent.
 *
 * - `idempotent: true` (default) honors the delivery key: a repeated key performs no new effect and
 *   answers `duplicate` with the first provider reference (the F6 adapter contract).
 * - `idempotent: false` performs an effect on every call, to prove the sender itself never re-sends.
 * - Hooks inject faults: report `unknown` after accepting (timeout), reject (transient or permanent),
 *   crash after accepting (the sender process dies before recording), or make lookup unavailable.
 */
export class CrashAfterAccept extends Error {
  constructor() {
    super('synthetic crash after provider acceptance');
    this.name = 'CrashAfterAccept';
  }
}

export interface FakeMessagingHooks {
  beforeAccept?: (req: MessagingSendRequest) => Promise<void> | void;
  afterAccept?: (req: MessagingSendRequest) => 'timeout' | 'crash' | undefined;
  reject?: (req: MessagingSendRequest) => { retryable: boolean } | undefined;
  lookupUnavailable?: () => boolean;
  /** Awaited after acceptance and before the answer: the provider's receipt can race the send record. */
  whileAccepted?: (req: MessagingSendRequest, providerRef: string) => Promise<void>;
}

export interface MessagingEffect {
  readonly deliveryKey: string;
  readonly providerRef: string;
  readonly channel: string;
  readonly recipient: string;
  readonly body: string;
}

export class FakeMessaging implements MessagingPort {
  readonly effects: MessagingEffect[] = [];
  readonly calls: MessagingSendRequest[] = [];
  lookups = 0;
  hooks: FakeMessagingHooks;
  private readonly refs = new Map<string, string>();
  private seq = 0;
  /** Provider references are unique across fake instances, as a real provider's are. */
  private readonly instance = randomUUID().slice(0, 8);

  constructor(
    private readonly options: { readonly idempotent?: boolean } = {},
    hooks: FakeMessagingHooks = {},
  ) {
    this.hooks = hooks;
  }

  effectsFor(deliveryKey: string): number {
    return this.effects.filter((e) => e.deliveryKey === deliveryKey).length;
  }

  providerRefOf(deliveryKey: string): string | undefined {
    return this.refs.get(deliveryKey);
  }

  async send(req: MessagingSendRequest): Promise<MessagingSendResult> {
    this.calls.push(req);
    await this.hooks.beforeAccept?.(req);
    const rejected = this.hooks.reject?.(req);
    if (rejected) return { outcome: 'rejected', retryable: rejected.retryable, reasonClass: 'synthetic' };
    const prior = this.refs.get(req.deliveryKey);
    if ((this.options.idempotent ?? true) && prior) return { outcome: 'duplicate', providerRef: prior };
    this.seq += 1;
    const providerRef = prior ?? `fake-msg-${this.instance}-${this.seq}`;
    this.refs.set(req.deliveryKey, providerRef);
    this.effects.push({
      deliveryKey: req.deliveryKey,
      providerRef,
      channel: req.channel,
      recipient: req.recipient,
      body: req.body,
    });
    await this.hooks.whileAccepted?.(req, providerRef);
    const after = this.hooks.afterAccept?.(req);
    if (after === 'crash') throw new CrashAfterAccept();
    if (after === 'timeout') return { outcome: 'unknown' };
    return { outcome: 'accepted', providerRef };
  }

  async lookup(deliveryKey: string): Promise<MessagingLookup> {
    this.lookups += 1;
    if (this.hooks.lookupUnavailable?.()) return { status: 'unavailable' };
    const ref = this.refs.get(deliveryKey);
    return ref ? { status: 'found', providerRef: ref } : { status: 'not_found' };
  }
}
