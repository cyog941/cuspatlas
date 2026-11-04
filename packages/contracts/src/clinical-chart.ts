import type { ValidateFunction } from 'ajv/dist/2020.js';
import type { ClinicalAuthor } from './clinical';
import schema from './clinical.schema.json' with { type: 'json' };
import { createAjv } from './validation';

/**
 * Types mirroring the C6 (chart), C7 (periodontal) and C11 (treatment plan) definitions of
 * clinical.schema.json. The JSON Schema is authoritative. Semantics are
 * recommended-pending-clinical-approval (docs/adr/0005-chart-semantics.md); synthetic data only.
 * Kept in its own module so the clinical record batches register with one export line.
 */
export type ToothInputSystem = 'universal' | 'fdi' | 'canonical';
export type ToothDisplaySystem = 'universal' | 'fdi';
export type ToothDentition = 'permanent' | 'primary' | 'supernumerary';

export interface ToothInput {
  readonly system: ToothInputSystem;
  readonly code: string;
}

export interface ToothRef {
  readonly canonicalRef: string;
  readonly dentition: ToothDentition;
  readonly displaySystem: ToothDisplaySystem;
  readonly display: string | null;
  readonly universal: string | null;
  readonly fdi: string | null;
}

export type ChartEntryKind =
  | 'condition'
  | 'existing_restoration'
  | 'missing'
  | 'supernumerary'
  | 'implant'
  | 'prosthodontic';
export type ChartRecordedState = 'active' | 'resolved' | 'entered_in_error';
export type ChartEntryState = 'active' | 'resolved' | 'superseded' | 'entered_in_error';
export type ChartProvenance = 'recorded' | 'imported' | 'patient_reported';

export interface ChartEntryRecord {
  readonly patientRef: string;
  readonly encounterRef?: string;
  readonly provenance: ChartProvenance;
  readonly sourceRef?: string;
  readonly tooth?: ToothInput;
  readonly surfaces?: readonly string[];
  readonly kind: ChartEntryKind;
  readonly findingRef: string;
  readonly state?: 'active' | 'resolved';
  readonly detailText?: string;
}

export interface ChartEntryCorrect {
  readonly reasonCode: string;
  readonly state: ChartRecordedState;
  readonly encounterRef?: string;
  readonly tooth?: ToothInput;
  readonly surfaces?: readonly string[] | null;
  readonly kind?: ChartEntryKind;
  readonly findingRef?: string;
  readonly detailText?: string | null;
}

export interface ChartEntry {
  readonly entryRef: string;
  readonly chartRef: string;
  readonly patientRef: string;
  readonly sourcePatientRef: string;
  readonly sequence: number;
  readonly tooth: ToothRef | null;
  readonly surfaces: readonly string[] | null;
  readonly kind: ChartEntryKind;
  readonly findingRef: string;
  readonly state: ChartEntryState;
  readonly recordedState: ChartRecordedState;
  readonly detailText: string | null;
  readonly provenance: ChartProvenance;
  readonly sourceRef: string | null;
  readonly encounterRef: string | null;
  readonly recordedBy: ClinicalAuthor;
  readonly clinicalAuthor: ClinicalAuthor | null;
  readonly recordedAt: string;
  readonly supersedesEntryRef: string | null;
  readonly supersededByEntryRef: string | null;
  readonly correctionReasonCode: string | null;
  readonly toothVocabulary: string | null;
}

export interface ChartEntryRecordData {
  readonly outcome: 'recorded' | 'existing';
  readonly entry: ChartEntry;
}

export interface ChartReadQuery {
  readonly asOf?: string;
  readonly dentition?: 'permanent' | 'primary';
  readonly provenance?: ChartProvenance;
  readonly displaySystem?: ToothDisplaySystem;
}

export interface ChartToothState {
  readonly tooth: ToothRef;
  readonly status: 'present' | 'missing' | 'implant';
  readonly activeEntryRefs: readonly string[];
}

