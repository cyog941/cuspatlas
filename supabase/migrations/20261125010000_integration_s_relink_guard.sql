-- Integration hardening (codex/backend-integration; synthetic data only): the S-owned patient
-- references registered in the merge registry get the same database relink guard as the C records
-- (20261108030000, bound to the merge or reversal of its own transaction by 20261109100000). New
-- migration; applied migrations are never edited.
--
-- A merge-registered S reference (patient_relationships.subject_patient_id and
-- .counterparty_patient_id, appointment_requests, appointments, appointment_series and
-- waitlist_entries .subject_patient_id) moves only:
--   forward  (merged -> survivor): with a merge of that pair recorded in this very transaction (its
--            patients.merged_into NULL -> survivor observed now), not reversed, listing this record and
--            column as moved;
--   reversal (survivor -> merged): with the reversal of that merge recorded in this very transaction
--            (merged_into survivor -> NULL observed now), a listed move of this record and column, and
--            no later merge that moved this record and column (the merge is the record's lineage).
-- Excluded S references (recall_tasks.subject_patient_id: a recall task stays with the identity it
-- was created for) never move under the runtime role.
--
-- Scope as in the C guards (20261109050000): the checks bind the runtime role `cuspatlas_app`;
-- privileged roles (restore, owner, superuser) can disable triggers in any case.
CREATE FUNCTION cuspatlas.merge_reference_relink_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    col text := TG_ARGV[0];
    o uuid := (to_jsonb(OLD) ->> col)::uuid;
    n uuid := (to_jsonb(NEW) ->> col)::uuid;
  BEGIN
    IF o IS NOT DISTINCT FROM n OR current_user <> 'cuspatlas_app' THEN
      RETURN NULL;
    END IF;
    IF EXISTS (
      SELECT 1 FROM cuspatlas.patient_merges m
      JOIN cuspatlas.patient_merge_moves mv ON mv.merge_id = m.id AND mv.tenant_id = m.tenant_id
      WHERE m.tenant_id = NEW.tenant_id AND mv.record_ref = NEW.id AND mv.reference_column = col
        AND cuspatlas.merge_class_table(mv.record_class) = TG_TABLE_NAME
        AND m.merged_patient_id = o AND m.survivor_patient_id = n
        AND m.merged_at = now()
        AND cuspatlas.patient_reference_moved_now('patients', 'merged_into', m.merged_patient_id, NULL,
                                                  m.survivor_patient_id)
        AND NOT EXISTS (SELECT 1 FROM cuspatlas.patient_merge_reversals r WHERE r.merge_id = m.id)
    ) THEN
      RETURN NULL;
    END IF;
    IF EXISTS (
      SELECT 1 FROM cuspatlas.patient_merges m
      JOIN cuspatlas.patient_merge_moves mv ON mv.merge_id = m.id AND mv.tenant_id = m.tenant_id
      JOIN cuspatlas.patient_merge_reversals r ON r.merge_id = m.id AND r.tenant_id = m.tenant_id
      WHERE m.tenant_id = NEW.tenant_id AND mv.record_ref = NEW.id AND mv.reference_column = col
        AND cuspatlas.merge_class_table(mv.record_class) = TG_TABLE_NAME
        AND m.survivor_patient_id = o AND m.merged_patient_id = n
        AND r.reversed_at = now()
        AND cuspatlas.patient_reference_moved_now('patients', 'merged_into', m.merged_patient_id,
                                                  m.survivor_patient_id, NULL)
        AND cuspatlas.patient_reference_moved_now(TG_TABLE_NAME, col, NEW.id, o, n)
        AND NOT EXISTS (
          SELECT 1 FROM cuspatlas.patient_merge_moves later_mv
          JOIN cuspatlas.patient_merges later ON later.id = later_mv.merge_id AND later.tenant_id = later_mv.tenant_id
          WHERE later_mv.tenant_id = NEW.tenant_id AND later_mv.record_ref = NEW.id
            AND later_mv.reference_column = col
            AND cuspatlas.merge_class_table(later_mv.record_class) = TG_TABLE_NAME
            AND later.id <> m.id AND later.merged_at > m.merged_at)
    ) THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'a patient reference moves only with the merge or reversal of its transaction'
      USING ERRCODE = '42501';
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.merge_reference_relink_guard() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER patient_relationships_subject_relink
  AFTER UPDATE OF subject_patient_id ON cuspatlas.patient_relationships DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.merge_reference_relink_guard('subject_patient_id');
CREATE CONSTRAINT TRIGGER patient_relationships_counterparty_relink
  AFTER UPDATE OF counterparty_patient_id ON cuspatlas.patient_relationships DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.merge_reference_relink_guard('counterparty_patient_id');
CREATE CONSTRAINT TRIGGER appointment_requests_relink
  AFTER UPDATE OF subject_patient_id ON cuspatlas.appointment_requests DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.merge_reference_relink_guard('subject_patient_id');
CREATE CONSTRAINT TRIGGER appointments_relink
  AFTER UPDATE OF subject_patient_id ON cuspatlas.appointments DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.merge_reference_relink_guard('subject_patient_id');
CREATE CONSTRAINT TRIGGER appointment_series_relink
  AFTER UPDATE OF subject_patient_id ON cuspatlas.appointment_series DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.merge_reference_relink_guard('subject_patient_id');
CREATE CONSTRAINT TRIGGER waitlist_entries_relink
  AFTER UPDATE OF subject_patient_id ON cuspatlas.waitlist_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.merge_reference_relink_guard('subject_patient_id');

-- Excluded S reference: a recall task's patient never moves under the runtime role.
CREATE FUNCTION cuspatlas.excluded_reference_immutable_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user = 'cuspatlas_app'
       AND (to_jsonb(OLD) ->> TG_ARGV[0]) IS DISTINCT FROM (to_jsonb(NEW) ->> TG_ARGV[0]) THEN
      RAISE EXCEPTION 'this patient reference is excluded from merges and never moves' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.excluded_reference_immutable_guard() FROM PUBLIC;
CREATE TRIGGER recall_tasks_subject_immutable BEFORE UPDATE OF subject_patient_id ON cuspatlas.recall_tasks
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.excluded_reference_immutable_guard('subject_patient_id');
