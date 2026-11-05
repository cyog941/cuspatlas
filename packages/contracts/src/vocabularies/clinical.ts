import { vocabularyEntry as e, type ModuleVocabularies } from './types';

/**
 * OR-02 clinical state vocabularies (owner C). Labels are synthetic operator-facing plain English
 * pending workflow validation; no colour or layout. `sources` are the DB CHECK columns (`table.column`)
 * or domain constants (`domain:Name`) whose every value must have exactly one entry here
 * (tests/integration/vocabularies.test.ts).
 */
export const CLINICAL_VOCABULARIES: ModuleVocabularies = {
  module: 'clinical',
  owner: 'C',
  version: 'clinical-state-labels.1',
  vocabularies: [
    {
      name: 'chart_entry',
      sources: ['clinical_chart_entries.recorded_state'],
      entries: [
        e('active', 'ACT', 'Active', 'clinical', false),
        e('resolved', 'RES', 'Resolved', 'clinical', true),
        e('entered_in_error', 'EIE', 'Entered in error', 'exception', true),
      ],
    },
    {
      name: 'encounter_image_link',
      sources: ['clinical_encounter_image_links.state'],
      entries: [
        e('active', 'ACT', 'Active', 'clinical', false),
        e('ended', 'END', 'Ended', 'clinical', true),
      ],
    },
    {
      name: 'encounter',
      sources: ['clinical_encounters.state'],
      entries: [e('open', 'OPE', 'Open', 'clinical', false), e('closed', 'CLO', 'Closed', 'clinical', true)],
    },
    {
      name: 'estimate_coverage',
      sources: ['clinical_estimates.coverage_status', 'clinical_estimate_presentations.coverage_status'],
      entries: [
        e('entered', 'ENT', 'Entered', 'financial', false),
        e('unknown', 'UNK', 'Unknown', 'exception', false),
        e('stale', 'STA', 'Stale', 'exception', false),
        e('inactive', 'INA', 'Inactive', 'financial', false),
      ],
    },
    {
      name: 'history_entry',
      sources: ['clinical_history_changes.state'],
      entries: [
        e('active', 'ACT', 'Active', 'clinical', false),
        e('resolved', 'RES', 'Resolved', 'clinical', true),
        e('discontinued', 'DIS', 'Discontinued', 'clinical', true),
        e('entered_in_error', 'EIE', 'Entered in error', 'exception', true),
      ],
    },
    {
      name: 'lab_case',
      sources: [
        'clinical_lab_cases.state',
        'clinical_lab_case_transitions.from_state',
        'clinical_lab_case_transitions.to_state',
        'clinical_lab_case_state_config.state',
      ],
      entries: [
        e('draft', 'DRA', 'Draft', 'clinical', false),
        e('sent', 'SEN', 'Sent', 'clinical', false),
        e('in_progress', 'IP', 'In progress', 'clinical', false),
        e('received', 'REC', 'Received', 'clinical', false),
        e('seated', 'SEA', 'Seated', 'clinical', true),
        e('remake', 'REM', 'Remake', 'exception', false),
        e('cancelled', 'CAN', 'Cancelled', 'clinical', true),
      ],
    },
    {
      name: 'note_template',
      sources: ['clinical_note_templates.state'],
      entries: [
        e('active', 'ACT', 'Active', 'clinical', false),
        e('retired', 'RET', 'Retired', 'clinical', true),
      ],
    },
    {
      name: 'note',
      sources: ['clinical_notes.state'],
      entries: [
        e('draft', 'DRA', 'Draft', 'clinical', false),
        e('signed', 'SIG', 'Signed', 'clinical', true),
      ],
    },
    {
      name: 'perio_derived_value',
      sources: ['clinical_perio_derived_values.status'],
      entries: [
        e('derived', 'DER', 'Derived', 'clinical', false),
        e('not_computable', 'NC', 'Cannot be calculated', 'exception', false),
      ],
    },
    {
      name: 'perio_measurement',
      sources: ['clinical_perio_measurements.status'],
      entries: [
        e('measured', 'MEA', 'Measured', 'clinical', false),
        e('not_measured', 'NM', 'Not measured', 'exception', false),
      ],
    },
    {
      name: 'plan_item',
      sources: [
        'clinical_plan_item_events.from_state',
        'clinical_plan_item_events.to_state',
        'clinical_plan_detail_events.to_state',
      ],
      entries: [
        e('proposed', 'PRO', 'Proposed', 'clinical', false),
        e('accepted', 'ACC', 'Accepted', 'clinical', false),
        e('scheduled', 'SCH', 'Scheduled', 'clinical', false),
        e('completed', 'COM', 'Completed', 'clinical', true),
        e('declined', 'DEC', 'Declined', 'clinical', true),
        e('discontinued', 'DIS', 'Discontinued', 'clinical', true),
      ],
    },
    {
      name: 'plan_version',
      sources: ['clinical_plan_versions.state'],
      entries: [
        e('draft', 'DRA', 'Draft', 'clinical', false),
        e('accepted', 'ACC', 'Accepted', 'clinical', false),
      ],
    },
    {
      name: 'referral',
      sources: [
        'clinical_referrals.state',
        'clinical_referral_events.from_state',
        'clinical_referral_events.to_state',
      ],
      entries: [
        e('prepared', 'PRE', 'Prepared', 'clinical', false),
        e('received', 'REC', 'Received', 'clinical', false),
        e('sent', 'SEN', 'Sent', 'clinical', false),
        e('responded', 'RES', 'Responded', 'clinical', false),
        e('closed', 'CLO', 'Closed', 'clinical', true),
        e('cancelled', 'CAN', 'Cancelled', 'clinical', true),
      ],
    },
  ],
};
