-- Hardening after the independent review of c-chart 0b72f27 and c-notes 99ba582 (synthetic data
-- only). New migration; applied migrations are never edited.
--
-- Scope of the checks below: they enforce consistency for the runtime role `cuspatlas_app`, the only
-- role the application uses. Privileged roles (the restore connection, the table owner, a superuser)
-- can disable triggers in any case and are not checked here, so a restore of consistent historical
-- rows is never refused for being historical.

-- 1. Merge rows (S6) cannot be forged to relink clinical records.
--
-- The record-class registry mirrors MERGE_RECORD_CLASSES in packages/domain/src/patients/merge.ts
-- (a test asserts they agree): the table of each class and the columns its content digest leaves out.
CREATE FUNCTION cuspatlas.merge_class_table(record_class text) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE record_class
      WHEN 'patientRelationship' THEN 'patient_relationships'
      WHEN 'appointmentRequest' THEN 'appointment_requests'
      WHEN 'appointment' THEN 'appointments'
      WHEN 'clinicalEncounter' THEN 'clinical_encounters'
      WHEN 'clinicalHistoryStream' THEN 'clinical_history_streams'
      WHEN 'clinicalChart' THEN 'clinical_charts'
      WHEN 'clinicalPerioStream' THEN 'clinical_perio_streams'
      WHEN 'clinicalTreatmentPlan' THEN 'clinical_treatment_plans'
      WHEN 'clinicalConsent' THEN 'clinical_consents'
    END
  $$;
CREATE FUNCTION cuspatlas.merge_class_digest_exclude(record_class text) RETURNS text[]
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
      WHEN 'clinicalEncounter' THEN ARRAY['subject_patient_id', 'state', 'disposition_code', 'closed_by', 'closed_by_role',
        'closed_by_credential_ref', 'closed_at', 'version', 'updated_at']
      WHEN 'clinicalHistoryStream' THEN ARRAY['subject_patient_id', 'head_sequence', 'version', 'updated_at']
      WHEN 'clinicalChart' THEN ARRAY['subject_patient_id', 'head_sequence', 'version', 'updated_at']
      WHEN 'clinicalPerioStream' THEN ARRAY['subject_patient_id', 'head_sequence', 'version', 'updated_at']
      WHEN 'clinicalTreatmentPlan' THEN ARRAY['subject_patient_id', 'head_version', 'version', 'updated_at']
      WHEN 'clinicalConsent' THEN ARRAY['subject_patient_id', 'version', 'updated_at']
    END
  $$;
GRANT EXECUTE ON FUNCTION cuspatlas.merge_class_table(text), cuspatlas.merge_class_digest_exclude(text) TO cuspatlas_app;

CREATE FUNCTION cuspatlas.patient_identity_digest(patient_id uuid) RETURNS text
  LANGUAGE sql STABLE
  AS $$
    SELECT encode(sha256(convert_to((to_jsonb(p) - 'version' - 'updated_at' - 'merged_into')::text, 'UTF8')), 'hex')
    FROM cuspatlas.patients p WHERE p.id = patient_id
  $$;

