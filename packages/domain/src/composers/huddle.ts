import {
  type ActorContext,
  assertValid,
  foundationDef,
  RefusalError,
  SYNTHETIC_TASK_PROPERTIES,
  type TenantTransaction,
} from '@cuspatlas/contracts';
import { patientBalanceIn } from '../billing/entries';
import { labCasesFor, unsignedNotesFor } from '../clinical/read-surfaces';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { PATIENT_COLUMNS, toSummary } from '../patients/model';
import { assertLocation, DISPLAY_SCOPE } from '../policy/authorize';
import { coverageSummariesFor } from '../rcm/coverage';
import { appointmentsInRange, rangeOf, type ScheduleLocation } from '../scheduling/schedule-view';
import { addDays, isRealDate } from '../scheduling/zoned-time';
import {
  type Component,
  type ComponentSpec,
  type ComposerBase,
  live,
  ok,
  restricted,
  unavailable,
} from './framework';

/**
 * A18 (PT-01) daily huddle projection: the appointments of one location and local day (default: the
 * next local day in the location zone, named in the response) with readiness flags from their
 * producers. Each flag carries its owner, its own authorization outcome and freshness; a flag the
 * caller may not read is `restricted` with no value (never zero); a producer that is not published is
 * `unavailable` (forms readiness today), never shown as checked.
 *
 * Shared-display rule (practice sign-off pending): `display=shared`, and ALWAYS for a display principal
 * (a membership holding `display.shared`), returns no patient identity, no appointment reference, no
 * readiness flag (clinical and financial detail omitted entirely): time, resources and attendance only.
 */

const FLAGS = {
  patient: { key: 'patient', owner: 'S4', action: 'patients.read', scope: 'patients.read' },
  forms: { key: 'forms', owner: 'C13', action: 'clinical.consents.list', scope: 'clinical.read' },
  eligibility: { key: 'eligibility', owner: 'B5', action: 'rcm.coverages.resolve', scope: 'coverage.read' },
  balance: { key: 'balance', owner: 'B2', action: 'billing.balances.read', scope: 'ledger.read' },
  labs: { key: 'labs', owner: 'C16', action: 'clinical.labCases.list', scope: 'clinical.read' },
  clinical: { key: 'clinical', owner: 'C10', action: 'clinical.notes.list', scope: 'clinical.read' },
} as const satisfies Record<string, ComponentSpec>;

const validate = foundationDef('HuddleQuery');
const notFound = () => new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
const localDate = (ms: number, zone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));

export function createHuddleReads(base: ComposerBase) {
  return {
    async readHuddle(ctx: ActorContext, query: unknown) {
      const op = 'huddle.read';
      return base.guarded(ctx, op, async () => {
        const decision = await base.authorize(ctx, op);
        assertValid<{ locationRef: string; onDate?: string; display?: 'staff' | 'shared' }>(
          validate,
          query,
          SYNTHETIC_TASK_PROPERTIES,
        );
        if (query.onDate !== undefined && !isRealDate(query.onDate))
          throw new RefusalError({
            code: 'validation_failed',
            detail: { violations: [{ pointer: '/onDate', rule: 'invalidDate' }] },
          });
        assertLocation(decision.locationRefs, query.locationRef);
        const forced = ctx.scopes.includes(DISPLAY_SCOPE);
        const display = forced ? 'shared' : (query.display ?? 'staff');
        const allowed =
          display === 'staff'
            ? await base.permissions(ctx, Object.values(FLAGS))
            : new Map<string, boolean>();
        return base.deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{ id: string; location_ref: string; time_zone: string; now: Date }>(
            'SELECT id, location_ref, time_zone, now() AS now FROM cuspatlas.scheduling_locations WHERE location_ref = $1',
            [query.locationRef],
          );
          const l = rows[0];
          if (!l) throw notFound();
          const location: ScheduleLocation = { id: l.id, locationRef: l.location_ref, timeZone: l.time_zone };
          const onDate = query.onDate ?? addDays(localDate(l.now.getTime(), l.time_zone), 1);
          const { appointments } = await appointmentsInRange(tx, location, rangeOf(location, onDate, onDate));
          const now = l.now;
          const head = {
            location: { locationRef: location.locationRef, timeZone: location.timeZone },
            onDate,
            zone: location.timeZone,
            display,
            displayForced: forced,
            asOf: now.toISOString(),
          };
          if (display === 'shared') {
            return {
              data: {
                ...head,
                appointments: appointments.map((a) => ({
                  startsAt: a.startsAt,
                  localStart: a.localStart,
                  localEnd: a.localEnd,
                  resources: a.resources,
                  attendanceState: a.attendance.state,
                  patient: 'anonymized',
                })),
              },
            };
          }
          const flags = await readiness(tx, allowed, appointments, onDate, now);
          const read = Object.values(FLAGS)
            .filter((f) => allowed.get(f.key) && f.key !== 'forms')
            .map((f) => f.key);
          // Any returned patient-linked section (identity, eligibility, balance, labs, clinical) is a
          // sensitive read, not only the identity section.
          const seen = [...new Set(appointments.map((a) => a.patientRef))];
          if (seen.length > 0 && read.length > 0)
            await recordSensitiveRead(tx, {
              operation: op,
              resourceType: 'patient',
              resourceRefs: seen.slice(0, 100),
              ...(seen.length > 100 ? { totalCount: seen.length } : {}),
              // Which sections were read (clinical and financial), never their values.
              queryFields: read,
            });
          return {
            data: {
              ...head,
              sections: Object.values(FLAGS).map((f) => ({
                key: f.key,
                owner: f.owner,
                status: f.key === 'forms' ? 'unavailable' : allowed.get(f.key) ? 'ok' : 'restricted',
                ...(allowed.get(f.key) || f.key === 'forms' ? {} : { requiredScope: f.scope }),
              })),
              appointments: appointments.map((a) => ({
                appointmentRef: a.appointmentRef,
                startsAt: a.startsAt,
                localStart: a.localStart,
                localEnd: a.localEnd,
                resources: a.resources,
                attendanceState: a.attendance.state,
                patientRef: a.patientRef,
                ...flags.get(a.appointmentRef),
              })),
            },
          };
        });
      });
    },
  };
}

