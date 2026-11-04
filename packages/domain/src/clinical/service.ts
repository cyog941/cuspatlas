import { createAuthorshipOperations } from './authorship';
import { type ClinicalDeps, createClinicalBase } from './base';
import { createEncounterOperations } from './encounters';

/**
 * The clinical service (C5 encounters and authorship). The only command/query layer for these
 * tables; REST, MCP and workers call these functions, none of which takes a tenant from its input.
 * Clinical semantics are recommended-pending-clinical-approval and not clinically validated.
 */
export function createClinicalService(deps: ClinicalDeps) {
  const base = createClinicalBase(deps);
  return {
    ...createAuthorshipOperations(base),
    ...createEncounterOperations(base),
  };
}

export type ClinicalService = ReturnType<typeof createClinicalService>;
