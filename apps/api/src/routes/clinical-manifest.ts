import type { RouteContract } from './manifest';

const C = (name: string) => `clinical:${name}`;
const COMMAND = ['400', '401', '403', '404', '409', '422', '503'] as const;
const READ = ['401', '403', '404', '503'] as const;

/**
 * Route contracts of the clinical service (C5 encounters and authorship, C8 medical history), spread into ROUTES so the
 * drift check and route registration see one table. Clinical semantics are
 * recommended-pending-clinical-approval; synthetic data only.
 */
export const CLINICAL_ROUTES: readonly RouteContract[] = [
  {
    method: 'post',
    path: '/v1/clinical/authors',
    operationId: 'clinical.authors.define',
    protected: true,
    requestBody: C('ClinicalAuthorDefine'),
    success: { status: '201', schema: C('ClinicalAuthorCommandResult') },
    refusals: COMMAND,
  },
  {
    method: 'get',
    path: '/v1/clinical/author-context',
    operationId: 'clinical.authors.context',
    protected: true,
    success: { status: '200', schema: C('AuthorContext') },
    refusals: ['401', '403', '503'],
  },
  {
    method: 'post',
    path: '/v1/clinical/encounters',
    operationId: 'clinical.encounters.open',
    protected: true,
    requestBody: C('EncounterOpen'),
    success: { status: '201', schema: C('EncounterOpenResult') },
    refusals: COMMAND,
  },
  {
    method: 'get',
    path: '/v1/clinical/encounters/{encounterRef}',
    operationId: 'clinical.encounters.read',
    protected: true,
    success: { status: '200', schema: C('EncounterRead') },
    refusals: READ,
  },
  {
    method: 'post',
    path: '/v1/clinical/encounters/{encounterRef}/assignments',
    operationId: 'clinical.encounters.assign',
    protected: true,
    requestBody: C('EncounterAssign'),
    success: { status: '201', schema: C('EncounterCommandResult') },
    refusals: COMMAND,
  },
  {
    method: 'post',
    path: '/v1/clinical/encounters/{encounterRef}/close',
    operationId: 'clinical.encounters.close',
    protected: true,
    requestBody: C('EncounterClose'),
    success: { status: '200', schema: C('EncounterCommandResult') },
    refusals: COMMAND,
  },
  {
    method: 'get',
    path: '/v1/clinical/patients/{patientRef}/encounters',
    operationId: 'clinical.encounters.list',
    protected: true,
    success: { status: '200', schema: C('EncounterList') },
    refusals: ['400', '401', '403', '404', '503'],
  },
  // C8 medical history, allergies and medications.
  {
    method: 'post',
    path: '/v1/clinical/history/changes',
    operationId: 'clinical.history.recordChange',
    protected: true,
    requestBody: C('HistoryChangeRecord'),
    success: { status: '201', schema: C('HistoryVersionCommandResult') },
    refusals: COMMAND,
  },
  {
    method: 'get',
    path: '/v1/clinical/patients/{patientRef}/history',
    operationId: 'clinical.history.read',
    protected: true,
    success: { status: '200', schema: C('HistoryRead') },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
  },
  {
    method: 'get',
    path: '/v1/clinical/history/versions/{historyVersionRef}',
    operationId: 'clinical.history.readVersion',
    protected: true,
    success: { status: '200', schema: C('HistoryVersionRead') },
    refusals: READ,
  },
  {
    method: 'get',
    path: '/v1/clinical/patients/{patientRef}/alerts',
    operationId: 'clinical.history.alerts',
    protected: true,
    success: { status: '200', schema: C('ActiveAlerts') },
    refusals: ['401', '403', '404', '409', '503'],
  },
  {
    method: 'post',
    path: '/v1/clinical/history/items/{itemRef}/verifications',
    operationId: 'clinical.history.verifyItem',
    protected: true,
    requestBody: C('HistoryVerify'),
    success: { status: '201', schema: C('HistoryItemCommandResult') },
    refusals: COMMAND,
  },
  {
    method: 'post',
    path: '/v1/clinical/encounters/{encounterRef}/history-reviews',
    operationId: 'clinical.history.attestReview',
    protected: true,
    requestBody: C('HistoryReviewAttest'),
    success: { status: '201', schema: C('HistoryReviewCommandResult') },
    refusals: COMMAND,
  },
];