export interface ChartReadData {
  readonly patientRef: string;
  readonly asOf: string;
  readonly displaySystem: ToothDisplaySystem;
  readonly recorded: boolean;
  readonly charts: readonly {
    readonly chartRef: string;
    readonly sourcePatientRef: string;
    readonly version: number;
  }[];
  readonly entries: readonly ChartEntry[];
  readonly teeth: readonly ChartToothState[];
}

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: keyof typeof schema.$defs): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`schema definition missing: ${name}`);
  return v;
}

export const validateChartEntryRecord = def('ChartEntryRecord');
export const validateChartEntryCorrect = def('ChartEntryCorrect');
export const validateChartReadQuery = def('ChartReadQuery');
/** Response schemas, used by tests to prove REST and MCP results conform to the contract. */
export const validateChartEntryCommandResult = def('ChartEntryCommandResult');
export const validateChartCorrectionResult = def('ChartCorrectionResult');
export const validateChartRead = def('ChartRead');

/** C7 periodontal exams: raw measurements; derived values only from the pending formula registry. */
export type PerioSite = 'db' | 'b' | 'mb' | 'dl' | 'l' | 'ml';
export type PerioMeasure = 'probing_depth' | 'recession' | 'bleeding' | 'mobility' | 'furcation';
export type PerioInputMeasure = 'probing_depth' | 'recession';
export type PerioValueInput =
  | { readonly status: 'measured'; readonly mm?: number; readonly present?: boolean; readonly grade?: string }
  | { readonly status: 'not_measured' };

/** A tooth of an exam: one value per site in the scheme order (db, b, mb, dl, l, ml). */
export type NotMeasured = 'not_measured';
export interface PerioToothInput {
  readonly tooth: ToothInput;
  readonly mobility: { readonly grade: string } | NotMeasured;
  readonly furcation: { readonly grade: string } | NotMeasured;
  readonly probingDepth: readonly (number | NotMeasured)[];
  readonly recession: readonly (number | NotMeasured)[];
  readonly bleeding: readonly (boolean | NotMeasured)[];
}

export interface PerioExamRecord {
  readonly patientRef: string;
  readonly encounterRef?: string;
  readonly examDate?: string;
  readonly siteScheme: 'six_site_provisional';
  readonly teeth: readonly PerioToothInput[];
}

export interface PerioExamCorrect {
  readonly reasonCode: string;
  readonly encounterRef?: string;
  readonly corrections: readonly { readonly measurementRef: string; readonly value: PerioValueInput }[];
}

export interface PerioDerive {
  readonly formulaRef: string;
  readonly formulaVersion: number;
}

export interface PerioCompareQuery {
  readonly baseExamRef: string;
  readonly targetExamRef: string;
  readonly formulaRef?: string;
  readonly formulaVersion?: string;
}

export interface PerioMeasurement {
  readonly measurementRef: string;
  readonly tooth: ToothRef;
  readonly site: PerioSite | null;
  readonly measure: PerioMeasure;
  readonly status: 'measured' | 'not_measured';
  readonly mm: number | null;
  readonly present: boolean | null;
  readonly grade: string | null;
  readonly current: boolean;
  readonly supersedesRef: string | null;
  readonly supersededByRef: string | null;
  readonly reasonCode: string | null;
  readonly recordedBy: ClinicalAuthor;
  readonly recordedAt: string;
}

export interface PerioFormula {
  readonly formulaRef: string;
  readonly version: number;
  readonly operation: 'sum';
  readonly inputs: readonly PerioInputMeasure[];
  readonly approvalStatus: 'pending';
  readonly withdrawn: boolean;
  readonly historical: boolean;
}

export interface PerioDerivedValue {
  readonly tooth: ToothRef;
  readonly site: PerioSite;
  readonly status: 'derived' | 'not_computable';
  readonly value: number | null;
  readonly missingInputs: readonly PerioInputMeasure[];
}

export interface PerioDerivation {
  readonly derivationRef: string;
  readonly examRef: string;
  readonly formula: PerioFormula;
  readonly label: 'derived_pending_clinical_approval';
  readonly computedBy: ClinicalAuthor;
  readonly computedAt: string;
  readonly values: readonly PerioDerivedValue[];
}

