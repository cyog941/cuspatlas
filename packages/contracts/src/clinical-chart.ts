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
