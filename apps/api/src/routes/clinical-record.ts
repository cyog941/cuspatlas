import type { ClinicalService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { routeFor } from './manifest';

/** The Idempotency-Key, validated by the domain after authorization (the scheduling-route pattern). */
function key(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  return typeof raw === 'string' ? raw : '';
}

type Handler = (request: FastifyRequest) => Promise<unknown>;

/**
 * Thin REST adapter for the structured clinical record (C6 chart, C7 periodontal charting, C11
 * treatment plans). Authentication runs in `onRequest`; no tenant is read from the path, query,
 * headers or body. Refusals are thrown and mapped centrally, never 2xx.
 */
export function registerClinicalRecordRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; clinical: ClinicalService },
): void {
  const c = deps.clinical;
  const mount = (operationId: string, handler: Handler) => {
    const r = routeFor(operationId);
    const opts = { onRequest: authenticateOnRequest(deps.authenticator, r.operationId) };
    if (r.method === 'get') {
      app.get(r.fastifyPath, opts, async (request) => handler(request));
    } else {
      app.post(r.fastifyPath, opts, async (request, reply) =>
        reply.code(Number(r.success.status)).send(await handler(request)),
      );
    }
  };
  const env = (operation: string, request: FastifyRequest) => ({
    operation,
    idempotencyKey: key(request),
    payload: request.body,
  });
  const param = (request: FastifyRequest, name: string) =>
    (request.params as Record<string, string>)[name] ?? '';
  const query = (request: FastifyRequest) => ({ ...(request.query as object) });

  // C6 chart.
  mount('clinical.chart.recordEntry', (r) =>
    c.recordChartEntry(requireActor(r), env('clinical.chart.recordEntry', r)),
  );
  mount('clinical.chart.correctEntry', (r) =>
    c.correctChartEntry(requireActor(r), param(r, 'chartEntryRef'), env('clinical.chart.correctEntry', r)),
  );
  mount('clinical.chart.read', async (r) => ({
    data: await c.readChart(requireActor(r), param(r, 'patientRef'), query(r)),
  }));
}
