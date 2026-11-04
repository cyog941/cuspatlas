import type { RouteContract } from './manifest';

const S = (name: string) => `scheduling:${name}`;
const COMMAND = ['400', '401', '403', '404', '409', '422', '503'] as const;

/**
 * Route contracts of the appointment service (S8 requests; S10 booking; S11 attendance), spread
 * into ROUTES so the drift check and route registration see one table.
 */
export const APPOINTMENT_ROUTES: readonly RouteContract[] = [
  // S8 appointment requests (a separate fact; holds no resource).
  {
    method: 'post',
    path: '/v1/scheduling/appointment-requests',
    operationId: 'scheduling.requests.create',
    protected: true,
    requestBody: S('AppointmentRequestCreate'),
    success: { status: '201', schema: S('AppointmentRequestCommandResult') },
    refusals: COMMAND,
  },
  {
    method: 'get',
    path: '/v1/scheduling/appointment-requests',
    operationId: 'scheduling.requests.list',
    protected: true,
    success: { status: '200', schema: S('AppointmentRequestList') },
    refusals: ['400', '401', '403', '503'],
  },
  {
    method: 'get',
    path: '/v1/scheduling/appointment-requests/{requestRef}',
    operationId: 'scheduling.requests.read',
    protected: true,
    success: { status: '200', schema: S('AppointmentRequestRead') },
    refusals: ['401', '403', '404', '503'],
  },
  {
    method: 'post',
    path: '/v1/scheduling/appointment-requests/{requestRef}/preferences',
    operationId: 'scheduling.requests.updatePreferences',
    protected: true,
    requestBody: S('AppointmentRequestPreferences'),
    success: { status: '200', schema: S('AppointmentRequestCommandResult') },
    refusals: COMMAND,
  },
  {
    method: 'post',
    path: '/v1/scheduling/appointment-requests/{requestRef}/review',
    operationId: 'scheduling.requests.review',
    protected: true,
    requestBody: S('AppointmentRequestReview'),
    success: { status: '200', schema: S('AppointmentRequestCommandResult') },
    refusals: ['400', '401', '403', '404', '409', '503'],
  },
  {
    method: 'post',
    path: '/v1/scheduling/appointment-requests/{requestRef}/close',
    operationId: 'scheduling.requests.close',
    protected: true,
    requestBody: S('AppointmentRequestClose'),
    success: { status: '200', schema: S('AppointmentRequestCommandResult') },
    refusals: COMMAND,
  },
  {
    method: 'post',
    path: '/v1/scheduling/appointment-requests/{requestRef}/reopen',
    operationId: 'scheduling.requests.reopen',
    protected: true,
    requestBody: S('AppointmentRequestReopen'),
    success: { status: '200', schema: S('AppointmentRequestCommandResult') },
    refusals: ['400', '401', '403', '404', '409', '503'],
  },
  {
    method: 'get',
    path: '/v1/scheduling/reports/unbooked-requests',
    operationId: 'scheduling.requests.unbookedReport',
    protected: true,
    success: { status: '200', schema: S('UnbookedRequestReport') },
    refusals: ['401', '403', '503'],
  },
];
