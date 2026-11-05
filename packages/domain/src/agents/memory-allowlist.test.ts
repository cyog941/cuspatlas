import { describe, expect, it } from 'vitest';
import { structuredMemoryValueAccepted } from './workspace';

/**
 * Closeout D review N1: the structured-kind lookup is an own-key lookup. An inherited name such as
 * `constructor` or `__proto__` is never a kind, even when a caller bypasses the schema enum.
 */
describe('agent memory structured kinds (N1)', () => {
  it('refuses inherited property names as kinds', () => {
    for (const kind of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])
      expect(structuredMemoryValueAccepted(kind, 'pending'), kind).toBe(false);
  });

  it('still accepts a registered kind whose value matches', () => {
    expect(structuredMemoryValueAccepted('flag', 'true')).toBe(true);
    expect(structuredMemoryValueAccepted('code', 'pending')).toBe(true);
    expect(structuredMemoryValueAccepted('code', 'maria.garcia')).toBe(false);
  });
});
