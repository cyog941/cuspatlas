import { randomUUID } from 'node:crypto';
import type { MembershipSource, SecurityAttemptSink } from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, createAuthorize } from '@cuspatlas/domain';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from 'fastify';
import { createAuthenticator, type IdentityVerifierConfig, isTestIssuer } from './auth';
import { mapErrorToRefusal, safeErrorKind } from './errors';
import { registerSessionRoutes } from './routes/session';

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
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  if (!RUNTIME_ENVIRONMENTS.includes(deps.env)) {
    throw new Error('Unsupported runtime environment');
  }
  if (deps.identity && isTestIssuer(deps.identity) && deps.env !== 'synthetic-test') {
    throw new Error('Refusing to start: the test issuer is only permitted when CUSPATLAS_ENV=synthetic-test');
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
  }

  await app.ready();
  return app;
}
