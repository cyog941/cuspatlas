import { vocabularyEntry as e, type ModuleVocabularies } from './types';

/**
 * OR-02 patients state vocabularies (owner S). Labels are synthetic operator-facing plain English
 * pending workflow validation; no colour or layout. `sources` are the DB CHECK columns (`table.column`)
 * or domain constants (`domain:Name`) whose every value must have exactly one entry here
 * (tests/integration/vocabularies.test.ts).
 */
export const PATIENTS_VOCABULARIES: ModuleVocabularies = {
  module: 'patients',
  owner: 'S',
  version: 'patients-state-labels.1',
  vocabularies: [
    {
      name: 'patient_status',
      sources: ['patients.status', 'patient_status_history.status'],
      entries: [
        e('active', 'ACT', 'Active', 'lifecycle', false),
        e('inactive', 'INA', 'Inactive', 'lifecycle', false),
        e('deceased', 'DEC', 'Deceased', 'lifecycle', true),
      ],
    },
  ],
};
