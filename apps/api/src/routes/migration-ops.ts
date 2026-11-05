import type { ActorContext, CommandEnvelope } from '@cuspatlas/contracts';
import type { ActionName, MigrationService, PackageBytes, PackageBytesRequest } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { DEFAULT_DOWNLOAD_CHUNK_BYTES, sendPackageBytes, wantsPackageBytes } from '../package-download';
import type { RouteContract } from './manifest';
import type { OpInput } from './scheduling-ops';

/**
 * One table for the workstream M operations (M2-M6): the REST route contract, the MCP tool name and
 * the call into the shared migration service. REST registration, the MCP tools
 * (apps/mcp/src/tools/migration-ops.ts), the generated OpenAPI block and the drift checks derive from
 * it, so an operation cannot exist on one surface only. No migration route takes a path parameter:
 * every reference travels in the validated body or query, and the tenant always comes from the token.
 */
export interface MigrationOp extends RouteContract {
  readonly operationId: ActionName;
  readonly tool: string;
  readonly description: string;
  /** GET only: the migration.schema.json definition of the query object. */
  readonly query?: string;
  invoke(svc: MigrationService, actor: ActorContext, input: OpInput): Promise<unknown>;
  /** A8: the byte representation of a `ranges: 'bytes'` operation (same policy, grant and audit). */
  invokeBytes?(
    svc: MigrationService,
    actor: ActorContext,
    input: OpInput,
    request: PackageBytesRequest,
  ): Promise<{ data: PackageBytes }>;
}

const M = (name: string) => `migration:${name}`;
const COMMAND = ['400', '401', '403', '404', '409', '422', '503'] as const;
const READ = ['400', '401', '403', '404', '503'] as const;

const env = (operation: string, input: OpInput): CommandEnvelope<unknown> => ({
  operation,
  idempotencyKey: input.key,
  payload: input.body,
});
const data = async (p: Promise<unknown>) => ({ data: await p });

