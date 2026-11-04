import type { RouteContract } from './manifest';

const C = (name: string) => `clinical:${name}`;
const COMMAND = ['400', '401', '403', '404', '409', '422', '503'] as const;
const QUERY = ['400', '401', '403', '404', '409', '422', '503'] as const;

/**
 * Route contracts of the structured clinical record (workstream C batch 2a: C6 chart, C7 periodontal
 * charting, C11 treatment plans), spread into ROUTES so the drift check and route registration see
 * one table. Semantics are recommended-pending-clinical-approval; synthetic data only.
 */
export const CLINICAL_RECORD_ROUTES: readonly RouteContract[] = [
  // C6 structured chart.
  {
    method: 'post',
    path: '/v1/clinical/chart/entries',
    operationId: 'clinical.chart.recordEntry',
    protected: true,
    requestBody: C('ChartEntryRecord'),
    success: { status: '201', schema: C('ChartEntryCommandResult') },
    refusals: COMMAND,
  },
  {
    method: 'post',
    path: '/v1/clinical/chart/entries/{chartEntryRef}/corrections',
    operationId: 'clinical.chart.correctEntry',
    protected: true,
    requestBody: C('ChartEntryCorrect'),
    success: { status: '201', schema: C('ChartCorrectionResult') },
    refusals: COMMAND,
  },
  {
    method: 'get',
    path: '/v1/clinical/patients/{patientRef}/chart',
    operationId: 'clinical.chart.read',
    protected: true,
    success: { status: '200', schema: C('ChartRead') },
    refusals: QUERY,
  },
  // C7 periodontal exams.
  {
    method: 'post',
    path: '/v1/clinical/perio/exams',
    operationId: 'clinical.perio.recordExam',
    protected: true,
    requestBody: C('PerioExamRecord'),
    success: { status: '201', schema: C('PerioExamCommandResult') },
    refusals: COMMAND,
  },
  {
    method: 'post',
    path: '/v1/clinical/perio/exams/{perioExamRef}/corrections',
    operationId: 'clinical.perio.correctExam',
    protected: true,
    requestBody: C('PerioExamCorrect'),
    success: { status: '201', schema: C('PerioExamCommandResult') },
    refusals: COMMAND,
  },
  {
    method: 'post',
    path: '/v1/clinical/perio/exams/{perioExamRef}/derivations',
    operationId: 'clinical.perio.derive',
    protected: true,
    requestBody: C('PerioDerive'),
    success: { status: '201', schema: C('PerioDerivationCommandResult') },
    refusals: COMMAND,
  },
  {
    method: 'get',
    path: '/v1/clinical/perio/exams/{perioExamRef}',
    operationId: 'clinical.perio.readExam',
    protected: true,
    success: { status: '200', schema: C('PerioExamRead') },
    refusals: ['401', '403', '404', '503'],
  },
  {
    method: 'get',
    path: '/v1/clinical/patients/{patientRef}/perio-exams',
    operationId: 'clinical.perio.listExams',
    protected: true,
    success: { status: '200', schema: C('PerioExamList') },
    refusals: ['401', '403', '404', '409', '503'],
  },
  {
    method: 'get',
    path: '/v1/clinical/perio/comparisons',
    operationId: 'clinical.perio.compare',
    protected: true,
    success: { status: '200', schema: C('PerioComparison') },
    refusals: QUERY,
  },
];
