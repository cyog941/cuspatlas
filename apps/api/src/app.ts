import { type KeyObject, randomUUID } from 'node:crypto';
import type {
  DeviceCredentialSource,
  MalwareScannerPort,
  MembershipSource,
  ObjectStorePort,
  PortalPrincipalSource,
  SecurityAttemptSink,
  WithTenantTransaction,
} from '@cuspatlas/contracts';
import {
  type AttachmentRefResolver,
  type AttemptRecordingDeps,
  CLINICAL_POST_MERGE_FACT_PROBES,
  type CommandExecutor,
  type CursorCodec,
  createAppointmentService,
  createAuthorize,
  createClinicalService,
  createClinicalVisitContextProducers,
  createDurableExecutor,
  createEngagementService,
  createImagingService,
  createPatientService,
  createProposalService,
  createSchedulingResourceService,
  createSyntheticTaskService,
  type ImageRefResolver,
  type ImagingLimits,
  readLatestCompletedProcedures,
  resolveIdempotencyDigestKey,
  resolveImagingTokenSecret,
  resolveMatchKeyPepper,
  type StagingMaintenance,
} from '@cuspatlas/domain';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from 'fastify';
import {
  createAuthenticator,
  createPortalAuthenticator,
  type IdentityVerifierConfig,
  isConfiguredIdentity,
  isTestIssuer,
} from './auth';
import { createDeviceAuthenticator } from './device-auth';
import { mapErrorToRefusal, safeErrorKind } from './errors';
import {
  registerAppointmentRoutes,
  registerAttendanceRoutes,
  registerBookingRoutes,
} from './routes/appointments';
import { registerClinicalRoutes } from './routes/clinical';
import { registerClinicalRecordRoutes } from './routes/clinical-record';
import { registerImagingRoutes } from './routes/imaging-routes';
import { registerPatientRoutes } from './routes/patients';
import { registerEngagementOpRoutes, registerPortalRoutes } from './routes/portal-routes';
import { registerProposalRoutes } from './routes/proposals';
import { registerSchedulingRoutes } from './routes/scheduling';
import { registerSchedulingOpRoutes } from './routes/scheduling-ops-routes';
import { registerSessionRoutes } from './routes/session';
import { registerSyntheticTaskRoutes } from './routes/synthetic-tasks';

export const RUNTIME_ENVIRONMENTS = ['synthetic-test', 'development', 'production'] as const;
export type RuntimeEnvironment = (typeof RUNTIME_ENVIRONMENTS)[number];

export interface LogDestination {
  write(line: string): void;
}

export interface AppDeps {
  readonly env: RuntimeEnvironment;
  readonly logger?: { readonly level?: string; readonly stream?: LogDestination };
  /** Token verification. Protected routes are registered only when identity is configured. */
  readonly identity?: IdentityVerifierConfig;
  /** Live membership lookups on the runtime-role pool. */
  readonly membership?: MembershipSource;
  /** Security-attempt sink on an independent runtime-role pool. */
  readonly attempts?: SecurityAttemptSink;
  /** Runtime-role tenant transactions; enables the synthetic-task routes. */
  readonly tenantTransactions?: WithTenantTransaction;
  /** Command executor; defaults to the durable executeOnce. Tests may inject a faulting one. */
  readonly execute?: CommandExecutor;
  /** Pagination cursor codec; defaults to a per-process random HMAC key. */
  readonly cursors?: CursorCodec;
  /** Proposal policy version (defaults to PROPOSAL_POLICY_VERSION); tests bump it. */
  readonly proposalPolicyVersion?: string;
  /** Match-key pepper (CUSPATLAS_MATCH_KEY_PEPPER); optional only under synthetic-test. */
  readonly matchKeyPepper?: Uint8Array;
  /**
   * Idempotency payload digest key (CUSPATLAS_IDEMPOTENCY_DIGEST_KEY); optional only under
   * synthetic-test, where the test-only key is used. The test-only key is refused elsewhere.
   */
  readonly idempotencyDigestKey?: Uint8Array;
  /** C15: the I3 imageRef seam (absent: image link commands are refused typed). */
  readonly imageRefResolver?: ImageRefResolver;
  /** I's attachment reference read (another branch); without it message attachments are refused. */
  readonly attachmentRefs?: AttachmentRefResolver;
  /**
   * E1 portal transport: the same verifier key with the portal audience (distinct from the staff
   * audience). Portal routes are registered only when this and `portalPrincipals` are configured.
   */
  readonly portalIdentity?: IdentityVerifierConfig;
  /** The MCP resource audience, when an MCP server runs beside this API: the portal must differ. */
  readonly mcpAudience?: string;
  /** Live portal-enrolment lookups on the runtime-role pool. */
  readonly portalPrincipals?: PortalPrincipalSource;
  /** I1: private object store (synthetic local adapter in tests); absent = every byte path is 503. */
  readonly objectStore?: ObjectStorePort;
  /** Maintenance-only staging listing for the orphan sweep (absent = only database-named staging is swept). */
  readonly stagingMaintenance?: StagingMaintenance;
  /** I2: malware scanner; absent = every verdict is unknown, so nothing becomes available. */
  readonly scanner?: MalwareScannerPort;
  /** I1 read-grant secret (CUSPATLAS_IMAGING_TOKEN_SECRET); optional only under synthetic-test. */
  readonly imagingTokenSecret?: Uint8Array;
  readonly imagingLimits?: ImagingLimits;
  /**
   * I6 bridge audience: live device credentials on the runtime-role pool. Bridge routes are registered
   * only when this is configured.
   */
  readonly deviceCredentials?: DeviceCredentialSource;
  /** I6 server job-signing key (Ed25519 private key); see resolveBridgeSigningKey. */
  readonly bridgeSigningKey?: KeyObject | null;
}

