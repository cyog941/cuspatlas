import type { ValidateFunction } from 'ajv/dist/2020.js';
import schema from './clinical.schema.json' with { type: 'json' };
import { collectPropertyNames, createAjv } from './validation';

/**
 * Types mirroring clinical.schema.json (C5 encounters and clinical authorship). The JSON Schema is
 * authoritative for validation. Clinical semantics are recommended-pending-clinical-approval
 * (docs/adr/0005-chart-semantics.md, docs/adr/0006-note-signing.md); synthetic data only.
 */
export type ClinicalRole = 'dentist' | 'hygienist' | 'assistant' | 'other_clinical';

/** Recorded on every clinical mutation; the credential detail stays in the staff module. */
export interface ClinicalAuthor {
  readonly actorRef: string;
  readonly role: ClinicalRole;
  readonly credentialRef: string | null;
}

export interface ClinicalAuthorDefine {
  readonly actorRef: string;
  readonly role: ClinicalRole;
  readonly credentialRef?: string;
  readonly active?: boolean;
  readonly expectedVersion?: number;
}

export interface ClinicalAuthorProfile {
  readonly actorRef: string;
  readonly role: ClinicalRole;
  readonly credentialRef: string | null;
  readonly active: boolean;
  readonly version: number;
}

export interface AuthorContextData {
  readonly resolvable: boolean;
  readonly author: ClinicalAuthor | null;
  readonly reason: 'service_principal' | 'no_profile' | 'profile_inactive' | null;
}

export type AssignmentRole =
  | 'treating_provider'
  | 'secondary_provider'
  | 'supervising_provider'
  | 'staff'
  | 'completing_provider';

export interface Assignee {
  readonly kind: 'provider' | 'staff';
  readonly resourceRef: string;
}

export interface AssignmentInput {
  readonly role: AssignmentRole;
  readonly assignee: Assignee;
}

export interface EncounterOpen {
  readonly patientRef: string;
  readonly appointmentRef?: string;
  readonly locationRef?: string;
  readonly assignments?: readonly AssignmentInput[];
}

export interface EncounterAssign {
  readonly expectedVersion: number;
  readonly role: AssignmentRole;
  readonly assignee: Assignee | null;
}

export interface EncounterClose {
  readonly expectedVersion: number;
  readonly dispositionCode: string;
}

export interface EncounterListQuery {
  readonly limit?: string;
  readonly cursor?: string;
}

export type EncounterAppointmentStatus = 'booked' | 'cancelled' | 'rescheduled';
export type EncounterFlag =
  | 'appointment_cancelled_at_open'
  | 'appointment_rescheduled_at_open'
  | 'appointment_changed_since_open';

export interface EncounterAssignment {
  readonly sequence: number;
  readonly role: AssignmentRole;
  readonly assignee: Assignee | null;
  readonly assignedBy: ClinicalAuthor;
  readonly assignedAt: string;
}

export interface Encounter {
  readonly encounterRef: string;
  readonly patientRef: string;
  readonly locationRef: string;
  readonly appointment: {
    readonly appointmentRef: string;
    readonly statusAtOpen: EncounterAppointmentStatus;
    readonly currentStatus: EncounterAppointmentStatus;
    readonly rescheduledToRef: string | null;
  } | null;
  readonly flags: readonly EncounterFlag[];
  readonly state: 'open' | 'closed';
  /** The current assignment of each assigned role. */
  readonly assignments: readonly EncounterAssignment[];
  /** Every assignment ever recorded, oldest first (append-only). */
  readonly assignmentHistory: readonly EncounterAssignment[];
  readonly openedBy: ClinicalAuthor;
  readonly openedAt: string;
  readonly closure: {
    readonly dispositionCode: string;
    readonly closedBy: ClinicalAuthor;
    readonly closedAt: string;
  } | null;
  readonly version: number;
}

export interface EncounterOpenData {
  readonly outcome: 'opened' | 'existing';
  readonly encounter: Encounter;
}

export interface EncounterPage {
  readonly data: readonly Encounter[];
  readonly nextCursor: string | null;
}

export const clinicalSchema = schema;
export const CLINICAL_SCHEMA_ID = schema.$id;
export const CLINICAL_PROPERTIES: ReadonlySet<string> = collectPropertyNames(schema);

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: keyof typeof schema.$defs): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`schema definition missing: ${name}`);
  return v;
}

export const validateClinicalIdempotencyKey = def('IdempotencyKey');
export const validateClinicalRef = def('EncounterRef');
export const validateClinicalAuthorDefine = def('ClinicalAuthorDefine');
export const validateEncounterOpen = def('EncounterOpen');
export const validateEncounterAssign = def('EncounterAssign');
export const validateEncounterClose = def('EncounterClose');
export const validateEncounterListQuery = def('EncounterListQuery');
/** Response schemas, used by tests to prove REST and MCP results conform to the contract. */
export const validateEncounterRead = def('EncounterRead');
export const validateEncounterOpenResult = def('EncounterOpenResult');
export const validateEncounterList = def('EncounterList');

