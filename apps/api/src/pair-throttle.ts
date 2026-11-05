import { RefusalError } from '@cuspatlas/contracts';

/**
 * Bounded failed-attempt throttle for the one anonymous bridge route (`POST /v1/bridge/pair`). It counts
 * failures per source and per pairing code in a fixed window, in memory: a throttled request answers
 * 429 `rate_limited` before any database work, so a flood cannot amplify into one attempt row per
 * request beyond the bound. The table is bounded (expired entries are dropped, then the oldest).
 * Per-process by design; a multi-instance deployment adds an edge limit in front (a deployment decision).
 */
export interface PairThrottleOptions {
  readonly windowMs?: number;
  readonly perCode?: number;
  readonly perSource?: number;
  readonly maxKeys?: number;
}

interface Entry {
  failures: number;
  windowStart: number;
}

const PAIRING_ID = /^cpb1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.([0-9a-f-]{36})\./;

export function pairingIdOf(body: unknown): string | null {
  const code = (body as { pairingCode?: unknown } | null)?.pairingCode;
  return typeof code === 'string' ? (PAIRING_ID.exec(code)?.[1] ?? null) : null;
}

export class PairThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly windowMs: number;
  private readonly perCode: number;
  private readonly perSource: number;
  private readonly maxKeys: number;

  constructor(o: PairThrottleOptions = {}) {
    this.windowMs = o.windowMs ?? 60_000;
    this.perCode = o.perCode ?? 5;
    this.perSource = o.perSource ?? 30;
    this.maxKeys = o.maxKeys ?? 10_000;
  }

  private keys(source: string, pairingId: string | null) {
    return [[`s:${source}`, this.perSource], ...(pairingId ? [[`p:${pairingId}`, this.perCode]] : [])] as [
      string,
      number,
    ][];
  }

  private live(key: string, now: number): Entry | undefined {
    const e = this.entries.get(key);
    if (e && now - e.windowStart >= this.windowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  /** Throws 429 when either bound is already used up in the current window. */
  check(source: string, pairingId: string | null, now = Date.now()): void {
    for (const [key, limit] of this.keys(source, pairingId)) {
      if ((this.live(key, now)?.failures ?? 0) >= limit)
        throw new RefusalError({ code: 'rate_limited', retryable: true });
    }
  }

  recordFailure(source: string, pairingId: string | null, now = Date.now()): void {
    for (const [key] of this.keys(source, pairingId)) {
      const e = this.live(key, now);
      if (e) e.failures += 1;
      else {
        if (this.entries.size >= this.maxKeys) this.evict(now);
        this.entries.set(key, { failures: 1, windowStart: now });
      }
    }
  }

  private evict(now: number): void {
    for (const [k, e] of this.entries) if (now - e.windowStart >= this.windowMs) this.entries.delete(k);
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
