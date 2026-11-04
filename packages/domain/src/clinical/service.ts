import { createAuthorshipOperations } from './authorship';
import { type ClinicalDeps, createClinicalBase } from './base';
import { createChartOperations } from './chart';
import { createConsentOperations } from './consents';
import { createEncounterOperations } from './encounters';
import { createEstimateOperations } from './estimates';
import { createClinicalExportOperations } from './export';
import { createHistoryOperations } from './history';
import { createImageLinkOperations } from './image-links';
import { createLabCaseOperations } from './lab-cases';
import { createNoteOperations } from './notes/notes';
import { createNoteTemplateOperations } from './notes/templates';
import { createPerioOperations } from './perio';
import { createProcedureOperations } from './procedures';
import { createReferralOperations } from './referrals';
import { createTreatmentPlanOperations } from './treatment-plans';

/**
 * The clinical service (C5 encounters and authorship, C8 medical history, C9 note templates, C10 notes). The only command/query layer for these
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
    ...createEstimateOperations(base),
    ...createConsentOperations(base),
    ...createProcedureOperations(base),
    ...createImageLinkOperations(base),
    ...createLabCaseOperations(base),
    ...createReferralOperations(base),
    ...createClinicalExportOperations(base),
    ...createNoteTemplateOperations(base),
    ...createNoteOperations(base),
  };
}

export type ClinicalService = ReturnType<typeof createClinicalService>;