/** C8 medical history, allergies and medications (append-only versions; no drug database). */
export type HistoryKind = 'condition' | 'allergy' | 'medication' | 'vital' | 'social';
export type HistoryState = 'active' | 'resolved' | 'discontinued' | 'entered_in_error';
export type HistoryEntryType = 'fact' | 'none_known';
export type HistoryProvenance = 'staff' | 'patient_reported' | 'imported';
export type ReportedBy = 'patient' | 'guardian' | 'caregiver' | 'clinician' | 'external_record';
export type ReviewOutcome = 'none' | 'confirmed';
export type AlertStatus = 'unknown' | 'none_reported' | 'reviewed_none' | 'present';

export interface HistoryChangeInput {
  readonly itemRef?: string;
  readonly kind?: HistoryKind;
  readonly entryType?: HistoryEntryType;
  readonly state: HistoryState;
  readonly displayText?: string;
  readonly codeRef?: string;
  readonly detailText?: string;
  readonly effectiveFrom?: string;
  readonly effectiveUntil?: string;
  readonly reasonCode?: string;
}

export interface HistoryChangeRecord {
  readonly patientRef: string;
  readonly encounterRef?: string;
  readonly provenance: HistoryProvenance;
  readonly reportedBy: ReportedBy;
  readonly sourceRef?: string;
  readonly expectedVersion?: number;
  readonly changes: readonly HistoryChangeInput[];
}

export interface HistoryVersionHeader {
  readonly historyVersionRef: string;
  readonly streamRef: string;
  readonly version: number;
  readonly provenance: HistoryProvenance;
  readonly reportedBy: ReportedBy;
  readonly sourceRef: string | null;
  readonly encounterRef: string | null;
  readonly recordedBy: ClinicalAuthor;
  readonly recordedAt: string;
}

export interface HistoryChange {
  readonly changeRef: string;
  readonly itemSequence: number;
  readonly state: HistoryState;
  readonly displayText: string | null;
  readonly codeRef: string | null;
  readonly detailText: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly reasonCode: string | null;
  readonly recorded: HistoryVersionHeader;
}

export interface HistoryVerification {
  readonly changeRef: string;
  readonly verifiedBy: ClinicalAuthor;
  readonly verifiedAt: string;
  readonly encounterRef: string | null;
}

export interface HistoryItem {
  readonly itemRef: string;
  readonly kind: HistoryKind;
  readonly entryType: HistoryEntryType;
  readonly streamRef: string;
  readonly sourcePatientRef: string;
  readonly current: HistoryChange;
  /** Verification of exactly the current change, or null (a later change needs a new verification). */
  readonly verification: HistoryVerification | null;
  readonly changes: readonly HistoryChange[];
  readonly verifications: readonly HistoryVerification[];
}

export interface HistoryStream {
  readonly streamRef: string;
  readonly sourcePatientRef: string;
  readonly version: number;
}

export interface HistoryReadData {
  readonly patientRef: string;
  readonly asOf: string;
  readonly recorded: boolean;
  readonly streams: readonly HistoryStream[];
  readonly items: readonly HistoryItem[];
}

export interface HistoryVersionDetail {
  readonly header: HistoryVersionHeader;
  readonly changes: readonly {
    readonly itemRef: string;
    readonly kind: HistoryKind;
    readonly entryType: HistoryEntryType;
    readonly change: HistoryChange;
  }[];
}

export interface HistoryVerify {
  readonly expectedChangeRef: string;
  readonly encounterRef?: string;
}

export interface HistoryReviewAttest {
  readonly allergy?: ReviewOutcome;
  readonly condition?: ReviewOutcome;
  readonly medication?: ReviewOutcome;
}

export interface HistoryReview {
  readonly reviewRef: string;
  readonly encounterRef: string;
  readonly patientRef: string;
  readonly allergy: ReviewOutcome | null;
  readonly condition: ReviewOutcome | null;
  readonly medication: ReviewOutcome | null;
  readonly reviewedBy: ClinicalAuthor;
  readonly reviewedAt: string;
}

export interface AlertSection {
  readonly status: AlertStatus;
  readonly items: readonly {
    readonly itemRef: string;
    readonly displayText: string | null;
    readonly codeRef: string | null;
    readonly detailText: string | null;
    readonly provenance: HistoryProvenance;
    readonly verified: boolean;
    readonly recordedAt: string;
  }[];
  readonly noneKnown: {
    readonly itemRef: string;
    readonly provenance: HistoryProvenance;
    readonly recordedAt: string;
  } | null;
  readonly lastReview: {
    readonly reviewRef: string;
    readonly encounterRef: string;
    readonly outcome: ReviewOutcome;
    readonly reviewedBy: ClinicalAuthor;
    readonly reviewedAt: string;
    readonly stale: boolean;
  } | null;
}

export interface NotProvided {
  readonly provided: false;
  readonly statement: string;
}

export interface ActiveAlertsData {
  readonly patientRef: string;
  readonly computedAt: string;
  readonly allergy: AlertSection;
  readonly condition: AlertSection;
  readonly medication: AlertSection;
  readonly interactionChecking: NotProvided;
  readonly decisionSupport: NotProvided;
}

export const validateHistoryChangeRecord = def('HistoryChangeRecord');
export const validateHistoryReadQuery = def('HistoryReadQuery');
export const validateHistoryVerify = def('HistoryVerify');
export const validateHistoryReviewAttest = def('HistoryReviewAttest');
export const validateHistoryRead = def('HistoryRead');
export const validateHistoryVersionRead = def('HistoryVersionRead');
export const validateActiveAlerts = def('ActiveAlerts');