export const MIGRATION_OPS: MigrationOp[] = [
  {
    method: 'post',
    path: '/v1/migration/source-profiles',
    operationId: 'migration.sourceProfiles.register',
    protected: true,
    requestBody: M('SourceProfileRegister'),
    success: { status: '201', schema: M('SourceProfileResult') },
    refusals: COMMAND,
    tool: 'migration_source_profiles_register',
    description:
      'M2: register a new version of a source profile (synthetic source system, adapter format, practice). A correction is a new version; intake must name the latest version (409 stale_profile).',
    invoke: (svc, actor, i) => svc.registerSourceProfile(actor, env('migration.sourceProfiles.register', i)),
  },
  {
    method: 'post',
    path: '/v1/migration/packages',
    operationId: 'migration.packages.intake',
    protected: true,
    requestBody: M('PackageIntake'),
    success: { status: '201', schema: M('PackageIntakeResult') },
    refusals: COMMAND,
    tool: 'migration_packages_intake',
    description:
      'M2: stage an authorised synthetic source package. The manifest counts and digests must match the tables; every row is staged (unknown entities unmapped, unusable identifiers flagged per row) and ambiguous fields, terminology and money are queued for staff review. The same package twice returns the same staged package. Writes no patient, clinical or billing row.',
    invoke: (svc, actor, i) => svc.intakePackage(actor, env('migration.packages.intake', i)),
  },
  {
    method: 'get',
    path: '/v1/migration/packages/state',
    operationId: 'migration.packages.read',
    protected: true,
    query: 'PackageQuery',
    success: { status: '200', schema: M('PackageState') },
    refusals: READ,
    tool: 'migration_packages_read',
    description:
      'M2: staging state of one package: per-entity staged and flagged counts, open review items, cutover state.',
    invoke: (svc, actor, i) => data(svc.readPackage(actor, i.body)),
  },
  {
    method: 'get',
    path: '/v1/migration/review-items',
    operationId: 'migration.reviewItems.list',
    protected: true,
    query: 'ReviewItemListQuery',
    success: { status: '200', schema: M('ReviewItemList') },
    refusals: READ,
    tool: 'migration_review_items_list',
    description:
      'M2: the staff review queue of one package (unknown fields and entities, legacy terminology, ambiguous money, unusable identifiers, identity candidates, future appointments) with the adapter proposal and the decisions each item allows.',
    invoke: (svc, actor, i) => data(svc.listReviewItems(actor, i.body)),
  },
  {
    method: 'post',
    path: '/v1/migration/review-items/resolve',
    operationId: 'migration.reviewItems.resolve',
    protected: true,
    requestBody: M('ReviewItemResolve'),
    success: { status: '200', schema: M('ReviewItemResolveResult') },
    refusals: COMMAND,
    tool: 'migration_review_items_resolve',
    description:
      'M2/M4: record a staff decision on one review item (exclude, archive only, accept the proposal, or an identity decision). Resolved once; any decision invalidates an earlier reconciliation sign-off.',
    invoke: (svc, actor, i) => svc.resolveReviewItem(actor, env('migration.reviewItems.resolve', i)),
  },
  {
    method: 'get',
    path: '/v1/migration/imports/plan',
    operationId: 'migration.imports.plan',
    protected: true,
    query: 'PackageQuery',
    success: { status: '200', schema: M('ImportPlan') },
    refusals: READ,
    tool: 'migration_imports_plan',
    description:
      'M3: dry run. The full import plan of one package (per-entity staged, planned, applied, excluded and blocked counts, exceptions with the required action) and its digest. Writes nothing.',
    invoke: (svc, actor, i) => data(svc.planImport(actor, i.body)),
  },
  {
    method: 'post',
    path: '/v1/migration/imports/apply',
    operationId: 'migration.imports.apply',
    protected: true,
    requestBody: M('ImportApply'),
    success: { status: '200', schema: M('ImportApplyResult') },
    refusals: COMMAND,
    tool: 'migration_imports_apply',
    description:
      'M3: apply one bounded batch of exactly the planned operations (409 plan_digest_changed when the plan moved). Idempotent per source record and resumable after a crash; patients through S4 createPatient only, legacy appointments and procedures as archive references only. Call again until remaining is 0.',
    invoke: (svc, actor, i) => svc.applyImport(actor, env('migration.imports.apply', i)),
  },
  {
    method: 'post',
    path: '/v1/migration/identity/merges',
    operationId: 'migration.identity.merge',
    protected: true,
    requestBody: M('IdentityMerge'),
    success: { status: '201', schema: M('IdentityMergeResult') },
    refusals: COMMAND,
    tool: 'migration_identity_merge',
    description:
      'M4: merge two patients that a staff-decided identity group (mergeAfterImport) became, delegated verbatim to S6 mergePatients with the S6 confirmation token (S6 checks patients.merge and the human principal). No merge happens automatically and M defines no confirmation of its own.',
    invoke: (svc, actor, i) => svc.mergeIdentityGroup(actor, env('migration.identity.merge', i)),
  },
  {
    method: 'get',
    path: '/v1/migration/provenance',
    operationId: 'migration.provenance.read',
    protected: true,
    query: 'ProvenanceQuery',
    success: { status: '200', schema: M('ProvenanceList') },
    refusals: READ,
    tool: 'migration_provenance_read',
    description:
      'M4: source provenance of one patient and every identity merged into it: source system, source id, entity, applied action and time precision. Merges never overwrite provenance.',
    invoke: (svc, actor, i) => data(svc.readProvenance(actor, i.body)),
  },
  {
    method: 'get',
    path: '/v1/migration/opening-items',
    operationId: 'migration.openingItems.list',
    protected: true,
    query: 'PackageQuery',
    success: { status: '200', schema: M('OpeningReconciliation') },
    refusals: READ,
    tool: 'migration_opening_items_list',
    description:
      'M5: opening balances, unapplied credits (per source payment, with age basis) and open-claim references of one package, with per-guarantor source vs imported totals and the explicit difference (integer minor units). Opening figures need financial sign-off.',
    invoke: (svc, actor, i) => data(svc.listOpeningReconciliation(actor, i.body)),
  },
  {
    method: 'post',
    path: '/v1/migration/reports',
    operationId: 'migration.reports.build',
    protected: true,
    requestBody: M('ReportBuild'),
    success: { status: '200', schema: M('ReportSummaryResult') },
    refusals: COMMAND,
    tool: 'migration_reports_build',
    description:
      'M6: build the reconciliation report of one package (counts, per-guarantor balances, unapplied credit, exceptions, not-imported list) with its digest. An unchanged run returns the same version; a changed run adds a superseding version and never deletes the prior one.',
    invoke: (svc, actor, i) => svc.buildReconciliationReport(actor, env('migration.reports.build', i)),
  },
  {
    method: 'get',
    path: '/v1/migration/reports/latest',
    operationId: 'migration.reports.read',
    protected: true,
    query: 'PackageQuery',
    success: { status: '200', schema: M('ReconciliationReportRead') },
    refusals: READ,
    tool: 'migration_reports_read',
    description:
      'M6: the latest report version, whether it is stale against the current run, the cutover state and every sign-off with its validity.',
    invoke: (svc, actor, i) => data(svc.readReconciliationReport(actor, i.body)),
  },
  {
    method: 'post',
    path: '/v1/migration/signoffs',
    operationId: 'migration.signoffs.record',
    protected: true,
    requestBody: M('SignOffRecord'),
    success: { status: '201', schema: M('SignOffResult') },
    refusals: COMMAND,
    tool: 'migration_signoffs_record',
    description:
      'M6: a human reviewer with the sign-off scope approves or rejects one specific report version and digest in one role (financialReviewer or operationsReviewer). Refused for a stale version, with blocking exceptions (approval), or when the same person already signed it.',
    invoke: (svc, actor, i) => svc.recordSignOff(actor, env('migration.signoffs.record', i)),
  },
  {
    method: 'post',
    path: '/v1/migration/cutover/advance',
    operationId: 'migration.cutover.advance',
    protected: true,
    requestBody: M('CutoverAdvance'),
    success: { status: '200', schema: M('CutoverResult') },
    refusals: COMMAND,
    tool: 'migration_cutover_advance',
    description:
      'M6: mark the package ready for cutover. Requires the current report version approved in both roles by two distinct humans and no blocking exception; any later import change resets the state to reconciling and makes the sign-offs stale. Not a cutover itself.',
    invoke: (svc, actor, i) => svc.advanceCutover(actor, env('migration.cutover.advance', i)),
  },
  // M7 historical archive packages (read-only source history; M-S2 blocks the real arrangement).
  {
    method: 'post',
    path: '/v1/migration/archives',
    operationId: 'migration.archive.register',
    protected: true,
    requestBody: M('ArchiveRegister'),
    success: { status: '201', schema: M('ArchiveRegisterResult') },
    refusals: COMMAND,
    tool: 'migration_archive_register',
    description:
      'M7: register the archive references of one package (historical appointments and procedures, archived future appointments) as a new read-only archive package version with per-entry digests. Never writes a live clinical, scheduling or financial row; a prior version stays readable.',
    invoke: (svc, actor, i) => svc.registerArchive(actor, env('migration.archive.register', i)),
  },
  {
    method: 'post',
    path: '/v1/migration/archives/verify',
    operationId: 'migration.archive.verify',
    protected: true,
    requestBody: M('ArchiveVerify'),
    success: { status: '200', schema: M('ArchiveVerifyResult') },
    refusals: COMMAND,
    tool: 'migration_archive_verify',
    description:
      'M7: recompute every entry digest of one archive package and record its state: verified, partial (unreadable entries enumerated) or failed (not served).',
    invoke: (svc, actor, i) => svc.verifyArchive(actor, env('migration.archive.verify', i)),
  },
  {
    method: 'get',
    path: '/v1/migration/archives/references',
    operationId: 'migration.archive.references',
    protected: true,
    query: 'ArchiveReferencesQuery',
    success: { status: '200', schema: M('ArchiveReferenceList') },
    refusals: READ,
    tool: 'migration_archive_references',
    description:
      'M7: the read-only archive references of one patient across archive versions (an explicit empty list when there are none). Sensitive-read logged.',
    invoke: (svc, actor, i) => svc.listArchiveReferences(actor, i.body),
  },
  {
    method: 'get',
    path: '/v1/migration/archives/entries',
    operationId: 'migration.archive.read',
    protected: true,
    query: 'ArchiveEntryQuery',
    success: { status: '200', schema: M('ArchiveEntry') },
    refusals: READ,
    tool: 'migration_archive_read',
    description:
      'M7: one archive entry (the source row as received) for its linked patient only; 409 archive_entry_unreadable or archive_unavailable instead of serving damaged content. Sensitive-read logged.',
    invoke: (svc, actor, i) => svc.readArchiveEntry(actor, i.body),
  },
  {
    method: 'post',
    path: '/v1/migration/archives/holds',
    operationId: 'migration.archive.holds.record',
    protected: true,
    requestBody: M('ArchiveHold'),
    success: { status: '201', schema: M('ArchiveHoldResult') },
    refusals: COMMAND,
    tool: 'migration_archive_holds_record',
    description:
      'M7: place a legal hold on one archive package, or release an active hold once. A held package (or one whose patient is under an I8 hold) is never deleted.',
    invoke: (svc, actor, i) => svc.recordArchiveHold(actor, env('migration.archive.holds.record', i)),
  },
  {
    method: 'get',
    path: '/v1/migration/archives/retention',
    operationId: 'migration.archive.retention.evaluate',
    protected: true,
    query: 'ArchiveRetentionQuery',
    success: { status: '200', schema: M('ArchiveRetention') },
    refusals: READ,
    tool: 'migration_archive_retention_evaluate',
    description:
      'M7: whether one archive package may be disposed of under the recommended-pending-approval retention policy: never while held or inside the retention period (reasons listed).',
    invoke: (svc, actor, i) => svc.evaluateArchiveRetention(actor, i.body),
  },
  // M9 operator ownership, backup verification and readiness (no deployment; M-S3 open).
  {
    method: 'post',
    path: '/v1/operations/operator-profiles',
    operationId: 'operations.operatorProfiles.record',
    protected: true,
    requestBody: M('OperatorProfileRecord'),
    success: { status: '201', schema: M('OperatorProfileResult') },
    refusals: COMMAND,
    tool: 'operations_operator_profiles_record',
    description:
      'M9: record a new operator profile version (placeholder names and contacts only): hosting model, named responsibilities and escalation paths. Refused when a required responsibility is missing (422 responsibility_missing) or the security-incident path is not always covered (422 weak_escalation). Prior versions are retained.',
    invoke: (svc, actor, i) => svc.recordOperatorProfile(actor, env('operations.operatorProfiles.record', i)),
  },
  {
    method: 'post',
    path: '/v1/operations/backup-verifications',
    operationId: 'operations.backupVerifications.record',
    protected: true,
    requestBody: M('BackupVerificationRecord'),
    success: { status: '201', schema: M('BackupVerificationResult') },
    refusals: COMMAND,
    tool: 'operations_backup_verifications_record',
    description:
      'M9: record one backup verification (the worker job or a person): manifest digests and an isolated sample restore. The server derives the result: verified only with both; checksum_only without a restore; failed otherwise.',
    invoke: (svc, actor, i) =>
      svc.recordBackupVerification(actor, env('operations.backupVerifications.record', i)),
  },
  {
    method: 'get',
    path: '/v1/operations/readiness',
    operationId: 'operations.readiness.assert',
    protected: true,
    query: 'OperationsEmptyQuery',
    success: { status: '200', schema: M('ReadinessResult') },
    refusals: READ,
    tool: 'operations_readiness_assert',
    description:
      'M9: release readiness of the operator obligations: every unmet obligation listed (missing operator, weak escalation, absent, stale, failed or checksum-only backup verification, an SLA the drill has not demonstrated); ready only when the list is empty.',
    invoke: (svc, actor, i) => svc.assertReadiness(actor, i.body),
  },
  {
    method: 'get',
    path: '/v1/operations/alerts',
    operationId: 'operations.alerts.list',
    protected: true,
    query: 'OperationsEmptyQuery',
    success: { status: '200', schema: M('OperationsAlertList') },
    refusals: READ,
    tool: 'operations_alerts_list',
    description:
      'M9: operator alerts as work items (practice manager queue, owed by the platform operator): one per unmet readiness obligation, with the evidence reference and the suggested next action.',
    invoke: (svc, actor, i) => svc.listOperationsAlerts(actor, i.body),
  },
  {
    method: 'post',
    path: '/v1/operations/downtime/windows',
    operationId: 'operations.downtime.start',
    protected: true,
    requestBody: M('DowntimeStart'),
    success: { status: '201', schema: M('DowntimeWindowResult') },
    refusals: COMMAND,
    tool: 'operations_downtime_start',
    description:
      'Downtime log (M8 runbook): open a downtime window for the tenant or a set of locations, with a reason code and the time paper records began (startedAt, not in the future). Refused (409 downtime_already_open) while an open window covers an overlapping scope; a location-restricted member may open windows for its own locations only.',
    invoke: (svc, actor, i) => svc.startDowntime(actor, env('operations.downtime.start', i)),
  },
  {
    method: 'post',
    path: '/v1/operations/downtime/windows/end',
    operationId: 'operations.downtime.end',
    protected: true,
    requestBody: M('DowntimeEnd'),
    success: { status: '200', schema: M('DowntimeWindowResult') },
    refusals: COMMAND,
    tool: 'operations_downtime_end',
    description:
      'Downtime log (M8 runbook): end the open window at its expected version (409 stale_version otherwise; 409 window_not_open once ended). Entries may still be logged against it for 14 days, captured inside its bounds.',
    invoke: (svc, actor, i) => svc.endDowntime(actor, env('operations.downtime.end', i)),
  },
  {
    method: 'post',
    path: '/v1/operations/downtime/entries',
    operationId: 'operations.downtime.log',
    protected: true,
    requestBody: M('DowntimeLog'),
    success: { status: '201', schema: M('DowntimeEntryResult') },
    refusals: COMMAND,
    tool: 'operations_downtime_log',
    description:
      'Downtime log (M8 runbook): record one paper record transcribed after downtime (kind, structured synthetic payload, summary, paper reference, capture time inside the window) as pending_review. The log never applies or overwrites anything; a reviewer applies it through the owning command and resolves the entry.',
    invoke: (svc, actor, i) => svc.logDowntimeEntry(actor, env('operations.downtime.log', i)),
  },
  {
    method: 'post',
    path: '/v1/operations/downtime/entries/resolve',
    operationId: 'operations.downtime.entries.resolve',
    protected: true,
    requestBody: M('DowntimeEntryResolve'),
    success: { status: '200', schema: M('DowntimeEntryResult') },
    refusals: COMMAND,
    tool: 'operations_downtime_entries_resolve',
    description:
      'Downtime log (M8 runbook): a human reviewer resolves one pending entry once. applied links the committed owning command that applied it (operation, resource, correlation; it must exist in the tenant audit record after the entry was logged, fit the entry kind and apply no other entry); rejected names a reason code; superseded names the replacing entry. Never applies the payload itself.',
    invoke: (svc, actor, i) => svc.resolveDowntimeEntry(actor, env('operations.downtime.entries.resolve', i)),
  },
  {
    method: 'get',
    path: '/v1/operations/downtime/entries',
    operationId: 'operations.downtime.entries.list',
    protected: true,
    query: 'DowntimeEntryListQuery',
    success: { status: '200', schema: M('DowntimeEntryList') },
    refusals: READ,
    tool: 'operations_downtime_entries_list',
    description:
      'Downtime log (M8 runbook): the reconciliation worklist of transcribed entries, filtered by window, review state and kind, oldest capture first (signed cursor pages of up to 500), with each review and its linked command.',
    invoke: (svc, actor, i) => svc.listDowntimeEntries(actor, i.body),
  },
  {
    method: 'get',
    path: '/v1/operations/downtime/windows',
    operationId: 'operations.downtime.windows.list',
    protected: true,
    query: 'DowntimeWindowListQuery',
    success: { status: '200', schema: M('DowntimeWindowList') },
    refusals: READ,
    tool: 'operations_downtime_windows_list',
    description:
      'Downtime log (M8 runbook): downtime windows of the tenant, newest first (signed cursor pages of up to 500), with scope, state, bounds and the count of entries still pending review.',
    invoke: (svc, actor, i) => svc.listDowntimeWindows(actor, i.body),
  },
  // Closeout A6 (H2 M-5): the administrator-facing reviewer list that the sign-off role check reads.
  {
    method: 'post',
    path: '/v1/migration/reviewers',
    operationId: 'migration.reviewers.assign',
    protected: true,
    requestBody: M('ReviewerAssign'),
    success: { status: '201', schema: M('ReviewerAssignmentResult') },
    refusals: COMMAND,
    tool: 'migration_reviewers_assign',
    description:
      'H2 M-5: assign a live human member of the tenant to a migration sign-off role (financialReviewer or operationsReviewer). Tenant-wide human administrators only (admin.configure); never the administrator themself (409 self_assignment_refused); a service principal or a revoked, unknown or other-tenant member is refused (422 reviewer_not_eligible); one live assignment per member and role (409 already_assigned).',
    invoke: (svc, actor, i) => svc.assignReviewer(actor, env('migration.reviewers.assign', i)),
  },
  {
    method: 'post',
    path: '/v1/migration/reviewers/unassign',
    operationId: 'migration.reviewers.unassign',
    protected: true,
    requestBody: M('ReviewerUnassign'),
    success: { status: '200', schema: M('ReviewerAssignmentResult') },
    refusals: COMMAND,
    tool: 'migration_reviewers_unassign',
    description:
      'H2 M-5: end a live reviewer assignment at its expected version with a reason code (409 stale_version; 409 assignment_not_active once ended). The assignment is kept as revoked (when, by whom, why), never deleted; the member can no longer sign off in that role. Tenant-wide human administrators only (admin.configure).',
    invoke: (svc, actor, i) => svc.unassignReviewer(actor, env('migration.reviewers.unassign', i)),
  },
  {
    method: 'get',
    path: '/v1/migration/reviewers',
    operationId: 'migration.reviewers.list',
    protected: true,
    query: 'ReviewerListQuery',
    success: { status: '200', schema: M('ReviewerAssignmentList') },
    refusals: READ,
    tool: 'migration_reviewers_list',
    description:
      'H2 M-5: the tenant migration reviewer list, live and ended assignments, oldest first (signed cursor pages of up to 500), filtered by role, member and state, with who assigned and who ended each one.',
    invoke: (svc, actor, i) => svc.listReviewers(actor, i.body),
  },
  // M10 migration export: the migration workspace for audit (B10 carries the opening chain).
  {
    method: 'get',
    path: '/v1/migration/export',
    operationId: 'migration.export',
    protected: true,
    query: 'OperationsEmptyQuery',
    success: { status: '200', schema: M('MigrationExportRead') },
    refusals: READ,
    tool: 'migration_export',
    description:
      'M10: versioned migration workspace export of the caller tenant (cuspatlas-migration-export/1): profiles, packages and staged records outside the B10 opening chain, review items, runs, applied records with provenance, reviewer assignments, reports, sign-offs, archive packages, entries and holds, operator profiles, backup verifications and downtime windows and entries, tenant column removed. Tenant-wide human administrators only; sensitive-read logged.',
    invoke: (svc, actor, i) => data(svc.exportMigration(actor, i.body)),
  },
  // M1 practice export (easy exit): one versioned package of the whole tenant, private delivery.
  {
    method: 'post',
    path: '/v1/practice/exports',
    operationId: 'practice.export.create',
    protected: true,
    requestBody: M('PracticeExportCreate'),
    success: { status: '201', schema: M('PracticeExportResult') },
    refusals: COMMAND,
    tool: 'practice_export_create',
    description:
      'M1: compose the S, I, C, E and B exports of the caller tenant into one versioned package (cuspatlas-practice-export/1): a manifest with per-document digests, per-table counts, blob digests and terminology refs, no tenant identifier. Refused (409 export_incomplete) when any count differs from the live tenant; stored privately. Tenant-wide human administrators only.',
    invoke: (svc, actor, i) => svc.createPracticeExport(actor, env('practice.export.create', i)),
  },
  {
    method: 'post',
    path: '/v1/practice/exports/grants',
    operationId: 'practice.export.grant',
    protected: true,
    requestBody: M('PracticeExportGrant'),
    success: { status: '201', schema: M('PracticeExportGrantResult') },
    refusals: COMMAND,
    tool: 'practice_export_grant',
    description:
      'M1: mint a short-lived (at most 300 s) delivery grant for one practice export, bound to the caller. Each call mints a new grant; the token is never stored.',
    invoke: (svc, actor, i) => svc.grantPracticeExport(actor, env('practice.export.grant', i)),
  },
  {
    method: 'post',
    path: '/v1/practice/exports/package',
    operationId: 'practice.export.download',
    protected: true,
    requestBody: M('PracticeExportDownload'),
    success: { status: '200', schema: M('PracticeExportPackage') },
    refusals: COMMAND,
    tool: 'practice_export_download',
    description:
      'M1: the stored practice export package (manifest and documents), verified against its digest, to the holder of a live delivery grant. Imaging bytes travel as I9 blob bundles named by the manifest. Sensitive-read logged.',
    invoke: (svc, actor, i) => svc.downloadPracticeExport(actor, env('practice.export.download', i)),
    ranges: 'bytes',
    invokeBytes: (svc, actor, i, r) =>
      svc.downloadPracticeExportBytes(actor, env('practice.export.download', i), r),
  },
  {
    method: 'get',
    path: '/v1/practice/exports/verification',
    operationId: 'practice.export.verify',
    protected: true,
    query: 'PracticeExportQuery',
    success: { status: '200', schema: M('PracticeExportVerification') },
    refusals: READ,
    tool: 'practice_export_verify',
    description:
      'M1: re-verify one practice export: stored bytes and completeness (failed otherwise), then the live tenant against the manifest, naming every table whose count or document whose digest differs (drifted).',
    invoke: (svc, actor, i) => svc.verifyPracticeExport(actor, i.body),
  },
];

