import { createEngagementBase, type EngagementDeps } from './common';
import { createConsentOperations } from './communications/consent';
import { createDeliveryOperations } from './communications/deliveries';
import { createRecallEnrollmentOperations } from './communications/recall-enrollment';
import { createIntakeOperations } from './intake/forms';
import { createPortalOfferOperations } from './portal/offers';
import { createPortalPrincipalOperations } from './portal/principals';
import { createPortalRequestOperations } from './portal/requests';
import { createPortalSessionOperations } from './portal/session';
import { createPortalViewOperations } from './portal/views';

/**
 * The engagement domain (workstream E: portal and communications). REST (staff and portal
 * transports), MCP (staff operations) and the messaging worker call only these functions; none of
 * them takes a tenant from its input. Portal operations take a portal-principal context and authorize
 * through S5 relationships; staff operations go through the shared action policy table.
 */
export function createEngagementService(deps: EngagementDeps) {
  const base = createEngagementBase(deps);
  return {
    ...createPortalPrincipalOperations(base),
    ...createPortalSessionOperations(base),
    ...createPortalViewOperations(base),
    ...createPortalRequestOperations(base),
    ...createPortalOfferOperations(base),
    ...createConsentOperations(base),
    ...createRecallEnrollmentOperations(base),
    ...createDeliveryOperations(base),
    ...createIntakeOperations(base),
  };
}

export type EngagementService = ReturnType<typeof createEngagementService>;
