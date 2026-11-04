export { AUTHOR_PROFILE_RESOURCE, resolveClinicalAuthor } from './authorship';
export type { ClinicalDeps } from './base';
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
export { NOTE_DIGEST_FORMAT, noteVersionDigest } from './notes/digest';
export { NOTE_POST_MERGE_FACT_PROBE, NOTE_RESOURCE } from './notes/notes';
export { checkAgainstTemplate, type TemplateCheck } from './notes/template-check';
export { NOTE_TEMPLATE_RESOURCE } from './notes/templates';
export { type ClinicalService, createClinicalService } from './service';
