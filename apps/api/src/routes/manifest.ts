/**
 * Every HTTP operation the service implements, in OpenAPI path syntax. Routes are registered from
 * this table and the contract drift check compares it with docs/api/openapi.yaml, so the two cannot
 * silently diverge.
 */
export interface RouteContract {
  readonly method: 'get' | 'post';
  readonly path: string;
  readonly operationId: string;
  readonly protected: boolean;
  /** `$defs` name in synthetic-task.schema.json, or a local `#/components/schemas/<name>`. */
  readonly requestBody?: string;
  readonly success: { readonly status: '200' | '201'; readonly schema: string };
  /** Documented refusal statuses (all use the shared Refusal schema). */
  readonly refusals: readonly string[];
}

export const SCHEMA_FILE = 'synthetic-task.schema.json';

export const ROUTES: readonly RouteContract[] = [
  {
    method: 'get',
    path: '/healthz',
    operationId: 'health.read',
    protected: false,
    success: { status: '200', schema: '#/components/schemas/Health' },
    refusals: [],
  },
  {
    method: 'get',
    path: '/v1/session',
    operationId: 'session.read',
    protected: true,
    success: { status: '200', schema: '#/components/schemas/Session' },
    refusals: ['401', '403', '503'],
  },
  {
    method: 'post',
    path: '/v1/synthetic-tasks',
    operationId: 'syntheticTasks.create',
    protected: true,
    requestBody: 'SyntheticTaskCreate',
    success: { status: '201', schema: 'SyntheticTaskCommandResult' },
    refusals: ['400', '401', '403', '503'],
  },
  {
    method: 'get',
    path: '/v1/synthetic-tasks',
    operationId: 'syntheticTasks.list',
    protected: true,
    success: { status: '200', schema: 'SyntheticTaskList' },
    refusals: ['400', '401', '403', '503'],
  },
  {
    method: 'get',
    path: '/v1/synthetic-tasks/{taskRef}',
    operationId: 'syntheticTasks.read',
    protected: true,
    success: { status: '200', schema: 'SyntheticTaskRead' },
    refusals: ['401', '403', '404', '503'],
  },
  {
    method: 'post',
    path: '/v1/synthetic-tasks/{taskRef}/relabel',
    operationId: 'syntheticTasks.relabel',
    protected: true,
    requestBody: 'SyntheticTaskRelabel',
    success: { status: '200', schema: 'SyntheticTaskCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '503'],
  },
];

export function routeFor(operationId: string): RouteContract & { fastifyPath: string } {
  const r = ROUTES.find((x) => x.operationId === operationId);
  if (!r) throw new Error(`no route contract for ${operationId}`);
  return { ...r, fastifyPath: r.path.replace(/\{(\w+)\}/g, ':$1') };
}
