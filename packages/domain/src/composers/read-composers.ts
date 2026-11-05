import {
  type ActorContext,
  assertValid,
  foundationDef,
  RefusalError,
  SYNTHETIC_TASK_PROPERTIES,
  type TenantTransaction,
} from '@cuspatlas/contracts';
import { patientBalanceIn } from '../billing/entries';
import { plannedProceduresFor } from '../clinical/read-surfaces';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { PATIENT_COLUMNS, toSummary } from '../patients/model';
import { assertLocation } from '../policy/authorize';
import { coverageSummariesFor } from '../rcm/coverage';
import {
  appointmentFacts,
  appointmentsInRange,
  blocksInRange,
  rangeOf,
  SCHEDULE_VIEW_MAX_DAYS,
  type ScheduledAppointment,
  type ScheduleLocation,
  scheduleCounters,
  unavailableIntervals,
} from '../scheduling/schedule-view';
import { daysInclusive, isRealDate } from '../scheduling/zoned-time';
import {
  ageOn,
  type Component,
  type ComponentSpec,
  type ComposerBase,
  live,
  ok,
  restricted,
  unavailable,
} from './framework';

/**
 * A21 composers: `schedule.view` (OR-03) and `appointments.detail` (OR-10). The producers default to
 * the owning domains' published read functions; a deployment (or a test) that lacks one passes `null`
 * and the component reports `unavailable` with its owner.
 */
export interface ComposerProducers {
  readonly coverage: typeof coverageSummariesFor | null;
  readonly balance: typeof patientBalanceIn | null;
  readonly plannedProcedures: typeof plannedProceduresFor | null;
}
export const DEFAULT_PRODUCERS: ComposerProducers = {
  coverage: coverageSummariesFor,
  balance: patientBalanceIn,
  plannedProcedures: plannedProceduresFor,
};

export const COMPONENTS = {
  patient: { key: 'patient', owner: 'S4', action: 'patients.read', scope: 'patients.read' },
  contact: {
    key: 'contact',
    owner: 'S4',
    action: 'communications.consents.list',
    scope: 'communications.read',
  },
  coverage: { key: 'coverage', owner: 'B5', action: 'rcm.coverages.resolve', scope: 'coverage.read' },
  balance: { key: 'balance', owner: 'B2', action: 'billing.balances.read', scope: 'ledger.read' },
  plannedProcedures: {
    key: 'plannedProcedures',
    owner: 'C11',
    action: 'clinical.treatmentPlans.read',
    scope: 'clinical.read',
  },
} as const satisfies Record<string, ComponentSpec>;
const SPECS = Object.values(COMPONENTS);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const notFound = () => new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
const failedAt = (pointer: string, rule: string) =>
  new RefusalError({ code: 'validation_failed', detail: { violations: [{ pointer, rule }] } });

interface ScheduleViewQuery {
  readonly locationRef: string;
  readonly from: string;
  readonly to?: string;
  readonly grain?: 'detailed' | 'compact';
}

const validateScheduleViewQuery = foundationDef('ScheduleViewQuery');

