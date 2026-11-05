-- Integration (codex/backend-integration; synthetic data only): the SQL mirror of the merge registry
-- gains I3's record class imagingAssociation (imaging_match_decisions.subject_patient_id), which the I
-- branch registered in MERGE_RECORD_CLASSES without the C-era mirror; the regression pin in
-- clinical-review-hardening.test.ts compares every class. The decision's own relink guard stays I's
-- (20261111050000); the S6 observation trigger is added so the moves-cover guard sees its moves.
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
      WHEN 'clinicalLabCase' THEN 'clinical_lab_cases'
      WHEN 'clinicalReferral' THEN 'clinical_referrals'
      WHEN 'imagingAssociation' THEN 'imaging_match_decisions'
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
      WHEN 'clinicalLabCase' THEN ARRAY['subject_patient_id', 'state', 'received_date', 'no_attachment_reason', 'version',
        'updated_at']
      WHEN 'clinicalReferral' THEN ARRAY['subject_patient_id', 'state', 'version', 'updated_at']
      WHEN 'imagingAssociation' THEN ARRAY['subject_patient_id', 'superseded_by_id', 'superseded_at', 'version',
        'updated_at']
    END
  $$;
CREATE TRIGGER imaging_match_decisions_observe_subject
  AFTER UPDATE OF subject_patient_id ON cuspatlas.imaging_match_decisions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('subject_patient_id');
