import type { ActorContext } from '@cuspatlas/contracts';
import type { EngagementService } from '@cuspatlas/domain';
import type { RouteContract } from './manifest';
import type { OpInput } from './scheduling-ops';

/**
 * The portal transport (E1-E3, E6): patient, guardian and proxy routes under /portal/v1, served
 * only to tokens of the portal audience and to live portal principals. A staff token is refused here
 * (audience), a portal token is refused by every staff route and by MCP (audience), and the portal
 * context carries no staff scope. These are not MCP tools: MCP is a staff and agent surface.
 */
export interface PortalOp extends RouteContract {
  readonly query?: string;
  invoke(svc: EngagementService, actor: ActorContext, input: OpInput): Promise<unknown>;
}

const E = (name: string) => `engagement:${name}`;
const data = async (p: Promise<unknown>) => ({ data: await p });

export const PORTAL_OPS: readonly PortalOp[] = [
  {
    method: 'get',
    path: '/portal/v1/session',
    operationId: 'portal.session.read',
    protected: true,
    query: 'EmptyQuery',
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['400', '401', '403', '503'],
    invoke: (svc, actor, i) => data(svc.readPortalSession(actor, i.body)),
  },
  // E2 scoped views: allowlist projections, explicit unavailable coverage, sensitive-read logged.
  {
    method: 'get',
    path: '/portal/v1/patients/{patientRef}/views/{view}',
    operationId: 'portal.views.read',
    protected: true,
    query: 'EmptyQuery',
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['400', '401', '403', '404', '503'],
    invoke: (svc, actor, i) =>
      data(svc.readPortalView(actor, i.params.patientRef ?? '', i.params.view ?? '', i.body)),
  },
  // E3 appointment requests: S8's own create command with origin portal (never a booking).
  {
    method: 'post',
    path: '/portal/v1/patients/{patientRef}/appointment-requests',
    operationId: 'portal.requests.submit',
    protected: true,
    requestBody: E('PortalRequestSubmit'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: ['400', '401', '403', '404', '409', '422', '429', '503'],
    invoke: (svc, actor, i) =>
      svc.submitPortalRequest(actor, i.params.patientRef ?? '', {
        operation: 'portal.requests.submit',
        idempotencyKey: i.key,
        payload: i.body,
      }),
  },
  // S15 seam: the patient or a guardian holding scheduling answers a waitlist offer (never a service).
  {
    method: 'post',
    path: '/portal/v1/patients/{patientRef}/waitlist-offers/{offerRef}/respond',
    operationId: 'portal.offers.respond',
    protected: true,
    requestBody: E('PortalOfferRespond'),
    success: { status: '200', schema: E('EngagementCommandResult') },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
    invoke: (svc, actor, i) =>
      svc.respondToPortalOffer(actor, i.params.patientRef ?? '', i.params.offerRef ?? '', {
        operation: 'portal.offers.respond',
        idempotencyKey: i.key,
        payload: i.body,
      }),
  },
  // E4 intake forms through the portal (self, or a relationship holding demographics and consent).
  {
    method: 'get',
    path: '/portal/v1/forms/{formRef}',
    operationId: 'portal.forms.describe',
    protected: true,
    query: 'EmptyQuery',
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['400', '401', '403', '404', '503'],
    invoke: (svc, actor, i) => data(svc.describePortalForm(actor, i.params.formRef ?? '', i.body)),
  },
  {
    method: 'post',
    path: '/portal/v1/patients/{patientRef}/intake-submissions',
    operationId: 'portal.forms.submit',
    protected: true,
    requestBody: E('FormSubmissionInput'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
    invoke: (svc, actor, i) =>
      svc.submitPortalForm(actor, i.params.patientRef ?? '', {
        operation: 'portal.forms.submit',
        idempotencyKey: i.key,
        payload: i.body,
      }),
  },
  // E5 secure messaging through the portal (self, or a relationship holding consent; messages view).
  {
    method: 'post',
    path: '/portal/v1/patients/{patientRef}/message-threads',
    operationId: 'portal.threads.open',
    protected: true,
    requestBody: E('ThreadOpen'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
    invoke: (svc, actor, i) =>
      svc.openPortalThread(actor, i.params.patientRef ?? '', {
        operation: 'portal.threads.open',
        idempotencyKey: i.key,
        payload: i.body,
      }),
  },
  {
    method: 'get',
    path: '/portal/v1/patients/{patientRef}/message-threads/{threadRef}',
    operationId: 'portal.threads.read',
    protected: true,
    query: 'EmptyQuery',
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['400', '401', '403', '404', '503'],
    invoke: (svc, actor, i) =>
      data(svc.readPortalThread(actor, i.params.patientRef ?? '', i.params.threadRef ?? '', i.body)),
  },
  {
    method: 'post',
    path: '/portal/v1/patients/{patientRef}/message-threads/{threadRef}/messages',
    operationId: 'portal.threads.post',
    protected: true,
    requestBody: E('MessagePost'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
    invoke: (svc, actor, i) =>
      svc.postPortalMessage(actor, i.params.patientRef ?? '', i.params.threadRef ?? '', {
        operation: 'portal.threads.post',
        idempotencyKey: i.key,
        payload: i.body,
      }),
  },
  // E6 consent through the portal (self, or a relationship holding the consent scope).
  {
    method: 'post',
    path: '/portal/v1/patients/{patientRef}/consents',
    operationId: 'portal.consents.record',
    protected: true,
    requestBody: E('PortalConsentInput'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: ['400', '401', '403', '404', '409', '422', '503'],
    invoke: (svc, actor, i) =>
      svc.recordPortalConsent(actor, i.params.patientRef ?? '', {
        operation: 'portal.consents.record',
        idempotencyKey: i.key,
        payload: i.body,
      }),
  },
  {
    method: 'get',
    path: '/portal/v1/views/{view}',
    operationId: 'portal.views.describe',
    protected: true,
    query: 'EmptyQuery',
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['400', '401', '403', '404', '503'],
    invoke: (svc, actor, i) => data(svc.describePortalView(actor, i.params.view ?? '', i.body)),
  },
];

export const PORTAL_ROUTES: readonly RouteContract[] = PORTAL_OPS.map((o) => ({
  method: o.method,
  path: o.path,
  operationId: o.operationId,
  protected: o.protected,
  ...(o.requestBody ? { requestBody: o.requestBody } : {}),
  success: o.success,
  refusals: o.refusals,
}));
