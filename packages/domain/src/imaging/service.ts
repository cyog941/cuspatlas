import { createImagingBase, type ImagingDeps } from './base';
import { createIngressOperations, sweepAbandonedIngress } from './ingress';
import { createObjectOperations } from './objects';

/**
 * Imaging service (workstream I). One instance per transport; REST and MCP call the same functions,
 * which authorize first (fresh membership), validate, then run inside the caller's tenant transaction.
 */
export function createImagingService(deps: ImagingDeps) {
  const base = createImagingBase(deps);
  return {
    ...createObjectOperations(base, [], [sweepAbandonedIngress]),
    ...createIngressOperations(base),
  };
}

export type ImagingService = ReturnType<typeof createImagingService>;
