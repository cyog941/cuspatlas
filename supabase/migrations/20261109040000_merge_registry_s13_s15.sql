-- Merge of codex/scheduling-patients into codex/c-chart (synthetic data only). The S13 and S15 record
-- classes (appointmentSeries, waitlistEntry) join the database merge-class registry that the merge-move
-- integrity guard (20261109020000) uses, so a real merge can record their moves. The registry still
-- mirrors MERGE_RECORD_CLASSES in packages/domain/src/patients/merge.ts (pinned by a test).
CREATE OR REPLACE FUNCTION cuspatlas.merge_class_table(record_class text) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE record_class
      WHEN 'patientRelationship' THEN 'patient_relationships'
      WHEN 'appointmentRequest' THEN 'appointment_requests'
      WHEN 'appointment' THEN 'appointments'
      WHEN 'appointmentSeries' THEN 'appointment_series'
      WHEN 'waitlistEntry' THEN 'waitlist_entries'
      WHEN 'clinicalEncounter' THEN 'clinical_encounters'
      WHEN 'clinicalHistoryStream' THEN 'clinical_history_streams'
      WHEN 'clinicalChart' THEN 'clinical_charts'
      WHEN 'clinicalPerioStream' THEN 'clinical_perio_streams'
      WHEN 'clinicalTreatmentPlan' THEN 'clinical_treatment_plans'
      WHEN 'clinicalConsent' THEN 'clinical_consents'
    END
  $$;
CREATE OR REPLACE FUNCTION cuspatlas.merge_class_digest_exclude(record_class text) RETURNS text[]
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE record_class
      WHEN 'patientRelationship' THEN ARRAY['subject_patient_id', 'counterparty_patient_id', 'revoked_at', 'revoked_by',
        'revoke_reason', 'version', 'updated_at']
      WHEN 'appointmentRequest' THEN ARRAY['subject_patient_id', 'provider_preference_id', 'preferred_windows',
        'flexibility', 'urgent', 'contact_consent', 'note', 'state', 'state_reason', 'appointment_id',
        'expiry_policy_ref', 'closed_at', 'version', 'updated_at']
      WHEN 'appointment' THEN ARRAY['subject_patient_id', 'status', 'cancel_reason', 'cancelled_at', 'rescheduled_to_id',
        'request_id', 'version', 'updated_at']
      WHEN 'appointmentSeries' THEN ARRAY['subject_patient_id', 'occurrence_count', 'state', 'end_reason', 'ended_at',
        'version', 'updated_at']
      WHEN 'waitlistEntry' THEN ARRAY['subject_patient_id', 'state', 'state_reason', 'appointment_id', 'version',
        'updated_at']
      WHEN 'clinicalEncounter' THEN ARRAY['subject_patient_id', 'state', 'disposition_code', 'closed_by', 'closed_by_role',
        'closed_by_credential_ref', 'closed_at', 'version', 'updated_at']
      WHEN 'clinicalHistoryStream' THEN ARRAY['subject_patient_id', 'head_sequence', 'version', 'updated_at']
      WHEN 'clinicalChart' THEN ARRAY['subject_patient_id', 'head_sequence', 'version', 'updated_at']
      WHEN 'clinicalPerioStream' THEN ARRAY['subject_patient_id', 'head_sequence', 'version', 'updated_at']
      WHEN 'clinicalTreatmentPlan' THEN ARRAY['subject_patient_id', 'head_version', 'version', 'updated_at']
      WHEN 'clinicalConsent' THEN ARRAY['subject_patient_id', 'version', 'updated_at']
    END
  $$;
