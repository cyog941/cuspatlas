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
  /**
   * `$defs` name in synthetic-task.schema.json, `proposal:<name>` for action-proposal.schema.json,
   * `scheduling:<name>` for scheduling.schema.json, or a local `#/components/schemas/<name>`.
   */
  readonly requestBody?: string;
  readonly success: { readonly status: '200' | '201'; readonly schema: string };
  /** Documented refusal statuses (all use the shared Refusal schema). */
  readonly refusals: readonly string[];
}

export const SCHEMA_FILE = 'synthetic-task.schema.json';
export const PROPOSAL_SCHEMA_FILE = 'action-proposal.schema.json';
export const SCHEDULING_SCHEMA_FILE = 'scheduling.schema.json';

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
    refusals: ['400', '401', '403', '409', '503'],
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
  // F Task 7a: prepare / approve / commit / read over the synthetic task domain.
  {
    method: 'post',
    path: '/v1/synthetic-tasks/proposals',
    operationId: 'syntheticTasks.proposals.prepare',
    protected: true,
    requestBody: 'proposal:ProposalPrepare',
    success: { status: '201', schema: 'proposal:ProposalCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '503'],
  },
  {
    method: 'get',
    path: '/v1/synthetic-tasks/proposals/{proposalRef}',
    operationId: 'syntheticTasks.proposals.read',
    protected: true,
    success: { status: '200', schema: 'proposal:ProposalRead' },
    refusals: ['401', '403', '404', '503'],
  },
  {
    method: 'post',
    path: '/v1/synthetic-tasks/proposals/{proposalRef}/approve',
    operationId: 'syntheticTasks.proposals.approve',
    protected: true,
    requestBody: 'proposal:ProposalApprove',
    success: { status: '200', schema: 'proposal:ProposalCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '503'],
  },
  {
    method: 'post',
    path: '/v1/synthetic-tasks/proposals/{proposalRef}/commit',
    operationId: 'syntheticTasks.proposals.commit',
    protected: true,
    requestBody: 'proposal:ProposalCommit',
    success: { status: '200', schema: 'SyntheticTaskCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '503'],
  },
  // S7 scheduling resources (resources track).
  {
    method: 'post',
    path: '/v1/scheduling/locations',
    operationId: 'scheduling.locations.define',
    protected: true,
    requestBody: 'scheduling:LocationDefine',
    success: { status: '201', schema: 'scheduling:LocationCommandResult' },
    refusals: ['400', '401', '403', '409', '422', '503'],
  },
  {
    method: 'get',
    path: '/v1/scheduling/locations',
    operationId: 'scheduling.locations.list',
    protected: true,
    success: { status: '200', schema: 'scheduling:LocationList' },
    refusals: ['400', '401', '403', '503'],
  },
  {
    method: 'post',
    path: '/v1/scheduling/locations/{locationRef}/time-zone',
    operationId: 'scheduling.locations.changeTimeZone',
    protected: true,
    requestBody: 'scheduling:LocationTimeZoneChange',
    success: { status: '200', schema: 'scheduling:LocationCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
  },
  {
    method: 'post',
    path: '/v1/scheduling/resources',
    operationId: 'scheduling.resources.define',
    protected: true,
    requestBody: 'scheduling:ResourceDefine',
    success: { status: '201', schema: 'scheduling:ResourceCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
  },
  {
    method: 'get',
    path: '/v1/scheduling/resources',
    operationId: 'scheduling.resources.list',
    protected: true,
    success: { status: '200', schema: 'scheduling:ResourceList' },
    refusals: ['400', '401', '403', '503'],
  },
  {
    method: 'get',
    path: '/v1/scheduling/resources/{resourceRef}',
    operationId: 'scheduling.resources.read',
    protected: true,
    success: { status: '200', schema: 'scheduling:ResourceRead' },
    refusals: ['401', '403', '404', '503'],
  },
  {
    method: 'post',
    path: '/v1/scheduling/resources/{resourceRef}/availability',
    operationId: 'scheduling.resources.setAvailability',
    protected: true,
    requestBody: 'scheduling:AvailabilitySet',
    success: { status: '201', schema: 'scheduling:AvailabilityCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
  },
  {
    method: 'post',
    path: '/v1/scheduling/resources/{resourceRef}/deactivate',
    operationId: 'scheduling.resources.deactivate',
    protected: true,
    requestBody: 'scheduling:ResourceDeactivate',
    success: { status: '200', schema: 'scheduling:ResourceCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '503'],
  },
  {
    method: 'post',
    path: '/v1/scheduling/time-blocks',
    operationId: 'scheduling.timeBlocks.create',
    protected: true,
    requestBody: 'scheduling:TimeBlockCreate',
    success: { status: '201', schema: 'scheduling:TimeBlockCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
  },
  {
    method: 'get',
    path: '/v1/scheduling/data-quality/state-labelled-resources',
    operationId: 'scheduling.resources.dataQuality',
    protected: true,
    success: { status: '200', schema: 'scheduling:StateLabelReport' },
    refusals: ['401', '403', '503'],
  },
];

export function routeFor(operationId: string): RouteContract & { fastifyPath: string } {
  const r = ROUTES.find((x) => x.operationId === operationId);
  if (!r) throw new Error(`no route contract for ${operationId}`);
  return { ...r, fastifyPath: r.path.replace(/\{(\w+)\}/g, ':$1') };
}
