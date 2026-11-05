import type { ValidateFunction } from 'ajv/dist/2020.js';
import schema from './migration.schema.json' with { type: 'json' };
import type { Money } from './money';
import { collectPropertyNames, createAjv } from './validation';

/**
 * Migration contract (workstream M: M2-M6). Types mirror migration.schema.json, which is authoritative
 * for validation. Synthetic source packages only: real exports stay blocked on M-S1 (authorised
 * export availability), M-S2 (lawful archive) and M-S3 (recovery objective). Every mapping and
 * reconciliation rule is recommended-pending-approval.
 */
export type SourceFormat = 'cuspatlas-synthetic-legacy/1';
export const SOURCE_FORMATS: readonly SourceFormat[] = schema.$defs.SourceFormat.enum as SourceFormat[];

export interface SourceProfileRegister {
  readonly sourceSystem: string;
  readonly format: SourceFormat;
  readonly practiceRef: string;
}

export interface ManifestEntity {
  readonly name: string;
  readonly declaredCount: number;
  readonly artifactDigest: string;
}

export interface SourcePackage {
  readonly format: SourceFormat;
  readonly sourceSystem: string;
  readonly practiceRef: string;
  readonly producedAt: string;
  readonly manifest: { readonly entities: readonly ManifestEntity[] };
  /** Entity name -> CSV text (header row first). */
  readonly tables: Readonly<Record<string, string>>;
}

export interface PackageIntake {
  readonly profileRef: string;
  readonly authorisation: { readonly reference: string; readonly practiceRef: string };
  readonly package: SourcePackage;
}

export interface PackageIntakeSummary {
  readonly packageRef: string;
  readonly state: 'staged';
  readonly alreadyStaged: boolean;
  readonly stagedCount: number;
  readonly reviewCount: number;
}

export type ReviewCategory =
  | 'unknown_field'
  | 'unmapped_entity'
  | 'terminology'
  | 'monetary_semantics'
  | 'missing_source_id'
  | 'duplicate_source_id'
  | 'identity'
  | 'future_appointment';

export type ReviewDecision =
  | 'exclude'
  | 'archiveOnly'
  | 'acceptProposal'
  | 'distinct'
  | 'sameAsExisting'
  | 'mergeAfterImport';

export interface ReviewItem {
  readonly itemRef: string;
  readonly category: ReviewCategory;
  readonly entity: string;
  readonly field: string | null;
  readonly subjectKey: string;
  readonly stagedRefs: readonly string[];
  readonly proposal: Readonly<Record<string, unknown>>;
  readonly state: 'open' | 'resolved';
  readonly decision: ReviewDecision | null;
  readonly allowedDecisions: readonly ReviewDecision[];
}

export interface ReviewItemResolve {
  readonly packageRef: string;
  readonly itemRef: string;
  readonly decision: ReviewDecision;
  readonly reasonCode: string;
  readonly patientRef?: string;
}

export interface PackageStateView {
  readonly packageRef: string;
  readonly profileRef: string;
  readonly sourceSystem: string;
  readonly format: SourceFormat;
  readonly packageDigest: string;
  readonly cutoverState: 'reconciling' | 'readyForCutover';
  readonly changeSeq: number;
  readonly entities: readonly { entity: string; mapped: boolean; staged: number; withIssue: number }[];
  readonly openReviewItems: number;
}

export type { Money };

export const migrationSchema = schema;
export const MIGRATION_SCHEMA_ID = schema.$id;
export const MIGRATION_PROPERTIES: ReadonlySet<string> = collectPropertyNames(schema);

const ajv = createAjv();
ajv.addSchema(schema);
function def(name: keyof typeof schema.$defs): ValidateFunction {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!v) throw new Error(`schema definition missing: ${name}`);
  return v;
}

export const validateMigrationIdempotencyKey = def('IdempotencyKey');
export const validateMigrationRef = def('Uuid');
export const validateSourceProfileRegister = def('SourceProfileRegister');
export const validatePackageIntake = def('PackageIntake');
export const validatePackageQuery = def('PackageQuery');
export const validateReviewItemListQuery = def('ReviewItemListQuery');
export const validateReviewItemResolve = def('ReviewItemResolve');
export const validateImportApply = def('ImportApply');
export const validateIdentityMerge = def('IdentityMerge');
export const validateProvenanceQuery = def('ProvenanceQuery');
export const validateSignOffRecord = def('SignOffRecord');
export const validateCutoverAdvance = def('CutoverAdvance');