export const MIGRATION_OP_ROUTES = (): RouteContract[] =>
  MIGRATION_OPS.map(
    ({ method, path, operationId, protected: p, requestBody, success, refusals, ranges }) => ({
      method,
      path,
      operationId,
      protected: p,
      ...(requestBody ? { requestBody } : {}),
      success,
      refusals,
      ...(ranges ? { ranges } : {}),
    }),
  );

/** Registers every MIGRATION_OPS route; authentication in `onRequest`, no tenant read from input. */
export function registerMigrationOpRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; migration: MigrationService; downloadChunkBytes?: number },
): void {
  for (const op of MIGRATION_OPS) {
    const input = (request: FastifyRequest): OpInput => {
      const key = request.headers['idempotency-key'];
      return {
        params: {},
        body: op.method === 'get' ? { ...(request.query as object) } : request.body,
        key: typeof key === 'string' ? key : '',
      };
    };
    const opts = { onRequest: authenticateOnRequest(deps.authenticator, op.operationId) };
    if (op.method === 'get') {
      app.get(op.path, opts, async (request) =>
        op.invoke(deps.migration, requireActor(request), input(request)),
      );
    } else {
      app.post(op.path, opts, async (request, reply) => {
        const bytes = op.invokeBytes;
        if (op.ranges === 'bytes' && bytes && wantsPackageBytes(request)) {
          const actor = requireActor(request);
          return sendPackageBytes(
            request,
            reply,
            (ranged) => bytes(deps.migration, actor, input(request), { ranged }),
            deps.downloadChunkBytes ?? DEFAULT_DOWNLOAD_CHUNK_BYTES,
          );
        }
        if (op.ranges === 'bytes') reply.header('accept-ranges', 'bytes');
        return reply
          .code(op.success.status === '201' ? 201 : 200)
          .send(await op.invoke(deps.migration, requireActor(request), input(request)));
      });
    }
  }
}
