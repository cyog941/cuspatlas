import { type AttemptRecordingDeps, type Authorize, withAttemptRecording } from '@cuspatlas/domain';
import type { FastifyInstance } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { routeFor } from './manifest';

/** GET /v1/session: the server-derived context for the presented token. Never caller-supplied. */
export function registerSessionRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; authorize: Authorize; recording: AttemptRecordingDeps },
): void {
  const operation = 'session.read';
  const onRequest = authenticateOnRequest(deps.authenticator, operation);
  app.get(routeFor('session.read').fastifyPath, { onRequest }, async (request) => {
    const ctx = requireActor(request);
    await withAttemptRecording(
      deps.recording,
      { correlationId: ctx.correlationId, tenantId: ctx.tenantId, actorId: ctx.actorId, operation },
      () => deps.authorize(ctx, operation, { tenantId: ctx.tenantId, id: ctx.actorId }),
    );
    return {
      tenantRef: ctx.tenantId,
      principalRef: ctx.actorId,
      principal: ctx.principal,
      scopes: ctx.scopes,
    };
  });
}
