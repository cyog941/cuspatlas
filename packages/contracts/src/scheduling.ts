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
