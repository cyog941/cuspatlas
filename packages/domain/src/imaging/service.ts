import { associationExtension, createAssociationOperations } from './association';
import { createImagingBase, type ImagingDeps } from './base';
import { createBridgeOperations } from './bridge';
import { createBridgeHealthOperations, sweepBridgeStep } from './bridge-health';
import {
  compositionExtension,
  createCompositionOperations,
  mountGuard,
  sourceOfDerived,
} from './composition';
import { createDicomOperations } from './dicom';
import { createExportOperations } from './export';
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
      [sweepAbandonedIngress, reconcileDeletions, sweepBridgeStep],
    ),
    ...createIngressOperations(base),
    ...createAssociationOperations(base, [mountGuard], deps.limits?.unmatchedEscalationHours ?? 48),
    ...createCompositionOperations(base),
    ...createRetentionOperations(base),
    ...createDicomOperations(base),
    ...createExportOperations(base),
    ...createBridgeHealthOperations(base, {
      staleSeconds: deps.limits?.bridgeStaleSeconds ?? 120,
      offlineSeconds: deps.limits?.bridgeOfflineSeconds ?? 600,
      maxDeferred: deps.limits?.maxDeferredAcquisitions ?? 25,
    }),
    ...createBridgeOperations(base, {
      leaseSeconds: deps.limits?.bridgeLeaseSeconds ?? 300,
      resultSkewSeconds: 300,
      staleSeconds: deps.limits?.bridgeStaleSeconds ?? 120,
      offlineSeconds: deps.limits?.bridgeOfflineSeconds ?? 600,
    }),
  };
}

export type ImagingService = ReturnType<typeof createImagingService>;
