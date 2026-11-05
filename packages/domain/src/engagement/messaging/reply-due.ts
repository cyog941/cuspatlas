/**
 * E10 reply-due arithmetic. Business days are Monday to Friday in the location's IANA zone (no
 * location holiday calendar exists yet: when one does, it replaces the weekday test below and nothing
 * else). The local wall-clock time of the starting instant is preserved, so a DST change never shifts
 * a due time by an hour. The count starts at the next local day: a message on Saturday with one
 * business day is due Monday at the same local time.
 */
interface Local {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  ms: number;
}

function formatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
}

function localParts(at: Date, zone: string): Local {
  const p: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(at)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return {
    y: p.year as number,
    m: p.month as number,
    d: p.day as number,
    hh: p.hour as number,
    mm: p.minute as number,
    ss: p.second as number,
    ms: at.getUTCMilliseconds(),
  };
}

/** The instant at which the zone shows the given wall-clock time (earlier occurrence if ambiguous). */
function instantOf(l: Local, zone: string): Date {
  const wall = Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm, l.ss, l.ms);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const g = localParts(new Date(guess), zone);
    const shown = Date.UTC(g.y, g.m - 1, g.d, g.hh, g.mm, g.ss, l.ms);
    guess += wall - shown;
  }
  return new Date(guess);
}

export function addBusinessDays(from: Date, days: number, zone: string): Date {
  if (!Number.isInteger(days) || days < 1) throw new RangeError('days must be a positive integer');
  const l = localParts(from, zone);
  let day = Date.UTC(l.y, l.m - 1, l.d);
  let left = days;
  while (left > 0) {
    day += 86_400_000;
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  const t = new Date(day);
  return instantOf({ ...l, y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }, zone);
}
