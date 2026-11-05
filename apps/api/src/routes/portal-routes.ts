import type { ActorContext, ObjectContent } from '@cuspatlas/contracts';
import type { EngagementService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { ENGAGEMENT_OPS } from './engagement-ops';
import { routeFor } from './manifest';
import { PORTAL_OPS } from './portal-ops';
import { type OpInput, pathParamsOf } from './scheduling-ops';

interface InvokableOp {
  readonly method: 'get' | 'post';
  readonly path: string;
  readonly operationId: string;
  readonly success: { readonly status: string; readonly media?: string };
  invoke(svc: EngagementService, actor: ActorContext, input: OpInput): Promise<unknown>;
}

/**
 * Registers E routes from their operation tables. Authentication runs in `onRequest` with the
 * authenticator of the transport (staff or portal audience); the handler passes path parameters, the
 * body (POST) or query (GET) and the Idempotency-Key to the shared engagement call. No tenant is
 * read from the request.
 */
function register(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; engagement: EngagementService },
  ops: readonly InvokableOp[],
): void {
  for (const op of ops) {
    const r = routeFor(op.operationId);
    const names = pathParamsOf(op.path);
    const input = (request: FastifyRequest): OpInput => {
      const raw = request.params as Record<string, string>;
      const key = request.headers['idempotency-key'];
      return {
        params: Object.fromEntries(names.map((n) => [n, raw[n] ?? ''])),
        body: op.method === 'get' ? { ...(request.query as object) } : request.body,
        key: typeof key === 'string' ? key : '',
      };
    };
    const opts = { onRequest: authenticateOnRequest(deps.authenticator, op.operationId) };
    if (op.method === 'get' && op.success.media === 'application/octet-stream') {
      // E2 documents: the read-grant token travels in a header only (never a URL), as on imaging.
      app.get(r.fastifyPath, opts, async (request, reply) => {
        const base = input(request);
        const token = request.headers['x-object-read-token'];
        const content = (await op.invoke(deps.engagement, requireActor(request), {
          ...base,
          params: { ...base.params, token: typeof token === 'string' ? token : '' },
        })) as ObjectContent;
        return reply
          .code(200)
          .header('content-type', content.contentType)
          .header('content-disposition', 'attachment')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .header('referrer-policy', 'no-referrer')
          .header('x-object-digest-sha256', content.digestSha256)
          .send(Buffer.from(content.bytes.buffer, content.bytes.byteOffset, content.bytes.byteLength));
      });
    } else if (op.method === 'get') {
      app.get(r.fastifyPath, opts, async (request) =>
        op.invoke(deps.engagement, requireActor(request), input(request)),
      );
    } else {
      app.post(r.fastifyPath, opts, async (request, reply) =>
        reply
          .code(Number(op.success.status))
          .send(await op.invoke(deps.engagement, requireActor(request), input(request))),
      );
    }
  }
}

/** Staff E operations: the staff authenticator (staff audience, live membership). */
export function registerEngagementOpRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; engagement: EngagementService },
): void {
  register(app, deps, ENGAGEMENT_OPS);
}

/** Portal operations: the portal authenticator only (portal audience, live portal enrolment). */
export function registerPortalRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; engagement: EngagementService },
): void {
  register(app, deps, PORTAL_OPS);
}
