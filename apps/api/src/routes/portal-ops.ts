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
