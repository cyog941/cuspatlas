import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysInclusive,
  formatLocal,
  isKnownTimeZone,
  isoWeekday,
  isRealDate,
  localToInstant,
} from './zoned-time';

const iso = (ms: number) => new Date(ms).toISOString();
const NY = 'America/New_York';

describe('ADR 0009 S-S3-R2 local time rule (compatible disambiguation)', () => {
  it('moves a nonexistent spring-forward time forward by the gap', () => {
    // 2030-03-10 02:30 does not exist in New York; it becomes 03:30 EDT.
    const t = localToInstant('2030-03-10', 150, NY);
    expect(iso(t)).toBe('2030-03-10T07:30:00.000Z');
    expect(formatLocal(t, NY)).toBe('2030-03-10T03:30:00-04:00');
  });

  it('resolves a repeated fall-back time to the earlier instant', () => {
    const t = localToInstant('2030-11-03', 90, NY);
    expect(iso(t)).toBe('2030-11-03T05:30:00.000Z');
    expect(formatLocal(t, NY)).toBe('2030-11-03T01:30:00-04:00');
    expect(formatLocal(t + 3_600_000, NY)).toBe('2030-11-03T01:30:00-05:00');
  });

  it('handles ordinary days, 24:00, half-hour offsets and UTC', () => {
    expect(iso(localToInstant('2030-01-14', 8 * 60, NY))).toBe('2030-01-14T13:00:00.000Z');
    expect(iso(localToInstant('2030-01-14', 1440, NY))).toBe('2030-01-15T05:00:00.000Z');
    expect(iso(localToInstant('2030-01-14', 9 * 60, 'Asia/Kolkata'))).toBe('2030-01-14T03:30:00.000Z');
    expect(formatLocal(Date.parse('2030-01-14T03:30:00Z'), 'Asia/Kolkata')).toBe('2030-01-14T09:00:00+05:30');
    expect(formatLocal(Date.parse('2030-01-14T03:30:00Z'), 'UTC')).toBe('2030-01-14T03:30:00+00:00');
  });

  it('walks the calendar across month ends and leap days', () => {
    expect(addDays('2030-01-31', 1)).toBe('2030-02-01');
    expect(addDays('2030-02-28', 1)).toBe('2030-03-01');
    expect(addDays('2032-02-28', 1)).toBe('2032-02-29');
    expect(daysInclusive('2030-01-01', '2030-01-31')).toBe(31);
    expect(daysInclusive('2030-01-02', '2030-01-01')).toBe(0);
    expect(isoWeekday('2030-03-10')).toBe(7);
    expect(isoWeekday('2030-01-14')).toBe(1);
    expect(isRealDate('2030-02-29')).toBe(false);
    expect(isRealDate('2032-02-29')).toBe(true);
    expect(isKnownTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isKnownTimeZone(NY)).toBe(true);
  });
});
