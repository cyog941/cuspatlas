export { AUTHOR_PROFILE_RESOURCE, resolveClinicalAuthor } from './authorship';
export type { ClinicalDeps } from './base';
export { CHART_ENTRY_RESOURCE, loadChartEntry, resolveTooth, toothOnChart } from './chart';
export { CLINICAL_REPLAY_CODECS } from './codecs';
export {
  ENCOUNTER_RESOURCE,
  loadClinicalPatient,
  loadEncounter,
  requireOpenEncounter,
} from './encounters';
export {
  HISTORY_NOT_PROVIDED,
  HISTORY_REVIEW_RESOURCE,
  HISTORY_VERIFICATION_RESOURCE,
  HISTORY_VERSION_RESOURCE,
  resolveHistoryReference,
} from './history';
export { CLINICAL_POST_MERGE_FACT_PROBES } from './merge-probes';
export { type ClinicalService, createClinicalService } from './service';
export {
  checkSurfaces,
  convertToothRef,
  parseTooth,
  TOOTH_VOCABULARY,
  toothDisplay,
  toothInfo,
} from './tooth-identity';
