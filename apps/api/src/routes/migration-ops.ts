import type { ActorContext, CommandEnvelope } from '@cuspatlas/contracts';
import type { ActionName, MigrationService } from '@cuspatlas/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Authenticator, authenticateOnRequest, requireActor } from '../auth';
import type { RouteContract } from './manifest';
import type { OpInput } from './scheduling-ops';

/**
 * One table for the workstream M operations (M2-M6): the REST route contract, the MCP tool name and
 * the call into the shared migration service. REST registration, the MCP tools
 * (apps/mcp/src/tools/migration-ops.ts), the generated OpenAPI block and the drift checks derive from
 * it, so an operation cannot exist on one surface only. No migration route takes a path parameter:
 * every reference travels in the validated body or query, and the tenant always comes from the token.
 */
export interface MigrationOp extends RouteContract {
  readonly operationId: ActionName;
  readonly tool: string;
  readonly description: string;
  /** GET only: the migration.schema.json definition of the query object. */
  readonly query?: string;
  invoke(svc: MigrationService, actor: ActorContext, input: OpInput): Promise<unknown>;
}

const M = (name: string) => `migration:${name}`;
const COMMAND = ['400', '401', '403', '404', '409', '422', '503'] as const;
const READ = ['400', '401', '403', '404', '503'] as const;

const env = (operation: string, input: OpInput): CommandEnvelope<unknown> => ({
  operation,
  idempotencyKey: input.key,
  payload: input.body,
});
const data = async (p: Promise<unknown>) => ({ data: await p });

export const MIGRATION_OPS: MigrationOp[] = [
  {
    method: 'post',
    path: '/v1/migration/source-profiles',
    operationId: 'migration.sourceProfiles.register',
    protected: true,
    requestBody: M('SourceProfileRegister'),
    success: { status: '201', schema: M('SourceProfileResult') },
    refusals: COMMAND,
    tool: 'migration_source_profiles_register',
    description:
      'M2: register a new version of a source profile (synthetic source system, adapter format, practice). A correction is a new version; intake must name the latest version (409 stale_profile).',
    invoke: (svc, actor, i) => svc.registerSourceProfile(actor, env('migration.sourceProfiles.register', i)),
  },
  {
    method: 'post',
    path: '/v1/migration/packages',
    operationId: 'migration.packages.intake',
    protected: true,
    requestBody: M('PackageIntake'),
    success: { status: '201', schema: M('PackageIntakeResult') },
    refusals: COMMAND,
    tool: 'migration_packages_intake',
    description:
      'M2: stage an authorised synthetic source package. The manifest counts and digests must match the tables; every row is staged (unknown entities unmapped, unusable identifiers flagged per row) and ambiguous fields, terminology and money are queued for staff review. The same package twice returns the same staged package. Writes no patient, clinical or billing row.',
    invoke: (svc, actor, i) => svc.intakePackage(actor, env('migration.packages.intake', i)),
  },
  {
    method: 'get',
    path: '/v1/migration/packages/state',
    operationId: 'migration.packages.read',
    protected: true,
    query: 'PackageQuery',
    success: { status: '200', schema: M('PackageState') },
    refusals: READ,
    tool: 'migration_packages_read',
    description:
      'M2: staging state of one package: per-entity staged and flagged counts, open review items, cutover state.',
    invoke: (svc, actor, i) => data(svc.readPackage(actor, i.body)),
  },
  {
    method: 'get',
    path: '/v1/migration/review-items',
    operationId: 'migration.reviewItems.list',
    protected: true,
    query: 'ReviewItemListQuery',
    success: { status: '200', schema: M('ReviewItemList') },
    refusals: READ,
    tool: 'migration_review_items_list',
    description:
      'M2: the staff review queue of one package (unknown fields and entities, legacy terminology, ambiguous money, unusable identifiers, identity candidates, future appointments) with the adapter proposal and the decisions each item allows.',
    invoke: (svc, actor, i) => data(svc.listReviewItems(actor, i.body)),
  },
  {
    method: 'post',
    path: '/v1/migration/review-items/resolve',
    operationId: 'migration.reviewItems.resolve',
    protected: true,
    requestBody: M('ReviewItemResolve'),
    success: { status: '200', schema: M('ReviewItemResolveResult') },
    refusals: COMMAND,
    tool: 'migration_review_items_resolve',
    description:
      'M2/M4: record a staff decision on one review item (exclude, archive only, accept the proposal, or an identity decision). Resolved once; any decision invalidates an earlier reconciliation sign-off.',
    invoke: (svc, actor, i) => svc.resolveReviewItem(actor, env('migration.reviewItems.resolve', i)),
  },
];

export const MIGRATION_OP_ROUTES = (): RouteContract[] =>
  MIGRATION_OPS.map(({ method, path, operationId, protected: p, requestBody, success, refusals }) => ({
    method,
    path,
    operationId,
    protected: p,
    ...(requestBody ? { requestBody } : {}),
    success,
    refusals,
  }));

/** Registers every MIGRATION_OPS route; authentication in `onRequest`, no tenant read from input. */
export function registerMigrationOpRoutes(
  app: FastifyInstance,
  deps: { authenticator: Authenticator; migration: MigrationService },
): void {
  for (const op of MIGRATION_OPS) {
    const input = (request: FastifyRequest): OpInput => {
      const key = request.headers['idempotency-key'];
      return {
        params: {},
        body: op.method === 'get' ? { ...(request.query as object) } : request.body,
        key: typeof key === 'string' ? key : '',
      };
    };
    const opts = { onRequest: authenticateOnRequest(deps.authenticator, op.operationId) };
    if (op.method === 'get') {
      app.get(op.path, opts, async (request) =>
        op.invoke(deps.migration, requireActor(request), input(request)),
      );
    } else {
      app.post(op.path, opts, async (request, reply) =>
        reply
          .code(op.success.status === '201' ? 201 : 200)
          .send(await op.invoke(deps.migration, requireActor(request), input(request))),
      );
    }
  }
}
