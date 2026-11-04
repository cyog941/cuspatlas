import type { CallEventInput, TelephonyAdapter } from '@cuspatlas/domain';

/**
 * SYNTHETIC fake telephony adapter (E8; E-S2 blocks any real provider). In-memory, no network, no
 * audio and no recordings: it only hands out normalized call events that a test queued, with
 * fictional 555-01xx numbers. `unavailable` simulates a provider outage.
 */
export class FakeTelephony implements TelephonyAdapter {
  readonly provider = 'synthetic-fake' as const;
  private queue: CallEventInput[] = [];
  unavailable = false;
  private seq = 0;

  ring(e: Omit<CallEventInput, 'providerCallRef'> & { providerCallRef?: string }): CallEventInput {
    this.seq += 1;
    const event = { ...e, providerCallRef: e.providerCallRef ?? `fake-call-${Date.now()}-${this.seq}` };
    this.queue.push(event);
    return event;
  }

  async pull(): Promise<readonly CallEventInput[]> {
    if (this.unavailable) throw new Error('synthetic telephony provider unavailable');
    const out = this.queue;
    this.queue = [];
    return out;
  }
}
