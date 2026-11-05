-- Integration seam E4 -> C8 (codex/backend-integration; synthetic data only; recommended-pending-
-- clinical-approval like E4 and C8). New migration; applied migrations are never edited.
--
-- A medical-history hand-off (E4) is never copied into the chart: free-text intake answers become
-- structured history only through a clinician's own C8 `clinical.history.recordChange` (provenance
-- `patient_reported`, `sourceRef` = `intake-submission:<submission>`). The review item may then be
-- resolved `applied`, naming that C8 history version; it is applied only when such a version exists
-- for the item's own patient and submission. Before this migration a hand-off could never be applied.
ALTER TABLE cuspatlas.intake_review_items
  ADD COLUMN applied_history_version_id uuid,
  ADD CONSTRAINT intake_review_items_history_version_fkey
    FOREIGN KEY (applied_history_version_id, tenant_id) REFERENCES cuspatlas.clinical_history_versions (id, tenant_id),
  ADD CONSTRAINT intake_review_items_history_kind
    CHECK (applied_history_version_id IS NULL OR (kind = 'medical_history_handoff' AND state = 'applied'));

-- The E4 rule "a hand-off is never applied" becomes "a hand-off is applied only with its C8 version".
DO $$
DECLARE
  c text;
BEGIN
  SELECT con.conname INTO c FROM pg_constraint con
  WHERE con.conrelid = 'cuspatlas.intake_review_items'::regclass AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%medical_history_handoff%' AND con.conname <> 'intake_review_items_history_kind';
  IF c IS NULL THEN
    RAISE EXCEPTION 'expected the E4 hand-off check on intake_review_items';
  END IF;
  EXECUTE format('ALTER TABLE cuspatlas.intake_review_items DROP CONSTRAINT %I', c);
END
$$;
ALTER TABLE cuspatlas.intake_review_items ADD CONSTRAINT intake_review_items_handoff_applied
  CHECK (kind <> 'medical_history_handoff' OR state <> 'applied' OR applied_history_version_id IS NOT NULL);

CREATE OR REPLACE FUNCTION cuspatlas.intake_review_items_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'review items are never deleted' USING ERRCODE = '42501';
    END IF;
    IF OLD.state <> 'open' OR NEW.version <> OLD.version + 1
        OR (to_jsonb(NEW) - 'state' - 'resolution_reason' - 'applied_patient_version' - 'applied_history_version_id'
            - 'resolved_by' - 'resolved_at' - 'version')
           IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'resolution_reason' - 'applied_patient_version'
            - 'applied_history_version_id' - 'resolved_by' - 'resolved_at' - 'version') THEN
      RAISE EXCEPTION 'a review item is resolved once and its proposal never changes' USING ERRCODE = '42501';
    END IF;
    -- The named C8 version is a patient-reported history version of this item's own patient recorded
    -- from this item's own submission.
    IF NEW.applied_history_version_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM cuspatlas.clinical_history_versions v
         JOIN cuspatlas.clinical_history_streams s ON s.id = v.stream_id AND s.tenant_id = v.tenant_id
         WHERE v.id = NEW.applied_history_version_id AND v.tenant_id = NEW.tenant_id
           AND s.subject_patient_id = NEW.patient_id AND v.provenance = 'patient_reported'
           AND v.source_ref = 'intake-submission:' || NEW.submission_id::text) THEN
      RAISE EXCEPTION 'a hand-off is applied only with a C8 version recorded from its own submission'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;

GRANT UPDATE (applied_history_version_id) ON cuspatlas.intake_review_items TO cuspatlas_app;
