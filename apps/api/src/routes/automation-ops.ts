import type { ActorContext, CommandEnvelope } from '@cuspatlas/contracts';
import type { ActionName, AutomationService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import { type OpsBlockSpec, renderOpsBlock } from '../migration-openapi';
import type { RouteContract } from './manifest';
import type { OpInput } from './scheduling-ops';

/**
 * One table for the workstream A batch 4 operations (A14 webhooks, A15 exports): the REST route
 * contract, the MCP tool name and the call into the shared automation service. REST registration, the
 * MCP tools (apps/mcp/src/tools/automation-ops.ts), the generated OpenAPI block and the drift checks
 * derive from it. No path parameters; the tenant always comes from the token. Lists return the OR-01
 * envelope. Administration, replay and export are human only (agents never register an endpoint,
 * re-send an event or export).
 */
export interface AutomationOp extends RouteContract {
  readonly operationId: ActionName;
  readonly tool: string;
  readonly description: string;
  /** GET only: the automation.schema.json definition of the query object. */
  readonly query?: string;
  invoke(svc: AutomationService, actor: ActorContext, input: OpInput): Promise<unknown>;
}

const A = (name: string) => `automation:${name}`;
const COMMAND = ['400', '401', '403', '404', '409', '422', '503'] as const;
const READ = ['400', '401', '403', '404', '503'] as const;

const env = (operation: string, input: OpInput): CommandEnvelope<unknown> => ({
  operation,
  idempotencyKey: input.key,
  payload: input.body,
});

export const AUTOMATION_OPS: AutomationOp[] = [
  {
    method: 'get',
    path: '/v1/webhooks/event-types',
    operationId: 'webhooks.eventTypes.list',
    protected: true,
    query: 'WebhookEventTypeListQuery',
    success: { status: '200', schema: A('WebhookEventTypeList') },
    refusals: READ,
    tool: 'webhooks_event_types_list',
    description:
      'A14: the published webhook event catalog (closed, versioned, derived from outbox aggregate types), returned whole (OR-01 envelope).',
    invoke: (svc, actor, i) => svc.listWebhookEventTypes(actor, i.body),
  },
  {
    method: 'post',
    path: '/v1/webhooks/subscriptions',
    operationId: 'webhooks.subscriptions.create',
    protected: true,
    requestBody: A('WebhookSubscriptionCreate'),
    success: { status: '201', schema: A('WebhookSubscriptionCommandResult') },
    refusals: COMMAND,
    tool: 'webhooks_subscriptions_create',
    description:
      'A14: register an https endpoint on the operator allowlist for catalog event types at one event version. The endpoint guard refuses non-https, credentialed, unlisted, private, loopback, link-local and metadata destinations (422). One active subscription per endpoint and version (409). The HMAC-SHA-256 signing secret is returned once and never on a replay. Human only (webhooks.manage).',
    invoke: (svc, actor, i) => svc.createWebhookSubscription(actor, env('webhooks.subscriptions.create', i)),
  },
  {
    method: 'get',
    path: '/v1/webhooks/subscriptions',
    operationId: 'webhooks.subscriptions.list',
    protected: true,
    query: 'WebhookSubscriptionListQuery',
    success: { status: '200', schema: A('WebhookSubscriptionList') },
    refusals: READ,
    tool: 'webhooks_subscriptions_list',
    description: 'A14: subscriptions of the caller tenant, newest first (OR-01 envelope). Never a secret.',
    invoke: (svc, actor, i) => svc.listWebhookSubscriptions(actor, i.body),
  },
  {
    method: 'post',
    path: '/v1/webhooks/subscriptions/rotate-secret',
    operationId: 'webhooks.subscriptions.rotateSecret',
    protected: true,
    requestBody: A('WebhookSubscriptionRotate'),
    success: { status: '200', schema: A('WebhookSubscriptionCommandResult') },
    refusals: COMMAND,
    tool: 'webhooks_subscriptions_rotate_secret',
    description:
      'A14: mint a new signing secret (returned once); the previous one keeps verifying for a 24 h overlap during which deliveries carry both signatures. Each call mints a new secret. Human only.',
    invoke: (svc, actor, i) => svc.rotateWebhookSecret(actor, env('webhooks.subscriptions.rotateSecret', i)),
  },
  {
    method: 'post',
    path: '/v1/webhooks/subscriptions/revoke',
    operationId: 'webhooks.subscriptions.revoke',
    protected: true,
    requestBody: A('WebhookSubscriptionRevoke'),
    success: { status: '200', schema: A('WebhookSubscriptionCommandResult') },
    refusals: COMMAND,
    tool: 'webhooks_subscriptions_revoke',
    description:
      'A14: revoke a subscription; its queued deliveries are cancelled in the same transaction and nothing further is sent. Human only.',
    invoke: (svc, actor, i) => svc.revokeWebhookSubscription(actor, env('webhooks.subscriptions.revoke', i)),
  },
  {
    method: 'get',
    path: '/v1/webhooks/deliveries',
    operationId: 'webhooks.deliveries.list',
    protected: true,
    query: 'WebhookDeliveryListQuery',
    success: { status: '200', schema: A('WebhookDeliveryList') },
    refusals: READ,
    tool: 'webhooks_deliveries_list',
    description:
      'A14: the delivery log (state, attempts, last response class, guard outcome, replay link), newest first (OR-01 envelope). Bodies are never listed.',
    invoke: (svc, actor, i) => svc.listWebhookDeliveries(actor, i.body),
  },
  {
    method: 'get',
    path: '/v1/webhooks/deliveries/failures',
    operationId: 'webhooks.deliveries.failures.list',
    protected: true,
    query: 'WebhookFailureListQuery',
    success: { status: '200', schema: A('WebhookDeliveryList') },
    refusals: READ,
    tool: 'webhooks_deliveries_failures_list',
    description:
      'A14: failures worklist: dead-lettered deliveries with their attempts and last response class, deliveries waiting for a delivery adapter (adapter_not_configured) and deliveries paused by the send-time endpoint guard.',
    invoke: (svc, actor, i) => svc.listWebhookFailures(actor, i.body),
  },
  {
    method: 'post',
    path: '/v1/webhooks/deliveries/replay',
    operationId: 'webhooks.deliveries.replay',
    protected: true,
    requestBody: A('WebhookReplay'),
    success: { status: '201', schema: A('WebhookDeliveryCommandResult') },
    refusals: COMMAND,
    tool: 'webhooks_deliveries_replay',
    description:
      'A14: re-send a delivered or dead-lettered delivery as a new delivery identity with the same event identity and bytes; each attempt is signed with a fresh timestamp. Human only (webhooks.manage).',
    invoke: (svc, actor, i) => svc.replayWebhookDelivery(actor, env('webhooks.deliveries.replay', i)),
  },
];

export const AUTOMATION_OP_ROUTES = (): RouteContract[] =>
  AUTOMATION_OPS.map(({ method, path, operationId, protected: p, requestBody, success, refusals }) => ({
    method,
    path,
    operationId,
    protected: p,
    ...(requestBody ? { requestBody } : {}),
    success,
    refusals,
  }));

export const AUTOMATION_OPS_BLOCK: OpsBlockSpec = {
  begin: '  # BEGIN generated: AUTOMATION_OPS (scripts/openapi-automation.ts)',
  end: '  # END generated: AUTOMATION_OPS',
  schema: '../../packages/contracts/src/automation.schema.json',
  prefix: 'automation:',
};

export const renderAutomationOpsBlock = (defs: Parameters<typeof renderOpsBlock>[1]) =>
  renderOpsBlock(AUTOMATION_OPS, defs, AUTOMATION_OPS_BLOCK);

/** GET query object; a decimal `limit` string becomes the integer the schema expects. */
function queryOf(raw: unknown): Record<string, unknown> {
  const q: Record<string, unknown> = { ...(raw as object) };
  if (typeof q.limit === 'string' && /^[0-9]{1,4}$/.test(q.limit)) q.limit = Number(q.limit);
  return q;
}

/** Registers every AUTOMATION_OPS route; authentication in `onRequest`, no tenant read from input. */
export function registerAutomationOpRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; automation: AutomationService },
): void {
  for (const op of AUTOMATION_OPS) {
    const input = (request: FastifyRequest): OpInput => {
      const key = request.headers['idempotency-key'];
      return {
        params: {},
        body: op.method === 'get' ? queryOf(request.query) : request.body,
        key: typeof key === 'string' ? key : '',
      };
    };
    const opts = { onRequest: authenticateOnRequest(deps.authenticator, op.operationId) };
    if (op.method === 'get') {
      app.get(op.path, opts, async (request) =>
        op.invoke(deps.automation, requireActor(request), input(request)),
      );
    } else {
      app.post(op.path, opts, async (request, reply) =>
        reply
          .code(op.success.status === '201' ? 201 : 200)
          .send(await op.invoke(deps.automation, requireActor(request), input(request))),
      );
    }
  }
}
