import type { ActorContext, CommandEnvelope } from '@cuspatlas/contracts';
import type { ActionName, EngagementService } from '@cuspatlas/domain';
import type { RouteContract } from './manifest';
import type { OpInput } from './scheduling-ops';

/**
 * One table for the workstream E staff operations (E1-E7): the REST route contract, the MCP tool
 * name and the call into the shared engagement service. REST registration, the MCP tool list, the
 * drift checks and the E negative harness are derived from it, so a staff operation cannot exist on
 * one surface only. Portal-audience operations live in portal.ts and are never MCP tools.
 */
export interface EngagementOp extends RouteContract {
  readonly operationId: ActionName;
  readonly tool: string;
  readonly description: string;
  /** GET only: the engagement.schema.json definition of the query object. */
  readonly query?: string;
  invoke(svc: EngagementService, actor: ActorContext, input: OpInput): Promise<unknown>;
}

const E = (name: string) => `engagement:${name}`;
const COMMAND = ['400', '401', '403', '404', '409', '422', '503'] as const;
const READ = ['400', '401', '403', '404', '503'] as const;

const env = (operation: string, input: OpInput): CommandEnvelope<unknown> => ({
  operation,
  idempotencyKey: input.key,
  payload: input.body,
});
const param = (input: OpInput, name: string) => input.params[name] ?? '';
const data = async (p: Promise<unknown>) => ({ data: await p });
const PRINCIPAL = '/v1/portal/principals/{principalRef}';

export const ENGAGEMENT_OPS: readonly EngagementOp[] = [
  // E1 portal principals (staff side) and the S5 grant projection.
  {
    method: 'post',
    path: '/v1/portal/principals',
    operationId: 'portal.principals.enroll',
    protected: true,
    requestBody: E('PortalEnroll'),
    success: { status: '201', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'portal_principals_enroll',
    description:
      'Enroll a portal principal bound to exactly one person record, invited through a contact already on that record. A contact shared with another identity is refused (shared_contact_ambiguous). The principal is pending until verified; proofing level unverified-synthetic (E-S3 open).',
    invoke: (svc, actor, i) => svc.enrollPortalPrincipal(actor, env('portal.principals.enroll', i)),
  },
  {
    method: 'post',
    path: `${PRINCIPAL}/verify`,
    operationId: 'portal.principals.verify',
    protected: true,
    requestBody: E('PortalVerify'),
    success: { status: '200', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'portal_principals_verify',
    description:
      'Record the (synthetic, staff-attested) contact verification of a pending portal principal; it becomes active. Human staff only.',
    invoke: (svc, actor, i) =>
      svc.verifyPortalPrincipal(actor, param(i, 'principalRef'), env('portal.principals.verify', i)),
  },
  {
    method: 'post',
    path: `${PRINCIPAL}/revoke`,
    operationId: 'portal.principals.revoke',
    protected: true,
    requestBody: E('PortalRevoke'),
    success: { status: '200', schema: E('EngagementCommandResult') },
    refusals: COMMAND,
    tool: 'portal_principals_revoke',
    description: 'Revoke a portal principal; its existing sessions are denied at their next request. Final.',
    invoke: (svc, actor, i) =>
      svc.revokePortalPrincipal(actor, param(i, 'principalRef'), env('portal.principals.revoke', i)),
  },
  {
    method: 'get',
    path: PRINCIPAL,
    operationId: 'portal.principals.read',
    protected: true,
    success: { status: '200', schema: E('EngagementRead') },
    refusals: ['401', '403', '404', '503'],
    tool: 'portal_principals_get',
    description:
      'One portal principal: person binding, state, proofing level and contact channel (never the value).',
    invoke: (svc, actor, i) => data(svc.readPortalPrincipal(actor, param(i, 'principalRef'))),
  },
  {
    method: 'get',
    path: '/v1/patients/{patientRef}/portal-grants',
    operationId: 'portal.grants.list',
    protected: true,
    query: 'EmptyQuery',
    success: { status: '200', schema: E('EngagementRead') },
    refusals: READ,
    tool: 'portal_grants_list',
    description:
      'Portal grants of a patient: its S5 relationships projected with their current status (grantRef = relationshipRef), plus the portal principals of the people involved.',
    invoke: (svc, actor, i) => data(svc.listPortalGrants(actor, param(i, 'patientRef'), i.body)),
  },
];

export const ENGAGEMENT_OP_ROUTES: readonly RouteContract[] = ENGAGEMENT_OPS.map((o) => ({
  method: o.method,
  path: o.path,
  operationId: o.operationId,
  protected: o.protected,
  ...(o.requestBody ? { requestBody: o.requestBody } : {}),
  success: o.success,
  refusals: o.refusals,
}));
