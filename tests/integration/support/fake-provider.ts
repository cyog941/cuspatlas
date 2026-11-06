import type { DeliveryAdapter, DeliveryReceipt, DeliveryRequest, ReceiptLookup } from '@cuspatlas/domain';

/**
 * SYNTHETIC fake provider for worker tests. In-memory, no network, no real integration. It counts
 * every external "effect" it performs, so tests can assert exactly one logical action per event.
 *
 * - `idempotent: true` (default) honors the delivery key: a repeated key performs no new effect and
 *   answers `duplicate` with the first receipt (the frozen adapter contract).
 * - `idempotent: false` performs an effect on every call. Tests use it to prove that the worker
 *   itself never re-sends after a crash or an unknown outcome (any resend would show as 2 effects).
 * - Hooks inject faults: delay before or after acceptance, report a timeout after acceptance
 *   (`unknown`), fail, or make lookup unavailable.
 */
export interface FakeProviderHooks {
  /** Runs before the provider decides; await a gate here to hold a request in flight. */
  beforeAccept?: (req: DeliveryRequest) => Promise<void> | void;
  /** Runs after an accepted effect; return 'timeout' to answer `unknown` although it was accepted. */
  afterAccept?: (req: DeliveryRequest) => Promise<'timeout' | undefined> | 'timeout' | undefined;
  /** Answer `failed` without performing anything. */
  fail?: (req: DeliveryRequest) => { retryable: boolean } | undefined;
  lookupUnavailable?: () => boolean;
}

export interface Effect {
  readonly deliveryKey: string;
  readonly receiptId: string;
  readonly attempt: number;
  readonly payload: unknown;
}

export class FakeProvider implements DeliveryAdapter {
  readonly effects: Effect[] = [];
  readonly deliverCalls: DeliveryRequest[] = [];
  lookupCalls = 0;
  hooks: FakeProviderHooks;
  private readonly receipts = new Map<string, string>();
  private seq = 0;

  constructor(
    private readonly options: { readonly idempotent?: boolean } = {},
    hooks: FakeProviderHooks = {},
  ) {
    this.hooks = hooks;
  }

  effectsFor(deliveryKey: string): number {
    return this.effects.filter((e) => e.deliveryKey === deliveryKey).length;
  }

  callsFor(deliveryKey: string): number {
    return this.deliverCalls.filter((c) => c.deliveryKey === deliveryKey).length;
  }

  /** Simulates an effect performed earlier (for example by a process whose acknowledgement was lost). */
  preAccept(deliveryKey: string): string {
    const receiptId = this.nextReceipt();
    this.receipts.set(deliveryKey, receiptId);
    this.effects.push({ deliveryKey, receiptId, attempt: 0, payload: null });
    return receiptId;
  }

  async deliver(req: DeliveryRequest): Promise<DeliveryReceipt> {
    this.deliverCalls.push(req);
    await this.hooks.beforeAccept?.(req);
    const failure = this.hooks.fail?.(req);
    if (failure) return { outcome: 'failed', retryable: failure.retryable };
    const idempotent = this.options.idempotent ?? true;
    const prior = this.receipts.get(req.deliveryKey);
    if (idempotent && prior) return { outcome: 'duplicate', receiptId: prior };
    const receiptId = prior ?? this.nextReceipt();
    this.receipts.set(req.deliveryKey, receiptId);
    this.effects.push({
      deliveryKey: req.deliveryKey,
      receiptId,
      attempt: req.attempt,
      payload: req.payload,
    });
    if ((await this.hooks.afterAccept?.(req)) === 'timeout') return { outcome: 'unknown' };
    return { outcome: 'delivered', receiptId };
  }

  async lookup(deliveryKey: string): Promise<ReceiptLookup> {
    this.lookupCalls += 1;
    if (this.hooks.lookupUnavailable?.()) return { status: 'unavailable' };
    const receiptId = this.receipts.get(deliveryKey);
    return receiptId ? { status: 'found', receiptId } : { status: 'not_found' };
  }

  private nextReceipt(): string {
    this.seq += 1;
    return `fake-rcpt-${this.seq}`;
  }
}

/** A manually released gate for holding a request in flight. */
export function gate(): { readonly wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}
