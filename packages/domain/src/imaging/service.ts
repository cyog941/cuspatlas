import { associationExtension, createAssociationOperations } from './association';
import { createImagingBase, type ImagingDeps } from './base';
import {
  compositionExtension,
  createCompositionOperations,
  mountGuard,
  sourceOfDerived,
} from './composition';
import { createDicomOperations } from './dicom';
import { createIngressOperations, sweepAbandonedIngress } from './ingress';
import { createObjectOperations } from './objects';
import { createRetentionOperations, reconcileDeletions } from './retention';

/**
 * Imaging service (workstream I). One instance per transport; REST and MCP call the same functions,
 * which authorize first (fresh membership), validate, then run inside the caller's tenant transaction.
 */
export function createImagingService(deps: ImagingDeps) {
  const base = createImagingBase(deps);
  return {
    ...createObjectOperations(
      base,
      [associationExtension(() => sourceOfDerived), compositionExtension],
      [sweepAbandonedIngress, reconcileDeletions],
    ),
    ...createIngressOperations(base),
    ...createAssociationOperations(base, [mountGuard], deps.limits?.unmatchedEscalationHours ?? 48),
    ...createCompositionOperations(base),
    ...createRetentionOperations(base),
    ...createDicomOperations(base),
  };
}

export type ImagingService = ReturnType<typeof createImagingService>;
