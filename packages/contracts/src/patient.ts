import type { ValidateFunction } from 'ajv/dist/2020.js';
import schema from './patient.schema.json' with { type: 'json' };
import { collectPropertyNames, createAjv } from './validation';

/** Types mirroring patient.schema.json (S4-S6). The JSON Schema is authoritative for validation. */
export type UnknownReason = 'not_provided' | 'declined' | 'not_applicable' | 'unavailable';
export interface Unknown {
  readonly known: false;
  readonly reason: UnknownReason;
}
export type Known<T> = { readonly known: true } & T;
export type LegalName = Known<{ given: string; middle?: string; family: string }> | Unknown;
export type PreferredName = Known<{ value: string }> | Unknown;
export type Pronouns = Known<{ value: string }> | Unknown;
export type BirthDatePrecision = 'day' | 'month' | 'year';
export type BirthDate = Known<{ value: string; precision: BirthDatePrecision }> | Unknown;
export type Language = Known<{ tag: string }> | Unknown;
export interface ContactPoint {
  readonly channel: 'phone' | 'email';
  readonly use: 'mobile' | 'home' | 'work' | 'other';
  readonly value: string;
  readonly preference: 'preferred' | 'accepted' | 'avoid';
}
export type Contact = Known<{ points: readonly ContactPoint[] }> | Unknown;
export type Address =
  | Known<{ lines: readonly string[]; city: string; region?: string; postalCode: string; country: string }>
  | Unknown;
export interface PatientIdentifier {
  readonly type: 'chart_number' | 'prior_system' | 'external_record';
  readonly issuer: string;
  readonly value: string;
}
export type Provenance = 'staff_entry' | 'patient_reported' | 'guardian_reported' | 'migration_import';
export const PATIENT_FIELD_GROUPS = [
  'legalName',
  'preferredName',
  'pronouns',
  'birthDate',
  'language',
  'contact',
  'address',
  'identifiers',
] as const;
export type PatientFieldGroup = (typeof PATIENT_FIELD_GROUPS)[number];
export type ProvenanceMap = Partial<Record<PatientFieldGroup, Provenance>>;
export type PatientStatus = 'active' | 'inactive' | 'deceased';
export type StatusReasonCode =
  | 'moved_away'
  | 'no_recent_visits'
  | 'patient_request'
  | 'deceased_reported'
  | 'returned'
  | 'entered_in_error'
  | 'other';

export interface PatientCreate {
  readonly legalName: LegalName;
  readonly birthDate: BirthDate;
  readonly preferredName?: PreferredName;
  readonly pronouns?: Pronouns;
  readonly language?: Language;
  readonly timeZone?: string;
  readonly contact?: Contact;
  readonly address?: Address;
  readonly identifiers?: readonly PatientIdentifier[];
  readonly homeLocationRef?: string;
  readonly provenance?: ProvenanceMap;
}
export interface PatientDemographicsUpdate extends Partial<PatientCreate> {
  readonly expectedVersion: number;
  /** S5: the related person who asked for the change (needs the demographics relationship scope). */
  readonly requestedBy?: string;
}
export interface PatientReadQuery {
  readonly requestedBy?: string;
}
export interface PatientStatusChange {
  readonly expectedVersion: number;
  readonly status: PatientStatus;
  readonly effectiveAt: string;
  readonly reasonCode: StatusReasonCode;
}
export interface PatientSearch {
  readonly name?: string;
  readonly birthDate?: string;
  readonly phone?: string;
  readonly status?: PatientStatus;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface PatientSummary {
  readonly patientRef: string;
  readonly legalName: LegalName;
  readonly preferredName: PreferredName;
  readonly birthDate: BirthDate;
  readonly status: PatientStatus;
  readonly statusEffectiveAt: string;
  readonly homeLocationRef: string | null;
  readonly contactable: boolean;
  readonly mergedIntoRef: string | null;
  readonly version: number;
}
export interface Patient extends PatientSummary {
  readonly pronouns: Pronouns;
  readonly language: Language;
  readonly timeZone: string | null;
  readonly contact: Contact;
  readonly address: Address;
  readonly identifiers: readonly PatientIdentifier[];
  readonly provenance: ProvenanceMap;
}
export interface PatientSummaryPage {
  readonly data: readonly PatientSummary[];
  readonly nextCursor: string | null;
}

/** S5. The relationship scopes registered in docs/SHARED-CONTRACTS.md: the complete set. */
export const RELATIONSHIP_SCOPES = [
  'demographics',
  'scheduling',
  'clinical_read',
  'financial',
  'consent',
] as const;
export type RelationshipScope = (typeof RELATIONSHIP_SCOPES)[number];
export type RelationshipKind = 'guardian' | 'guarantor' | 'dependent' | 'proxy';
export type RelationshipStatus = 'active' | 'pending' | 'expired' | 'revoked';
export type RelationshipStatusReason =
  | 'active'
  | 'not_yet_effective'
  | 'window_ended'
  | 'age_of_majority_reached'
  | 'revoked';
export type RelationshipRevokeReason =
  | 'patient_request'
  | 'guardian_request'
  | 'authority_ended'
  | 'entered_in_error'
  | 'other';
export interface RelationshipCreate {
  readonly counterpartyRef: string;
  readonly kind: RelationshipKind;
  readonly scopes: readonly RelationshipScope[];
  readonly effectiveFrom?: string;
  readonly effectiveUntil?: string;
  readonly evidenceRef?: string;
}
export interface RelationshipRevoke {
  readonly expectedVersion: number;
  readonly reasonCode: RelationshipRevokeReason;
}
export interface Relationship {
  readonly relationshipRef: string;
  readonly subjectRef: string;
  readonly counterpartyRef: string;
  readonly kind: RelationshipKind;
  readonly scopes: readonly RelationshipScope[];
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly effectiveEnd: string | null;
  readonly evidenceRef: string | null;
  readonly revokedAt: string | null;
  readonly revokeReason: RelationshipRevokeReason | null;
  readonly status: RelationshipStatus;
  readonly statusReason: RelationshipStatusReason;
  readonly version: number;
}
export type PatientAccessReason =
  | 'relationship_active'
  | 'relationship_missing'
  | 'relationship_pending'
  | 'relationship_expired'
  | 'relationship_revoked';
export interface PatientAccess {
  readonly subjectRef: string;
  readonly counterpartyRef: string;
  readonly evaluatedAt: string;
  readonly policyVersion: string;
  readonly scopes: readonly RelationshipScope[];
  readonly reason: PatientAccessReason;
  readonly relationships: readonly Relationship[];
}

export const patientSchema = schema;
export const PATIENT_SCHEMA_ID = schema.$id;
export const PATIENT_PROPERTIES: ReadonlySet<string> = collectPropertyNames(schema);

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: keyof typeof schema.$defs): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`schema definition missing: ${name}`);
  return v;
}

export const validatePatientCreate = def('PatientCreate');
export const validatePatientDemographicsUpdate = def('PatientDemographicsUpdate');
export const validatePatientStatusChange = def('PatientStatusChange');
export const validatePatientReadQuery = def('PatientReadQuery');
export const validatePatientSearch = def('PatientSearch');
export const validatePatientRef = def('PatientRef');
export const validatePatientIdempotencyKey = def('IdempotencyKey');
export const validateRelationshipCreate = def('RelationshipCreate');
export const validateRelationshipRevoke = def('RelationshipRevoke');
export const validateRelationshipListQuery = def('RelationshipListQuery');
export const validateRelationshipRef = def('RelationshipRef');
export const validatePatientAccessQuery = def('PatientAccessQuery');
