import { vocabularyEntry as e, type ModuleVocabularies } from './types';

/**
 * OR-02 scheduling state vocabularies (owner S). Labels are synthetic operator-facing plain English
 * pending workflow validation; no colour or layout. `sources` are the DB CHECK columns (`table.column`)
 * or domain constants (`domain:Name`) whose every value must have exactly one entry here
 * (tests/integration/vocabularies.test.ts).
 */
export const SCHEDULING_VOCABULARIES: ModuleVocabularies = {
  module: 'scheduling',
  owner: 'S',
  version: 'scheduling-state-labels.1',
  vocabularies: [
    {
      name: 'appointment_request',
      sources: [
        'appointment_requests.state',
        'appointment_request_transitions.from_state',
        'appointment_request_transitions.to_state',
      ],
      entries: [
        e('scheduled', 'SCH', 'Scheduled', 'lifecycle', false),
        e('declined', 'DEC', 'Declined', 'lifecycle', true),
        e('expired', 'EXP', 'Expired', 'lifecycle', true),
        e('withdrawn', 'WIT', 'Withdrawn', 'lifecycle', true),
        e('open', 'OPE', 'Open', 'lifecycle', false),
        e('in_review', 'IR', 'In review', 'lifecycle', false),
      ],
    },
    {
      name: 'appointment_series',
      sources: ['appointment_series.state'],
      entries: [
        e('active', 'ACT', 'Active', 'lifecycle', false),
        e('ended', 'END', 'Ended', 'lifecycle', true),
      ],
    },
    {
      name: 'appointment_booking',
      sources: ['appointments.status'],
      entries: [
        e('booked', 'BOO', 'Booked', 'lifecycle', true),
        e('cancelled', 'CAN', 'Cancelled', 'lifecycle', true),
        e('rescheduled', 'RES', 'Rescheduled', 'lifecycle', true),
      ],
    },
    {
      name: 'attendance',
      sources: ['schema:scheduling:AttendanceState'],
      entries: [
        e('scheduled', 'SCH', 'Scheduled', 'presence', false),
        e('confirmed', 'CON', 'Confirmed', 'presence', false),
        e('late', 'LAT', 'Running late', 'exception', false),
        e('arrived', 'ARR', 'Arrived', 'presence', false),
        e('waiting', 'WAI', 'Waiting', 'presence', false),
        e('in_care', 'IC', 'In care', 'presence', false),
        e('left_without_treatment', 'LWT', 'Left without treatment', 'exception', true),
        e('no_show', 'NS', 'No show', 'exception', true),
        e('cancelled', 'CAN', 'Cancelled', 'presence', true),
        e('rescheduled', 'RES', 'Rescheduled', 'presence', true),
      ],
    },
    {
      name: 'cancellation_recovery',
      sources: ['cancellation_recoveries.state'],
      entries: [
        e('open', 'OPE', 'Open', 'lifecycle', false),
        e('filled', 'FIL', 'Filled', 'lifecycle', true),
        e('closed', 'CLO', 'Closed', 'lifecycle', true),
      ],
    },
    {
      name: 'recall_task',
      sources: ['recall_tasks.state'],
      entries: [
        e('open', 'OPE', 'Open', 'lifecycle', false),
        e('resolved', 'RES', 'Resolved', 'lifecycle', true),
      ],
    },
    {
      name: 'scheduling_hold',
      sources: ['scheduling_holds.state'],
      entries: [
        e('active', 'ACT', 'Active', 'lifecycle', false),
        e('converted', 'CON', 'Converted', 'lifecycle', true),
        e('released', 'REL', 'Released', 'lifecycle', true),
      ],
    },
    {
      name: 'location_status',
      sources: ['scheduling_locations.status'],
      entries: [
        e('active', 'ACT', 'Active', 'lifecycle', false),
        e('inactive', 'INA', 'Inactive', 'lifecycle', false),
      ],
    },
    {
      name: 'resource_status',
      sources: ['scheduling_resources.status'],
      entries: [
        e('active', 'ACT', 'Active', 'lifecycle', false),
        e('inactive', 'INA', 'Inactive', 'lifecycle', false),
      ],
    },
    {
      name: 'provider_request',
      sources: ['scheduling_provider_requests.state'],
      entries: [
        e('open', 'OPE', 'Open', 'lifecycle', false),
        e('acknowledged', 'ACK', 'Acknowledged', 'lifecycle', false),
        e('cleared', 'CLE', 'Cleared', 'lifecycle', false),
      ],
    },
    {
      name: 'staff_presence',
      sources: ['scheduling_staff_presence.status'],
      entries: [
        e('available', 'AVA', 'Available', 'presence', false),
        e('busy', 'BUS', 'Busy', 'presence', false),
        e('away', 'AWA', 'Away', 'presence', false),
      ],
    },
    {
      name: 'staging_entry',
      sources: ['scheduling_staging_entries.state'],
      entries: [
        e('staged', 'STA', 'Staged', 'lifecycle', false),
        e('moved', 'MOV', 'Moved', 'lifecycle', true),
        e('removed', 'REM', 'Removed', 'lifecycle', true),
      ],
    },
    {
      name: 'visit_context_item',
      sources: ['visit_context_items.state'],
      entries: [
        e('active', 'ACT', 'Active', 'lifecycle', false),
        e('ended', 'END', 'Ended', 'lifecycle', true),
      ],
    },
    {
      name: 'waitlist_entry',
      sources: ['waitlist_entries.state'],
      entries: [
        e('active', 'ACT', 'Active', 'lifecycle', false),
        e('offered', 'OFF', 'Offered', 'lifecycle', false),
        e('booked', 'BOO', 'Booked', 'lifecycle', true),
        e('removed', 'REM', 'Removed', 'lifecycle', true),
      ],
    },
    {
      name: 'work_item_kind',
      sources: ['schema:scheduling:WorkItem.kind'],
      entries: [
        e(
          'notification_without_channel',
          'NWC',
          'Notification has no way to reach the patient',
          'exception',
          false,
        ),
        e('cancellation_recovery', 'CR', 'Fill a cancelled time', 'lifecycle', false),
        e('waitlist_offer_pending', 'WOP', 'Waitlist offer awaiting a reply', 'lifecycle', false),
        e('recall_due', 'RD', 'Recall visit due', 'lifecycle', false),
        e('recall_task_open', 'RTO', 'Recall follow-up open', 'lifecycle', false),
        e('request_unbooked', 'RU', 'Appointment request not yet booked', 'lifecycle', false),
        e('request_booking_lost', 'RBL', 'Appointment request lost its booking', 'exception', false),
        e('lab_return_overdue', 'LRO', 'Lab case return overdue', 'exception', false),
        e('lab_case_review', 'LCR', 'Lab case needs review', 'lifecycle', false),
        e('referral_response_due', 'RRD', 'Referral response due', 'lifecycle', false),
        e('referral_review', 'RR', 'Referral needs review', 'lifecycle', false),
        e('delivery_exception', 'DE', 'Message could not be delivered', 'exception', false),
        e('intake_review', 'IR', 'Intake form needs review', 'lifecycle', false),
        e('message_awaiting_reply', 'MAR', 'Message awaiting a reply', 'lifecycle', false),
      ],
    },
  ],
};