export interface PerioExamHeader {
  readonly examRef: string;
  readonly streamRef: string;
  readonly patientRef: string;
  readonly sourcePatientRef: string;
  readonly sequence: number;
  readonly siteScheme: 'six_site_provisional';
  readonly examDate: string | null;
  readonly encounterRef: string | null;
  readonly toothCount: number;
  readonly recordedBy: ClinicalAuthor;
  readonly recordedAt: string;
}

export interface PerioExam extends PerioExamHeader {
  readonly measurements: readonly PerioMeasurement[];
  readonly derivations: readonly PerioDerivation[];
}

export type PerioCompareStatus =
  | 'compared'
  | 'not_measured_in_base'
  | 'not_measured_in_target'
  | 'not_measured_in_both'
  | 'not_computable_in_base'
  | 'not_computable_in_target'
  | 'not_computable_in_both'
  | 'absent_in_base'
  | 'absent_in_target';

export interface PerioComparedSite {
  readonly tooth: ToothRef;
  readonly site: PerioSite;
  readonly measure: PerioInputMeasure | 'derived';
  readonly base: number | null;
  readonly target: number | null;
  readonly delta: number | null;
  readonly status: PerioCompareStatus;
}

export interface PerioComparisonData {
  readonly patientRef: string;
  readonly baseExamRef: string;
  readonly targetExamRef: string;
  readonly sites: readonly PerioComparedSite[];
  readonly derived: {
    readonly formulaRef: string;
    readonly approvalStatus: 'pending';
    readonly label: 'derived_pending_clinical_approval';
    readonly sites: readonly PerioComparedSite[];
  } | null;
  readonly formulaVersions: readonly {
    readonly examRef: string;
    readonly formulaRef: string;
    readonly version: number;
  }[];
}

export const validatePerioExamRecord = def('PerioExamRecord');
export const validatePerioExamCorrect = def('PerioExamCorrect');
export const validatePerioDerive = def('PerioDerive');
export const validatePerioCompareQuery = def('PerioCompareQuery');
export const validatePerioExamCommandResult = def('PerioExamCommandResult');
export const validatePerioDerivationCommandResult = def('PerioDerivationCommandResult');
export const validatePerioExamRead = def('PerioExamRead');
export const validatePerioExamList = def('PerioExamList');
export const validatePerioComparison = def('PerioComparison');

/** C11 treatment plans: plan version, detail and item as three addressable levels; no amount anywhere. */
export type PlanDetailScope = 'tooth' | 'surface_set' | 'area' | 'whole_mouth';
export type PlanAreaCode = 'ur' | 'ul' | 'll' | 'lr' | 'upper' | 'lower';
export type PlanItemState = 'proposed' | 'accepted' | 'scheduled' | 'completed' | 'declined' | 'discontinued';
export type PlanDetailState = 'active' | 'declined' | 'discontinued';
export type PlanVersionState = 'draft' | 'accepted' | 'superseded';
export type PlanTransitionCause =
  | 'created'
  | 'direct'
  | 'detail_declined'
  | 'detail_discontinued'
  | 'carried_forward';

export interface TreatmentPlanCreate {
  readonly patientRef: string;
  readonly encounterRef?: string;
  readonly displayText?: string;
}

export interface PlanDetailAdd {
  readonly expectedRevision: number;
  readonly scope: PlanDetailScope;
  readonly tooth?: ToothInput;
  readonly surfaces?: readonly string[];
  readonly areaCode?: PlanAreaCode;
  readonly phase?: number;
  readonly chartEntryRef?: string;
  readonly displayText?: string;
}

export interface PlanItemAdd {
  readonly expectedRevision: number;
  readonly procedureCodeRef: string;
  readonly sequence: number;
  readonly tooth?: ToothInput;
  readonly surfaces?: readonly string[];
  readonly areaCode?: PlanAreaCode;
  readonly feeScheduleRef?: string;
  readonly chartEntryRef?: string;
  readonly displayText?: string;
}

export interface PlanItemStateSet {
  readonly expectedRevision: number;
  readonly state: PlanItemState;
  readonly reasonCode?: string;
  readonly appointmentRef?: string;
}

export interface PlanDetailStateSet {
  readonly expectedRevision: number;
  readonly state: 'declined' | 'discontinued';
  readonly reasonCode: string;
}

