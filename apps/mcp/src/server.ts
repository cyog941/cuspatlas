import { createHash, randomUUID } from 'node:crypto';
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type IdentityVerifierConfig,
  mapErrorToRefusal,
  RUNTIME_ENVIRONMENTS,
  type RuntimeEnvironment,
  safeErrorKind,
} from '@cuspatlas/api';
import {
  type ActorContext,
  attachListEnvelope,
  attachVocabularyVersions,
  DEPRECATIONS,
  type DeprecationEntry,
  type DomainRefusal,
  deprecationIndex,
  deprecationNotice,
  LIST_OPERATIONS,
  type MalwareScannerPort,
  type MembershipSource,
  type ObjectStorePort,
  REFUSAL_HTTP_STATUS,
  RefusalError,
  type SecurityAttemptSink,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import type { AgentToolInvoker } from '@cuspatlas/domain';
import {
  type AttachmentRefResolver,
  type AttemptRecordingDeps,
  BILLING_POST_MERGE_PROBE,
  type BudgetTicket,
  type BudgetWarning,
  CLINICAL_POST_MERGE_FACT_PROBES,
  type ClaimsPartnerPort,
  type CommandExecutor,
  type CursorCodec,
  createAgentService,
  createAiSourceReaders,
  createAppointmentService,
  createAuthorize,
  createAutomationService,
  createBillingEstimatePricing,
  createBillingService,
  createClinicalService,
  createClinicalVisitContextProducers,
  createCursorCodec,
  createDurableExecutor,
  createEngagementService,
  createFakeClearinghouse,
  createImagingAttachmentRefResolver,
  createImagingAttachmentSource,
  createImagingImageRefResolver,
  createImagingService,
  createMigrationService,
  createPatientService,
  createProposalService,
  createReadSurfaceService,
  createSchedulingCursorCodec,
  createSchedulingResourceService,
  createSyntheticPaymentProvider,
  createSyntheticTaskService,
  type ImageRefResolver,
  type ImagingLimits,
  type ModelAdapter,
  newListScope,
  type PaymentProviderPort,
  readLatestCompletedProcedures,
  resolveCursorKeyRing,
  resolveIdempotencyDigestKey,
  resolveImagingTokenSecret,
  resolveMatchKeyPepper,
  resolveModelAdapter,
  resolveWebhookPort,
  resolveWebhookSecretKey,
  runInListScope,
  runWithBudgetMeter,
  type StagingMaintenance,
  type WebhookDeliveryPort,
} from '@cuspatlas/domain';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { assertDistinctAudience, assertIdentityAllowed, createMcpAuthenticator } from './auth';
import { toolCatalogDrift } from './catalog';
import { AGENT_TOOLS } from './tools/agent-ops';
import { APPOINTMENT_TOOLS } from './tools/appointments';
import { AUTOMATION_TOOLS } from './tools/automation-ops';
import { BILLING_TOOLS } from './tools/billing';
import { BILLING_OP_TOOLS } from './tools/billing-ops';
import { CLINICAL_TOOLS } from './tools/clinical';
import { CLINICAL_RECORD_TOOLS } from './tools/clinical-record';
import { ENGAGEMENT_OP_TOOLS } from './tools/engagement-ops';
import { IMAGING_TOOLS } from './tools/imaging-ops';
import { MIGRATION_TOOLS } from './tools/migration-ops';
import { PATIENT_TOOLS } from './tools/patients';
import { PROPOSAL_TOOLS } from './tools/proposals';
import { READ_OP_TOOLS } from './tools/read-ops';
import { SCHEDULING_TOOLS } from './tools/scheduling';
import { SCHEDULING_OP_TOOLS } from './tools/scheduling-ops';
import {
  compileInput,
  refuseInvalid,
  SYNTHETIC_TASK_TOOLS,
  type ToolDefinition,
  type ToolDeps,
  violationsOf,
} from './tools/synthetic-tasks';
import { VOCABULARY_TOOLS } from './tools/vocabularies';
import { advertisedTool, isTruncatable } from './truncation';

export const MCP_PATH = '/mcp';
export const METADATA_PATH = '/.well-known/oauth-protected-resource';
const BODY_LIMIT = 16 * 1024;
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const UNSPECIFIED_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '']);

