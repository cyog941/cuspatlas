import {
  attachListEnvelope,
  type CatalogOperation,
  LIST_OPERATIONS,
  type ListOperationSpec,
} from '@cuspatlas/contracts';
import operations from '@cuspatlas/contracts/catalog/operations.json' with { type: 'json' };
import { type ListScopeRecord, newListScope, runInListScope } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';

/**
 * A20 / OR-01 on REST: every catalog list route answers the shared envelope. The route's handler runs
 * inside a list scope (so `authorize` records the location restriction it applied) and the envelope is
 * attached when the 2xx body is serialized. MCP does the same in `callTool` from the same table.
 */
interface ListCall {
  readonly spec: ListOperationSpec;
  readonly asOf: Date;
  readonly scope: ListScopeRecord;
}
const CALLS = new WeakMap<FastifyRequest, ListCall>();

const LIST_ROUTES = new Map<string, ListOperationSpec>();
for (const o of operations as readonly CatalogOperation[]) {
  const spec = LIST_OPERATIONS[o.operation];
  if (spec && o.rest)
    LIST_ROUTES.set(`${o.rest.method.toUpperCase()} ${o.rest.path.replace(/\{(\w+)\}/g, ':$1')}`, spec);
}

export function registerListEnvelope(app: FastifyInstance): void {
  app.addHook('onRoute', (r: RouteOptions) => {
    const method = [r.method].flat()[0];
    const spec = LIST_ROUTES.get(`${String(method).toUpperCase()} ${r.url}`);
    if (!spec) return;
    const handler = r.handler;
    r.handler = function listHandler(this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
      const scope = newListScope();
      CALLS.set(request, { spec, asOf: new Date(), scope });
      return runInListScope(scope, () => handler.call(this, request, reply));
    };
  });
  app.addHook('preSerialization', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const call = CALLS.get(request);
    if (!call || reply.statusCode < 200 || reply.statusCode >= 300) return payload;
    const filters = {
      ...((request.params as Record<string, unknown> | undefined) ?? {}),
      ...((request.query as Record<string, unknown> | undefined) ?? {}),
      // A read-only POST (search) carries its filters in the body.
      ...(request.method === 'POST' &&
      request.body &&
      typeof request.body === 'object' &&
      !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {}),
    };
    return attachListEnvelope(call.spec, payload, {
      asOf: call.asOf,
      filters,
      locationRefs: call.scope.locationRefs,
    });
  });
}
