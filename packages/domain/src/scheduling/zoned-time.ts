/**
 * Local wall-clock <-> UTC instant conversion for IANA zones, using only the runtime's Intl zone
 * database. The disambiguation rule is ADR 0009 S-S3-R2 ("compatible", as RFC 9557 / Temporal):
 * a local time inside a spring-forward gap moves forward by the gap; a local time that occurs twice
 * on a fall-back day resolves to the earlier instant. Durations are always real elapsed minutes.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Minutes after local midnight for `HH:MM` (`24:00` = 1440). */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function parts(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error('not a local date');
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True for a real calendar date `YYYY-MM-DD` (rejects 2030-02-30). */
export function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, mo, d] = parts(date);
  return new Date(Date.UTC(y, mo - 1, d)).toISOString().slice(0, 10) === date;
}

/** True when the runtime's IANA zone database accepts the zone name. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Calendar arithmetic on local dates (no zone involved). */
export function addDays(date: string, n: number): string {
  const [y, mo, d] = parts(date);
  return new Date(Date.UTC(y, mo - 1, d) + n * DAY).toISOString().slice(0, 10);
}

/** Inclusive number of local days from `from` to `to` (1 when equal; <= 0 when reversed). */
export function daysInclusive(from: string, to: string): number {
  const [y1, m1, d1] = parts(from);
  const [y2, m2, d2] = parts(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY) + 1;
}

/** ISO weekday of a local date: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: string): number {
  const [y, mo, d] = parts(date);
  const w = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface Wall {
  readonly date: string;
  readonly time: string;
  /** UTC offset in minutes (east positive). */
  readonly offset: number;
}

function wallOf(instantMs: number, timeZone: string): Wall {
  const p = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(instantMs))
      .map((x) => [x.type, x.value]),
  );
  const name = String(p.timeZoneName ?? 'GMT');
  const m = /^GMT(?:([+-])(\d{2}):?(\d{2})?)?$/.exec(name);
  if (!m) throw new Error('unexpected zone offset format');
  const offset = m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}`, offset };
}

/** UTC offset (minutes, east positive) of `timeZone` at an instant. */
export function offsetAt(instantMs: number, timeZone: string): number {
  return wallOf(instantMs, timeZone).offset;
}

/**
 * The instant at which local `date` + `minutes` after midnight occurs in `timeZone` (minutes may be
 * 1440 for the following midnight). Gap: moved forward by the gap. Overlap: the earlier instant.
 */
export function localToInstant(date: string, minutes: number, timeZone: string): number {
  const [y, mo, d] = parts(date);
  const naive = Date.UTC(y, mo - 1, d) + minutes * MINUTE;
  const before = offsetAt(naive - DAY, timeZone);
  const after = offsetAt(naive + DAY, timeZone);
  const candidates = [...new Set([naive - before * MINUTE, naive - after * MINUTE])]
    .filter((t) => t + offsetAt(t, timeZone) * MINUTE === naive)
    .sort((a, b) => a - b);
  const first = candidates[0];
  if (first !== undefined) return first;
  // Nonexistent local time (spring-forward gap): interpret it with the offset in force before the
  // transition, which lands the same distance after the transition.
  return naive - before * MINUTE;
}

/** RFC 3339 wall time in `timeZone` with its offset, e.g. `2030-11-03T01:30:00-05:00`. */
export function formatLocal(instantMs: number, timeZone: string): string {
  const w = wallOf(instantMs, timeZone);
  const sign = w.offset < 0 ? '-' : '+';
  const abs = Math.abs(w.offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${w.date}T${w.time}${sign}${hh}:${mm}`;
}
