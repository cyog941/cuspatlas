import { describe, expect, it } from 'vitest';
import { BACKOFF_CAP_SECONDS, backoffSeconds } from './backoff';

describe('backoffSeconds', () => {
  it('doubles the ceiling per attempt and jitters within [ceiling/2, ceiling]', () => {
    expect([backoffSeconds(1, () => 0), backoffSeconds(1, () => 1)]).toStrictEqual([1, 2]);
    expect([backoffSeconds(3, () => 0), backoffSeconds(3, () => 1)]).toStrictEqual([4, 8]);
    for (let a = 1; a <= 12; a += 1) {
      const d = backoffSeconds(a);
      const ceiling = Math.min(BACKOFF_CAP_SECONDS, 2 * 2 ** (a - 1));
      expect(d).toBeGreaterThanOrEqual(ceiling / 2);
      expect(d).toBeLessThanOrEqual(ceiling);
    }
  });

  it('is capped and rejects nonsense attempts', () => {
    expect(backoffSeconds(1000, () => 1)).toBe(BACKOFF_CAP_SECONDS);
    expect(() => backoffSeconds(0)).toThrow();
    expect(() => backoffSeconds(1.5)).toThrow();
  });
});
