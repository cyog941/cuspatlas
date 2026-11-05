import { vocabularyEntry as e, type ModuleVocabularies } from './types';

/**
 * OR-02 platform state vocabularies (owner F). Labels are synthetic operator-facing plain English
 * pending workflow validation; no colour or layout. `sources` are the DB CHECK columns (`table.column`)
 * or domain constants (`domain:Name`) whose every value must have exactly one entry here
 * (tests/integration/vocabularies.test.ts).
 */
export const PLATFORM_VOCABULARIES: ModuleVocabularies = {
  module: 'platform',
  owner: 'F',
  version: 'platform-state-labels.1',
  vocabularies: [
    {
      name: 'action_proposal',
      sources: ['action_proposals.state'],
      entries: [
        e('expired', 'EXP', 'Expired', 'lifecycle', true),
        e('rejected', 'REJ', 'Rejected', 'exception', true),
        e('prepared', 'PRE', 'Prepared', 'lifecycle', false),
        e('approved', 'APP', 'Approved', 'lifecycle', false),
        e('committed', 'COM', 'Committed', 'lifecycle', true),
      ],
    },
    {
      name: 'command_idempotency',
      sources: ['command_idempotency.state'],
      entries: [
        e('pending', 'PEN', 'Pending', 'lifecycle', false),
        e('committed', 'COM', 'Committed', 'lifecycle', true),
        e('failed', 'FAI', 'Failed', 'exception', true),
      ],
    },
    {
      name: 'outbox_event',
      sources: ['outbox_events.state'],
      entries: [
        e('pending', 'PEN', 'Pending', 'lifecycle', false),
        e('leased', 'LEA', 'Leased', 'lifecycle', false),
        e('delivered', 'DEL', 'Delivered', 'lifecycle', true),
        e('retry', 'RET', 'Retry', 'exception', false),
        e('reconciliation', 'REC', 'Reconciliation', 'exception', false),
        e('dead_letter', 'DL', 'Delivery stopped', 'exception', true),
      ],
    },
  ],
};
