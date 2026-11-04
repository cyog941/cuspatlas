import type { RouteContract } from './manifest';

const C = (name: string) => `clinical:${name}`;
const COMMAND = ['400', '401', '403', '404', '409', '422', '503'] as const;
const READ = ['401', '403', '404', '503'] as const;

/**
 * Route contracts of the clinical service (C5 encounters and authorship), spread into ROUTES so the
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
];