-- A merge row describes a merge that really happened in this transaction: the merged identity is
-- marked merged into an active survivor, both identity digests are recomputed by the database, and
-- the move count is the number of recorded moves.
CREATE FUNCTION cuspatlas.patient_merges_integrity_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user <> 'cuspatlas_app' THEN
      RETURN NULL;
    END IF;
    IF NEW.merged_at <> now()
       OR NOT EXISTS (SELECT 1 FROM cuspatlas.patients p WHERE p.id = NEW.merged_patient_id AND p.tenant_id = NEW.tenant_id
                      AND p.merged_into = NEW.survivor_patient_id)
       OR NOT EXISTS (SELECT 1 FROM cuspatlas.patients p WHERE p.id = NEW.survivor_patient_id AND p.tenant_id = NEW.tenant_id
                      AND p.merged_into IS NULL)
       OR cuspatlas.patient_identity_digest(NEW.survivor_patient_id) IS DISTINCT FROM NEW.survivor_digest
       OR cuspatlas.patient_identity_digest(NEW.merged_patient_id) IS DISTINCT FROM NEW.merged_digest
       OR NEW.move_count <> (SELECT count(*) FROM cuspatlas.patient_merge_moves mv WHERE mv.merge_id = NEW.id
                             AND mv.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'a merge record must describe the merge performed in its transaction' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.patient_merges_integrity_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER patient_merges_integrity
  AFTER INSERT ON cuspatlas.patient_merges DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.patient_merges_integrity_guard();

-- A move is recorded only in its merge's own transaction, from the merged patient to the survivor,
-- for a registered record that now references the survivor, with the digest the database computes
-- from that record.
CREATE FUNCTION cuspatlas.patient_merge_moves_integrity_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    m record;
    tbl text := cuspatlas.merge_class_table(NEW.record_class);
    excl text[] := cuspatlas.merge_class_digest_exclude(NEW.record_class);
    ref uuid;
    digest text;
  BEGIN
    IF current_user <> 'cuspatlas_app' THEN
      RETURN NULL;
    END IF;
    SELECT * INTO m FROM cuspatlas.patient_merges WHERE id = NEW.merge_id AND tenant_id = NEW.tenant_id;
    IF m IS NULL OR m.merged_at <> now() OR NEW.prior_patient_id <> m.merged_patient_id
       OR NEW.new_patient_id <> m.survivor_patient_id OR tbl IS NULL
       OR NOT (NEW.reference_column = ANY (excl)) THEN
      RAISE EXCEPTION 'a merge move must belong to the merge of its transaction' USING ERRCODE = '42501';
    END IF;
    EXECUTE format(
      'SELECT (to_jsonb(r) ->> %L)::uuid, encode(sha256(convert_to((to_jsonb(r) - %L::text[])::text, ''UTF8'')), ''hex'')
       FROM cuspatlas.%I r WHERE r.id = $1 AND r.tenant_id = $2', NEW.reference_column, excl, tbl)
      INTO ref, digest USING NEW.record_ref, NEW.tenant_id;
    IF ref IS DISTINCT FROM NEW.new_patient_id OR digest IS DISTINCT FROM NEW.content_digest_after THEN
      RAISE EXCEPTION 'a merge move must describe the moved record' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.patient_merge_moves_integrity_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER patient_merge_moves_integrity
  AFTER INSERT ON cuspatlas.patient_merge_moves DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.patient_merge_moves_integrity_guard();

-- A reversal restores the merged identity in its own transaction.
CREATE FUNCTION cuspatlas.patient_merge_reversals_integrity_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user <> 'cuspatlas_app' THEN
      RETURN NULL;
    END IF;
    IF NEW.reversed_at <> now() OR NOT EXISTS (
         SELECT 1 FROM cuspatlas.patient_merges m JOIN cuspatlas.patients p ON p.id = m.merged_patient_id
           AND p.tenant_id = m.tenant_id
         WHERE m.id = NEW.merge_id AND m.tenant_id = NEW.tenant_id AND p.merged_into IS NULL) THEN
      RAISE EXCEPTION 'a merge reversal must restore the merged identity in its transaction' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.patient_merge_reversals_integrity_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER patient_merge_reversals_integrity
  AFTER INSERT ON cuspatlas.patient_merge_reversals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.patient_merge_reversals_integrity_guard();

-- The identity side: merged_into is set only with a merge row of this transaction and cleared only
-- with a reversal of this transaction.
CREATE FUNCTION cuspatlas.patients_merge_state_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user <> 'cuspatlas_app' OR NEW.merged_into IS NOT DISTINCT FROM OLD.merged_into THEN
      RETURN NULL;
    END IF;
    IF NEW.merged_into IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM cuspatlas.patient_merges m WHERE m.tenant_id = NEW.tenant_id AND m.merged_patient_id = NEW.id
           AND m.survivor_patient_id = NEW.merged_into AND m.merged_at = now()) THEN
      RAISE EXCEPTION 'a patient is marked merged only by a recorded merge' USING ERRCODE = '42501';
    END IF;
    IF NEW.merged_into IS NULL AND NOT EXISTS (
         SELECT 1 FROM cuspatlas.patient_merges m JOIN cuspatlas.patient_merge_reversals r ON r.merge_id = m.id
           AND r.tenant_id = m.tenant_id
         WHERE m.tenant_id = NEW.tenant_id AND m.merged_patient_id = NEW.id AND m.survivor_patient_id = OLD.merged_into
           AND r.reversed_at = now()) THEN
      RAISE EXCEPTION 'a merged patient is restored only by a recorded reversal' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.patients_merge_state_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER patients_merge_state
  AFTER UPDATE OF merged_into ON cuspatlas.patients DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.patients_merge_state_guard();

-- 2. Notes: insert-side integrity.
CREATE TRIGGER clinical_notes_author
  BEFORE INSERT ON cuspatlas.clinical_notes
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'created_by', 'created_by_role', 'created_by_credential_ref');
CREATE TRIGGER clinical_notes_draft_author
  BEFORE INSERT OR UPDATE OF draft_updated_by, draft_updated_by_role, draft_updated_by_credential_ref
  ON cuspatlas.clinical_notes
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'draft_updated_by', 'draft_updated_by_role', 'draft_updated_by_credential_ref');
CREATE TRIGGER clinical_note_versions_author
  BEFORE INSERT ON cuspatlas.clinical_note_versions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'authored_by', 'authored_by_role', 'authored_by_credential_ref');
