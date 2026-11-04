import type { SchedulingResourceService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { routeFor } from './manifest';

/**
 * The Idempotency-Key of a scheduling command. Validated by the domain after authorization, so REST
 * and MCP refuse a missing or malformed key identically (a repeated header becomes an invalid key).
 */
function key(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  return typeof raw === 'string' ? raw : '';
}

/**
 * Thin REST adapter for S7 resources. Authentication runs in `onRequest` before any body parsing;
 * no tenant is read from the path, query, headers or body.
 */
export function registerSchedulingRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; scheduling: SchedulingResourceService },
): void {
  const on = (operation: string) => ({ onRequest: authenticateOnRequest(deps.authenticator, operation) });
  const s = deps.scheduling;
  type WithLocation = { Params: { locationRef: string } };
  type WithResource = { Params: { resourceRef: string } };

  const defineLocation = routeFor('scheduling.locations.define');
  app.post(defineLocation.fastifyPath, on(defineLocation.operationId), async (request, reply) =>
    reply.code(201).send(
      await s.defineLocation(requireActor(request), {
        operation: 'scheduling.locations.define',
        idempotencyKey: key(request),
        payload: request.body,
      }),
    ),
  );

  const listLocations = routeFor('scheduling.locations.list');
  app.get(listLocations.fastifyPath, on(listLocations.operationId), async (request) =>
    s.listLocations(requireActor(request), { ...(request.query as object) }),
  );

  const changeZone = routeFor('scheduling.locations.changeTimeZone');
  app.post<WithLocation>(changeZone.fastifyPath, on(changeZone.operationId), async (request) =>
    s.changeLocationTimeZone(requireActor(request), request.params.locationRef, {
      operation: 'scheduling.locations.changeTimeZone',
      idempotencyKey: key(request),
      payload: request.body,
    }),
  );

  const defineResource = routeFor('scheduling.resources.define');
  app.post(defineResource.fastifyPath, on(defineResource.operationId), async (request, reply) =>
    reply.code(201).send(
      await s.defineResource(requireActor(request), {
        operation: 'scheduling.resources.define',
        idempotencyKey: key(request),
        payload: request.body,
      }),
    ),
  );

  const listResources = routeFor('scheduling.resources.list');
  app.get(listResources.fastifyPath, on(listResources.operationId), async (request) =>
    s.listResources(requireActor(request), { ...(request.query as object) }),
  );

  const readResource = routeFor('scheduling.resources.read');
  app.get<WithResource>(readResource.fastifyPath, on(readResource.operationId), async (request) => ({
    data: await s.getResource(requireActor(request), request.params.resourceRef),
  }));

  const setAvailability = routeFor('scheduling.resources.setAvailability');
  app.post<WithResource>(
    setAvailability.fastifyPath,
    on(setAvailability.operationId),
    async (request, reply) =>
      reply.code(201).send(
        await s.setResourceAvailability(requireActor(request), request.params.resourceRef, {
          operation: 'scheduling.resources.setAvailability',
          idempotencyKey: key(request),
          payload: request.body,
        }),
      ),
  );

  const deactivate = routeFor('scheduling.resources.deactivate');
  app.post<WithResource>(deactivate.fastifyPath, on(deactivate.operationId), async (request) =>
    s.deactivateResource(requireActor(request), request.params.resourceRef, {
      operation: 'scheduling.resources.deactivate',
      idempotencyKey: key(request),
      payload: request.body,
    }),
  );

  const createBlock = routeFor('scheduling.timeBlocks.create');
  app.post(createBlock.fastifyPath, on(createBlock.operationId), async (request, reply) =>
    reply.code(201).send(
      await s.createTimeBlock(requireActor(request), {
        operation: 'scheduling.timeBlocks.create',
        idempotencyKey: key(request),
        payload: request.body,
      }),
    ),
  );

  const dataQuality = routeFor('scheduling.resources.dataQuality');
  app.get(dataQuality.fastifyPath, on(dataQuality.operationId), async (request) => ({
    data: await s.stateLabelledResources(requireActor(request)),
  }));

  // S9: read-only; takes no Idempotency-Key and writes nothing.
  const search = routeFor('scheduling.availability.search');
  app.post(search.fastifyPath, on(search.operationId), async (request) => ({
    data: await s.searchAvailability(requireActor(request), request.body),
  }));
}