function sendRefusal(request: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
  const { status, body } = mapErrorToRefusal(err, request.id);
  if (status >= 500) request.log.error(safeErrorKind(err), 'request failed');
  if (status === 401) reply.header('www-authenticate', 'Bearer realm="cuspatlas"');
  return reply.code(status).type('application/json; charset=utf-8').send(body);
}

const safeSerializers = {
  req: (req: { method?: string; routeOptions?: { url?: string } }) => ({
    method: req.method,
    route: req.routeOptions?.url ?? 'unmatched',
  }),
  res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
  err: (err: unknown) => safeErrorKind(err),
};

/**
 * Builds the HTTP service. Request logging is restricted to method, matched route pattern, status
 * and the server-generated correlation id: no URL, query, headers or bodies are ever logged.
 */
/** Reads CUSPATLAS_ENV and refuses anything that is not a known runtime environment. */
export function resolveRuntimeEnv(env: NodeJS.ProcessEnv): RuntimeEnvironment {
  const value = env.CUSPATLAS_ENV;
  if (!value || !(RUNTIME_ENVIRONMENTS as readonly string[]).includes(value)) {
    throw new Error(`CUSPATLAS_ENV must be one of ${RUNTIME_ENVIRONMENTS.join(', ')}`);
  }
  return value as RuntimeEnvironment;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  if (!RUNTIME_ENVIRONMENTS.includes(deps.env)) {
    throw new Error('Unsupported runtime environment');
  }
  if (
    deps.identity &&
    deps.env !== 'synthetic-test' &&
    (isTestIssuer(deps.identity) || !isConfiguredIdentity(deps.identity))
  ) {
    throw new Error(
      'Refusing to start: the test issuer or any non-configured key source is only permitted when CUSPATLAS_ENV=synthetic-test',
    );
  }
  if (deps.identity && (!deps.membership || !deps.attempts)) {
    throw new Error('Refusing to start: identity requires a membership source and a security-attempt sink');
  }
  if (deps.portalIdentity) {
    if (
      deps.env !== 'synthetic-test' &&
      (isTestIssuer(deps.portalIdentity) || !isConfiguredIdentity(deps.portalIdentity))
    ) {
      throw new Error('Refusing to start: the portal verifier must be a configured key source');
    }
    if (!deps.identity || deps.portalIdentity.audience === deps.identity.audience) {
      throw new Error(
        'Refusing to start: the portal audience must be configured and differ from the staff audience',
      );
    }
    if (deps.mcpAudience !== undefined && deps.portalIdentity.audience === deps.mcpAudience) {
      throw new Error('Refusing to start: the portal audience must differ from the MCP audience');
    }
    if (!deps.portalPrincipals) {
      throw new Error('Refusing to start: the portal transport requires a portal-principal source');
    }
  }

  const app = Fastify({
    logger: {
      level: deps.logger?.level ?? 'info',
      ...(deps.logger?.stream ? { stream: deps.logger.stream } : {}),
      // Typed loosely on purpose: these replace pino's defaults so no URL, header or message is logged.
      serializers: safeSerializers as never,
    },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
    bodyLimit: 16 * 1024,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    return503OnClosing: true,
  });

  app.decorateRequest('actor', null);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });

  app.setErrorHandler((err, request, reply) => sendRefusal(request, reply, err));
  app.setNotFoundHandler((request, reply) => sendRefusal(request, reply, { statusCode: 404 }));

  app.get('/healthz', async () => ({ status: 'ok' }));

  if (deps.identity && deps.membership && deps.attempts) {
    const recording: AttemptRecordingDeps = {
      sink: deps.attempts,
      alert: (code) => app.log.error({ alert: code }, 'security alert'),
    };
    const authenticator = createAuthenticator(deps.identity, deps.membership, recording);
    const authorize = createAuthorize(deps.membership);
    registerSessionRoutes(app, { authenticator, authorize, recording });
    if (deps.tenantTransactions) {
      // Durable idempotency with the keyed payload digest of this environment (the key is required
      // outside synthetic-test even when a test injects its own executor).
      const durable = createDurableExecutor(resolveIdempotencyDigestKey(deps.env, deps.idempotencyDigestKey));
      const execute = deps.execute ?? durable;
      const service = createSyntheticTaskService({
        authorize,
        withTenantTransaction: deps.tenantTransactions,
        recording,
        execute,
        ...(deps.cursors ? { cursors: deps.cursors } : {}),
      });
      registerSyntheticTaskRoutes(app, { authenticator, service });
      const proposals = createProposalService({
        authorize,
        memberships: deps.membership,
        withTenantTransaction: deps.tenantTransactions,
        recording,
        execute,
        ...(deps.proposalPolicyVersion ? { policyVersion: deps.proposalPolicyVersion } : {}),
      });
      registerProposalRoutes(app, { authenticator, proposals });
      const patients = createPatientService({
        matchKeyPepper: resolveMatchKeyPepper(deps.env, deps.matchKeyPepper),
        // C5: clinical facts after a merge make an unmerge need the reconciliation review (S-D2).
        postMergeFactProbes: CLINICAL_POST_MERGE_FACT_PROBES,
        authorize,
        withTenantTransaction: deps.tenantTransactions,
        recording,
        execute,
        ...(deps.cursors ? { cursors: deps.cursors } : {}),
      });
      registerPatientRoutes(app, { authenticator, patients });
      const scheduling = createSchedulingResourceService({
        authorize,
        withTenantTransaction: deps.tenantTransactions,
        recording,
        execute,
      });
      registerSchedulingRoutes(app, { authenticator, scheduling });
      const appointments = createAppointmentService({
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
      registerAppointmentRoutes(app, { authenticator, appointments });
      registerBookingRoutes(app, { authenticator, appointments });
      registerAttendanceRoutes(app, { authenticator, appointments });
      const clinical = createClinicalService({
        authorize,
        withTenantTransaction: deps.tenantTransactions,
        recording,
        execute,
        ...(deps.cursors ? { cursors: deps.cursors } : {}),
        ...(deps.imageRefResolver ? { imageRefResolver: deps.imageRefResolver } : {}),
      });
      registerClinicalRoutes(app, { authenticator, clinical });
      registerClinicalRecordRoutes(app, { authenticator, clinical });
      registerSchedulingOpRoutes(app, { authenticator, appointments });
      const engagement = createEngagementService({
        patients,
        completedProcedures: readLatestCompletedProcedures,
        appointments,
        matchKeyPepper: resolveMatchKeyPepper(deps.env, deps.matchKeyPepper),
        ...(deps.attachmentRefs ? { attachmentRefs: deps.attachmentRefs } : {}),
        authorize,
        withTenantTransaction: deps.tenantTransactions,
        recording,
        execute,
      });
      registerEngagementOpRoutes(app, { authenticator, engagement });
      if (deps.portalIdentity && deps.portalPrincipals) {
        const portalAuthenticator = createPortalAuthenticator(
          deps.portalIdentity,
          deps.portalPrincipals,
          recording,
        );
        registerPortalRoutes(app, { authenticator: portalAuthenticator, engagement });
      }
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
        bridgeSigningKey: deps.bridgeSigningKey ?? null,
        alert: (code) => app.log.error({ alert: code }, 'imaging alert'),
      });
      registerImagingRoutes(app, {
        authenticator,
        imaging,
        maxObjectBytes: deps.imagingLimits?.maxObjectBytes ?? 32 * 1024 * 1024,
        ...(deps.deviceCredentials
          ? { deviceAuthenticator: createDeviceAuthenticator(deps.deviceCredentials, recording) }
          : {}),
      });
    }
  }

  await app.ready();
  return app;
}
