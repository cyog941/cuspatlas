import { vocabularyEntry as e, type ModuleVocabularies } from './types';

/**
 * OR-02 imaging state vocabularies (owner I). Labels are synthetic operator-facing plain English
 * pending workflow validation; no colour or layout. `sources` are the DB CHECK columns (`table.column`)
 * or domain constants (`domain:Name`) whose every value must have exactly one entry here
 * (tests/integration/vocabularies.test.ts).
 */
export const IMAGING_VOCABULARIES: ModuleVocabularies = {
  module: 'imaging',
  owner: 'I',
  // .2 (Closeout D): orphan_removal (durable orphan-bytes removal intents).
  version: 'imaging-state-labels.2',
  vocabularies: [
    {
      name: 'acquisition_deferral',
      sources: ['imaging_acquisition_deferrals.state'],
      entries: [
        e('deferred', 'DEF', 'Deferred', 'lifecycle', false),
        e('released', 'REL', 'Released', 'lifecycle', true),
        e('cancelled', 'CAN', 'Cancelled', 'lifecycle', true),
      ],
    },
    {
      name: 'annotation',
      sources: ['imaging_annotations.state'],
      entries: [
        e('current', 'CUR', 'Current', 'clinical', false),
        e('superseded', 'SUP', 'Superseded', 'clinical', true),
        e('withdrawn', 'WIT', 'Withdrawn', 'clinical', true),
      ],
    },
    {
      name: 'bridge_job',
      sources: ['imaging_bridge_jobs.state'],
      entries: [
        e('claimed', 'CLA', 'Claimed', 'lifecycle', false),
        e('transferring', 'TRA', 'Transferring', 'lifecycle', false),
        e('queued', 'QUE', 'Queued', 'lifecycle', false),
        e('completed', 'COM', 'Completed', 'lifecycle', true),
        e('failed', 'FAI', 'Failed', 'exception', true),
        e('expired', 'EXP', 'Expired', 'lifecycle', true),
        e('denied', 'DEN', 'Denied', 'exception', true),
        e('outcome_unknown', 'OU', 'Outcome unknown', 'exception', false),
        e('cancelled', 'CAN', 'Cancelled', 'lifecycle', true),
      ],
    },
    {
      name: 'deletion_request',
      sources: ['imaging_deletion_requests.state'],
      entries: [
        e('pending', 'PEN', 'Pending', 'lifecycle', false),
        e('executed', 'EXE', 'Executed', 'lifecycle', true),
      ],
    },
    {
      name: 'orphan_removal',
      sources: ['imaging_orphan_removals.state'],
      entries: [
        e('intended', 'INT', 'Removal intended', 'lifecycle', false),
        e('removed', 'REM', 'Removed', 'lifecycle', true),
        e('absent', 'ABS', 'Already absent', 'lifecycle', true),
        e('kept', 'KEP', 'Kept', 'lifecycle', true),
      ],
    },
    {
      name: 'deletion_bytes',
      sources: ['imaging_deletion_requests.bytes_state'],
      entries: [
        e('pending', 'PEN', 'Pending', 'lifecycle', false),
        e('removed', 'REM', 'Removed', 'lifecycle', true),
        e('retained_shared', 'RS', 'Kept (shared with another record)', 'lifecycle', true),
      ],
    },
    {
      name: 'derivation',
      sources: ['imaging_derivations.state'],
      entries: [
        e('succeeded', 'SUC', 'Succeeded', 'lifecycle', true),
        e('failed', 'FAI', 'Failed', 'exception', true),
      ],
    },
    {
      name: 'device_key',
      sources: ['imaging_device_keys.state'],
      entries: [
        e('active', 'ACT', 'Active', 'lifecycle', false),
        e('retired', 'RET', 'Retired', 'lifecycle', true),
        e('revoked', 'REV', 'Revoked', 'lifecycle', true),
      ],
    },
    {
      name: 'device',
      sources: ['imaging_devices.state'],
      entries: [
        e('pending', 'PEN', 'Pending', 'lifecycle', false),
        e('active', 'ACT', 'Active', 'lifecycle', false),
        e('revoked', 'REV', 'Revoked', 'lifecycle', true),
      ],
    },
    {
      name: 'ingress_session',
      sources: ['imaging_ingress_sessions.state'],
      entries: [
        e('awaiting_bytes', 'AB', 'Waiting for image data', 'lifecycle', false),
        e('staged', 'STA', 'Staged', 'lifecycle', false),
        e('accepted', 'ACC', 'Accepted', 'lifecycle', false),
        e('quarantined', 'QUA', 'Quarantined', 'exception', false),
        e('abandoned', 'ABA', 'Abandoned', 'exception', true),
      ],
    },
    {
      name: 'image_object',
      sources: ['imaging_objects.state'],
      entries: [
        e('available', 'AVA', 'Available', 'lifecycle', false),
        e('quarantined', 'QUA', 'Quarantined', 'exception', false),
        e('deleted', 'DEL', 'Deleted', 'lifecycle', true),
      ],
    },
  ],
};
