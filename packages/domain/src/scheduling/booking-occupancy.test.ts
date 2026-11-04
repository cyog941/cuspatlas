import { type ActorContext, isRefusalError, type TenantTransaction } from '@cuspatlas/contracts';
import { describe, expect, it } from 'vitest';
import { OCCUPANCY_ATTEMPTS, occupy } from './booking';
import type { LocationRow } from './resources';

/**
 * S10 failure case 2: a deadlock between contenders (40P01 raised inside the exclusion check) is
 * retried within a bounded budget and ends as a conflict with a non-empty list; it never commits a
 * partial booking. Uses a scripted transaction double; no database.
 */
function scripted(outcomes: readonly (string | null)[]) {
  let calls = 0;
  const tx = {
    ctx: {} as ActorContext,
    async query() {
      const code = outcomes[calls] ?? null;
      calls += 1;
      if (code !== null) throw Object.assign(new Error('scripted'), { code });
      return { rows: [], rowCount: 2 };
    },
    savepoint: <T>(work: () => Promise<T>) => work(),
  } as unknown as TenantTransaction;
  return { tx, calls: () => calls };
}

const location = { id: '00000000-0000-4000-8000-000000000001' } as LocationRow;
const w = { s: Date.UTC(2030, 0, 7, 14), e: Date.UTC(2030, 0, 7, 15) };
const ids = ['00000000-0000-4000-8000-0000000000aa'];
const refs = [{ kind: 'operatory' as const, resourceRef: ids[0] as string }];
const named = [{ kind: 'resource_overlap' as const, explanation: 'named', overrideable: false }];

describe('occupancy insert under contention', () => {
  it('retries a deadlock victim and succeeds once the contender is gone', async () => {
    const s = scripted(['40P01', '40P01', null]);
    await occupy(s.tx, 'appointment', ids[0] as string, location, refs, w, async () => named);
    expect(s.calls()).toBe(3);
  });

  it('after the bounded budget with no committed winner: a retryable conflict naming the contended resource', async () => {
    const s = scripted(Array(OCCUPANCY_ATTEMPTS).fill('40P01'));
    const err = await occupy(s.tx, 'appointment', ids[0] as string, location, refs, w, async () => []).catch(
      (e: unknown) => e,
    );
    expect(s.calls()).toBe(OCCUPANCY_ATTEMPTS);
    expect(
      isRefusalError(err) && [err.code, err.retryable, err.detail?.conflicts?.[0]?.resourceRef],
    ).toStrictEqual(['conflict', true, refs[0]]);
  });

  it('maps an exclusion violation after a retry to the re-read conflict list', async () => {
    const s = scripted(['40P01', '23P01']);
    const err = await occupy(
      s.tx,
      'appointment',
      ids[0] as string,
      location,
      refs,
      w,
      async () => named,
    ).catch((e: unknown) => e);
    expect(isRefusalError(err) && [err.code, err.retryable, err.detail?.conflicts]).toStrictEqual([
      'conflict',
      false,
      named,
    ]);
  });
});
