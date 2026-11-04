export { AUTHOR_PROFILE_RESOURCE, resolveClinicalAuthor } from './authorship';
export type { ClinicalDeps } from './base';
export { CLINICAL_REPLAY_CODECS } from './codecs';
export {
  ENCOUNTER_RESOURCE,
  loadClinicalPatient,
  loadEncounter,
  requireOpenEncounter,
} from './encounters';
export { CLINICAL_POST_MERGE_FACT_PROBES } from './merge-probes';
export { type ClinicalService, createClinicalService } from './service';
