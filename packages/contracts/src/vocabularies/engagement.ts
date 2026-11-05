import { vocabularyEntry as e, type ModuleVocabularies } from './types';

/**
 * OR-02 engagement state vocabularies (owner E). Labels are synthetic operator-facing plain English
 * pending workflow validation; no colour or layout. `sources` are the DB CHECK columns (`table.column`)
 * or domain constants (`domain:Name`) whose every value must have exactly one entry here
 * (tests/integration/vocabularies.test.ts).
 */
export const ENGAGEMENT_VOCABULARIES: ModuleVocabularies = {
  module: 'engagement',
  owner: 'E',
  version: 'engagement-state-labels.1',
  vocabularies: [
    {
      name: 'communication_consent',
      sources: ['communication_consents.state'],
      entries: [
        e('granted', 'GRA', 'Granted', 'lifecycle', false),
        e('denied', 'DEN', 'Denied', 'exception', true),
        e('opted_out', 'OO', 'Opted out', 'lifecycle', false),
      ],
    },
    {
      name: 'intake_form_version',
      sources: ['intake_form_versions.state'],
      entries: [
        e('published', 'PUB', 'Published', 'lifecycle', false),
        e('retired', 'RET', 'Retired', 'lifecycle', true),
      ],
    },
    {
      name: 'intake_review_item',
      sources: ['intake_review_items.state'],
      entries: [
        e('open', 'OPE', 'Open', 'lifecycle', false),
        e('applied', 'APP', 'Applied', 'lifecycle', true),
        e('rejected', 'REJ', 'Rejected', 'exception', true),
      ],
    },
    {
      name: 'message_receipt',
      sources: ['message_receipts.state'],
      entries: [
        e('delivered', 'DEL', 'Delivered', 'lifecycle', true),
        e('failed', 'FAI', 'Failed', 'exception', true),
        e('bounced', 'BOU', 'Bounced', 'exception', true),
      ],
    },
    {
      name: 'message_template',
      sources: ['message_templates.state'],
      entries: [
        e('approved', 'APP', 'Approved', 'lifecycle', false),
        e('withdrawn', 'WIT', 'Withdrawn', 'lifecycle', true),
      ],
    },
    {
      name: 'message_thread',
      sources: ['message_threads.state'],
      entries: [
        e('open', 'OPE', 'Open', 'lifecycle', false),
        e('closed', 'CLO', 'Closed', 'lifecycle', true),
      ],
    },
    {
      name: 'outbound_message',
      sources: ['outbound_messages.state'],
      entries: [
        e('queued', 'QUE', 'Queued', 'lifecycle', false),
        e('sending', 'SEN', 'Sending', 'lifecycle', false),
        e('sent', 'SEN2', 'Sent', 'lifecycle', false),
        e('delivered', 'DEL', 'Delivered', 'lifecycle', true),
        e('failed', 'FAI', 'Failed', 'exception', true),
        e('suppressed', 'SUP', 'Suppressed', 'exception', false),
        e('unknown', 'UNK', 'Unknown', 'exception', false),
        e('abandoned', 'ABA', 'Abandoned', 'exception', true),
      ],
    },
    {
      name: 'portal_principal',
      sources: ['portal_principals.state'],
      entries: [
        e('pending', 'PEN', 'Pending', 'lifecycle', false),
        e('active', 'ACT', 'Active', 'lifecycle', false),
        e('revoked', 'REV', 'Revoked', 'lifecycle', true),
      ],
    },
  ],
};
