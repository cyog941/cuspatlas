export { assertPatientSchedulable } from './identity';
export {
  MERGE_EXCLUDED_REFERENCES,
  MERGE_RECORD_CLASSES,
  type MergeRecordClass,
  type PostMergeFactProbe,
  scoreCandidate,
} from './merge';
export { createMergeConfirmationCodec, type MergeConfirmationCodec } from './merge-confirmation';
export { PATIENT_REPLAY_CODECS } from './replay-codecs';
export { createPatientService, type PatientService } from './service';
export type { PatientServiceDeps } from './service-context';
