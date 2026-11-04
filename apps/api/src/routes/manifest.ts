import { APPOINTMENT_ROUTES } from './appointment-manifest';
import { BILLING_ROUTES } from './billing-manifest';
import { BILLING_OP_ROUTES } from './billing-ops';
import { CLINICAL_ROUTES } from './clinical-manifest';
import { CLINICAL_RECORD_ROUTES } from './clinical-record-manifest';
import { SCHEDULING_OP_ROUTES } from './scheduling-ops';

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
   * `patient:<name>` for patient.schema.json, `scheduling:<name>` for scheduling.schema.json,
   * `billing:<name>` for billing.schema.json, `clinical:<name>` for clinical.schema.json, or a
   * local `#/components/schemas/<name>`.
   */
  readonly requestBody?: string;
  readonly success: { readonly status: '200' | '201'; readonly schema: string };
  /** Documented refusal statuses (all use the shared Refusal schema). */
  readonly refusals: readonly string[];
}

export const SCHEMA_FILE = 'synthetic-task.schema.json';
export const PROPOSAL_SCHEMA_FILE = 'action-proposal.schema.json';
export const PATIENT_SCHEMA_FILE = 'patient.schema.json';
export const SCHEDULING_SCHEMA_FILE = 'scheduling.schema.json';
export const BILLING_SCHEMA_FILE = 'billing.schema.json';
export const CLINICAL_SCHEMA_FILE = 'clinical.schema.json';

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
  // S4 patient identity.
  {
    method: 'post',
    path: '/v1/patients',
    operationId: 'patients.create',
    protected: true,
    requestBody: 'patient:PatientCreate',
    success: { status: '201', schema: 'patient:PatientCommandResult' },
    refusals: ['400', '401', '403', '409', '422', '503'],
  },
  {
    method: 'post',
    path: '/v1/patients/search',
    operationId: 'patients.search',
    protected: true,
    requestBody: 'patient:PatientSearch',
    success: { status: '200', schema: 'patient:PatientSummaryPage' },
    refusals: ['400', '401', '403', '503'],
  },
  {
    method: 'get',
    path: '/v1/patients/{patientRef}',
    operationId: 'patients.read',
    protected: true,
    success: { status: '200', schema: 'patient:PatientRead' },
    refusals: ['400', '401', '403', '404', '409', '503'],
  },
  {
    method: 'post',
    path: '/v1/patients/{patientRef}/demographics',
    operationId: 'patients.updateDemographics',
    protected: true,
    requestBody: 'patient:PatientDemographicsUpdate',
    success: { status: '200', schema: 'patient:PatientCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
  },
  {
    method: 'post',
    path: '/v1/patients/{patientRef}/status',
    operationId: 'patients.setStatus',
    protected: true,
    requestBody: 'patient:PatientStatusChange',
    success: { status: '200', schema: 'patient:PatientCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
  },
  // S5 relationships.
  {
    method: 'post',
    path: '/v1/patients/{patientRef}/relationships',
    operationId: 'patients.relationships.add',
    protected: true,
    requestBody: 'patient:RelationshipCreate',
    success: { status: '201', schema: 'patient:RelationshipCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
  },
  {
    method: 'get',
    path: '/v1/patients/{patientRef}/relationships',
    operationId: 'patients.relationships.list',
    protected: true,
    success: { status: '200', schema: 'patient:RelationshipList' },
    refusals: ['400', '401', '403', '404', '503'],
  },
  {
    method: 'post',
    path: '/v1/patients/{patientRef}/relationships/{relationshipRef}/revoke',
    operationId: 'patients.relationships.revoke',
    protected: true,
    requestBody: 'patient:RelationshipRevoke',
    success: { status: '200', schema: 'patient:RelationshipCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '503'],
  },
  {
    method: 'get',
    path: '/v1/patients/{patientRef}/access',
    operationId: 'patients.access.resolve',
    protected: true,
    success: { status: '200', schema: 'patient:PatientAccessRead' },
    refusals: ['400', '401', '403', '404', '503'],
  },
  // S6 duplicate review, merge and unmerge.
  {
    method: 'get',
    path: '/v1/patients/{patientRef}/duplicate-candidates',
    operationId: 'patients.duplicates.find',
    protected: true,
    success: { status: '200', schema: 'patient:DuplicateCandidateList' },
    refusals: ['400', '401', '403', '404', '409', '503'],
  },
  {
    method: 'post',
    path: '/v1/patients/merges',
    operationId: 'patients.merge',
    protected: true,
    requestBody: 'patient:MergeRequest',
    success: { status: '201', schema: 'patient:MergeCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
  },
  {
    method: 'post',
    path: '/v1/patients/merges/{mergeRef}/unmerge',
    operationId: 'patients.unmerge',
    protected: true,
    requestBody: 'patient:UnmergeRequest',
    success: { status: '200', schema: 'patient:MergeCommandResult' },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
  },
  {
    method: 'get',
    path: '/v1/patients/{patientRef}/merge-history',
    operationId: 'patients.merges.list',
    protected: true,
    success: { status: '200', schema: 'patient:MergeHistory' },
    refusals: ['400', '401', '403', '404', '503'],
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
  // S9: read-only availability search (POST because the query is a structured body).
  {
    method: 'post',
    path: '/v1/availability/search',
    operationId: 'scheduling.availability.search',
    protected: true,
    requestBody: 'scheduling:AvailabilitySearch',
    success: { status: '200', schema: 'scheduling:AvailabilitySearchResult' },
    refusals: ['400', '401', '403', '404', '422', '503'],
  },
  ...APPOINTMENT_ROUTES,
  ...BILLING_ROUTES,
  ...BILLING_OP_ROUTES(),
  ...CLINICAL_ROUTES,
  ...CLINICAL_RECORD_ROUTES,
  ...SCHEDULING_OP_ROUTES,
];

export function routeFor(operationId: string): RouteContract & { fastifyPath: string } {
  const r = ROUTES.find((x) => x.operationId === operationId);
  if (!r) throw new Error(`no route contract for ${operationId}`);
  return { ...r, fastifyPath: r.path.replace(/\{(\w+)\}/g, ':$1') };
}