async function readiness(
  tx: TenantTransaction,
  allowed: Map<string, boolean>,
  appts: Awaited<ReturnType<typeof appointmentsInRange>>['appointments'],
  onDate: string,
  now: Date,
): Promise<Map<string, Record<string, Component<unknown>>>> {
  const ids = appts.map((a) => a.appointmentRef);
  const patients = [...new Set(appts.map((a) => a.patientRef))];
  const labs = allowed.get('labs') ? await labCasesFor(tx, ids) : [];
  const notes = allowed.get('clinical') ? await unsignedNotesFor(tx, patients) : new Map<string, number>();
  const out = new Map<string, Record<string, Component<unknown>>>();
  for (const a of appts) {
    const flags: Record<string, Component<unknown>> = { forms: unavailable(FLAGS.forms) };
    if (allowed.get('patient')) {
      const { rows } = await tx.query<Parameters<typeof toSummary>[0]>(
        `SELECT ${PATIENT_COLUMNS} FROM cuspatlas.patients WHERE id = $1`,
        [a.patientRef],
      );
      const s = rows[0] ? toSummary(rows[0]) : null;
      flags.patient = s
        ? ok(
            FLAGS.patient,
            { legalName: s.legalName, preferredName: s.preferredName, status: s.status },
            live(now),
          )
        : unavailable(FLAGS.patient, 'record_missing');
    } else flags.patient = restricted(FLAGS.patient);
    if (allowed.get('eligibility')) {
      const list = await coverageSummariesFor(tx, [a.patientRef], onDate);
      const retrieved = list
        .map((c) => c.eligibility?.retrievedAt ?? null)
        .filter((x): x is string => x !== null)
        .sort();
      const stale = list.some((c) => c.coverageStatus === 'stale');
      flags.eligibility = ok(
        FLAGS.eligibility,
        {
          state:
            list.length === 0
              ? 'no_coverage'
              : stale
                ? 'stale'
                : list.every((c) => c.coverageStatus === 'entered')
                  ? 'current'
                  : 'needs_review',
          statuses: list.map((c) => c.coverageStatus),
        },
        {
          asOf: retrieved.at(-1) ?? now.toISOString(),
          state: stale ? 'stale' : 'current',
          basis: retrieved.length
            ? 'B5 eligibility record retrievedAt'
            : 'live read in the composing transaction',
        },
      );
    } else flags.eligibility = restricted(FLAGS.eligibility);
    if (allowed.get('balance')) {
      const b = await patientBalanceIn(tx, a.patientRef, null);
      const minor = BigInt(b.balance.minor);
      flags.balance = ok(
        FLAGS.balance,
        { state: minor > 0n ? 'owing' : minor < 0n ? 'credit' : 'zero', balance: b.balance },
        { asOf: b.asOf, state: 'current', basis: 'B2 journal as of the read instant' },
      );
    } else flags.balance = restricted(FLAGS.balance);
    if (allowed.get('labs')) {
      const mine = labs.filter((x) => x.appointmentRef === a.appointmentRef);
      flags.labs = ok(
        FLAGS.labs,
        {
          state: mine.length === 0 ? 'none' : mine.every((x) => x.received) ? 'received' : 'awaiting',
          cases: mine.map((x) => ({
            labCaseRef: x.labCaseRef,
            state: x.state,
            expectedReturnDate: x.expectedReturnDate,
          })),
        },
        live(now),
      );
    } else flags.labs = restricted(FLAGS.labs);
    flags.clinical = allowed.get('clinical')
      ? ok(FLAGS.clinical, { unsignedNotes: notes.get(a.patientRef) ?? 0 }, live(now))
      : restricted(FLAGS.clinical);
    out.set(a.appointmentRef, flags);
  }
  return out;
}
