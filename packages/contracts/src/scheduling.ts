import type { ValidateFunction } from 'ajv/dist/2020.js';
import type { ResourceKind, ResourceRef } from './context';
import schema from './scheduling.schema.json' with { type: 'json' };
import { collectPropertyNames, createAjv } from './validation';

/** Types mirroring scheduling.schema.json (S7, S9). The JSON Schema is authoritative for validation. */
export type ResourceStatus = 'active' | 'inactive';
export type TimeBlockReason =
  | 'meeting'
  | 'maintenance'
  | 'training'
  | 'holiday'
  | 'lunch'
  | 'personal'
  | 'other';
/** Reserved exception vocabulary for an appointment without an operatory (consumed by S10). */
export type NoOperatoryReason = 'no_show' | 'cancelled' | 'not_yet_assigned' | 'off_site';
export const NO_OPERATORY_REASONS: readonly NoOperatoryReason[] = schema.$defs.NoOperatoryReason
  .enum as NoOperatoryReason[];

export type AppointmentOperatoryAssignment =
  | { readonly operatory: { readonly kind: 'operatory'; readonly resourceRef: string } }
  | { readonly operatory: null; readonly noOperatoryReason: NoOperatoryReason };

export interface WeeklyInterval {
  readonly weekday: number;
  readonly start: string;
  readonly end: string;
}
export interface LocationDefine {
  readonly locationRef: string;
  readonly displayLabel: string;
  readonly timeZone: string;
}
export interface LocationTimeZoneChange {
  readonly timeZone: string;
  readonly expectedVersion: number;
}
export interface ResourceDefine {
  readonly kind: ResourceKind;
  readonly locationRef: string;
  readonly displayLabel?: string;
  readonly displayOrder?: number;
}
export interface AvailabilitySet {
  readonly effectiveFrom: string;
  readonly weekly: readonly WeeklyInterval[];
}
export interface ResourceDeactivate {
  readonly expectedVersion: number;
}
export interface TimeBlockCreate {
  readonly locationRef: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly reasonCode: TimeBlockReason;
  readonly resources: readonly ResourceRef[];
}
export interface ResourceListQuery {
  readonly locationRef?: string;
  readonly kind?: ResourceKind;
  readonly limit?: string;
  readonly cursor?: string;
}
export interface LocationListQuery {
  readonly limit?: string;
  readonly cursor?: string;
}

export interface Location {
  readonly locationRef: string;
  readonly displayLabel: string;
  readonly timeZone: string;
  readonly status: ResourceStatus;
  readonly version: number;
}
export interface AvailabilityVersion {
  readonly availabilityRef: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly timeZone: string;
  readonly weekly: readonly WeeklyInterval[];
}
export interface Resource {
  readonly resourceRef: string;
  readonly kind: ResourceKind;
  readonly locationRef: string;
  readonly displayLabel: string | null;
  readonly displayOrder: number;
  readonly status: ResourceStatus;
  readonly version: number;
}
export interface ResourceDetail extends Resource {
  readonly availability: readonly AvailabilityVersion[];
}
export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}
export interface StateLabelReport {
  readonly vocabularyVersion: string;
  readonly checkedAt: string;
  readonly resourcesChecked: number;
  readonly stateLabelledCount: number;
  readonly stateLabelled: readonly {
    readonly resourceRef: string;
    readonly kind: ResourceKind;
    readonly locationRef: string;
    readonly matchedTerm: string;
  }[];
}
export interface LocationSummary {
  readonly locationRef: string;
  readonly timeZone: string;
}
export interface ResourceSummary {
  readonly resourceRef: string;
  readonly kind: ResourceKind;
  readonly status: ResourceStatus;
}
export interface AvailabilitySummary {
  readonly resourceRef: string;
  readonly availabilityRef: string;
  readonly effectiveFrom: string;
}
export interface TimeBlockSummary {
  readonly timeBlockRef: string;
}

/** S9 availability search (read-only, advisory). */
export interface AvailabilityRequirement {
  readonly kind: ResourceKind;
  readonly resourceRef?: string;
}
export interface AvailabilitySearch {
  readonly locationRef: string;
  readonly from: string;
  readonly to: string;
  readonly durationMinutes: number;
  readonly bufferMinutes?: number;
  readonly slotMinutes?: 5 | 10 | 15 | 20 | 30 | 60;
  readonly displayTimeZone: string;
  readonly appointmentTypeCode?: string;
  readonly requirements: readonly AvailabilityRequirement[];
  readonly limit?: number;
  readonly cursor?: string;
}
export interface AvailabilityWindow {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly durationMinutes: number;
  readonly localStart: string;
  readonly localEnd: string;
  readonly timeZone: string;
  readonly resources: readonly ResourceRef[];
}
export type AvailabilityOutcome =
  | 'windows'
  | 'none_free'
  | 'no_availability_configured'
  | 'no_eligible_resource';
