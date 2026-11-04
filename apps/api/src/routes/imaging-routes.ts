import type { ObjectContent } from '@cuspatlas/contracts';
import type { ImagingService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { authenticateDeviceOnRequest, type DeviceAuthenticator } from '../device-auth';
import { IMAGING_OPS } from './imaging-ops';
import { routeFor } from './manifest';
import { pathParamsOf } from './scheduling-ops';

export const OBJECT_TOKEN_HEADER = 'x-object-read-token';

/**
 * Registers every IMAGING_OPS route. Authentication runs in `onRequest`; handlers pass path
 * parameters, the body (POST), query (GET) or raw bytes (binary upload) and the Idempotency-Key to the
 * shared domain call, which authorizes before it validates. No tenant is read from the request.
 * Binary routes live in their own encapsulated scope: only there is `application/octet-stream`
 * accepted, with the configured object size as the body limit (the JSON limit stays 16 KiB elsewhere).
 */
export function registerImagingRoutes(
  app: FastifyInstance,
  deps: {
    authenticator: Authenticator;
    imaging: ImagingService;
    maxObjectBytes: number;
    /** I6 bridge audience; bridge routes are registered only when it is configured. */
    deviceAuthenticator?: DeviceAuthenticator;
  },
): void {
  app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: deps.maxObjectBytes },
      (_req, body, done) => done(null, body),
    );
    for (const op of IMAGING_OPS) {
      if (op.transport !== undefined && !deps.deviceAuthenticator) continue;
      const r = routeFor(op.operationId);
      const names = pathParamsOf(op.path);
      const input = (request: FastifyRequest) => {
        const raw = request.params as Record<string, string>;
        const key = request.headers['idempotency-key'];
        const token = request.headers[OBJECT_TOKEN_HEADER];
        return {
          params: Object.fromEntries(names.map((n) => [n, raw[n] ?? ''])),
          body: op.method === 'get' ? { ...(request.query as object) } : request.body,
          key: typeof key === 'string' ? key : '',
          ...(typeof token === 'string' ? { token } : {}),
        };
      };
      if (op.transport === 'pairing') {
        // The one anonymous bridge route: the one-time code in the body authenticates it.
        scope.post(r.fastifyPath, async (request, reply) =>
          reply
            .code(Number(op.success.status))
            .send(await op.invokeAnonymous?.(deps.imaging, input(request), request.id)),
        );
        continue;
      }
      const opts = {
        onRequest:
          op.transport === 'device' && deps.deviceAuthenticator
            ? authenticateDeviceOnRequest(deps.deviceAuthenticator, op.operationId)
            : authenticateOnRequest(deps.authenticator, op.operationId),
        ...(op.requestMedia ? { bodyLimit: deps.maxObjectBytes } : {}),
      };
      if (op.method === 'get' && op.success.media === 'application/octet-stream') {
        scope.get(r.fastifyPath, opts, async (request, reply) => {
          const content = (await op.invoke(
            deps.imaging,
            requireActor(request),
            input(request),
          )) as ObjectContent;
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
        scope.get(r.fastifyPath, opts, async (request) =>
          op.invoke(deps.imaging, requireActor(request), input(request)),
        );
      } else {
        scope.post(r.fastifyPath, opts, async (request, reply) =>
          reply
            .code(Number(op.success.status))
            .send(await op.invoke(deps.imaging, requireActor(request), input(request))),
        );
      }
    }
  });
}
