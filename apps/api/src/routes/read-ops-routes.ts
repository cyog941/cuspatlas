import type { ReadSurfaceService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { routeFor } from './manifest';
import { READ_OPS } from './read-ops';
import { pathParamsOf } from './scheduling-ops';

/** Registers every READ_OPS route (authentication in onRequest; the domain authorizes, then validates). */
export function registerReadOpRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; reads: ReadSurfaceService },
): void {
  for (const op of READ_OPS) {
    const r = routeFor(op.operationId);
    const names = pathParamsOf(op.path);
    const input = (request: FastifyRequest) => {
      const raw = request.params as Record<string, string>;
      const key = request.headers['idempotency-key'];
      return {
        params: Object.fromEntries(names.map((n) => [n, raw[n] ?? ''])),
        body: op.method === 'get' ? { ...(request.query as object) } : request.body,
        key: typeof key === 'string' ? key : '',
      };
    };
    const opts = { onRequest: authenticateOnRequest(deps.authenticator, op.operationId) };
    if (op.method === 'get') {
      app.get(r.fastifyPath, opts, async (request) =>
        op.invoke(deps.reads, requireActor(request), input(request)),
      );
    } else {
      app.post(r.fastifyPath, opts, async (request, reply) =>
        reply
          .code(Number(op.success.status))
          .send(await op.invoke(deps.reads, requireActor(request), input(request))),
      );
    }
  }
}
