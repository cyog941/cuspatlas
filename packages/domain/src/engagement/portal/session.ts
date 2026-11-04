import {
  type ActorContext,
  assertValid,
  ENGAGEMENT_PROPERTIES,
  type PortalGrant,
  RELATIONSHIP_SCOPES,
  type RelationshipScope,
  validateEmptyQuery,
} from '@cuspatlas/contracts';
import type { EngagementBase } from '../common';
import { loadPortalPrincipal, PORTAL_ACCESS_POLICY_VERSION, type SelfStatus, selfStatus } from './access';
import { projectGrants } from './principals';

export interface PortalSessionData {
  readonly principalRef: string;
  readonly personRef: string;
  readonly kind: 'portal';
  readonly assuranceLevel: string;
  readonly policyVersion: string;
  readonly self: SelfStatus;
  /** Every S5 relationship in which the person is the counterparty, with S5's current status. */
  readonly grants: readonly PortalGrant[];
  /** Effective access now: one entry per patient, scopes unioned (two grants never multiply access). */
  readonly patients: readonly { patientRef: string; via: string; scopes: readonly RelationshipScope[] }[];
  readonly projectedAt: string;
}

/** Portal session read (E1). Takes no parameters: nothing a caller sends can widen what it sees. */
export function createPortalSessionOperations(base: EngagementBase) {
  const { deps } = base;
  return {
    readPortalSession(ctx: ActorContext, query: unknown): Promise<PortalSessionData> {
      return base.guarded(ctx, 'portal.session.read', async () => {
        assertValid(validateEmptyQuery, query, ENGAGEMENT_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const principal = await loadPortalPrincipal(tx);
          const self = await selfStatus(tx, principal.personRef);
          const grants = await projectGrants(tx, 'counterparty', principal.personRef);
          const effective = new Map<string, { via: string; scopes: Set<RelationshipScope> }>();
          if (self.status === 'active') {
            effective.set(principal.personRef, { via: 'self', scopes: new Set(RELATIONSHIP_SCOPES) });
          }
          for (const g of grants) {
            if (g.status !== 'active') continue;
            const e = effective.get(g.patientRef) ?? { via: g.kind, scopes: new Set<RelationshipScope>() };
            for (const s of g.scope) e.scopes.add(s);
            effective.set(g.patientRef, e);
          }
          return {
            principalRef: principal.principalRef,
            personRef: principal.personRef,
            kind: 'portal',
            assuranceLevel: principal.proofingLevel,
            policyVersion: PORTAL_ACCESS_POLICY_VERSION,
            self,
            grants,
            patients: [...effective.entries()].map(([patientRef, e]) => ({
              patientRef,
              via: e.via,
              scopes: RELATIONSHIP_SCOPES.filter((s) => e.scopes.has(s)),
            })),
            projectedAt: (grants[0]?.projectedAt ?? new Date().toISOString()) as string,
          };
        });
      });
    },
  };
}
