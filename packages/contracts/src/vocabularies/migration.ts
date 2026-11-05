import { vocabularyEntry as e, type ModuleVocabularies } from './types';

/**
 * OR-02 migration state vocabularies (owner M). Labels are synthetic operator-facing plain English
 * pending workflow validation; no colour or layout. `sources` are the DB CHECK columns (`table.column`)
 * or domain constants (`domain:Name`) whose every value must have exactly one entry here
 * (tests/integration/vocabularies.test.ts).
 */
export const MIGRATION_VOCABULARIES: ModuleVocabularies = {
  module: 'migration',
  owner: 'M',
  version: 'migration-state-labels.2',
  vocabularies: [
    {
      name: 'migration_cutover',
      sources: ['migration_packages.cutover_state'],
      entries: [
        e('reconciling', 'REC', 'Reconciling', 'lifecycle', false),
        e('readyForCutover', 'RFC', 'Ready for cutover', 'lifecycle', false),
      ],
    },
    {
      name: 'migration_review_item',
      sources: ['migration_review_items.state'],
      entries: [
        e('open', 'OPE', 'Open', 'lifecycle', false),
        e('resolved', 'RES', 'Resolved', 'lifecycle', true),
      ],
    },
    {
      name: 'migration_archive_package',
      sources: ['migration_archive_packages.state'],
      entries: [
        e('verified', 'VER', 'Verified, readable', 'lifecycle', false),
        e('partial', 'PAR', 'Partly readable', 'exception', false),
        e('failed', 'FAI', 'Failed, not served', 'exception', false),
      ],
    },
  ],
};
