import type { BillingService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { routeFor } from './manifest';

/** The Idempotency-Key, validated by the domain after authorization (the scheduling-route pattern). */
function key(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  return typeof raw === 'string' ? raw : '';
}

/**
 * Thin REST adapter for the billing service. Authentication runs in `onRequest`; no tenant is read
 * from the path, query, headers or body; every refusal is thrown by the domain and mapped centrally
 * (never a 2xx with a failed outcome).
 */
export function registerBillingRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; billing: BillingService },
): void {
  const b = deps.billing;
  const on = (operationId: string) => ({ onRequest: authenticateOnRequest(deps.authenticator, operationId) });
  const param = (request: FastifyRequest, name: string) =>
    (request.params as Record<string, string>)[name] ?? '';
  const env = (operation: string, request: FastifyRequest) => ({
    operation,
    idempotencyKey: key(request),
    payload: request.body,
  });
  const post = (operationId: string, run: (r: FastifyRequest) => Promise<unknown>) => {
    const r = routeFor(operationId);
    app.post(r.fastifyPath, on(operationId), async (request, reply) =>
      reply.code(Number(r.success.status)).send(await run(request)),
    );
  };
  const get = (operationId: string, run: (r: FastifyRequest) => Promise<unknown>) => {
    const r = routeFor(operationId);
    app.get(r.fastifyPath, on(operationId), async (request) => run(request));
  };
  const query = (r: FastifyRequest) => ({ ...(r.query as object) });

  post('billing.charges.post', (r) => b.postCharge(requireActor(r), env('billing.charges.post', r)));
  get('billing.charges.read', async (r) => ({
    data: await b.getCharge(requireActor(r), param(r, 'chargeRef')),
  }));
  get('billing.entries.read', async (r) => ({
    data: await b.getEntry(requireActor(r), param(r, 'entryRef')),
  }));
  post('billing.entries.reverse', (r) =>
    b.reverseEntry(requireActor(r), param(r, 'entryRef'), env('billing.entries.reverse', r)),
  );
  get('billing.ledger.list', (r) => b.listLedger(requireActor(r), param(r, 'patientRef'), query(r)));
  get('billing.balances.read', async (r) => ({
    data: await b.readBalance(requireActor(r), param(r, 'patientRef'), query(r)),
  }));
  // B2.
  post('billing.payments.record', (r) => b.recordPayment(requireActor(r), env('billing.payments.record', r)));
  get('billing.payments.read', async (r) => ({
    data: await b.getPayment(requireActor(r), param(r, 'paymentRef')),
  }));
  post('billing.payments.settle', (r) =>
    b.settlePayment(requireActor(r), param(r, 'paymentRef'), env('billing.payments.settle', r)),
  );
  post('billing.payments.allocate', (r) =>
    b.allocatePayment(requireActor(r), param(r, 'paymentRef'), env('billing.payments.allocate', r)),
  );
  post('billing.payments.refund', (r) =>
    b.refundPayment(requireActor(r), param(r, 'paymentRef'), env('billing.payments.refund', r)),
  );
  post('billing.funds.transfer', (r) =>
    b.transferFunds(requireActor(r), param(r, 'paymentRef'), env('billing.funds.transfer', r)),
  );
  post('billing.responsibility.transfer', (r) =>
    b.transferResponsibility(
      requireActor(r),
      param(r, 'chargeRef'),
      env('billing.responsibility.transfer', r),
    ),
  );
  post('billing.payments.reconcile', (r) =>
    b.reconcileAttempt(requireActor(r), param(r, 'attemptRef'), env('billing.payments.reconcile', r)),
  );
  get('billing.worklist.list', (r) => b.listWorklist(requireActor(r), query(r)));
}
