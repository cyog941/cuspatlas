import {
  type ActorContext,
  assertValid,
  foundationDef,
  RefusalError,
  SYNTHETIC_TASK_PROPERTIES,
  type TenantTransaction,
} from '@cuspatlas/contracts';
import type { ComposerBase } from '../composers/framework';
import { loadPolicies, replyDueAt, type ThreadQueue } from '../engagement/messaging/threads';
import { type ActionName, assertLocation } from '../policy/authorize';
import { attendanceSnapshotsOf } from '../scheduling/attendance';
import {
  appointmentsInRange,
  blocksInRange,
  rangeOf,
  type ScheduleLocation,
  unavailableIntervals,
} from '../scheduling/schedule-view';
import { daysInclusive, isRealDate } from '../scheduling/zoned-time';

/**
 * A16 analytics read contracts (PT-06). A measure is served only from a registered definition; every
 * value names its definition version, as-of instant, date basis, applied filters and freshness. Small
 * cells are suppressed: a population (or count) from 1 to threshold-1 reports `suppressed` with no value
 * and no population, so it cannot be derived; a zero denominator reports `undefined`, never zero.
 * Aggregation is not authorization: `analytics.read` admits the measure catalog, and each measure also
 * requires its owning domain's read action, checked before anything is computed (so a refusal is the
 * same whether the population is empty or not). Definitions are proposals pending business review; the
 * default threshold 11 is pending approval.
 */
export const DEFAULT_SUPPRESSION_THRESHOLD = 11;
export const MEASURE_MAX_DAYS = 92;

type Filters = { location: ScheduleLocation; from: string; to: string; now: Date };
type Raw =
  | {
      readonly kind: 'ratio';
      readonly numerator: number;
      readonly denominator: number;
      readonly population: number;
    }
  | { readonly kind: 'count'; readonly value: number }
  | { readonly kind: 'money'; readonly value: unknown };

export interface MeasureDefinition {
  readonly key: string;
  readonly version: string;
  readonly owner: 'S' | 'B' | 'E';
  readonly title: string;
  readonly definition: string;
  readonly unit: 'ratio' | 'count' | 'money';
  readonly dateBasis: string;
  readonly filters: readonly string[];
  /** The owning domain's read action the caller must also hold. */
  readonly requires: readonly ActionName[];
  readonly suppression: 'population' | 'count' | 'none';
  readonly source: 'live' | 'B11';
  compute?(tx: TenantTransaction, f: Filters): Promise<Raw>;
}

const pastBooked = async (tx: TenantTransaction, f: Filters) => {
  const { appointments } = await appointmentsInRange(tx, f.location, rangeOf(f.location, f.from, f.to), 5000);
  return appointments.filter((a) => Date.parse(a.startsAt) < f.now.getTime());
};

