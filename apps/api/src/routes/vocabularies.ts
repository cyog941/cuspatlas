import type { VocabularyService } from '@cuspatlas/domain';
import type { FastifyInstance } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { routeFor } from './manifest';

/** A20 / OR-02: GET /v1/vocabularies and /v1/vocabularies/{name} (the MCP twins call the same service). */
export function registerVocabularyRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; vocabularies: VocabularyService },
): void {
  app.get(
    routeFor('vocabularies.list').fastifyPath,
    { onRequest: authenticateOnRequest(deps.authenticator, 'vocabularies.list') },
    async (request) => deps.vocabularies.listVocabularies(requireActor(request)),
  );
  app.get(
    routeFor('vocabularies.read').fastifyPath,
    { onRequest: authenticateOnRequest(deps.authenticator, 'vocabularies.read') },
    async (request) =>
      deps.vocabularies.getVocabulary(requireActor(request), (request.params as { name: string }).name),
  );
}
