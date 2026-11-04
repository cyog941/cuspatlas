export { AUTHOR_PROFILE_RESOURCE, resolveClinicalAuthor } from './authorship';
export type { ClinicalDeps } from './base';
export {
  CHART_ENTRY_RESOURCE,
  chartToothStates,
  loadChartEntry,
  resolveTooth,
  type ToothChartState,
  toothOnChart,
} from './chart';
export { CLINICAL_REPLAY_CODECS } from './codecs';
export { CONSENT_POST_MERGE_FACT_PROBE, CONSENT_RESOURCE, CONSENT_TEMPLATE_RESOURCE } from './consents';
export {
  ENCOUNTER_RESOURCE,
  loadClinicalPatient,
  loadEncounter,
  requireOpenEncounter,
} from './encounters';
export {
  COVERAGE_STALE_AFTER_MS,
  type ConsentBindingReader,
  coverageStatusAt,
  ESTIMATE_RESOURCE,
  PLAN_ACCEPTANCE_RESOURCE,
  registerConsentBindingReader,
} from './estimates';
export {
  HISTORY_NOT_PROVIDED,
  HISTORY_REVIEW_RESOURCE,
  HISTORY_VERIFICATION_RESOURCE,
  HISTORY_VERSION_RESOURCE,
  resolveHistoryReference,
} from './history';
export { IMAGE_LINK_RESOURCE, type ImageRefResolution, type ImageRefResolver } from './image-links';
export { LAB_CASE_RESOURCE, LAB_EXPORT_FORMAT } from './lab-cases';
export { CLINICAL_POST_MERGE_FACT_PROBES } from './merge-probes';
export { NOTE_DIGEST_FORMAT, noteVersionDigest } from './notes/digest';
export {
  type DigestQueryable,
  NOTE_POST_MERGE_FACT_PROBE,
  NOTE_RESOURCE,
  verifyImportedNoteDigests,
} from './notes/notes';
export { checkAgainstTemplate, type TemplateCheck } from './notes/template-check';
export { NOTE_TEMPLATE_RESOURCE } from './notes/templates';
export { PERIO_DERIVATION_RESOURCE, PERIO_EXAM_RESOURCE, PROVISIONAL_SITES } from './perio';
export {
  loadRenderedProcedureEvent,
  PROCEDURE_EVENT_FIELDS,
  PROCEDURE_POST_MERGE_FACT_PROBE,
  RENDERED_PROCEDURE_RESOURCE,
  readLatestCompletedProcedures,
} from './procedures';
export { REFERRAL_EXPORT_FORMAT, REFERRAL_RESOURCE } from './referrals';
export { type ClinicalService, createClinicalService } from './service';
export {
  checkSurfaces,
  convertToothRef,
  parseTooth,
  TOOTH_VOCABULARY,
  toothDisplay,
  toothInfo,
} from './tooth-identity';
export {
  PLAN_ITEM_TRANSITIONS,
  PLAN_VERSION_RESOURCE,
  recordPlanVersionAcceptance,
  TREATMENT_PLAN_RESOURCE,
} from './treatment-plans';
export { type ClinicalVisitProducerDeps, createClinicalVisitContextProducers } from './visit-producers';