const SCHEDULING: MeasureDefinition[] = [
  {
    key: 'scheduling.no_show_rate',
    version: 'scheduling.no_show_rate.1',
    owner: 'S',
    title: 'No-show rate',
    definition:
      'Booked appointments at the location whose start is in the window and before the as-of instant and whose derived attendance state is no_show, divided by all such booked appointments. Cancelled and rescheduled appointments are excluded.',
    unit: 'ratio',
    dateBasis: 'appointment start, location local date',
    filters: ['locationRef', 'from', 'to'],
    requires: ['schedule.view'],
    suppression: 'population',
    source: 'live',
    async compute(tx, f) {
      const past = await pastBooked(tx, f);
      const snaps = await attendanceSnapshotsOf(
        tx,
        past.map((a) => a.appointmentRef),
      );
      const n = past.filter((a) => snaps.get(a.appointmentRef)?.state === 'no_show').length;
      return { kind: 'ratio', numerator: n, denominator: past.length, population: past.length };
    },
  },
  {
    key: 'scheduling.utilization',
    version: 'scheduling.utilization.1',
    owner: 'S',
    title: 'Provider utilization',
    definition:
      'Minutes of booked appointments of the active providers of the location in the window, divided by the minutes those providers were available (their hours in force minus time blocks). The population is the number of booked appointments.',
    unit: 'ratio',
    dateBasis: 'appointment start and availability, location local dates',
    filters: ['locationRef', 'from', 'to'],
    requires: ['schedule.view'],
    suppression: 'population',
    source: 'live',
    async compute(tx, f) {
      const range = rangeOf(f.location, f.from, f.to);
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM cuspatlas.scheduling_resources WHERE location_id = $1 AND kind = 'provider' AND status = 'active'`,
        [f.location.id],
      );
      const providers = new Set(rows.map((r) => r.id));
      const blocks = await blocksInRange(tx, f.location, range);
      const off = await unavailableIntervals(tx, f.location, f.from, f.to, blocks);
      const minutes = (s: string, e: string) => (Date.parse(e) - Date.parse(s)) / 60_000;
      const total = ((range[1] - range[0]) / 60_000) * providers.size;
      // Blocks overlap only hours they fall in; an interval list never double counts one resource minute.
      const unavailable = mergeMinutes(off.filter((u) => providers.has(u.resourceRef)));
      const { appointments } = await appointmentsInRange(tx, f.location, range, 5000);
      const booked = appointments
        .filter((a) => a.resources.some((r) => providers.has(r.resourceRef)))
        .reduce((s, a) => s + minutes(a.startsAt, a.endsAt), 0);
      return {
        kind: 'ratio',
        numerator: booked,
        denominator: Math.max(0, total - unavailable),
        population: appointments.length,
      };
    },
  },
];

function mergeMinutes(list: readonly { resourceRef: string; startsAt: string; endsAt: string }[]): number {
  const by = new Map<string, [number, number][]>();
  for (const u of list)
    by.set(u.resourceRef, [...(by.get(u.resourceRef) ?? []), [Date.parse(u.startsAt), Date.parse(u.endsAt)]]);
  let sum = 0;
  for (const ivs of by.values()) {
    ivs.sort((a, b) => a[0] - b[0]);
    let [cs, ce] = ivs[0] as [number, number];
    for (const [s, e] of ivs.slice(1)) {
      if (s <= ce) ce = Math.max(ce, e);
      else {
        sum += ce - cs;
        [cs, ce] = [s, e];
      }
    }
    sum += ce - cs;
  }
  return sum / 60_000;
}

const COMMUNICATIONS: MeasureDefinition[] = [
  {
    key: 'communications.reply_sla',
    version: 'communications.reply_sla.1',
    owner: 'E',
    title: 'Portal reply within the due time',
    definition:
      'Patient portal messages at the location that opened a reply episode (no staff reply after an earlier portal message) with a creation instant in the window, whose first later staff message arrived by the reply-due time of the thread queue (OR-D4: business days per queue policy, default 1), divided by all such episodes that are due by the as-of instant.',
    unit: 'ratio',
    dateBasis: 'portal message creation, location local date; due time in business days',
    filters: ['locationRef', 'from', 'to'],
    requires: ['messaging.threads.list'],
    suppression: 'population',
    source: 'live',
    async compute(tx, f) {
      const range = rangeOf(f.location, f.from, f.to);
      const policies = await loadPolicies(tx);
      const { rows } = await tx.query<{ queue: ThreadQueue; at: Date; reply: Date | null }>(
        `SELECT t.queue, m.created_at AS at,
           (SELECT min(s.created_at) FROM cuspatlas.thread_messages s WHERE s.thread_id = t.id AND s.author_kind = 'staff'
              AND s.created_at > m.created_at) AS reply
         FROM cuspatlas.thread_messages m JOIN cuspatlas.message_threads t ON t.id = m.thread_id AND t.tenant_id = m.tenant_id
         WHERE t.location_id = $1 AND m.author_kind = 'portal' AND m.created_at >= $2 AND m.created_at < $3
           AND NOT EXISTS (SELECT 1 FROM cuspatlas.thread_messages p WHERE p.thread_id = t.id AND p.author_kind = 'portal'
              AND p.created_at < m.created_at
              AND p.created_at > coalesce((SELECT max(s.created_at) FROM cuspatlas.thread_messages s
                WHERE s.thread_id = t.id AND s.author_kind = 'staff' AND s.created_at < m.created_at), '-infinity'::timestamptz))
         LIMIT 5000`,
        [f.location.id, new Date(range[0]), new Date(range[1])],
      );
      let due = 0;
      let met = 0;
      for (const r of rows) {
        const by = replyDueAt(r.at, r.queue, f.location.timeZone, policies);
        if (by.getTime() > f.now.getTime() && r.reply === null) continue; // not yet due, not answered
        due += 1;
        if (r.reply !== null && r.reply.getTime() <= by.getTime()) met += 1;
      }
      return { kind: 'ratio', numerator: met, denominator: due, population: due };
    },
  },
];

/** B11 claim measures, reused as published by billing (its own definitions, versions and scopes). */
const FINANCIAL: MeasureDefinition[] = [
  ['open_insurer_receivable', 'Open insurer receivable', 'money', 'none'],
  ['claims_over_30_days', 'Claims open over 30 days', 'count', 'count'],
  ['needs_action', 'Claims needing action', 'count', 'count'],
  ['open_appeals', 'Open appeals', 'count', 'count'],
].map(([k, title, unit, suppression]) => ({
  key: `financial.${k}`,
  version: 'B11',
  owner: 'B' as const,
  title: title as string,
  definition: `B11 claim measure ${k}: definition text and version as published by rcm.claims.measures.`,
  unit: unit as 'money' | 'count',
  dateBasis: 'as published by B11',
  filters: [],
  requires: [],
  suppression: suppression as 'none' | 'count',
  source: 'B11' as const,
}));

export const MEASURES: readonly MeasureDefinition[] = [...SCHEDULING, ...FINANCIAL, ...COMMUNICATIONS];
const BY_KEY = new Map(MEASURES.map((m) => [m.key, m]));

/** A measure without a registered definition cannot be served (refused before anything runs). */
export function assertMeasurable(key: string): MeasureDefinition {
  const m = BY_KEY.get(key);
  if (!m) throw new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
  return m;
}

export type FinancialMeasuresPort = (ctx: ActorContext) => Promise<{
  data: {
    asOf: string;
    measures: readonly { key: string; definitionVersion: string; definition: string; value: unknown }[];
  };
}>;

const validateQuery = foundationDef('MeasureQuery');
const failedAt = (pointer: string, rule: string) =>
  new RefusalError({ code: 'validation_failed', detail: { violations: [{ pointer, rule }] } });

export function createMeasureReads(
  base: ComposerBase,
  opts: { suppressionThreshold?: number; financial?: FinancialMeasuresPort },
) {
  const threshold = opts.suppressionThreshold ?? DEFAULT_SUPPRESSION_THRESHOLD;
  const suppression = { threshold, rule: 'values from 1 to threshold-1 are suppressed', approval: 'pending' };
  const describe = (m: MeasureDefinition) => ({
    measureKey: m.key,
    definitionVersion: m.version,
    owner: m.owner,
    title: m.title,
    definition: m.definition,
    unit: m.unit,
    dateBasis: m.dateBasis,
    filters: [...m.filters],
    requiredActions: ['analytics.measures.read', ...m.requires],
    suppression: m.suppression,
    source: m.source,
  });
  const small = (n: number) => n > 0 && n < threshold;
  const shape = (m: MeasureDefinition, raw: Raw) => {
    if (raw.kind === 'ratio') {
      if (m.suppression === 'population' && small(raw.population)) return { state: 'suppressed' as const };
      if (raw.denominator === 0) return { state: 'undefined' as const, reason: 'zero_denominator' };
      return {
        state: 'value' as const,
        value: Math.round((raw.numerator / raw.denominator) * 10_000) / 10_000,
        numerator: raw.numerator,
        denominator: raw.denominator,
      };
    }
    if (raw.kind === 'count' && m.suppression === 'count' && small(raw.value))
      return { state: 'suppressed' as const };
    return { state: 'value' as const, value: raw.value };
  };

  return {
    async listMeasures(ctx: ActorContext) {
      const op = 'analytics.measures.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        const data = MEASURES.map(describe);
        return {
          data,
          suppression,
          envelope: {
            asOf: new Date().toISOString(),
            appliedFilters: {},
            scope: { kind: 'tenant_wide' as const },
            limit: data.length,
            truncated: false,
            nextCursor: null,
            ordering: { key: 'registry', direction: 'asc' as const, tieBreak: 'measureKey' },
            count: { exact: data.length },
          },
        };
      });
    },

    async readMeasure(ctx: ActorContext, measureKey: string, query: unknown) {
      const op = 'analytics.measures.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        const m = assertMeasurable(measureKey);
        for (const a of m.requires) await base.authorize(ctx, a);
        assertValid<{ locationRef?: string; from?: string; to?: string; version?: string }>(
          validateQuery,
          query,
          SYNTHETIC_TASK_PROPERTIES,
        );
        if (query.version !== undefined && query.version !== m.version)
          throw new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
        if (m.source === 'B11') {
          if (!opts.financial)
            return { data: { ...describe(m), result: { state: 'unavailable', owner: 'B11' } } };
          const b = await opts.financial(ctx);
          const k = m.key.replace('financial.', '');
          const hit = b.data.measures.find((x) => x.key === k);
          if (!hit) return { data: { ...describe(m), result: { state: 'unavailable', owner: 'B11' } } };
          return {
            data: {
              ...describe(m),
              definitionVersion: hit.definitionVersion,
              definition: hit.definition,
              appliedFilters: {},
              asOf: b.data.asOf,
              freshness: {
                asOf: b.data.asOf,
                state: 'current',
                basis: 'B11 rcm.claims.measures as of its read',
              },
              suppressionPolicy: suppression,
              result: shape(
                m,
                m.unit === 'money'
                  ? { kind: 'money', value: hit.value }
                  : { kind: 'count', value: Number(hit.value) },
              ),
            },
          };
        }
        if (query.locationRef === undefined) throw failedAt('/locationRef', 'required');
        if (query.from === undefined || !isRealDate(query.from)) throw failedAt('/from', 'invalidDate');
        const to = query.to ?? query.from;
        if (!isRealDate(to)) throw failedAt('/to', 'invalidDate');
        const days = daysInclusive(query.from, to);
        if (days < 1) throw failedAt('/to', 'rangeOrder');
        if (days > MEASURE_MAX_DAYS) throw failedAt('/to', 'beyondMaxRange');
        assertLocation(decision.locationRefs, query.locationRef);
        return base.deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{ id: string; location_ref: string; time_zone: string; now: Date }>(
            'SELECT id, location_ref, time_zone, now() AS now FROM cuspatlas.scheduling_locations WHERE location_ref = $1',
            [query.locationRef],
          );
          const l = rows[0];
          if (!l) throw new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
          const location = { id: l.id, locationRef: l.location_ref, timeZone: l.time_zone };
          const raw = await (m.compute as NonNullable<MeasureDefinition['compute']>)(tx, {
            location,
            from: query.from as string,
            to,
            now: l.now,
          });
          const asOf = l.now.toISOString();
          return {
            data: {
              ...describe(m),
              appliedFilters: {
                locationRef: location.locationRef,
                from: query.from,
                to,
                timeZone: location.timeZone,
              },
              asOf,
              freshness: {
                asOf,
                state: 'current',
                basis: 'computed live from the owning records at the as-of instant',
              },
              suppressionPolicy: suppression,
              result: shape(m, raw),
            },
          };
        });
      });
    },
  };
}
