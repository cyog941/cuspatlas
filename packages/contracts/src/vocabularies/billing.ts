import { vocabularyEntry as e, type ModuleVocabularies } from './types';

/**
 * OR-02 billing state vocabularies (owner B). Labels are synthetic operator-facing plain English
 * pending workflow validation; no colour or layout. `sources` are the DB CHECK columns (`table.column`)
 * or domain constants (`domain:Name`) whose every value must have exactly one entry here
 * (tests/integration/vocabularies.test.ts).
 */
export const BILLING_VOCABULARIES: ModuleVocabularies = {
  module: 'billing',
  owner: 'B',
  version: 'billing-state-labels.1',
  vocabularies: [
    {
      name: 'claim',
      sources: ['schema:billing:ClaimView.state'],
      entries: [
        e('prepared', 'PRE', 'Prepared', 'financial', false),
        e('validated', 'VAL', 'Validated', 'financial', false),
        e('replaced', 'REP', 'Replaced', 'financial', true),
        e('submission_pending', 'SP', 'Submission in progress', 'financial', false),
        e('submission_unknown', 'SU', 'Submission outcome unknown', 'exception', false),
        e('transport_rejected', 'TR', 'Rejected before reaching the payer', 'exception', false),
        e('transmitted', 'TRA', 'Sent to the payer', 'financial', false),
        e('payer_acknowledged', 'PA', 'Received by the payer', 'financial', false),
        e('payer_rejected', 'PR', 'Rejected by the payer', 'exception', false),
        e('paid', 'PAI', 'Paid', 'financial', true),
        e('denied', 'DEN', 'Denied', 'exception', false),
      ],
    },
    {
      name: 'appeal',
      sources: ['schema:billing:AppealCommandData.state'],
      entries: [
        e('draft', 'DRA', 'Draft', 'financial', false),
        e('rejected', 'REJ', 'Rejected', 'exception', true),
        e('sent', 'SEN', 'Sent', 'financial', false),
        e('send_unknown', 'SU', 'Send outcome unknown', 'exception', false),
      ],
    },
    {
      name: 'eligibility',
      sources: ['rcm_eligibility_records.state', 'schema:billing:Eligibility.state'],
      entries: [
        e('verified', 'VER', 'Verified', 'financial', false),
        e('unverified', 'UNV', 'Unverified', 'exception', false),
        e('unknown', 'UNK', 'Unknown', 'exception', false),
        e('unparsed', 'UNP', 'Unparsed', 'exception', false),
      ],
    },
    {
      name: 'charge',
      sources: ['schema:billing:Charge.state'],
      entries: [
        e('posted', 'POS', 'Posted', 'financial', false),
        e('reversed', 'REV', 'Reversed', 'financial', true),
      ],
    },
    {
      name: 'payment',
      sources: ['schema:billing:Payment.state'],
      entries: [
        e('received', 'REC', 'Received', 'financial', false),
        e('reversed', 'REV', 'Reversed', 'financial', true),
      ],
    },
    {
      name: 'plan_installment',
      sources: ['schema:billing:PlanInstallment.state'],
      entries: [
        e('scheduled', 'SCH', 'Scheduled', 'financial', false),
        e('due', 'DUE', 'Due', 'financial', false),
        e('overdue', 'OVE', 'Overdue', 'exception', false),
        e('partially_paid', 'PP', 'Partially paid', 'exception', false),
        e('paid', 'PAI', 'Paid', 'financial', true),
      ],
    },
    {
      name: 'plan_autopay',
      sources: ['schema:billing:PlanAutopay.state'],
      entries: [
        e('active', 'ACT', 'Active', 'financial', false),
        e('paused', 'PAU', 'Paused', 'financial', false),
      ],
    },
    {
      name: 'statement_freshness',
      sources: ['schema:billing:StatementFreshness.state'],
      entries: [
        e('fresh', 'FRE', 'Fresh', 'financial', false),
        e('stale', 'STA', 'Stale', 'exception', false),
      ],
    },
    {
      name: 'remittance_line',
      sources: ['rcm_remittance_lines.status'],
      entries: [
        e('posted', 'POS', 'Posted', 'financial', false),
        e('denied', 'DEN', 'Denied', 'exception', false),
        e('review', 'REV', 'Review', 'exception', false),
      ],
    },
  ],
};
