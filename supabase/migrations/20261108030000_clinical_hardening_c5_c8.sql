-- Hardening of C5 and C8 after the independent review of 58bb6b5 (synthetic data only). Independent
-- database enforcement for rules the domain already applies, so no application path, and no
-- direct statement under the runtime role, can bypass them. Semantics stay
-- recommended-pending-clinical-approval.

-- 1. Fact timestamps are taken when the row is written (after the locks), not at transaction start,
--    so a transaction begun before a merge and committed after it is seen as a post-merge fact.
ALTER TABLE cuspatlas.clinical_encounters
  ALTER COLUMN opened_at SET DEFAULT date_trunc('milliseconds', clock_timestamp());
ALTER TABLE cuspatlas.clinical_encounter_assignments
  ALTER COLUMN assigned_at SET DEFAULT date_trunc('milliseconds', clock_timestamp());

-- 2a. No clinical fact may name a closed encounter (the C6 guard, applied to C5 and C8 tables).
CREATE TRIGGER clinical_encounter_assignments_encounter
  BEFORE INSERT ON cuspatlas.clinical_encounter_assignments
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_open_encounter_guard('encounter_id');
CREATE TRIGGER clinical_history_versions_encounter
  BEFORE INSERT ON cuspatlas.clinical_history_versions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_open_encounter_guard('encounter_id');
CREATE TRIGGER clinical_history_verifications_encounter
  BEFORE INSERT ON cuspatlas.clinical_history_verifications
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_open_encounter_guard('encounter_id');
CREATE TRIGGER clinical_history_reviews_encounter
  BEFORE INSERT ON cuspatlas.clinical_history_reviews
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_open_encounter_guard('encounter_id');

-- 2b. Authorship snapshots must equal the author's active profile at write time.
CREATE TRIGGER clinical_encounters_author
  BEFORE INSERT ON cuspatlas.clinical_encounters
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'opened_by', 'opened_by_role', 'opened_by_credential_ref');
CREATE TRIGGER clinical_encounters_closer
  BEFORE UPDATE ON cuspatlas.clinical_encounters
  FOR EACH ROW WHEN (OLD.closed_by IS NULL AND NEW.closed_by IS NOT NULL)
  EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard('closed_by', 'closed_by_role', 'closed_by_credential_ref');
CREATE TRIGGER clinical_encounter_assignments_author
  BEFORE INSERT ON cuspatlas.clinical_encounter_assignments
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'assigned_by', 'assigned_by_role', 'assigned_by_credential_ref');
CREATE TRIGGER clinical_history_versions_author
  BEFORE INSERT ON cuspatlas.clinical_history_versions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'recorded_by', 'recorded_by_role', 'recorded_by_credential_ref');
CREATE TRIGGER clinical_history_verifications_author
  BEFORE INSERT ON cuspatlas.clinical_history_verifications
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'verified_by', 'verified_by_role', 'verified_by_credential_ref');
CREATE TRIGGER clinical_history_reviews_author
  BEFORE INSERT ON cuspatlas.clinical_history_reviews
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'reviewed_by', 'reviewed_by_role', 'reviewed_by_credential_ref');

-- 2c. A clinical record's patient reference moves only as part of a recorded merge (to the survivor
--     of an unreversed merge of the old patient that lists this record as moved) or of its recorded
--     reversal (back to the merged patient). Checked at commit, because the merge writes its merge,
--     move and reversal rows after relinking the records in the same transaction.
CREATE FUNCTION cuspatlas.clinical_subject_relink_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.subject_patient_id IS NOT DISTINCT FROM OLD.subject_patient_id THEN
      RETURN NULL;
    END IF;
    IF EXISTS (
      SELECT 1 FROM cuspatlas.patient_merges m
      JOIN cuspatlas.patient_merge_moves mv ON mv.merge_id = m.id AND mv.tenant_id = m.tenant_id
      WHERE m.tenant_id = NEW.tenant_id AND mv.record_ref = NEW.id
        AND ((m.merged_patient_id = OLD.subject_patient_id AND m.survivor_patient_id = NEW.subject_patient_id
              AND NOT EXISTS (SELECT 1 FROM cuspatlas.patient_merge_reversals r WHERE r.merge_id = m.id))
          OR (m.survivor_patient_id = OLD.subject_patient_id AND m.merged_patient_id = NEW.subject_patient_id
              AND EXISTS (SELECT 1 FROM cuspatlas.patient_merge_reversals r WHERE r.merge_id = m.id)))
    ) THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'a clinical patient reference moves only with a recorded merge or reversal' USING ERRCODE = '42501';
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_subject_relink_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER clinical_encounters_relink
  AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_encounters DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_subject_relink_guard();
CREATE CONSTRAINT TRIGGER clinical_history_streams_relink
  AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_history_streams DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_subject_relink_guard();
CREATE CONSTRAINT TRIGGER clinical_charts_relink
  AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_charts DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_subject_relink_guard();
CREATE CONSTRAINT TRIGGER clinical_perio_streams_relink
  AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_perio_streams DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_subject_relink_guard();
CREATE CONSTRAINT TRIGGER clinical_treatment_plans_relink
  AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_treatment_plans DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_subject_relink_guard();

-- 3. A history change belongs to a version of its own item's stream, so a change made through a
--    merge survivor stays with the stream (and source patient) that owns the item.
CREATE FUNCTION cuspatlas.clinical_history_changes_stream_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM cuspatlas.clinical_history_items i
      JOIN cuspatlas.clinical_history_versions v ON v.stream_id = i.stream_id AND v.tenant_id = i.tenant_id
      WHERE i.id = NEW.item_id AND i.tenant_id = NEW.tenant_id AND v.id = NEW.version_id
    ) THEN
      RAISE EXCEPTION 'a history change belongs to a version of its item''s stream' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_history_changes_stream_guard() FROM PUBLIC;
CREATE TRIGGER clinical_history_changes_stream
  BEFORE INSERT ON cuspatlas.clinical_history_changes
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_history_changes_stream_guard();

-- Deterministic order of a version's changes: the position in the recorded change set.
ALTER TABLE cuspatlas.clinical_history_changes ADD COLUMN ordinal integer CHECK (ordinal BETWEEN 1 AND 100);

-- 5. Two-person rule (recommended-pending-approval): nobody defines or changes their own clinical
--    author profile.
CREATE FUNCTION cuspatlas.clinical_author_profiles_self_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF (TG_OP = 'INSERT' AND NEW.defined_by = NEW.actor_id) OR NEW.updated_by = NEW.actor_id THEN
      RAISE EXCEPTION 'a clinical author profile is defined by another member' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_author_profiles_self_guard() FROM PUBLIC;
CREATE TRIGGER clinical_author_profiles_self
  BEFORE INSERT OR UPDATE ON cuspatlas.clinical_author_profiles
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_profiles_self_guard();
