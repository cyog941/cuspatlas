import { createAuthorshipOperations } from './authorship';
import { type ClinicalDeps, createClinicalBase } from './base';
import { createChartOperations } from './chart';
import { createEncounterOperations } from './encounters';
import { createHistoryOperations } from './history';
import { createPerioOperations } from './perio';
import { createTreatmentPlanOperations } from './treatment-plans';

/**
 * The clinical service (C5 encounters and authorship, C8 medical history). The only command/query layer for these
 * tables; REST, MCP and workers call these functions, none of which takes a tenant from its input.
 * Clinical semantics are recommended-pending-clinical-approval and not clinically validated.
 */
export function createClinicalService(deps: ClinicalDeps) {
  const base = createClinicalBase(deps);
  return {
    ...createAuthorshipOperations(base),
    ...createEncounterOperations(base),
    ...createHistoryOperations(base),
    ...createChartOperations(base),
    ...createPerioOperations(base),
    ...createTreatmentPlanOperations(base),
  };
}

export type ClinicalService = ReturnType<typeof createClinicalService>;
