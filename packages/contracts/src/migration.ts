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

/** M1 practice export (synthetic only; M-S1 blocks a real incumbent export). */
export const PRACTICE_EXPORT_FORMAT = 'cuspatlas-practice-export/1' as const;
export const validatePracticeExportCreate = def('PracticeExportCreate');
export const validatePracticeExportGrant = def('PracticeExportGrant');
export const validatePracticeExportDownload = def('PracticeExportDownload');
export const validatePracticeExportQuery = def('PracticeExportQuery');

export interface PracticeExportDocumentSummary {
  readonly format: string;
  readonly digestSha256: string;
  /** Table name -> row count of the document. */
  readonly tables: Readonly<Record<string, number>>;
}

export interface PracticeExportManifest {
  readonly format: typeof PRACTICE_EXPORT_FORMAT;
  /** Tenant-free identifier of the export (no tenant identifier anywhere in the package). */
  readonly exportRef: string;
  readonly exportedAt: string;
  readonly documents: readonly PracticeExportDocumentSummary[];
  /** Content-addressed imaging bytes; they travel as I9 blob bundles, verified against these digests. */
  readonly blobs: readonly { readonly digestSha256: string; readonly byteLength: number }[];
  readonly terminology: {
    readonly system: string;
    readonly licensed: false;
    readonly codeVersions: readonly string[];
  };
  readonly provenance: { readonly generator: string; readonly importOrder: readonly string[] };
}

export interface PracticeExportDocument {
  readonly format: string;
  readonly exportedAt: string;
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}

export interface PracticeExportPackage {
  readonly manifest: PracticeExportManifest;
  readonly documents: readonly PracticeExportDocument[];
}

/** M7 historical archive packages (synthetic only; the real archive arrangement is blocked on M-S2). */
export const validateArchiveRegister = def('ArchiveRegister');
export const validateArchiveVerify = def('ArchiveVerify');
export const validateArchiveReferencesQuery = def('ArchiveReferencesQuery');
export const validateArchiveEntryQuery = def('ArchiveEntryQuery');
export const validateArchiveHold = def('ArchiveHold');
export const validateArchiveRetentionQuery = def('ArchiveRetentionQuery');

/** M9 operator ownership, backup verification and readiness (named operator and objectives: M-S3). */
export const validateOperatorProfileRecord = def('OperatorProfileRecord');
export const validateBackupVerificationRecord = def('BackupVerificationRecord');
export const validateOperationsEmptyQuery = def('OperationsEmptyQuery');

/** Closeout A2 downtime log (M8 runbook gap): windows, transcribed entries and their human review. */
export const validateDowntimeStart = def('DowntimeStart');
export const validateDowntimeEnd = def('DowntimeEnd');
export const validateDowntimeLog = def('DowntimeLog');
export const validateDowntimeEntryResolve = def('DowntimeEntryResolve');
export const validateDowntimeWindowListQuery = def('DowntimeWindowListQuery');
export const validateDowntimeEntryListQuery = def('DowntimeEntryListQuery');

/** Closeout A6 (H2 M-5): administrator-facing migration reviewer assignments. */
export type ReviewerRole = 'financialReviewer' | 'operationsReviewer';
export interface ReviewerAssign {
  readonly principalRef: string;
  readonly role: ReviewerRole;
}
export interface ReviewerUnassign {
  readonly assignmentRef: string;
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export interface ReviewerListQuery {
  readonly role?: ReviewerRole;
  readonly principalRef?: string;
  readonly state?: 'active' | 'revoked';
}
export const validateReviewerAssign = def('ReviewerAssign');
export const validateReviewerUnassign = def('ReviewerUnassign');
export const validateReviewerListQuery = def('ReviewerListQuery');

/**
 * M10 migration export: the migration workspace an audit needs (profiles, packages and staged records
 * outside B's opening chain, review items, runs, applied records with provenance, reviewer
 * assignments, reports, sign-offs, archive packages, entries and holds, operator profiles and backup
 * verifications), in foreign-key order. B10 carries the opening chain; together they are complete.
 * Not exported: practice exports and delivery grants (bytes and short-lived credentials).
 */
export const MIGRATION_EXPORT_FORMAT = 'cuspatlas-migration-export/1' as const;
export const MIGRATION_EXPORT_TABLES = [
  'migration_source_profiles',
  'migration_packages',
  'migration_staged_records',
  'migration_review_items',
  'migration_apply_runs',
  'migration_applied_records',
  'migration_reviewer_assignments',
  'migration_reports',
  'migration_signoffs',
  'migration_archive_packages',
  'migration_archive_entries',
  'migration_archive_holds',
  'ops_operator_profiles',
  'ops_backup_verifications',
  'ops_downtime_windows',
  'ops_downtime_entries',
] as const;
export interface MigrationExport {
  readonly format: typeof MIGRATION_EXPORT_FORMAT;
  readonly exportedAt: string;
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}