/** Hostname of a Host header (port stripped, IPv6 kept in brackets), or null when unusable. */
function hostAllowed(host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) return false;
  try {
    const url = new URL(`http://${host}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    return allowed.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export interface McpServerDeps {
  readonly env: RuntimeEnvironment;
  /** Match-key pepper (CUSPATLAS_MATCH_KEY_PEPPER); optional only under synthetic-test. */
  readonly matchKeyPepper?: Uint8Array;
  /**
   * Idempotency payload digest key (CUSPATLAS_IDEMPOTENCY_DIGEST_KEY); optional only under
   * synthetic-test, where the test-only key is used. The test-only key is refused elsewhere.
   */
  readonly idempotencyDigestKey?: Uint8Array;
  /** E5: the I3 attachment check (absent: I3's consumer reference read, createImagingAttachmentRefResolver). */
  readonly attachmentRefs?: AttachmentRefResolver;
  /** Verifier whose audience is the MCP resource identifier (distinct from the REST audience). */
  readonly identity: IdentityVerifierConfig;
  /** The REST audience; the server refuses to start if it equals the MCP audience. */
  readonly restAudience?: string;
  /** The portal audience; the server refuses to start if it equals the MCP audience. */
  readonly portalAudience?: string;
  readonly membership: MembershipSource;
  readonly attempts: SecurityAttemptSink;
  readonly tenantTransactions: WithTenantTransaction;
  readonly execute?: CommandExecutor;
  /** A11: model adapter; synthetic-test only (default: the synthetic adapter; null: AI disabled). */
  readonly aiModel?: ModelAdapter | null;
  /** A14: webhook delivery port (honoured in synthetic-test only; absent: adapter_not_configured). */
  readonly webhookPort?: WebhookDeliveryPort | null;
  /** A14: operator allowlist of webhook endpoint hosts (A-D7); default empty. */
  readonly webhookAllowlist?: () => readonly string[];
  /** A14: name resolution for the endpoint guard; absent: literal checks only. */
  readonly webhookResolveHost?: (host: string) => Promise<readonly string[]>;
  /** A14: AES-GCM sealing key of subscription secrets (synthetic-test has a test-only default). */
  readonly webhookSecretKey?: Uint8Array;
  readonly cursors?: CursorCodec;
  /** CUSPATLAS_CURSOR_KEY (>= 32 bytes); optional only under synthetic-test (test-only key). */
  readonly cursorKey?: Uint8Array;
  /** CUSPATLAS_CURSOR_KEY_PREVIOUS: decode-only grace key during a rotation. */
  readonly cursorPreviousKey?: Uint8Array;
  /** Proposal policy version (defaults to PROPOSAL_POLICY_VERSION); tests bump it. */
  readonly proposalPolicyVersion?: string;
  /**
   * B2 payment processor and B6/B7 clearinghouse adapters. Absent: the synthetic fakes only under
   * synthetic-test; elsewhere the dependent operations are a typed 503 adapter_not_configured.
   */
  readonly billingPayments?: PaymentProviderPort;
  readonly billingClaims?: ClaimsPartnerPort;
  /** C15: the I3 imageRef seam (absent: I3's consumer reference read, createImagingImageRefResolver). */
  readonly imageRefResolver?: ImageRefResolver;
  readonly logger?: { readonly stream?: { write(line: string): void } };
  /** A5 deprecation entries (default: the published packages/contracts/src/catalog/deprecations.json). */
  readonly deprecations?: readonly DeprecationEntry[];
  /** Browser origins allowed to call the endpoint. Default none: native MCP clients send no Origin. */
  readonly allowedOrigins?: readonly string[];
  /**
   * Absolute URL of the protected-resource metadata, advertised in the 401 challenge. Required
   * outside synthetic-test; in synthetic-test it defaults to the listen address, which must then be
   * a concrete host (never 0.0.0.0 or ::).
   */
  readonly resourceMetadataUrl?: string;
  /**
   * Host header values (hostnames, any port) the endpoint answers. Always includes the loopback
   * names and the host of `resourceMetadataUrl`; anything else is refused with 421 (DNS rebinding).
   */
  readonly allowedHosts?: readonly string[];
  /** I imaging: object store (metadata tools work without it; byte-touching commands are 503). */
  readonly objectStore?: ObjectStorePort;
  readonly stagingMaintenance?: StagingMaintenance;
  readonly scanner?: MalwareScannerPort;
  /** I1 read-grant secret; optional only under synthetic-test. */
  readonly imagingTokenSecret?: Uint8Array;
  readonly imagingLimits?: ImagingLimits;
}

export interface McpServerHandle {
  listen(opts: { host: string; port: number }): Promise<{ url: string }>;
  close(): Promise<void>;
  /**
   * A23: the tool path for scheduled agent task runs (the worker): the same consent, budget,
   * argument and authorization checks as an interactive call on this deployment.
   */
  readonly agentTools: AgentToolInvoker;
}

interface Registered {
  readonly tool: ToolDefinition;
  readonly validate: ReturnType<typeof compileInput>;
}

export const TOOLS: readonly ToolDefinition[] = [
  ...SYNTHETIC_TASK_TOOLS,
  ...VOCABULARY_TOOLS,
  ...PROPOSAL_TOOLS,
  ...PATIENT_TOOLS,
  ...SCHEDULING_TOOLS,
  ...APPOINTMENT_TOOLS,
  ...BILLING_TOOLS,
  ...BILLING_OP_TOOLS,
  ...CLINICAL_TOOLS,
  ...CLINICAL_RECORD_TOOLS,
  ...SCHEDULING_OP_TOOLS,
  ...ENGAGEMENT_OP_TOOLS,
  ...IMAGING_TOOLS,
  ...MIGRATION_TOOLS,
  ...AGENT_TOOLS,
  ...READ_OP_TOOLS,
  ...AUTOMATION_TOOLS,
];

/** Path parameters of the REST twin. A malformed one is a 404 there, decided by the domain. */
const REF_PARAMS = [
  'taskRef',
  'proposalRef',
  'patientRef',
  'relationshipRef',
  'mergeRef',
  'resourceRef',
  'locationRef',
  'requestRef',
  'appointmentRef',
  'holdRef',
  'chargeRef',
  'entryRef',
  'paymentRef',
  'attemptRef',
  'encounterRef',
  // S12-S16 path parameters.
  'itemRef',
  'historyVersionRef',
  // C6/C7/C11 clinical record path references.
  'chartEntryRef',
  'perioExamRef',
  'planRef',
  'planVersionRef',
  'planDetailRef',
  'planItemRef',
  'estimateRef',
  'consentRef',
  'procedureRef',
  'imageLinkRef',
  'labCaseRef',
  'referralRef',
  'templateRef',
  'templateVersionRef',
  'noteRef',
  // S12-S16 path parameters.
  'seriesRef',
  'intentRef',
  'offerRef',
  'recoveryRef',
  'policyRef',
  'recallTaskRef',
  // Workstream E path parameters.
  'principalRef',
  'templateRef',
  'decisionRef',
  'messageRef',
  // I imaging path parameters.
  'objectRef',
  'grantRef',
  'ingressRef',
  'imageRef',
  'mountRef',
  'annotationRef',
  'legalHoldRef',
  'deletionRef',
  // I6/I7 bridge path parameters.
  'deviceRef',
  'jobRef',
  'deferralRef',
  // B6/B7/B9 path parameters (UUID references).
  'procedureRef',
  'claimRef',
  'appealRef',
  'submissionRef',
] as const;
const PLACEHOLDER_REF = '00000000-0000-4000-8000-000000000000';

/**
 * True when the arguments would be valid but for a string path reference that is malformed. Such
 * calls go to the domain, which refuses them with the same 404 as REST before any domain statement
 * (it validates the reference right after authorization).
 */
function onlyRefMalformed(registered: Registered, args: Record<string, unknown>): boolean {
  const present = REF_PARAMS.filter((p) => typeof args[p] === 'string');
  if (present.length === 0) return false;
  const patched = { ...args, ...Object.fromEntries(present.map((p) => [p, PLACEHOLDER_REF])) };
  return registered.validate(patched) === true;
}

const REGISTRY: ReadonlyMap<string, Registered> = new Map(
  TOOLS.map((tool) => [tool.name, { tool, validate: compileInput(tool.inputSchema) }]),
);

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('too large'), { tooLarge: true });
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Remote MCP endpoint for the synthetic-task domain over Streamable HTTP (stateless: every POST is
 * authenticated, served by a fresh protocol server and closed). Exposes exactly the tools in
 * TOOLS (synthetic-task, proposal, patient and scheduling tools); there is no SQL, shell, HTTP or file tool and no resources or prompts.
 */
export function buildMcpServer(deps: McpServerDeps): McpServerHandle {
  if (!RUNTIME_ENVIRONMENTS.includes(deps.env)) throw new Error('Unsupported runtime environment');
  assertIdentityAllowed(deps.env, deps.identity);
  const drift = toolCatalogDrift(TOOLS);
  if (drift.length > 0) {
    throw new Error(`Refusing to start: MCP tools disagree with the operation catalog: ${drift.join('; ')}`);
  }
  assertDistinctAudience({
    identity: deps.identity,
    ...(deps.restAudience === undefined ? {} : { restAudience: deps.restAudience }),
    ...(deps.portalAudience === undefined ? {} : { portalAudience: deps.portalAudience }),
  });

  const write = (line: Record<string, unknown>) =>
    (deps.logger?.stream ?? process.stderr).write(`${JSON.stringify(line)}\n`);
  const recording: AttemptRecordingDeps = {
    sink: deps.attempts,
    alert: (code) => write({ level: 'error', msg: 'security alert', alert: code }),
  };
  const authenticator = createMcpAuthenticator(
    {
      identity: deps.identity,
      ...(deps.restAudience === undefined ? {} : { restAudience: deps.restAudience }),
    },
    deps.membership,
    recording,
  );
  const authorize = createAuthorize(deps.membership);
  // Durable idempotency with the keyed payload digest of this environment (the key is required
  // outside synthetic-test even when a test injects its own executor).
  const durable = createDurableExecutor(resolveIdempotencyDigestKey(deps.env, deps.idempotencyDigestKey));
  const execute = deps.execute ?? durable;
  // Closeout A1: one configured key ring for every list cursor (shared across instances).
  const cursorRing = resolveCursorKeyRing(deps.env, deps.cursorKey, deps.cursorPreviousKey);
  const cursors = deps.cursors ?? createCursorCodec(cursorRing);
  const schedulingCursors = createSchedulingCursorCodec(cursorRing);
  const service = createSyntheticTaskService({
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute,
    cursors,
  });
  const proposals = createProposalService({
    authorize,
    memberships: deps.membership,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute,
    ...(deps.proposalPolicyVersion ? { policyVersion: deps.proposalPolicyVersion } : {}),
  });
  const patients = createPatientService({
    matchKeyPepper: resolveMatchKeyPepper(deps.env, deps.matchKeyPepper),
    // C5: clinical facts after a merge make an unmerge need the reconciliation review (S-D2).
    postMergeFactProbes: [...CLINICAL_POST_MERGE_FACT_PROBES, BILLING_POST_MERGE_PROBE],
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute,
    cursors,
  });
  const scheduling = createSchedulingResourceService({
    cursors: schedulingCursors,
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute,
  });
  const appointments = createAppointmentService({
    cursors: schedulingCursors,
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    memberships: deps.membership,
    recording,
    execute,
    // S12 visit context: the C producers through S12's domain port (C8, C10, C11, C13; C16 when built).
    visitContextProducers: createClinicalVisitContextProducers({ authorize }),
    // S16 completed-procedure recall basis: the C14 read (S keeps recall policy and due computation).
    completedProcedures: readLatestCompletedProcedures,
  });
  // External billing adapters: never a fake outside synthetic-test (operator line when absent).
  const synthetic = deps.env === 'synthetic-test';
  const payments = deps.billingPayments ?? (synthetic ? createSyntheticPaymentProvider() : null);
  const claims = deps.billingClaims ?? (synthetic ? createFakeClearinghouse() : null);
  for (const [adapter, port] of [
    ['payment_processor', payments],
    ['clearinghouse', claims],
  ] as const) {
    if (port === null)
      write({
        level: 'warn',
        msg: 'billing adapter not configured',
        alert: 'adapter_not_configured',
        adapter,
      });
  }
  const billing = createBillingService({
    cursors: schedulingCursors,
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute,
    // B CL-04 -> I3 (integration): attachment digests from I3's consumer reference read.
    ...(payments ? { payments } : {}),
    ...(claims ? { claims } : {}),
    attachments: createImagingAttachmentSource(),
  });
  const clinical = createClinicalService({
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute,
    cursors,
    // C15 -> I3 (integration): the consumer reference read, unless a test injects a double.
    imageRefResolver: deps.imageRefResolver ?? createImagingImageRefResolver(),
    // C12 -> B9/B5 (integration): server practice fees and coverage status for estimates.
    estimatePricing: createBillingEstimatePricing(),
  });
  const engagement = createEngagementService({
    patients,
    completedProcedures: readLatestCompletedProcedures,
    appointments,
    matchKeyPepper: resolveMatchKeyPepper(deps.env, deps.matchKeyPepper),
    // E5 -> I3 (integration): attachments are checked against the message patient.
    attachmentRefs: deps.attachmentRefs ?? createImagingAttachmentRefResolver(),
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute,
  });
  const imaging = createImagingService({
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute,
    tokenSecret: resolveImagingTokenSecret(deps.env, deps.imagingTokenSecret),
    matchKeyPepper: resolveMatchKeyPepper(deps.env, deps.matchKeyPepper),
    ...(deps.objectStore ? { objectStore: deps.objectStore } : {}),
    ...(deps.stagingMaintenance ? { stagingMaintenance: deps.stagingMaintenance } : {}),
    ...(deps.scanner ? { scanner: deps.scanner } : {}),
    ...(deps.imagingLimits ? { limits: deps.imagingLimits } : {}),
    alert: (code) => write({ level: 'error', msg: 'imaging alert', alert: code }),
  });
  const migration = createMigrationService({
    // Closeout C: the shared cursor key ring for the downtime and reviewer list pages.
    cursors: schedulingCursors,
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute,
    patients,
    matchKeyPepper: resolveMatchKeyPepper(deps.env, deps.matchKeyPepper),
    // M1: the practice export composes the five domain exports as the same caller.
    practiceExport: {
      exporters: {
        scheduling: (ctx, a) => appointments.exportScheduling(ctx, a),
        imaging: (ctx, a) => imaging.exportImaging(ctx, a),
        clinical: (ctx, a) => clinical.exportClinical(ctx, a),
        engagement: (ctx, a) => engagement.exportEngagement(ctx, {}, a),
        billing: (ctx, a) => billing.exportBilling(ctx, a),
      },
      ...(deps.objectStore ? { objectStore: deps.objectStore } : {}),
      tokenSecret: resolveImagingTokenSecret(deps.env, deps.imagingTokenSecret),
    },
  });
  const agents = createAgentService({
    cursors,
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute,
    memberships: deps.membership,
    matchKeyPepper: resolveMatchKeyPepper(deps.env, deps.matchKeyPepper),
    owners: { patients, engagement, billing },
    ai: {
      model: resolveModelAdapter(deps.env, deps.aiModel),
      readers: createAiSourceReaders({ clinical, engagement, billing, patients }),
      owners: {
        createNoteDraft: (c, r, e) => clinical.createNoteDraft(c, r, e),
        postStaffMessage: (c, r, e) => engagement.postStaffMessage(c, r, e),
      },
    },
  });
  const automation = createAutomationService({
    cursors,
    env: deps.env,
    authorize,
    withTenantTransaction: deps.tenantTransactions,
    recording,
    execute,
    webhooks: {
      port: resolveWebhookPort(deps.env, deps.webhookPort, deps.webhookResolveHost),
      ...(deps.webhookAllowlist ? { allowlist: deps.webhookAllowlist } : {}),
      ...(deps.webhookResolveHost ? { resolveHost: deps.webhookResolveHost } : {}),
      secretKey: resolveWebhookSecretKey(deps.env, deps.webhookSecretKey),
    },
    // A15: the same five module exports M1 composes, called as the caller, and M1 for the practice scope.
    exports: {
      exporters: {
        scheduling: (ctx, a) => appointments.exportScheduling(ctx, a),
        imaging: (ctx, a) => imaging.exportImaging(ctx, a),
        clinical: (ctx, a) => clinical.exportClinical(ctx, a),
        engagement: (ctx, a) => engagement.exportEngagement(ctx, {}, a),
        billing: (ctx, a) => billing.exportBilling(ctx, a),
      },
      practice: {
        build: (c, e) => migration.buildPracticeExport(c, e),
        grant: (c, e) => migration.grantPracticeExport(c, e),
        download: (c, e) => migration.downloadPracticeExport(c, e),
      },
      ...(deps.objectStore ? { objectStore: deps.objectStore } : {}),
      tokenSecret: resolveImagingTokenSecret(deps.env, deps.imagingTokenSecret),
    },
  });
  const toolDeps: ToolDeps = {
    agents,
    automation,
    service,
    proposals,
    patients,
    scheduling,
    appointments,
    billing,
    clinical,
    engagement,
    imaging,
    migration,
    reads: createReadSurfaceService({
      authorize,
      withTenantTransaction: deps.tenantTransactions,
      recording,
      memberships: deps.membership,
      execute,
      financialMeasures: (ctx) => billing.claimMeasures(ctx, {}),
    }),
    authorize,
    recording,
  };
  const allowedOrigins = new Set(deps.allowedOrigins ?? []);
  if (deps.env !== 'synthetic-test' && !deps.resourceMetadataUrl) {
    throw new Error('Refusing to start: resourceMetadataUrl must be configured outside synthetic-test');
  }
  /** Advertised in the 401 challenge; defaults to the address the server actually listens on. */
  let metadataUrl = deps.resourceMetadataUrl;
  const allowedHosts = new Set([...LOOPBACK_HOSTS, ...(deps.allowedHosts ?? [])].map((h) => h.toLowerCase()));
  if (metadataUrl) allowedHosts.add(new URL(metadataUrl).hostname.toLowerCase());

  // A5: a deprecated tool still answers and audits; its description and every result carry a notice.
  const deprecationIdx = deprecationIndex(deps.deprecations ?? DEPRECATIONS);
  const notices = new Map(
    TOOLS.flatMap((t) => {
      const e = deprecationIdx.get(t.operationId);
      return e ? [[t.name, deprecationNotice(e)] as const] : [];
    }),
  );
  const withBudgetWarning = (meta: { _meta?: Record<string, unknown> }, w: BudgetWarning | null) =>
    w ? { _meta: { ...(meta._meta ?? {}), budgetWarning: w } } : meta;
  const withTruncation = (meta: { _meta?: Record<string, unknown> }, t: Record<string, unknown> | null) =>
    t ? { _meta: { ...(meta._meta ?? {}), truncated: t } } : meta;
  const metaFor = (name: string) => {
    const n = notices.get(name);
    return n ? { _meta: { deprecation: n } } : {};
  };

  function refusalResult(refusal: DomainRefusal) {
    return {
      isError: true as const,
      content: [{ type: 'text' as const, text: JSON.stringify(refusal) }],
      structuredContent: { ...refusal },
    };
  }

  /**
   * Closeout B (A9 truncation): an agent query over a per-call budget answers a truncated page and a
   * resume cursor bound to the operation and its arguments. The cursor is a transport position (how
   * many leading records the agent already received), not a domain cursor; a resumed call reruns the
   * same query and skips them, so a list that changed in between may shift (stated in the A9 notes).
   */
  const argsDigest = (op: string, args: Record<string, unknown>) =>
    createHash('sha256')
      .update(
        JSON.stringify([
          op,
          Object.keys(args)
            .filter((k) => k !== 'idempotencyKey')
            .sort()
            .map((k) => [k, args[k]]),
        ]),
      )
      .digest('base64url');
  const encodeResume = (op: string, args: Record<string, unknown>, skip: number) =>
    Buffer.from(JSON.stringify({ v: 1, d: argsDigest(op, args), s: skip })).toString('base64url');
  const decodeResume = (op: string, args: Record<string, unknown>, cursor: unknown): number => {
    const bad = () =>
      new RefusalError({ code: 'invalid_request', detail: { reason: 'resume_cursor_invalid' } });
    if (typeof cursor !== 'string' || cursor.length > 200) throw bad();
    let c: { v?: unknown; d?: unknown; s?: unknown };
    try {
      c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw bad();
    }
    if (c?.v !== 1 || c.d !== argsDigest(op, args) || !Number.isSafeInteger(c.s) || (c.s as number) < 1)
      throw bad();
    return c.s as number;
  };

  /** One tool call: schema first (for routing), then the shared domain handler with a server-built actor. */
  async function callTool(actor: ActorContext, name: string, rawArgs: unknown) {
    const registered = REGISTRY.get(name);
    // Unknown tools are a protocol error and never echo the caller-supplied name.
    if (!registered) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
    const given =
      rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    // A resume cursor is a transport argument of agent queries only (never seen by a handler).
    const { resumeCursor, ...rest } = given;
    const resumable =
      actor.agent !== undefined && isTruncatable(registered.tool) && resumeCursor !== undefined;
    const args = resumable ? rest : given;
    const valid = registered.validate(args);
    const violations = valid ? [] : violationsOf(registered.validate.errors);
    let code = 'ok';
    // A9: an agent needs a live consent for this deployment and operation, and one call is reserved
    // against its budget before any handler (or argument check) runs.
    let ticket: BudgetTicket | null = null;
    let settled = false;
    try {
      if (actor.agent)
        ticket = await agents.admitToolCall(actor, deps.identity.audience, registered.tool.operationId);
      const skip = resumable ? decodeResume(registered.tool.operationId, args, resumeCursor) : 0;
      // Arguments are validated before any handler runs (the handler sees only valid input, except
      // for tools whose domain service performs the identical validation itself).
      if (!valid && registered.tool.onInvalid !== 'domain' && !onlyRefMalformed(registered, args)) {
        await refuseInvalid(toolDeps, actor, registered.tool, violations);
      }
      // A20 / OR-01: a list operation answers the shared envelope, with the scope its authorization applied.
      const listSpec = LIST_OPERATIONS[registered.tool.operationId];
      const asOf = new Date();
      const listScope = newListScope();
      const run = () =>
        runInListScope(listScope, async () => registered.tool.run(toolDeps, actor, args, valid, violations));
      // H3: content a handler reads or moves for an agent is charged before its effect.
      const live = ticket;
      const ran = live
        ? await runWithBudgetMeter((m) => agents.chargeToolCall(actor, live, m), run)
        : await run();
      let truncatedMeta: Record<string, unknown> | null = null;
      let result = attachVocabularyVersions(
        registered.tool.operationId,
        listSpec
          ? attachListEnvelope(listSpec, ran, { asOf, filters: args, locationRefs: listScope.locationRefs })
          : ran,
      );
      let budgetWarning: BudgetWarning | null = null;
      if (ticket) {
        settled = true;
        if (registered.tool.readOnly) {
          const op = registered.tool.operationId;
          const r = (result ?? {}) as Record<string, unknown>;
          const key = Array.isArray(r.items) ? 'items' : Array.isArray(r.data) ? 'data' : null;
          const page = skip > 0 && key ? { ...r, [key]: (r[key] as unknown[]).slice(skip) } : result;
          const settledQuery = await agents.settleQuery(actor, ticket, page);
          result = settledQuery.result as typeof result;
          if (settledQuery.truncated) {
            truncatedMeta = {
              ...settledQuery.truncated,
              resumeCursor: encodeResume(op, args, skip + settledQuery.truncated.returned),
            };
          }
        } else {
          // H3: a command's effect has happened; a settlement failure (or a budget exceeded by its
          // result) is a warning on the success, never a refusal of an effect that took place.
          budgetWarning = await agents
            .settleToolCall(actor, ticket, 'command', result, 'ok')
            .catch((): BudgetWarning => ({ reason: 'budget_settlement_failed' }));
        }
      }
      if (!valid) {
        // Defense in depth: an input rejected by the tool schema can never succeed.
        // Invariant for `onInvalid: 'domain'` tools (propose, approve, commit): their handler has
        // already run here, so it must have refused anything this schema rejects. That holds because
        // their input schema is exactly the domain validator's sub-schema plus transport properties
        // validated by the same definitions (asserted in tool-drift.test.ts, "domain-validated MCP
        // tools are never stricter than the domain validator"). Never make such a tool's schema
        // stricter than the domain, or a call could execute and still be reported as invalid.
        throw new RefusalError({ code: 'invalid_request', detail: { violations } });
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
        ...withTruncation(withBudgetWarning(metaFor(name), budgetWarning), truncatedMeta),
      };
    } catch (err) {
      const { body } = mapErrorToRefusal(err, actor.correlationId);
      code = body.code;
      if (ticket && !settled) {
        await agents.settleToolCall(actor, ticket, 'command', null, body.code).catch(() => undefined);
      }
      if (REFUSAL_HTTP_STATUS[body.code] >= 500)
        write({ level: 'error', msg: 'tool failed', ...safeErrorKind(err) });
      return { ...refusalResult(body), ...metaFor(name) };
    } finally {
      write({
        level: 'info',
        msg: 'tool_call',
        tool: name,
        actorId: actor.actorId,
        correlationId: actor.correlationId,
        code,
      });
    }
  }

  function protocolServer(actor: ActorContext): Server {
    const server = new Server(
      { name: 'cuspatlas-synthetic', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      // Closeout C: for an agent, truncatable (read-only) tools advertise resumeCursor and the
      // _meta.truncated schema; a non-agent caller is never truncated and is advertised neither.
      tools: TOOLS.map((t) => {
        const a = advertisedTool(
          t,
          notices.has(t.name) ? `${t.description} ${notices.get(t.name)?.notice}` : t.description,
          { agent: actor.agent !== undefined },
        );
        return { ...a, inputSchema: a.inputSchema as never };
      }),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      callTool(actor, request.params.name, request.params.arguments),
    );
    return server;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const correlationId = randomUUID();
    const common = { 'x-correlation-id': correlationId };
    const refuse = (status: number, err: unknown, extra: Record<string, string> = {}) => {
      const { body } = mapErrorToRefusal(err, correlationId);
      sendJson(res, status, body, { ...common, ...extra });
    };
    if (!hostAllowed(req.headers.host, allowedHosts)) {
      return refuse(421, new RefusalError({ code: 'invalid_request' }));
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'GET' && path === METADATA_PATH) {
      // RFC 9728 protected-resource metadata; public by design, contains no tenant data.
      return sendJson(
        res,
        200,
        {
          resource: deps.identity.audience,
          authorization_servers: [deps.identity.issuer],
          bearer_methods_supported: ['header'],
          // A9 (extension, pending A-S1): an agent principal needs a recorded per-deployment consent
          // naming each tool, and every agent call is budgeted (429 rate_limited, budget_exhausted).
          cuspatlas_agent_consent: 'required',
          cuspatlas_agent_budgets: ['calls', 'records', 'phiFields'],
        },
        common,
      );
    }
    if (path !== MCP_PATH) return refuse(404, { statusCode: 404 });
    if (typeof req.headers.origin === 'string' && !allowedOrigins.has(req.headers.origin)) {
      return refuse(403, new RefusalError({ code: 'forbidden' }));
    }
    if (req.method !== 'POST') {
      return refuse(405, { statusCode: 405 }, { allow: 'POST' });
    }

    let actor: ActorContext;
    try {
      actor = await authenticator.authenticate(req.headers.authorization, correlationId);
    } catch (err) {
      const { status } = mapErrorToRefusal(err, correlationId);
      const challenge = `Bearer realm="cuspatlas-mcp"${
        metadataUrl ? `, resource_metadata="${metadataUrl}"` : ''
      }`;
      if (status >= 500) write({ level: 'error', msg: 'auth failed', ...safeErrorKind(err) });
      return refuse(status, err, status === 401 ? { 'www-authenticate': challenge } : {});
    }

    let parsed: unknown;
    try {
      parsed = await readBody(req);
    } catch (err) {
      const tooLarge = (err as { tooLarge?: boolean }).tooLarge === true;
      return refuse(tooLarge ? 413 : 400, new RefusalError({ code: 'invalid_request' }));
    }

    const server = protocolServer(actor);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('cache-control', 'no-store');
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  }

  const http: HttpServer = createServer((req, res) => {
    handle(req, res).catch((err) => {
      write({ level: 'error', msg: 'request failed', ...safeErrorKind(err) });
      if (!res.headersSent) {
        sendJson(res, 500, { code: 'internal_error', retryable: true, correlationId: randomUUID() });
      } else {
        res.end();
      }
    });
  });

  const byOperation = new Map(TOOLS.map((t) => [t.operationId as string, t.name]));
  const agentTools: AgentToolInvoker = {
    deployment: deps.identity.audience,
    async invoke(actor, operation, args) {
      const name = byOperation.get(operation);
      if (!name || !actor.agent) return { ok: false, code: 'not_found' };
      const r = await callTool(actor, name, args);
      const code = (r as { structuredContent?: { code?: unknown } }).structuredContent?.code;
      return 'isError' in r && r.isError
        ? { ok: false, code: typeof code === 'string' ? code : 'failed' }
        : { ok: true, code: 'ok' };
    },
  };

  return {
    agentTools,
    listen: (opts) =>
      new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(opts.port, opts.host, () => {
          http.off('error', reject);
          const { port } = http.address() as AddressInfo;
          if (metadataUrl === undefined) {
            if (UNSPECIFIED_HOSTS.has(opts.host)) {
              http.close();
              reject(
                new Error('resourceMetadataUrl must be configured when listening on an unspecified address'),
              );
              return;
            }
            metadataUrl = `http://${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${port}${METADATA_PATH}`;
            allowedHosts.add(new URL(metadataUrl).hostname.toLowerCase());
          }
          resolve({ url: `http://${opts.host}:${port}${MCP_PATH}` });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}