export interface AvailabilitySearchResult {
  readonly outcome: AvailabilityOutcome;
  readonly advisory: true;
  readonly windows: readonly AvailabilityWindow[];
  readonly nextCursor: string | null;
  readonly constraints: {
    readonly applied: readonly string[];
    readonly durationMinutes: number;
    readonly bufferMinutes: number;
    readonly slotMinutes: number;
    readonly locationTimeZone: string;
    readonly displayTimeZone: string;
    readonly appointmentTypeCode?: string;
    readonly policyRef: string;
  };
  readonly coverage: {
    readonly notConsidered: readonly string[];
    readonly excludedResources: readonly {
      readonly resourceRef: ResourceRef;
      readonly reason: 'inactive' | 'no_availability_configured';
    }[];
    readonly statement: string;
  };
}

export const schedulingSchema = schema;
export const SCHEDULING_SCHEMA_ID = schema.$id;
export const SCHEDULING_PROPERTIES: ReadonlySet<string> = collectPropertyNames(schema);

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: keyof typeof schema.$defs): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`schema definition missing: ${name}`);
  return v;
}

export const validateLocationDefine = def('LocationDefine');
export const validateLocationTimeZoneChange = def('LocationTimeZoneChange');
export const validateResourceDefine = def('ResourceDefine');
export const validateAvailabilitySet = def('AvailabilitySet');
export const validateResourceDeactivate = def('ResourceDeactivate');
export const validateTimeBlockCreate = def('TimeBlockCreate');
export const validateResourceListQuery = def('ResourceListQuery');
export const validateLocationListQuery = def('LocationListQuery');
export const validateResourceRefId = def('ResourceRefId');
export const validateSchedulingLocationRef = def('LocationRef');
export const validateSchedulingIdempotencyKey = def('IdempotencyKey');
export const validateAppointmentOperatoryAssignment = def('AppointmentOperatoryAssignment');
export const validateAvailabilitySearch = def('AvailabilitySearch');

/** S8 appointment request (a separate fact from the booking). */
export type RequestState = 'open' | 'in_review' | 'scheduled' | 'declined' | 'expired' | 'withdrawn';
export type RequestOrigin = 'staff' | 'portal';
export type RequestFlexibility =
  | 'any_time'
  | 'mornings'
  | 'afternoons'
  | 'evenings'
  | 'weekdays'
  | 'weekends';