CREATE TRIGGER clinical_note_cosignatures_author
  BEFORE INSERT ON cuspatlas.clinical_note_cosignatures
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'cosigned_by', 'cosigned_by_role', 'cosigned_by_credential_ref');

-- A draft change is attributed to the actor making it.
CREATE FUNCTION cuspatlas.clinical_notes_draft_actor_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user = 'cuspatlas_app'
       AND (NEW.template_version_id, NEW.draft_sections, NEW.draft_code_refs, NEW.draft_updated_by,
            NEW.draft_updated_by_role, NEW.draft_updated_by_credential_ref, NEW.draft_updated_at)
           IS DISTINCT FROM (OLD.template_version_id, OLD.draft_sections, OLD.draft_code_refs, OLD.draft_updated_by,
            OLD.draft_updated_by_role, OLD.draft_updated_by_credential_ref, OLD.draft_updated_at)
       AND NEW.draft_updated_by IS DISTINCT FROM cuspatlas.current_actor_id() THEN
      RAISE EXCEPTION 'a draft change is attributed to its actor' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_notes_draft_actor_guard() FROM PUBLIC;
CREATE TRIGGER clinical_notes_draft_actor
  BEFORE UPDATE ON cuspatlas.clinical_notes
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_notes_draft_actor_guard();

