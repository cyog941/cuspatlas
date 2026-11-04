import type { BillingService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { BILLING_OPS } from './billing-ops';
import { routeFor } from './manifest';
import { pathParamsOf } from './scheduling-ops';

/**
 * Registers every BILLING_OPS route (B6, B7, B9 and the C14 consumer twin). Authentication runs in
 * `onRequest`; the handler passes the path parameters, the body (POST) or query (GET) and the
 * Idempotency-Key to the shared domain call, which authorizes before it validates. No tenant is read
 * from the request.
 */
export function registerBillingOpRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; billing: BillingService },
): void {
  for (const op of BILLING_OPS) {
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
        op.invoke(deps.billing, requireActor(request), input(request)),
      );
    } else {
      app.post(r.fastifyPath, opts, async (request, reply) =>
        reply
          .code(op.success.status === '201' ? 201 : 200)
          .send(await op.invoke(deps.billing, requireActor(request), input(request))),
      );
    }
  }
}
