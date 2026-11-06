import type { ProposalService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { routeFor } from './manifest';

/**
 * The Idempotency-Key of a prepare. Unlike the task routes it is validated by the domain, after
 * authorization, so REST and MCP refuse a missing or malformed key identically. A repeated header
 * becomes an empty (invalid) key.
 */
function prepareKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  return typeof raw === 'string' ? raw : '';
}

/**
 * Thin REST adapter for proposals (F Task 7a). Approve and commit take no Idempotency-Key header:
 * their idempotency key is the proposal id (frozen rule). No tenant, proposer or approver is read
 * from the path, query, headers or body.
 */
export function registerProposalRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; proposals: ProposalService },
): void {
  const on = (operation: string) => ({ onRequest: authenticateOnRequest(deps.authenticator, operation) });

  const prepare = routeFor('syntheticTasks.proposals.prepare');
  app.post(prepare.fastifyPath, on(prepare.operationId), async (request, reply) => {
    const result = await deps.proposals.prepareProposal(requireActor(request), {
      operation: 'syntheticTasks.proposals.prepare',
      idempotencyKey: prepareKey(request),
      payload: request.body,
    });
    return reply.code(201).send(result);
  });

  const read = routeFor('syntheticTasks.proposals.read');
  app.get<{ Params: { proposalRef: string } }>(read.fastifyPath, on(read.operationId), async (request) => ({
    data: await deps.proposals.getProposal(requireActor(request), request.params.proposalRef),
  }));

  const approve = routeFor('syntheticTasks.proposals.approve');
  app.post<{ Params: { proposalRef: string } }>(
    approve.fastifyPath,
    on(approve.operationId),
    async (request) =>
      deps.proposals.approveProposal(requireActor(request), request.params.proposalRef, request.body),
  );

  const commit = routeFor('syntheticTasks.proposals.commit');
  app.post<{ Params: { proposalRef: string } }>(commit.fastifyPath, on(commit.operationId), async (request) =>
    deps.proposals.commitProposal(requireActor(request), request.params.proposalRef, request.body),
  );
}