-- The header counts exactly its frozen versions (so it is signed only with an original), and a
-- version is the next one of its header: the original freezes the draft as it stands, and the
-- co-signature requirement is the encounter's current supervising assignment, never the writer's.
CREATE FUNCTION cuspatlas.clinical_notes_head_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user <> 'cuspatlas_app' THEN
      RETURN NULL;
    END IF;
    IF NEW.head_sequence <> (SELECT count(*) FROM cuspatlas.clinical_note_versions v WHERE v.note_id = NEW.id
                             AND v.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'a note header counts exactly its frozen versions' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_notes_head_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER clinical_notes_head
  AFTER UPDATE ON cuspatlas.clinical_notes DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_notes_head_guard();

CREATE FUNCTION cuspatlas.clinical_note_versions_link_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    n record;
    supervising uuid;
  BEGIN
    IF current_user <> 'cuspatlas_app' THEN
      RETURN NULL;
    END IF;
    SELECT * INTO n FROM cuspatlas.clinical_notes WHERE id = NEW.note_id AND tenant_id = NEW.tenant_id;
    SELECT a.resource_id INTO supervising FROM cuspatlas.clinical_encounter_assignments a
     WHERE a.encounter_id = n.encounter_id AND a.tenant_id = n.tenant_id AND a.role = 'supervising_provider'
     ORDER BY a.sequence DESC LIMIT 1;
    IF n IS NULL OR n.head_sequence <> (SELECT count(*) FROM cuspatlas.clinical_note_versions v
                                        WHERE v.note_id = n.id AND v.tenant_id = n.tenant_id)
       OR NEW.sequence > n.head_sequence
       OR (NEW.sequence = 1 AND (n.state <> 'signed' OR NEW.sections IS DISTINCT FROM n.draft_sections
           OR NEW.code_refs IS DISTINCT FROM n.draft_code_refs OR NEW.template_version_id IS DISTINCT FROM n.template_version_id))
       OR NEW.cosign_required <> (supervising IS NOT NULL)
       OR NEW.supervising_resource_id IS DISTINCT FROM supervising THEN
      RAISE EXCEPTION 'a note version must be the next frozen version of its header' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_note_versions_link_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER clinical_note_versions_link
  AFTER INSERT ON cuspatlas.clinical_note_versions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_note_versions_link_guard();

-- 5. Plans: database backing for the transition rules the domain enforces.
--    The item transition guard is replaced (same checks, plus: a carried-forward state equals its
--    source item's state, reason and appointment; no direct transition under a declined or
--    discontinued detail; a scheduled item names an appointment of the plan's own patient).
CREATE OR REPLACE FUNCTION cuspatlas.clinical_plan_item_events_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    last record;
    src record;
    item record;
  BEGIN
    SELECT e.sequence, e.to_state INTO last FROM cuspatlas.clinical_plan_item_events e
     WHERE e.item_id = NEW.item_id AND e.tenant_id = NEW.tenant_id ORDER BY e.sequence DESC LIMIT 1;
    SELECT i.id, i.detail_id, i.derived_from_item_id, p.subject_patient_id INTO item
      FROM cuspatlas.clinical_plan_items i
      JOIN cuspatlas.clinical_plan_versions v ON v.id = i.plan_version_id AND v.tenant_id = i.tenant_id
      JOIN cuspatlas.clinical_treatment_plans p ON p.id = v.plan_id AND p.tenant_id = v.tenant_id
     WHERE i.id = NEW.item_id AND i.tenant_id = NEW.tenant_id;
    IF NEW.to_state = 'completed' THEN
      RAISE EXCEPTION 'completion is recorded by a rendered procedure (C14)' USING ERRCODE = '42501';
    END IF;
    IF NEW.cause IN ('created', 'carried_forward') THEN
      IF last IS NOT NULL OR NEW.sequence <> 1 OR NEW.from_state IS NOT NULL
         OR (NEW.cause = 'created' AND NEW.to_state <> 'proposed') THEN
        RAISE EXCEPTION 'an item starts with exactly one initial state' USING ERRCODE = '42501';
      END IF;
      IF NEW.cause = 'carried_forward' THEN
        SELECT e.to_state, e.reason_code, e.appointment_id INTO src FROM cuspatlas.clinical_plan_item_events e
         WHERE e.item_id = item.derived_from_item_id AND e.tenant_id = NEW.tenant_id ORDER BY e.sequence DESC LIMIT 1;
        IF item.derived_from_item_id IS NULL OR src IS NULL
           OR (src.to_state, src.reason_code) IS DISTINCT FROM (NEW.to_state, NEW.reason_code)
           OR (NEW.to_state = 'scheduled' AND src.appointment_id IS DISTINCT FROM NEW.appointment_id) THEN
          RAISE EXCEPTION 'a carried-forward item carries its source item state' USING ERRCODE = '42501';
        END IF;
      END IF;
      RETURN NEW;
    END IF;
    IF last IS NULL OR NEW.sequence <> last.sequence + 1 OR NEW.from_state IS DISTINCT FROM last.to_state THEN
      RAISE EXCEPTION 'item transitions are appended in order from the current state' USING ERRCODE = '42501';
    END IF;
    IF (NEW.from_state, NEW.to_state) NOT IN (
         ('proposed', 'accepted'), ('proposed', 'declined'), ('proposed', 'discontinued'),
         ('accepted', 'scheduled'), ('accepted', 'declined'), ('accepted', 'discontinued'),
         ('scheduled', 'accepted'), ('scheduled', 'declined'), ('scheduled', 'discontinued'),
         ('declined', 'proposed')) THEN
      RAISE EXCEPTION 'item transition is not in the allowed set' USING ERRCODE = '42501';
    END IF;
    IF (NEW.from_state, NEW.to_state) IN (('scheduled', 'accepted'), ('declined', 'proposed')) AND NEW.reason_code IS NULL THEN
      RAISE EXCEPTION 'this item transition needs a reason' USING ERRCODE = '42501';
    END IF;
    IF (NEW.cause = 'detail_declined' AND NEW.to_state <> 'declined')
       OR (NEW.cause = 'detail_discontinued' AND NEW.to_state <> 'discontinued') THEN
      RAISE EXCEPTION 'a detail consequence matches the detail state' USING ERRCODE = '42501';
    END IF;
    IF NEW.cause = 'direct' AND EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_detail_events d
                                        WHERE d.detail_id = item.detail_id AND d.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'an item of a declined or discontinued detail takes no direct transition' USING ERRCODE = '42501';
    END IF;
    IF NEW.to_state = 'scheduled' AND NOT EXISTS (
         SELECT 1 FROM cuspatlas.appointments a WHERE a.id = NEW.appointment_id AND a.tenant_id = NEW.tenant_id
           AND a.subject_patient_id = item.subject_patient_id) THEN
      RAISE EXCEPTION 'a scheduled item names an appointment of the plan patient' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_items i
               JOIN cuspatlas.clinical_plan_versions s ON s.supersedes_version_id = i.plan_version_id
                 AND s.tenant_id = i.tenant_id
               WHERE i.id = NEW.item_id AND i.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'items of a superseded plan version are frozen' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;

-- A declined or discontinued detail takes no new item (carried-forward items excepted: superseding
-- copies the detail, its state and its items).
CREATE FUNCTION cuspatlas.clinical_plan_items_detail_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.derived_from_item_id IS NULL AND EXISTS (
         SELECT 1 FROM cuspatlas.clinical_plan_detail_events d WHERE d.detail_id = NEW.detail_id AND d.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'a declined or discontinued detail takes no new item' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_plan_items_detail_guard() FROM PUBLIC;
CREATE TRIGGER clinical_plan_items_detail_active
  BEFORE INSERT ON cuspatlas.clinical_plan_items
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_plan_items_detail_guard();

-- Surfaces fit the tooth class (provisional scope, C6-P1 blocking): anterior M D I F L, posterior
-- M D O B L, supernumerary none; no surface twice. Mirrors PROVISIONAL_SURFACE_SCOPE.
CREATE FUNCTION cuspatlas.tooth_surfaces_valid(tooth text, surfaces text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT surfaces IS NULL OR (
      tooth IS NOT NULL AND tooth NOT LIKE 'sn-%'
      AND cardinality(surfaces) = (SELECT count(DISTINCT s) FROM unnest(surfaces) s)
      AND surfaces <@ CASE WHEN split_part(tooth, '-', 3)::int <= 3 THEN ARRAY['M', 'D', 'I', 'F', 'L']
                           ELSE ARRAY['M', 'D', 'O', 'B', 'L'] END)
  $$;
GRANT EXECUTE ON FUNCTION cuspatlas.tooth_surfaces_valid(text, text[]) TO cuspatlas_app;
ALTER TABLE cuspatlas.clinical_plan_details ADD CONSTRAINT clinical_plan_details_surface_class
  CHECK (cuspatlas.tooth_surfaces_valid(tooth_canonical_ref, surfaces));
ALTER TABLE cuspatlas.clinical_plan_items ADD CONSTRAINT clinical_plan_items_surface_class
  CHECK (cuspatlas.tooth_surfaces_valid(tooth_canonical_ref, surfaces));
ALTER TABLE cuspatlas.clinical_chart_entries ADD CONSTRAINT clinical_chart_entries_surface_class
  CHECK (cuspatlas.tooth_surfaces_valid(tooth_canonical_ref, surfaces));
