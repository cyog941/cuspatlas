import type {
  AppointmentCommandData,
  AvailabilitySummary,
  BookingResult,
  HoldCommandData,
  HoldReconcileData,
  LocationSummary,
  RequestCommandData,
  ResourceKind,
  ResourceSummary,
  TimeBlockSummary,
} from '@cuspatlas/contracts';
import type { ReplayCodec, StoredResult } from '../commands/execute-once';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS: readonly string[] = ['provider', 'operatory', 'equipment', 'staff'];

const malformed = () => new Error('Stored result is malformed');
const ref = (v: unknown): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw malformed();
  return v;
};
const field = (payload: unknown, name: string): string => {
  const v = (payload as Record<string, unknown> | null)?.[name];
  if (typeof v !== 'string') throw new Error('Replay payload is malformed');
  return v;
};

/**
 * Scheduling replay projections (S7). Stored results hold server-issued references and server
 * enumerations only; caller-echoed fields (location reference, zone, effective date) are rebuilt
 * from the replay request, whose payload has the identical canonical digest.
 */
const location: ReplayCodec<LocationSummary> = {
  persist: (): StoredResult => ({ kind: 'success' }),
  restore(stored, payload) {
    if (stored.kind !== 'success') throw malformed();
    return { locationRef: field(payload, 'locationRef'), timeZone: field(payload, 'timeZone') };
  },
};

const resource = (status: 'active' | 'inactive'): ReplayCodec<ResourceSummary> => ({
  persist: (d): StoredResult => ({ kind: 'success', resourceRef: d.resourceRef, resourceKind: d.kind }),
  restore(stored) {
    if (stored.kind !== 'success' || !KINDS.includes(String(stored.resourceKind))) throw malformed();
    return { resourceRef: ref(stored.resourceRef), kind: stored.resourceKind as ResourceKind, status };
  },
});

const availability: ReplayCodec<AvailabilitySummary> = {
  persist: (d): StoredResult => ({
    kind: 'success',
    resourceRef: d.resourceRef,
    availabilityRef: d.availabilityRef,
  }),
  restore(stored, payload) {
    if (stored.kind !== 'success') throw malformed();
    return {
      resourceRef: ref(stored.resourceRef),
      availabilityRef: ref(stored.availabilityRef),
      effectiveFrom: field(payload, 'effectiveFrom'),
    };
  },
};

const timeBlock: ReplayCodec<TimeBlockSummary> = {
  persist: (d): StoredResult => ({ kind: 'success', timeBlockRef: d.timeBlockRef }),
  restore(stored) {
    if (stored.kind !== 'success') throw malformed();
    return { timeBlockRef: ref(stored.timeBlockRef) };
  },
};

export const SCHEDULING_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<unknown>>> = {
  'scheduling.locations.define': location as ReplayCodec<unknown>,
  'scheduling.locations.changeTimeZone': location as ReplayCodec<unknown>,
  'scheduling.resources.define': resource('active') as ReplayCodec<unknown>,
  'scheduling.resources.deactivate': resource('inactive') as ReplayCodec<unknown>,
  'scheduling.resources.setAvailability': availability as ReplayCodec<unknown>,
  'scheduling.timeBlocks.create': timeBlock as ReplayCodec<unknown>,
};

const REQUEST_STATES: readonly string[] = [
  'open',
  'in_review',
  'scheduled',
  'declined',
  'expired',
  'withdrawn',
];
/** S8: a request command stores its reference and the resulting state (a server enumeration). */
const request: ReplayCodec<RequestCommandData> = {
  persist: (d): StoredResult => ({ kind: 'success', requestRef: d.requestRef, state: d.state }),
  restore(stored) {
    if (stored.kind !== 'success' || !REQUEST_STATES.includes(String(stored.state))) throw malformed();
    return { requestRef: ref(stored.requestRef), state: stored.state as RequestCommandData['state'] };
  },
};

/** S10: booking results store server references, the outcome enum and the server-set expiry. */
const bookingResult: ReplayCodec<BookingResult> = {
  persist: (d): StoredResult => ({
    kind: 'success',
    outcome: d.outcome,
    appointmentRef: d.appointmentRef ?? null,
    holdRef: d.holdRef ?? null,
    expiresAt: d.expiresAt ?? null,
  }),
  restore(stored) {
    if (stored.kind !== 'success' || (stored.outcome !== 'booked' && stored.outcome !== 'held'))
      throw malformed();
    const expiresAt = stored.expiresAt;
    if (expiresAt !== null && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))))
      throw malformed();
    return {
      outcome: stored.outcome,
      ...(stored.appointmentRef === null ? {} : { appointmentRef: ref(stored.appointmentRef) }),
      ...(stored.holdRef === null ? {} : { holdRef: ref(stored.holdRef) }),
      ...(expiresAt === null ? {} : { expiresAt }),
      conflicts: [],
    };
  },
};
const holdReleased: ReplayCodec<HoldCommandData> = {
  persist: (d): StoredResult => ({ kind: 'success', holdRef: d.holdRef }),
  restore(stored) {
    if (stored.kind !== 'success') throw malformed();
    return { holdRef: ref(stored.holdRef), state: 'released' };
  },
};
const reconciled: ReplayCodec<HoldReconcileData> = {
  persist: (d): StoredResult => ({ kind: 'success', released: d.released }),
  restore(stored) {
    if (stored.kind !== 'success' || !Number.isSafeInteger(stored.released)) throw malformed();
    return { released: stored.released as number };
  },
};
const appointmentStatus: ReplayCodec<AppointmentCommandData> = {
  persist: (d): StoredResult => ({ kind: 'success', appointmentRef: d.appointmentRef, status: d.status }),
  restore(stored) {
    if (
      stored.kind !== 'success' ||
      !['booked', 'cancelled', 'rescheduled'].includes(String(stored.status))
    ) {
      throw malformed();
    }
    return {
      appointmentRef: ref(stored.appointmentRef),
      status: stored.status as AppointmentCommandData['status'],
    };
  },
};

export const APPOINTMENT_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<unknown>>> = {
  'scheduling.requests.create': request as ReplayCodec<unknown>,
  'scheduling.requests.updatePreferences': request as ReplayCodec<unknown>,
  'scheduling.requests.review': request as ReplayCodec<unknown>,
  'scheduling.requests.close': request as ReplayCodec<unknown>,
  'scheduling.requests.reopen': request as ReplayCodec<unknown>,
  'scheduling.appointments.book': bookingResult as ReplayCodec<unknown>,
  'scheduling.appointments.reschedule': bookingResult as ReplayCodec<unknown>,
  'scheduling.appointments.cancel': appointmentStatus as ReplayCodec<unknown>,
  'scheduling.holds.create': bookingResult as ReplayCodec<unknown>,
  'scheduling.holds.release': holdReleased as ReplayCodec<unknown>,
  'scheduling.holds.reconcile': reconciled as ReplayCodec<unknown>,
};