export function createReadComposers(base: ComposerBase, producers: ComposerProducers = DEFAULT_PRODUCERS) {
  const { deps } = base;

  /** Patient, coverage, balance and planned-procedure components for a set of appointments. */
  async function components(
    tx: TenantTransaction,
    allowed: Map<string, boolean>,
    appts: readonly ScheduledAppointment[],
    now: Date,
    withContact: boolean,
    operation: string,
  ) {
    const patients = new Map<string, Component<unknown>>();
    const coverage = new Map<string, Component<unknown>>();
    const balance = new Map<string, Component<unknown>>();
    const refs = [...new Set(appts.map((a) => a.patientRef))];
    const firstOf = new Map<string, ScheduledAppointment>();
    for (const a of appts) if (!firstOf.has(a.patientRef)) firstOf.set(a.patientRef, a);
    // One patient query for the whole set (no per-patient round trip over up to 500 appointments).
    const patientRows = new Map<string, Parameters<typeof toSummary>[0]>();
    if (allowed.get('patient') && refs.length > 0) {
      const { rows } = await tx.query<Parameters<typeof toSummary>[0] & { id: string }>(
        `SELECT ${PATIENT_COLUMNS} FROM cuspatlas.patients WHERE id = ANY ($1::uuid[])`,
        [refs],
      );
      for (const r of rows) patientRows.set(r.id, r);
    }
    for (const ref of refs) {
      const first = firstOf.get(ref) as ScheduledAppointment;
      const serviceDate = first.localStart.slice(0, 10);
      if (allowed.get('patient')) {
        const row = patientRows.get(ref);
        if (row) {
          const s = toSummary(row);
          const chart = row.identifiers.find((i) => i.type === 'chart_number');
          const phone =
            row.contact.known === true
              ? (row.contact.points.find((p) => p.channel === 'phone' && p.preference !== 'avoid')?.value ??
                null)
              : null;
          patients.set(
            ref,
            ok(
              COMPONENTS.patient,
              {
                patientRef: s.patientRef,
                legalName: s.legalName,
                preferredName: s.preferredName,
                ageYears: ageOn(s.birthDate as never, serviceDate),
                chartIdentifier: chart ? { issuer: chart.issuer, value: chart.value } : null,
                status: s.status,
                ...(withContact
                  ? {
                      phone: allowed.get('contact')
                        ? ok(COMPONENTS.contact, { value: phone }, live(now))
                        : restricted(COMPONENTS.contact),
                    }
                  : {}),
              },
              live(now),
            ),
          );
        } else patients.set(ref, unavailable(COMPONENTS.patient, 'record_missing'));
      } else patients.set(ref, restricted(COMPONENTS.patient));

      if (!allowed.get('coverage')) coverage.set(ref, restricted(COMPONENTS.coverage));
      else if (!producers.coverage) coverage.set(ref, unavailable(COMPONENTS.coverage));
      else {
        const list = await producers.coverage(tx, [ref], serviceDate);
        const stale = list.some((c) => c.coverageStatus === 'stale');
        const latest = list
          .map((c) => c.eligibility?.retrievedAt ?? c.latestAttempt?.retrievedAt ?? null)
          .filter((x): x is string => x !== null)
          .sort()
          .at(-1);
        coverage.set(
          ref,
          ok(
            COMPONENTS.coverage,
            {
              serviceDate,
              coverages: list.map((c) => ({
                coverageRef: c.coverageRef,
                carrierRef: c.payerRef,
                rank: c.rank,
                verificationStatus: c.coverageStatus,
                eligibilityRetrievedAt: c.eligibility?.retrievedAt ?? null,
              })),
            },
            {
              asOf: latest ?? now.toISOString(),
              state: stale ? 'stale' : 'current',
              basis: latest ? 'B5 eligibility record retrievedAt' : 'live read in the composing transaction',
            },
          ),
        );
      }

      if (!allowed.get('balance')) balance.set(ref, restricted(COMPONENTS.balance));
      else if (!producers.balance) balance.set(ref, unavailable(COMPONENTS.balance));
      else {
        const b = await producers.balance(tx, ref, null);
        balance.set(
          ref,
          ok(
            COMPONENTS.balance,
            {
              currency: b.currency,
              balance: b.balance,
              patientResponsibility: b.patientResponsibility,
              insurerResponsibility: b.insurerResponsibility,
              unappliedCredit: b.unappliedCredit,
              accountPatientRef: b.accountPatientRef,
            },
            { asOf: b.asOf, state: 'current', basis: 'B2 journal as of the read instant' },
          ),
        );
      }
    }
    let procedures: Map<string, Component<unknown>>;
    if (!allowed.get('plannedProcedures'))
      procedures = new Map(appts.map((a) => [a.appointmentRef, restricted(COMPONENTS.plannedProcedures)]));
    else if (!producers.plannedProcedures)
      procedures = new Map(appts.map((a) => [a.appointmentRef, unavailable(COMPONENTS.plannedProcedures)]));
    else {
      const items = await producers.plannedProcedures(
        tx,
        appts.map((a) => a.appointmentRef),
      );
      procedures = new Map(
        appts.map((a) => [
          a.appointmentRef,
          ok(
            COMPONENTS.plannedProcedures,
            items
              .filter((i) => i.appointmentRef === a.appointmentRef)
              .map(({ appointmentRef: _a, ...i }) => i),
            live(now),
          ),
        ]),
      );
    }
    // Any returned patient-linked component (identity, coverage, balance, planned procedures) is a
    // sensitive read, not only the identity component.
    const linked =
      [patients, coverage, balance].some((m) => [...m.values()].some((c) => c.status === 'ok')) ||
      [...procedures.values()].some((c) => c.status === 'ok');
    if (linked && refs.length > 0) {
      await recordSensitiveRead(tx, {
        operation,
        resourceType: 'patient',
        resourceRefs: refs.slice(0, 100),
        ...(refs.length > 100 ? { totalCount: refs.length } : {}),
        queryFields: [],
      });
    }
    return { patients, coverage, balance, procedures };
  }

  return {
    async readScheduleView(ctx: ActorContext, query: unknown) {
      const op = 'schedule.view';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        assertValid<ScheduleViewQuery>(validateScheduleViewQuery, query, SYNTHETIC_TASK_PROPERTIES);
        const to = query.to ?? query.from;
        if (!isRealDate(query.from)) throw failedAt('/from', 'invalidDate');
        if (!isRealDate(to)) throw failedAt('/to', 'invalidDate');
        const days = daysInclusive(query.from, to);
        if (days < 1) throw failedAt('/to', 'rangeOrder');
        if (days > SCHEDULE_VIEW_MAX_DAYS) throw failedAt('/to', 'beyondMaxRange');
        assertLocation(decision.locationRefs, query.locationRef);
        const grain = query.grain ?? 'detailed';
        const allowed = await base.permissions(ctx, grain === 'detailed' ? SPECS : []);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{ id: string; location_ref: string; time_zone: string; now: Date }>(
            `SELECT id, location_ref, time_zone, now() AS now FROM cuspatlas.scheduling_locations WHERE location_ref = $1`,
            [query.locationRef],
          );
          const l = rows[0];
          if (!l) throw notFound();
          const location: ScheduleLocation = { id: l.id, locationRef: l.location_ref, timeZone: l.time_zone };
          const now = l.now;
          const range = rangeOf(location, query.from, to);
          const { appointments, truncated } = await appointmentsInRange(tx, location, range);
          const blocks = await blocksInRange(tx, location, range);
          const unavailableList = await unavailableIntervals(tx, location, query.from, to, blocks);
          const counters = await scheduleCounters(tx, location, blocks.length);
          const c = grain === 'detailed' ? await components(tx, allowed, appointments, now, false, op) : null;
          return {
            data: {
              location: { locationRef: location.locationRef, timeZone: location.timeZone },
              from: query.from,
              to,
              grain,
              asOf: now.toISOString(),
              appointments: appointments.map((a) =>
                c === null
                  ? {
                      appointmentRef: a.appointmentRef,
                      startsAt: a.startsAt,
                      endsAt: a.endsAt,
                      resources: a.resources,
                      attendance: { state: a.attendance.state },
                      patientRef: a.patientRef,
                    }
                  : {
                      ...a,
                      patient: c.patients.get(a.patientRef) ?? restricted(COMPONENTS.patient),
                      coverage: c.coverage.get(a.patientRef),
                      balance: c.balance.get(a.patientRef),
                      plannedProcedures: c.procedures.get(a.appointmentRef),
                    },
              ),
              appointmentsTruncated: truncated,
              blocks,
              unavailableIntervals: unavailableList,
              counters,
              freshness: live(now),
            },
          };
        });
      });
    },

    async readAppointmentDetail(ctx: ActorContext, appointmentRef: string) {
      const op = 'appointments.detail';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        if (!UUID.test(appointmentRef)) throw notFound();
        const allowed = await base.permissions(ctx, SPECS);
        return deps.withTenantTransaction(ctx, async (tx) => {
          // Location first, from the bare row: another location's appointment is answered exactly like a
          // missing one, before any of its facts are read.
          const { rows: at } = await tx.query<{ location_ref: string }>(
            `SELECT l.location_ref FROM cuspatlas.appointments a
             JOIN cuspatlas.scheduling_locations l ON l.id = a.location_id AND l.tenant_id = a.tenant_id
             WHERE a.id = $1`,
            [appointmentRef],
          );
          const where = at[0]?.location_ref;
          if (where === undefined) throw notFound();
          if (decision.locationRefs !== null && !decision.locationRefs.includes(where)) throw notFound();
          const a = await appointmentFacts(tx, appointmentRef);
          if (!a) throw notFound();
          assertLocation(decision.locationRefs, a.location.locationRef);
          const { rows } = await tx.query<{ now: Date }>('SELECT now() AS now');
          const now = (rows[0] as { now: Date }).now;
          const c = await components(tx, allowed, [a], now, true, op);
          const { location, status, ...facts } = a;
          return {
            data: {
              ...facts,
              status,
              location: { locationRef: location.locationRef, timeZone: location.timeZone },
              asOf: now.toISOString(),
              patient: c.patients.get(a.patientRef) ?? restricted(COMPONENTS.patient),
              coverage: c.coverage.get(a.patientRef),
              balance: c.balance.get(a.patientRef),
              plannedProcedures: c.procedures.get(a.appointmentRef),
              chart: allowed.get('plannedProcedures')
                ? { patientRef: a.patientRef, operation: 'clinical.chart.read' }
                : restricted(COMPONENTS.plannedProcedures),
              freshness: live(now),
            },
          };
        });
      });
    },
  };
}

export type ReadComposers = ReturnType<typeof createReadComposers>;
