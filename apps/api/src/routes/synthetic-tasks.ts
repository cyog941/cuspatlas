import { RefusalError } from '@cuspatlas/contracts';
import type { SyntheticTaskService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { routeFor } from './manifest';

function idempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  // Missing or repeated headers are refused; the domain validates the value itself.
  if (typeof raw !== 'string') throw new RefusalError({ code: 'invalid_request' });
  return raw;
}

/**
 * Thin REST adapter: authenticate in `onRequest` (before any body is parsed), translate HTTP to a
 * command envelope, call the domain service. No tenant is read from the path, query, headers or body.
 */
export function registerSyntheticTaskRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; service: SyntheticTaskService },
): void {
  const on = (operation: string) => ({ onRequest: authenticateOnRequest(deps.authenticator, operation) });

  const create = routeFor('syntheticTasks.create');
  app.post(create.fastifyPath, on('syntheticTasks.create'), async (request, reply) => {
    const result = await deps.service.createSyntheticTask(requireActor(request), {
      operation: 'syntheticTasks.create',
      idempotencyKey: idempotencyKey(request),
      payload: request.body,
    });
    return reply.code(201).send(result);
  });

  const list = routeFor('syntheticTasks.list');
  app.get(list.fastifyPath, on('syntheticTasks.read'), async (request) =>
    deps.service.listSyntheticTasks(requireActor(request), { ...(request.query as object) }),
  );

  const read = routeFor('syntheticTasks.read');
  app.get<{ Params: { taskRef: string } }>(read.fastifyPath, on('syntheticTasks.read'), async (request) => ({
    data: await deps.service.getSyntheticTask(requireActor(request), request.params.taskRef),
  }));

  const relabel = routeFor('syntheticTasks.relabel');
  app.post<{ Params: { taskRef: string } }>(
    relabel.fastifyPath,
    on('syntheticTasks.relabel'),
    async (request) =>
      deps.service.relabelSyntheticTask(requireActor(request), request.params.taskRef, {
        operation: 'syntheticTasks.relabel',
        idempotencyKey: idempotencyKey(request),
        payload: request.body,
      }),
  );
}
