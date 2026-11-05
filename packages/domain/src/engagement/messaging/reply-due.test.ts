import { describe, expect, it } from 'vitest';
import { addBusinessDays } from './reply-due';

describe('addBusinessDays (Mon-Fri in the location zone, wall-clock preserved)', () => {
  it('one business day from a Wednesday is Thursday at the same local time', () => {
    // Wed 2026-11-04 15:30 America/New_York (EST, UTC-5) -> Thu 15:30 local.
    expect(addBusinessDays(new Date('2026-11-04T20:30:00Z'), 1, 'America/New_York').toISOString()).toBe(
      '2026-11-05T20:30:00.000Z',
    );
  });
  it('skips the weekend: Friday evening local is due Monday evening local', () => {
    expect(addBusinessDays(new Date('2026-11-06T22:00:00Z'), 1, 'America/New_York').toISOString()).toBe(
      '2026-11-09T22:00:00.000Z',
    );
  });
  it('a Saturday message is due the next business day (Monday) at the same local time', () => {
    expect(addBusinessDays(new Date('2026-11-07T15:00:00Z'), 1, 'America/New_York').toISOString()).toBe(
      '2026-11-09T15:00:00.000Z',
    );
  });
  it('uses the location zone for the weekday, not UTC', () => {
    // 2026-11-07T07:00Z is Saturday in UTC but Friday 23:00 in Los Angeles (PST): due Monday 23:00 local.
    expect(addBusinessDays(new Date('2026-11-07T07:00:00Z'), 1, 'America/Los_Angeles').toISOString()).toBe(
      '2026-11-10T07:00:00.000Z',
    );
  });
  it('keeps the wall-clock time across a DST change and supports several days', () => {
    // Fri 2026-10-30 12:00 EDT (16:00Z) + 3 business days = Wed 2026-11-04 12:00 EST (17:00Z).
    expect(addBusinessDays(new Date('2026-10-30T16:00:00Z'), 3, 'America/New_York').toISOString()).toBe(
      '2026-11-04T17:00:00.000Z',
    );
  });
  it('rejects a non-positive or fractional count', () => {
    expect(() => addBusinessDays(new Date(), 0, 'UTC')).toThrow();
    expect(() => addBusinessDays(new Date(), 1.5, 'UTC')).toThrow();
  });
});
