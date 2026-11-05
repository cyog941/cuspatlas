import {
  attachListEnvelope,
  attachVocabularyVersions,
  type CatalogOperation,
  LIST_OPERATIONS,
  type ListOperationSpec,
  VOCABULARY_BEARING,
} from '@cuspatlas/contracts';
import operations from '@cuspatlas/contracts/catalog/operations.json' with { type: 'json' };
import { type ListScopeRecord, newListScope, runInListScope } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';

/**
 * A20 on REST. OR-01: every catalog list route answers the shared envelope; the handler runs inside a
 * list scope (so `authorize` records the location restriction it applied) and the envelope is attached
 * when the 2xx body is serialized. OR-02: a response carrying a state code also carries its vocabulary
 * version. MCP does the same in `callTool` from the same tables.
 */
interface ReadCall {
  readonly operation: string;
  readonly spec: ListOperationSpec | undefined;
  readonly asOf: Date;
  readonly scope: ListScopeRecord;
}
const CALLS = new WeakMap<FastifyRequest, ReadCall>();

const ROUTES = new Map<string, string>();
for (const o of operations as readonly CatalogOperation[]) {
  if (o.rest && (LIST_OPERATIONS[o.operation] || VOCABULARY_BEARING[o.operation]))
    ROUTES.set(`${o.rest.method.toUpperCase()} ${o.rest.path.replace(/\{(\w+)\}/g, ':$1')}`, o.operation);
}

export function registerListEnvelope(app: FastifyInstance): void {
  app.addHook('onRoute', (r: RouteOptions) => {
    const method = [r.method].flat()[0];
    const operation = ROUTES.get(`${String(method).toUpperCase()} ${r.url}`);
    if (!operation) return;
    const spec = LIST_OPERATIONS[operation];
    const handler = r.handler;
    r.handler = function readHandler(this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
      const scope = newListScope();
      CALLS.set(request, { operation, spec, asOf: new Date(), scope });
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
    const listed = call.spec
      ? attachListEnvelope(call.spec, payload, {
          asOf: call.asOf,
          filters,
          locationRefs: call.scope.locationRefs,
        })
      : payload;
    return attachVocabularyVersions(call.operation, listed);
  });
}
