import type { ActorContext, CommandEnvelope } from '@cuspatlas/contracts';
import type { ActionName, MigrationService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
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
  MIGRATION_OPS.map(({ method, path, operationId, protected: p, requestBody, success, refusals }) => ({
    method,
    path,
    operationId,
    protected: p,
    ...(requestBody ? { requestBody } : {}),
    success,
    refusals,
  }));

/** Registers every MIGRATION_OPS route; authentication in `onRequest`, no tenant read from input. */
export function registerMigrationOpRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; migration: MigrationService },
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
      app.post(op.path, opts, async (request, reply) =>
        reply
          .code(op.success.status === '201' ? 201 : 200)
          .send(await op.invoke(deps.migration, requireActor(request), input(request))),
      );
    }
  }
}