export interface PlanVersionSupersede {
  readonly expectedRevision: number;
  readonly reasonCode: string;
  readonly displayText?: string;
}

export interface PlanItemTransition {
  readonly from: PlanItemState | null;
  readonly to: PlanItemState;
  readonly cause: PlanTransitionCause;
  readonly reasonCode: string | null;
  readonly parentDetailRef: string | null;
  readonly appointmentRef: string | null;
  readonly recordedBy: ClinicalAuthor;
  readonly recordedAt: string;
}

export interface PlanItem {
  readonly itemRef: string;
  readonly detailRef: string;
  readonly planVersionRef: string;
  readonly procedureCodeRef: string;
  readonly sequence: number;
  readonly tooth: ToothRef | null;
  readonly surfaces: readonly string[] | null;
  readonly areaCode: PlanAreaCode | null;
  readonly feeScheduleRef: string | null;
  readonly chartEntryRef: string | null;
  readonly displayText: string | null;
  readonly state: PlanItemState;
  readonly appointmentRef: string | null;
  readonly derivedFromItemRef: string | null;
  readonly createdBy: ClinicalAuthor;
  readonly createdAt: string;
  readonly transitions: readonly PlanItemTransition[];
}

export interface PlanDetail {
  readonly detailRef: string;
  readonly planVersionRef: string;
  readonly sequence: number;
  readonly phase: number | null;
  readonly scope: PlanDetailScope;
  readonly tooth: ToothRef | null;
  readonly surfaces: readonly string[] | null;
  readonly areaCode: PlanAreaCode | null;
  readonly chartEntryRef: string | null;
  readonly displayText: string | null;
  readonly state: PlanDetailState;
  readonly reasonCode: string | null;
  readonly stateRecordedBy: ClinicalAuthor | null;
  readonly stateRecordedAt: string | null;
  readonly derivedFromDetailRef: string | null;
  readonly createdBy: ClinicalAuthor;
  readonly createdAt: string;
  readonly items: readonly PlanItem[];
}

export interface PlanVersion {
  readonly planVersionRef: string;
  readonly number: number;
  readonly state: PlanVersionState;
  readonly revision: number;
  readonly displayText: string | null;
  readonly supersedesRef: string | null;
  readonly supersededByRef: string | null;
  readonly supersedeReasonCode: string | null;
  readonly acceptance: { readonly acceptanceRef: string; readonly acceptedAt: string } | null;
  readonly encounterRef: string | null;
  readonly createdBy: ClinicalAuthor;
  readonly createdAt: string;
  readonly estimateReadiness: {
    readonly complete: boolean;
    readonly itemCount: number;
    readonly itemsWithoutFeeScheduleRef: readonly string[];
  };
  readonly details: readonly PlanDetail[];
}

export interface TreatmentPlan {
  readonly planRef: string;
  readonly patientRef: string;
  readonly sourcePatientRef: string;
  readonly headVersionRef: string;
  readonly createdBy: ClinicalAuthor;
  readonly createdAt: string;
  readonly versions: readonly PlanVersion[];
}

export interface TreatmentPlanCommandData {
  readonly targetRef: string;
  readonly plan: TreatmentPlan;
}

export interface TreatmentPlanHeader {
  readonly planRef: string;
  readonly patientRef: string;
  readonly sourcePatientRef: string;
  readonly headVersionRef: string;
  readonly headVersionNumber: number;
  readonly headState: PlanVersionState;
  readonly createdAt: string;
}

export const validateTreatmentPlanCreate = def('TreatmentPlanCreate');
export const validatePlanDetailAdd = def('PlanDetailAdd');
export const validatePlanItemAdd = def('PlanItemAdd');
export const validatePlanItemStateSet = def('PlanItemStateSet');
export const validatePlanDetailStateSet = def('PlanDetailStateSet');
export const validatePlanVersionSupersede = def('PlanVersionSupersede');
export const validateTreatmentPlanCommandResult = def('TreatmentPlanCommandResult');
export const validateTreatmentPlanRead = def('TreatmentPlanRead');
export const validateTreatmentPlanList = def('TreatmentPlanList');