export type ContactConsent = 'unknown' | 'granted' | 'declined';
export interface PreferredWindow {
  readonly startsAt: string;
  readonly endsAt: string;
}
export interface AppointmentRequestCreate {
  readonly patientRef: string;
  readonly locationRef: string;
  readonly sourceChannel: string;
  readonly appointmentTypeCode?: string;
  readonly providerPreference?: string;
  readonly preferredWindows?: readonly PreferredWindow[];
  readonly flexibility?: RequestFlexibility;
  readonly urgent?: boolean;
  readonly contactConsent: ContactConsent;
  readonly note?: string;
}
export interface AppointmentRequestPreferences {
  readonly expectedVersion: number;
  readonly providerPreference?: string | null;
  readonly preferredWindows?: readonly PreferredWindow[];
  readonly flexibility?: RequestFlexibility | null;
  readonly urgent?: boolean;
  readonly contactConsent?: ContactConsent;
  readonly note?: string | null;
}
export interface AppointmentRequestReview {
  readonly expectedVersion: number;
}
export interface AppointmentRequestClose {
  readonly expectedVersion: number;
  readonly state: 'scheduled' | 'declined' | 'expired' | 'withdrawn';
  readonly reasonCode: string;
  readonly appointmentRef?: string;
  readonly expiryPolicyRef?: string;
}
export interface AppointmentRequestReopen {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export interface AppointmentRequestListQuery {
  readonly state?: RequestState;
  readonly locationRef?: string;
  readonly patientRef?: string;
  readonly limit?: string;
  readonly cursor?: string;
}
export interface RequestTransition {
  readonly from: RequestState | null;
  readonly to: RequestState;
  readonly reasonCode: string | null;
  readonly appointmentRef: string | null;
  readonly occurredAt: string;
  readonly version: number;
}
export interface AppointmentRequestSummary {
  readonly requestRef: string;
  readonly patientRef: string;
  readonly locationRef: string;
  readonly state: RequestState;
  readonly urgent: boolean;
  readonly appointmentRef: string | null;
  readonly version: number;
  readonly createdAt: string;
}
export interface AppointmentRequestRecord extends AppointmentRequestSummary {
  readonly origin: RequestOrigin;
  readonly sourceChannel: string;
  readonly appointmentTypeCode: string | null;
  readonly providerPreference: string | null;
  readonly preferredWindows: readonly PreferredWindow[];
  readonly flexibility: RequestFlexibility | null;
  readonly contactConsent: ContactConsent;
  readonly note: string | null;
  readonly stateReason: string | null;
  readonly closedAt: string | null;
  readonly transitions: readonly RequestTransition[];
}
export interface RequestCommandData {
  readonly requestRef: string;
  readonly state: RequestState;
}
export interface UnbookedRequestReport {
  readonly checkedAt: string;
  readonly count: number;
  readonly requests: readonly {
    readonly requestRef: string;
    readonly locationRef: string;
    readonly state: 'declined' | 'expired' | 'withdrawn';
    readonly reasonCode: string | null;
    readonly closedAt: string;
  }[];
}

export const validateAppointmentRequestCreate = def('AppointmentRequestCreate');
export const validateAppointmentRequestPreferences = def('AppointmentRequestPreferences');
export const validateAppointmentRequestReview = def('AppointmentRequestReview');
export const validateAppointmentRequestClose = def('AppointmentRequestClose');
export const validateAppointmentRequestReopen = def('AppointmentRequestReopen');
export const validateAppointmentRequestListQuery = def('AppointmentRequestListQuery');
export const validateSchedulingEntityRef = def('EntityRef');

/** S10 booking, holds and the inspectable conflict result. */
export type AppointmentStatus = 'booked' | 'cancelled' | 'rescheduled';
export type OverrideCode = 'provider_approved' | 'practice_policy' | 'emergency';
export interface BookingOverride {
  readonly code: OverrideCode;
  readonly reasonCode: string;
}
export interface BookingWindowInput {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly provider: { readonly kind: 'provider'; readonly resourceRef: string };
  readonly operatory: { readonly kind: 'operatory'; readonly resourceRef: string } | null;
  readonly noOperatoryReason?: NoOperatoryReason;
  readonly resources?: readonly ResourceRef[];
  readonly override?: BookingOverride;
}
export interface BookingCreate extends BookingWindowInput {
  readonly patientRef: string;
  readonly locationRef: string;
  readonly appointmentTypeCode?: string;
  readonly holdRef?: string;
  readonly requestRef?: string;
}
export interface AppointmentReschedule extends BookingWindowInput {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export interface AppointmentCancel {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export interface HoldCreate {
  readonly locationRef: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly resources: readonly ResourceRef[];
  readonly ttlMinutes?: number;
}
export interface HoldRelease {
  readonly reasonCode: string;
}
/**
 * The one booking result type. Only `booked` and `held` are successful outcomes; `conflict` and
 * `denied` travel as typed refusals (RefusalError with detail.conflicts, or forbidden/not_found).
 */
export interface BookingResult {
  readonly outcome: 'booked' | 'held';
  readonly appointmentRef?: string;
  readonly holdRef?: string;
  readonly expiresAt?: string;
  readonly conflicts: readonly [];
}
export interface HoldCommandData {
  readonly holdRef: string;
  readonly state: 'released';
}
export interface HoldReconcileData {
  readonly released: number;
}
export interface AppointmentCommandData {
  readonly appointmentRef: string;
  readonly status: AppointmentStatus;
}
export interface AppointmentRecord {
  readonly appointmentRef: string;
  readonly patientRef: string;
  readonly locationRef: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly durationMinutes: number;
  readonly timeZone: string;
  readonly provider: { readonly kind: 'provider'; readonly resourceRef: string };
  readonly operatory: { readonly kind: 'operatory'; readonly resourceRef: string } | null;
  readonly noOperatoryReason: NoOperatoryReason | null;
  readonly resources: readonly { readonly resourceRef: ResourceRef; readonly released: boolean }[];
  readonly appointmentTypeCode: string | null;
  readonly requestRef: string | null;
  readonly status: AppointmentStatus;
  readonly cancelReason: string | null;
  readonly rescheduledFrom: string | null;
  readonly rescheduledTo: string | null;
  readonly overrides: readonly {
    readonly code: OverrideCode;
    readonly reasonCode: string;
    readonly kinds: readonly string[];
    readonly actorRef: string;
  }[];
  readonly lifecycle: readonly {
    readonly kind: 'booked' | 'cancelled' | 'rescheduled_out' | 'rescheduled_in' | 'request_linked';
    readonly reasonCode: string | null;
    readonly relatedAppointmentRef: string | null;
    readonly occurredAt: string;
    readonly version: number;
  }[];
  readonly version: number;
  readonly createdAt: string;
}

export const validateBookingCreate = def('BookingCreate');
export const validateAppointmentReschedule = def('AppointmentReschedule');
export const validateAppointmentCancel = def('AppointmentCancel');
export const validateHoldCreate = def('HoldCreate');
export const validateHoldRelease = def('HoldRelease');
export const validateHoldReconcile = def('HoldReconcile');
