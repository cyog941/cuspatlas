import { randomUUID } from 'node:crypto';
import type { MembershipSource, SecurityAttemptSink, WithTenantTransaction } from '@cuspatlas/contracts';
import {
  type AttemptRecordingDeps,
  BILLING_POST_MERGE_PROBE,
  type CommandExecutor,
  type CursorCodec,
  createAppointmentService,
  createAuthorize,
  createBillingService,
  createPatientService,
  createProposalService,
  createSchedulingResourceService,
  createSyntheticTaskService,
  executeOnce,
  resolveMatchKeyPepper,
} from '@cuspatlas/domain';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from 'fastify';
import { createAuthenticator, type IdentityVerifierConfig, isConfiguredIdentity, isTestIssuer } from './auth';
import { mapErrorToRefusal, safeErrorKind } from './errors';
import {
  registerAppointmentRoutes,
  registerAttendanceRoutes,
  registerBookingRoutes,
} from './routes/appointments';
import { registerBillingRoutes } from './routes/billing';
import { registerPatientRoutes } from './routes/patients';
import { registerProposalRoutes } from './routes/proposals';
import { registerSchedulingRoutes } from './routes/scheduling';
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
      const service = createSyntheticTaskService({
        authorize,
        withTenantTransaction: deps.tenantTransactions,
        recording,
        execute: deps.execute ?? executeOnce,
        ...(deps.cursors ? { cursors: deps.cursors } : {}),
      });
      registerSyntheticTaskRoutes(app, { authenticator, service });
      const proposals = createProposalService({
        authorize,
        memberships: deps.membership,
        withTenantTransaction: deps.tenantTransactions,
        recording,
        execute: deps.execute ?? executeOnce,
        ...(deps.proposalPolicyVersion ? { policyVersion: deps.proposalPolicyVersion } : {}),
      });
      registerProposalRoutes(app, { authenticator, proposals });
      const patients = createPatientService({
        matchKeyPepper: resolveMatchKeyPepper(deps.env, deps.matchKeyPepper),
        authorize,
        withTenantTransaction: deps.tenantTransactions,
        recording,
        execute: deps.execute ?? executeOnce,
        ...(deps.cursors ? { cursors: deps.cursors } : {}),
        // B1: a financial fact posted after a merge makes the unmerge need reconciliation review.
        postMergeFactProbes: [BILLING_POST_MERGE_PROBE],
      });
      registerPatientRoutes(app, { authenticator, patients });
      const scheduling = createSchedulingResourceService({
        authorize,
        withTenantTransaction: deps.tenantTransactions,
        recording,
        execute: deps.execute ?? executeOnce,
      });
      registerSchedulingRoutes(app, { authenticator, scheduling });
      const appointments = createAppointmentService({
        authorize,
        withTenantTransaction: deps.tenantTransactions,
        recording,
        execute: deps.execute ?? executeOnce,
      });
      registerAppointmentRoutes(app, { authenticator, appointments });
      registerBookingRoutes(app, { authenticator, appointments });
      registerAttendanceRoutes(app, { authenticator, appointments });
      const billing = createBillingService({
        authorize,
        withTenantTransaction: deps.tenantTransactions,
        recording,
        execute: deps.execute ?? executeOnce,
      });
      registerBillingRoutes(app, { authenticator, billing });
    }
  }

  await app.ready();
  return app;
}
