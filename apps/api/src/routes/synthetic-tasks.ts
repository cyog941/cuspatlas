import { RefusalError } from '@cuspatlas/contracts';
import type { SyntheticTaskService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Authenticator } from '../auth';
import { routeFor } from './manifest';

function idempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  // Missing or repeated headers are refused; the domain validates the value itself.
  if (typeof raw !== 'string') throw new RefusalError({ code: 'invalid_request' });
  return raw;
}

/**
 * Thin REST adapter: authenticate, translate HTTP to a command envelope, call the domain service.
 * No tenant is read from the path, query, headers or body.
 */
export function registerSyntheticTaskRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; service: SyntheticTaskService },
): void {
  const auth = (request: FastifyRequest, operation: string) =>
    deps.authenticator.authenticate(request.headers.authorization, request.id, operation);

  const create = routeFor('syntheticTasks.create');
  app.post(create.fastifyPath, async (request, reply) => {
    const ctx = await auth(request, 'syntheticTasks.create');
    const result = await deps.service.createSyntheticTask(ctx, {
      operation: 'syntheticTasks.create',
      idempotencyKey: idempotencyKey(request),
      payload: request.body,
    });
    return reply.code(201).send(result);
  });

  const list = routeFor('syntheticTasks.list');
  app.get(list.fastifyPath, async (request) => {
    const ctx = await auth(request, 'syntheticTasks.read');
    return deps.service.listSyntheticTasks(ctx, { ...(request.query as object) });
  });

  const read = routeFor('syntheticTasks.read');
  app.get<{ Params: { taskRef: string } }>(read.fastifyPath, async (request) => {
    const ctx = await auth(request, 'syntheticTasks.read');
    return { data: await deps.service.getSyntheticTask(ctx, request.params.taskRef) };
  });

  const relabel = routeFor('syntheticTasks.relabel');
  app.post<{ Params: { taskRef: string } }>(relabel.fastifyPath, async (request) => {
    const ctx = await auth(request, 'syntheticTasks.relabel');
    return deps.service.relabelSyntheticTask(ctx, request.params.taskRef, {
      operation: 'syntheticTasks.relabel',
      idempotencyKey: idempotencyKey(request),
      payload: request.body,
    });
  });
}
