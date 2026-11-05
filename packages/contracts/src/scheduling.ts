import type { ValidateFunction } from 'ajv/dist/2020.js';
import type { Conflict, ResourceKind, ResourceRef } from './context';
import type { ListEnvelope } from './list-envelope';
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
export interface LocalTimeWindow {
  readonly start: string;
  readonly end: string;
}
export interface AvailabilitySearch {
  readonly locationRef: string;
  readonly from: string;
  /** Required unless `next` is given (S18). */
  readonly to?: string;
  readonly weekdays?: readonly number[];
  readonly timeWindows?: readonly LocalTimeWindow[];
  readonly preferredProviderRefs?: readonly string[];
  readonly next?: number;
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
  readonly envelope: ListEnvelope;
  readonly constraints: {
    readonly applied: readonly string[];
    readonly maxWindowDays: number;
    readonly weekdays?: readonly number[];
    readonly timeWindows?: readonly LocalTimeWindow[];
    readonly preferredProviderRefs?: readonly string[];
    readonly next?: number;
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

/** S11 attendance: an append-only transition sequence; the state is derived. */
export type AttendanceKind =
  | 'confirmed_manual'
  | 'confirmed_automated'
  | 'arrived'
  | 'arrived_curbside'
  | 'waiting'
  | 'in_care'
  | 'late'
  | 'left_without_treatment'
  | 'no_show'
  | 'cancelled'
  | 'rescheduled';
export type AttendanceState =
  | 'scheduled'
  | 'confirmed'
  | 'late'
  | 'arrived'
  | 'waiting'
  | 'in_care'
  | 'left_without_treatment'
  | 'no_show'
  | 'cancelled'
  | 'rescheduled';
export interface AttendanceRecord {
  readonly kind: AttendanceKind;
  readonly reasonCode?: string;
  readonly note?: string;
  readonly claimedAt?: string;
  readonly provenanceRef?: string;
  readonly amendsTransitionRef?: string;
}
export interface AttendanceTransitionRecord {
  readonly transitionRef: string;
  readonly appointmentRef: string;
  readonly sequence: number;
  readonly kind: AttendanceKind;
  readonly source: 'staff' | 'automation' | 'booking_command';
  readonly provenanceRef: string | null;
  readonly reasonCode: string | null;
  readonly note: string | null;
  readonly claimedAt: string | null;
  readonly amendsTransitionRef: string | null;
  readonly actorRef: string;
  readonly occurredAt: string;
}
export interface AttendanceCommandData {
  readonly transitionRef: string;
  readonly appointmentRef: string;
  readonly kind: AttendanceKind;
  readonly state: AttendanceState;
  readonly sequence: number;
}
export interface OwnedPlaceholder {
  readonly ref: null;
  readonly owner: 'C5' | 'B1';
  readonly statement: string;
}
export interface VisitStatusData {
  readonly appointmentRef: string;
  readonly booking: { readonly status: AppointmentStatus; readonly version: number };
  readonly attendance: {
    readonly state: AttendanceState;
    readonly confirmation: 'manual' | 'automated' | null;
    readonly lastTransitionAt: string | null;
    readonly transitions: number;
  };
  readonly clinicalCompletion: OwnedPlaceholder;
  readonly billing: OwnedPlaceholder;
}
export interface WorklistQuery {
  readonly locationRef: string;
  readonly date: string;
}
export interface WorklistEntry {
  readonly appointmentRef: string;
  readonly patientRef: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly provider: { readonly kind: 'provider'; readonly resourceRef: string };
  readonly operatory: { readonly kind: 'operatory'; readonly resourceRef: string } | null;
  readonly noOperatoryReason: NoOperatoryReason | null;
  readonly status: AppointmentStatus;
  readonly attendanceState: AttendanceState;
  readonly confirmation: 'manual' | 'automated' | null;
}
export interface DailyWorklistData {
  readonly locationRef: string;
  readonly date: string;
  readonly timeZone: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly appointments: readonly WorklistEntry[];
}

export const validateAttendanceRecord = def('AttendanceRecord');
export const validateWorklistQuery = def('WorklistQuery');

/** S12 visit context: a container of references to clinical producers (C8, C10, C11, C13, C16). */
export type VisitItemKind = 'medical_history_pin' | 'form_assignment' | 'lab_case_link';
export type VisitProducerKey = 'medicalHistory' | 'forms' | 'noteDrafts' | 'labCases' | 'treatmentPlanItems';
export type VisitProducerOwner = 'C8' | 'C10' | 'C11' | 'C13' | 'C16';
export interface VisitFormAssign {
  readonly formRef: string;
}
export interface VisitFormUnassign {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export interface VisitLabLink {
  readonly labCaseRef: string;
}
export interface VisitLabRelink {
  readonly labCaseRef: string;
  readonly reasonCode: string;
}
export interface VisitItemCommandData {
  readonly itemRef: string;
  readonly appointmentRef: string;
  readonly itemKind: VisitItemKind;
  readonly producerRef: string;
  readonly itemVersion: number | null;
  readonly state: 'active' | 'ended';
  readonly endKind: 'unassigned' | 'relinked' | null;
  readonly created: boolean;
}
export interface VisitContextEntry {
  readonly itemRef: string | null;
  readonly producerRef: string;
  readonly version: number | null;
  readonly currentVersion: number | null;
  readonly provenanceRef: string | null;
  readonly resolution: 'resolved' | 'voided' | 'not_found';
  readonly state: 'active' | 'ended';
}
export type VisitContextSlot =
  | {
      readonly status: 'unavailable';
      readonly owner: VisitProducerOwner;
      readonly reason: 'producer_not_deployed' | 'producer_access_denied';
    }
  | {
      readonly status: 'available';
      readonly owner: VisitProducerOwner;
      readonly entries: VisitContextEntry[];
    };
export interface VisitContextData {
  readonly appointmentRef: string;
  readonly asOf: string;
  readonly appointment: {
    readonly status: AppointmentStatus;
    readonly version: number;
    readonly startsAt: string;
    readonly locationRef: string;
    readonly acceptsChanges: boolean;
  };
  readonly patient: { readonly status: 'resolved'; readonly patientRef: string };
  readonly attendance: { readonly status: 'resolved'; readonly state: AttendanceState };
  readonly items: Readonly<Record<VisitProducerKey, VisitContextSlot>>;
  readonly readiness: {
    readonly resolved: number;
    readonly unavailable: VisitProducerKey[];
    readonly complete: boolean;
  };
}
export interface VisitContextItemRecord {
  readonly itemRef: string;
  readonly itemKind: VisitItemKind;
  readonly producer: 'C8' | 'C13' | 'C16';
  readonly producerRef: string;
  readonly itemVersion: number | null;
  readonly provenanceRef: string | null;
  readonly state: 'active' | 'ended';
  readonly endKind: 'unassigned' | 'relinked' | null;
  readonly endReason: string | null;
  readonly relinkedFrom: string | null;
  readonly relinkedTo: string | null;
  readonly actorRef: string;
  readonly createdAt: string;
  readonly endedAt: string | null;
  readonly version: number;
}

export const validateVisitContextPin = def('VisitContextPin');
export const validateVisitFormAssign = def('VisitFormAssign');
export const validateVisitFormUnassign = def('VisitFormUnassign');
export const validateVisitLabLink = def('VisitLabLink');
export const validateVisitLabRelink = def('VisitLabRelink');

/** S13 recurrence series (ADR 0009 S-D1 cap; S-S3-R1/R2 occurrence rules). */
export const SERIES_LIMIT_NAME = 'scheduling.series.occurrenceLimit';
/** Published configuration ceiling of the per-request occurrence limit (default limit 26). */
export const SERIES_LIMIT_CEILING = 52;
export const SERIES_DEFAULT_LIMIT = 26;
export interface SeriesPattern {
  readonly frequency: 'weekly' | 'monthly';
  readonly interval: number;
}
export interface SeriesCreate {
  readonly patientRef: string;
  readonly locationRef: string;
  readonly provider: { readonly kind: 'provider'; readonly resourceRef: string };
  readonly operatory: { readonly kind: 'operatory'; readonly resourceRef: string } | null;
  readonly noOperatoryReason?: NoOperatoryReason;
  readonly resources?: readonly ResourceRef[];
  readonly appointmentTypeCode?: string;
  readonly pattern: SeriesPattern;
  readonly firstDate: string;
  readonly startTime: string;
  readonly durationMinutes: number;
  readonly count: number;
  readonly skipConflicts?: boolean;
}
export interface SeriesExtend {
  readonly expectedVersion: number;
  readonly count: number;
  readonly skipConflicts?: boolean;
}
export interface SeriesEnd {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export interface SeriesCommandData {
  readonly seriesRef: string;
  readonly state: 'active' | 'ended';
  readonly requested: number;
  readonly created: number;
  readonly skipped: number;
  /** True when `skipConflicts` left occurrences unbooked: 201 with fewer bookings than requested. */
  readonly partial: boolean;
  readonly appointmentRefs: string[];
  readonly skippedOccurrences: {
    readonly index: number;
    readonly localDate: string;
    readonly reason: string;
  }[];
  readonly openOccurrenceRefs: string[];
}
export interface SeriesPlanData {
  readonly limit: { readonly name: string; readonly value: number; readonly ceiling: number };
  readonly requested: number;
  readonly conflicted: number;
  readonly occurrences: {
    readonly index: number;
    readonly localDate: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly conflicts: readonly Conflict[];
  }[];
}
export interface SeriesRecord {
  readonly seriesRef: string;
  readonly patientRef: string;
  readonly locationRef: string;
  readonly pattern: SeriesPattern;
  readonly firstDate: string;
  readonly startTime: string;
  readonly durationMinutes: number;
  readonly timeZone: string;
  readonly provider: { readonly kind: 'provider'; readonly resourceRef: string };
  readonly operatory: { readonly kind: 'operatory'; readonly resourceRef: string } | null;
  readonly state: 'active' | 'ended';
  readonly endReason: string | null;
  readonly limitAtCreation: number;
  readonly version: number;
  readonly occurrences: {
    readonly index: number;
    readonly localDate: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly outcome: 'booked' | 'skipped';
    readonly skipReason: string | null;
    readonly appointmentRef: string | null;
    readonly currentAppointmentRef: string | null;
    readonly status: AppointmentStatus | null;
  }[];
  readonly exceptions: {
    readonly index: number;
    readonly appointmentRef: string;
    readonly kind: 'cancelled' | 'rescheduled';
    readonly reasonCode: string;
    readonly occurredAt: string;
  }[];
}
export const validateSeriesCreate = def('SeriesCreate');
export const validateSeriesExtend = def('SeriesExtend');
export const validateSeriesEnd = def('SeriesEnd');

/** Proposed shared exception-first work item (S-owned until a shared module adopts it). */
export type WorkItemKind =
  | 'notification_without_channel'
  | 'cancellation_recovery'
  | 'waitlist_offer_pending'
  | 'recall_due'
  | 'recall_task_open'
  | 'request_unbooked'
  | 'request_booking_lost'
  // C kinds adopted from this shared model (C16 lab returns, C17 referral responses; PT-03).
  | 'lab_return_overdue'
  | 'lab_case_review'
  | 'referral_response_due'
  | 'referral_review'
  // E7: a failed or unknown delivery (owned by E; listed by communications.deliveries.worklist).
  | 'delivery_exception'
  // E4/E5: an intake review item and a secure-message thread awaiting the practice.
  | 'intake_review'
  | 'message_awaiting_reply';
export interface WorkItem {
  readonly workItemRef: string;
  readonly kind: WorkItemKind;
  readonly reasonCode: string;
  readonly explanation: string;
  readonly evidenceRefs: readonly { readonly kind: string; readonly ref: string }[];
  readonly owner: {
    readonly queue: 'front_desk' | 'scheduling' | 'recall' | 'practice_manager' | 'clinical';
    readonly principalRef: string | null;
  };
  readonly nextActionOwedBy: 'practice' | 'patient' | 'payer' | 'vendor' | 'platform';
  readonly dueAt: string | null;
  readonly priority: 'routine' | 'soon' | 'urgent';
  readonly priorityRationale: string;
  readonly suggestedNextAction: string;
  readonly blockingDependencies: readonly string[];
}
export type WorkCoverage =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable'; readonly reason: string; readonly owner: string };
export interface WorkItemListData {
  readonly asOf: string;
  readonly coverage: WorkCoverage;
  readonly count: number;
  /** Areas the list cannot cover yet (producer not deployed), reported rather than shown as empty. */
  readonly notCovered?: readonly { readonly area: string; readonly owner: string; readonly reason: string }[];
  readonly items: readonly WorkItem[];
}

/** S14 notification intents (no verified channel; E6 decides suppression; E7 delivers). */
export type NotificationPurpose = 'reminder' | 'cancellation' | 'waitlist_offer' | 'recall';
export type NotificationChannel = 'none' | 'sms' | 'email' | 'voice' | 'portal';
export interface NotificationWorklistQuery {
  readonly locationRef?: string;
}
export interface NotificationIntentRecord {
  readonly intentRef: string;
  readonly subjectKind: 'appointment' | 'waitlist_offer' | 'recall_task';
  readonly subjectRef: string;
  readonly locationRef: string;
  readonly purpose: NotificationPurpose;
  readonly channel: NotificationChannel;
  readonly deliveryKey: string;
  readonly policyRef: string;
  readonly templateRef: string | null;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
  readonly dueAt: string | null;
  /** E6's decision (recorded with the intent); `undecided` only for an intent recorded before E6. */
  readonly suppressionDecision: {
    readonly ref: string | null;
    readonly owner: 'E6';
    readonly state: 'undecided' | 'allowed' | 'suppressed';
    readonly reason: string | null;
    readonly statement: string;
  };
  /** E7's delivery state: its outbound message, or why there is none. */
  readonly delivery: { readonly owner: 'E7'; readonly state: string; readonly messageRef?: string | null };
  readonly createdAt: string;
}
export const validateNotificationWorklistQuery = def('NotificationWorklistQuery');

/** S15 waitlist and PT-02 cancellation recovery inputs (outputs are typed in the domain module). */
export type WaitlistState = 'active' | 'offered' | 'booked' | 'removed';
export type OfferOutcome = 'accepted' | 'declined' | 'expired' | 'withdrawn';
export interface WaitlistAdd {
  readonly patientRef: string;
  readonly locationRef: string;
  readonly durationMinutes: number;
  readonly desiredFrom: string;
  readonly desiredUntil: string;
  readonly providerPreference?: { readonly kind: 'provider'; readonly resourceRef: string };
  readonly appointmentTypeCode?: string;
  readonly priority?: number;
  readonly requestedChannel?: NotificationChannel;
  readonly expiresAt?: string;
}
export interface WaitlistRemove {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export interface WaitlistListQuery {
  readonly locationRef?: string;
  readonly state?: WaitlistState;
}
export interface WaitlistOffer {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly provider: { readonly kind: 'provider'; readonly resourceRef: string };
  readonly operatory: { readonly kind: 'operatory'; readonly resourceRef: string } | null;
  readonly noOperatoryReason?: NoOperatoryReason;
}
export interface OfferRespond {
  readonly expectedVersion: number;
  readonly outcome: 'accepted' | 'declined' | 'withdrawn';
  readonly reasonCode?: string;
}
export interface RecoveryListQuery {
  readonly locationRef?: string;
}
export interface RecoveryExecute {
  readonly expectedVersion: number;
  readonly entryRef?: string;
}
export interface StandingPolicyGrant {
  readonly operation: 'scheduling.recovery.execute';
  readonly granteeRef: string;
  readonly locationRefs: readonly string[];
  readonly maxOffersPerRecovery: number;
  readonly expiresAt: string;
}
export interface StandingPolicyRevoke {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export const validateWaitlistAdd = def('WaitlistAdd');
export const validateWaitlistRemove = def('WaitlistRemove');
export const validateWaitlistListQuery = def('WaitlistListQuery');
export const validateWaitlistOffer = def('WaitlistOffer');
export const validateOfferRespond = def('OfferRespond');
export const validateOfferReconcile = def('OfferReconcile');
export const validateRecoveryListQuery = def('RecoveryListQuery');
export const validateRecoveryExecute = def('RecoveryExecute');
export const validateStandingPolicyGrant = def('StandingPolicyGrant');
export const validateStandingPolicyRevoke = def('StandingPolicyRevoke');

/** S16 recall policy and due computation (ADR 0009 S-D7 pending approval). */
export type RecallBasis = 'attended_visit' | 'completed_procedure';
export interface RecallPolicyDefine {
  readonly category: string;
  readonly intervalMonths: number;
  readonly basis: RecallBasis;
  readonly appointmentTypeCodes?: readonly string[];
  readonly procedureCodeRefs?: readonly string[];
  readonly excludeBooked?: boolean;
}
export interface RecallDueQuery {
  readonly category: string;
  readonly asOf?: string;
  readonly locationRef?: string;
}
export interface RecallTaskCreate {
  readonly patientRef: string;
  readonly category: string;
  readonly locationRef: string;
  readonly expectedPolicyVersion: number;
  readonly asOf?: string;
}
export interface RecallTaskResolve {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export interface FollowUpWorklistQuery {
  readonly locationRef?: string;
}
export const validateRecallPolicyDefine = def('RecallPolicyDefine');
export const validateRecallDueQuery = def('RecallDueQuery');
export const validateRecallTaskCreate = def('RecallTaskCreate');
export const validateRecallTaskResolve = def('RecallTaskResolve');
export const validateFollowUpWorklistQuery = def('FollowUpWorklistQuery');

/**
 * S17 minimal scheduling export (S scope; the full export contract is M1). Versioned; one array of
 * row objects per table in foreign-key order, references preserved, no tenant field.
 */
export const SCHEDULING_EXPORT_FORMAT = 'cuspatlas-scheduling-export/1';
export const SCHEDULING_EXPORT_TABLES = [
  'scheduling_policy_settings',
  'scheduling_attendance_reasons',
  'scheduling_locations',
  'scheduling_resources',
  'scheduling_availability_versions',
  'scheduling_offer_policies',
  'scheduling_time_blocks',
  'patients',
  'patient_status_history',
  'patient_relationships',
  'patient_merges',
  'patient_merge_moves',
  'patient_merge_reversals',
  'appointment_requests',
  'appointment_request_transitions',
  'scheduling_holds',
  'appointments',
  'scheduling_occupancy',
  'appointment_lifecycle_events',
  'appointment_overrides',
  'appointment_attendance_transitions',
  'visit_context_items',
  'appointment_series',
  'appointment_series_occurrences',
  'appointment_series_exceptions',
  'notification_intents',
  'waitlist_entries',
  'cancellation_recoveries',
  'scheduling_standing_policies',
  'waitlist_offers',
  'recall_policies',
  'recall_tasks',
  // S20 staging list, S21 floor view, S22 patient reassignment (after their appointment,
  // request, location and resource parents).
  'scheduling_staging_lists',
  'scheduling_staging_entries',
  'scheduling_provider_requests',
  'scheduling_staff_presence',
  'appointment_patient_reassignments',
] as const;
export type SchedulingExportTable = (typeof SCHEDULING_EXPORT_TABLES)[number];
export interface SchedulingExport {
  readonly format: typeof SCHEDULING_EXPORT_FORMAT;
  readonly exportedAt: string;
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}

/** S20 (OR-05): bounded per-location staging list for appointments being moved. */
export type StagingEntryState = 'staged' | 'moved' | 'removed';
export interface StagingSettings {
  readonly locationRef: string;
  readonly capacity: number;
}
export interface StagingAdd {
  readonly locationRef: string;
  readonly appointmentRef?: string;
  readonly requestRef?: string;
  readonly reasonCode: string;
}
export interface StagingRemove {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export type StagingMove = AppointmentReschedule;
export interface StagingEntry {
  readonly entryRef: string;
  readonly locationRef: string;
  readonly subjectKind: 'appointment' | 'request';
  readonly subjectRef: string;
  readonly state: StagingEntryState;
  readonly reasonCode: string;
  readonly subjectStatus: string;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly stagedAt: string;
  readonly version: number;
}
export interface StagingList {
  readonly locationRef: string;
  readonly capacity: number;
  readonly items: readonly StagingEntry[];
  readonly envelope: ListEnvelope;
}
export interface StagingMoveData {
  readonly entryRef: string;
  readonly state: 'moved';
  readonly previousAppointmentRef: string;
  readonly appointmentRef: string;
}
export const validateStagingListQuery = def('StagingListQuery');
export const validateStagingSettings = def('StagingSettings');
export const validateStagingAdd = def('StagingAdd');
export const validateStagingRemove = def('StagingRemove');
export const validateStagingMove = def('StagingMove');

/** S21 (OR-06): floor view, provider request facts and staff presence. */
export type FloorProjection = 'standard' | 'anonymized';
export type ProviderRequestState = 'open' | 'acknowledged' | 'cleared';
export type PresenceStatus = 'available' | 'busy' | 'away';
export interface FloorQuery {
  readonly locationRef: string;
  readonly projection?: FloorProjection;
}
export interface ProviderRequestCreate {
  readonly reasonCode: string;
}
export interface ProviderRequestAcknowledge {
  readonly expectedVersion: number;
}
export interface ProviderRequestClear {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export interface PresenceSet {
  readonly locationRef: string;
  readonly status: PresenceStatus;
  readonly operatoryRef?: string;
  readonly expiresInMinutes?: number;
}
export interface ProviderRequestRecord {
  readonly requestRef: string;
  readonly appointmentRef: string;
  readonly locationRef: string;
  readonly state: ProviderRequestState;
  readonly reasonCode: string;
  readonly requestedAt: string;
  readonly version: number;
}
export interface FloorVisit {
  readonly appointmentRef?: string;
  readonly attendanceState: string;
  readonly label: string;
  readonly since: string | null;
  readonly elapsedMinutes: number | null;
  readonly nextActions: readonly string[];
  readonly patient: { readonly patientRef: string } | 'restricted' | 'anonymized';
  readonly providerRequest: { readonly requestRef: string; readonly state: 'open' | 'acknowledged' } | null;
}
export interface FloorView {
  readonly locationRef: string;
  readonly projection: FloorProjection;
  readonly operatories: readonly {
    readonly operatoryRef: string;
    readonly label: string | null;
    readonly currentVisit: FloorVisit | null;
  }[];
  readonly envelope: ListEnvelope;
}
export interface PresenceRecord {
  readonly principalRef: string;
  readonly status: PresenceStatus;
  readonly operatoryRef: string | null;
  readonly setAt: string;
  readonly expiresAt: string;
}
export const validateFloorQuery = def('FloorQuery');
export const validateProviderRequestCreate = def('ProviderRequestCreate');
export const validateProviderRequestAcknowledge = def('ProviderRequestAcknowledge');
export const validateProviderRequestClear = def('ProviderRequestClear');
export const validateProviderRequestListQuery = def('ProviderRequestListQuery');
export const validatePresenceSet = def('PresenceSet');
export const validatePresenceListQuery = def('PresenceListQuery');

/** S22 (OR-11): reassign an appointment's patient while no other fact references it. */
export interface AppointmentPatientReassign {
  readonly expectedVersion: number;
  readonly patientRef: string;
  readonly reasonCode: string;
}
export const validateAppointmentPatientReassign = def('AppointmentPatientReassign');
