-- S22 (OR-11): reassigning an appointment's patient. Synthetic data only. New migration; applied
-- migrations are never edited.
--
-- 1. appointment_patient_reassignments: append-only history of each reassignment (both identities
--    kept; excluded from merges, see MERGE_EXCLUDED_REFERENCES).
-- 2. Defense in depth: a reassignment row is refused when any staff or automation attendance fact,
--    clinical encounter (C5, which carries notes C10 and procedures C14) references the appointment.
--    Billing charges are reached only through C14 procedures, so the encounter check covers them.
-- 3. merge_reference_relink_guard: the appointments relink guard also admits a move recorded by a
--    reassignment of this transaction (replaced below with that one added branch).
-- 4. Reverse race: an encounter insert re-reads its appointment's patient with a key-share lock, so it
--    waits for a concurrent reassignment and then refuses a stale patient (serialization failure).

CREATE TABLE cuspatlas.appointment_patient_reassignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  prior_patient_id uuid NOT NULL,
  new_patient_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  appointment_version integer NOT NULL CHECK (appointment_version >= 2),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  reassigned_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES cuspatlas.appointments (id, tenant_id),
  FOREIGN KEY (prior_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (new_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  CHECK (prior_patient_id <> new_patient_id)
);
CREATE INDEX appointment_patient_reassignments_appointment
  ON cuspatlas.appointment_patient_reassignments (tenant_id, appointment_id);
CREATE TRIGGER appointment_patient_reassignments_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.appointment_patient_reassignments
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

CREATE FUNCTION cuspatlas.appointment_patient_reassignments_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cuspatlas.appointment_attendance_transitions t
             WHERE t.tenant_id = NEW.tenant_id AND t.appointment_id = NEW.appointment_id
               AND t.source <> 'booking_command')
     OR EXISTS (SELECT 1 FROM cuspatlas.clinical_encounters e
                WHERE e.tenant_id = NEW.tenant_id AND e.appointment_id = NEW.appointment_id) THEN
    RAISE EXCEPTION 'an appointment with attendance or clinical facts keeps its patient' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cuspatlas.appointment_patient_reassignments_guard() FROM PUBLIC;
CREATE TRIGGER appointment_patient_reassignments_guard
  BEFORE INSERT ON cuspatlas.appointment_patient_reassignments
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.appointment_patient_reassignments_guard();

ALTER TABLE cuspatlas.appointment_patient_reassignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.appointment_patient_reassignments FORCE ROW LEVEL SECURITY;
CREATE POLICY appointment_patient_reassignments_select ON cuspatlas.appointment_patient_reassignments
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY appointment_patient_reassignments_insert ON cuspatlas.appointment_patient_reassignments
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.appointment_patient_reassignments TO cuspatlas_app;

CREATE OR REPLACE FUNCTION cuspatlas.merge_reference_relink_guard() RETURNS trigger
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
    -- S22 (OR-11): an appointment's patient also moves with a reassignment recorded for exactly this
    -- record, old and new patient, in this very transaction.
    IF TG_TABLE_NAME = 'appointments' AND EXISTS (
      SELECT 1 FROM cuspatlas.appointment_patient_reassignments r
      WHERE r.tenant_id = NEW.tenant_id AND r.appointment_id = NEW.id AND r.prior_patient_id = o
        AND r.new_patient_id = n AND r.reassigned_at = now()
    ) THEN
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

CREATE FUNCTION cuspatlas.clinical_encounter_appointment_patient_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  current_patient uuid;
BEGIN
  IF NEW.appointment_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT a.subject_patient_id INTO current_patient FROM cuspatlas.appointments a
  WHERE a.id = NEW.appointment_id AND a.tenant_id = NEW.tenant_id FOR KEY SHARE;
  IF current_patient IS DISTINCT FROM NEW.subject_patient_id THEN
    RAISE EXCEPTION 'the appointment patient changed concurrently' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_encounter_appointment_patient_guard() FROM PUBLIC;
CREATE TRIGGER clinical_encounters_appointment_patient_guard
  BEFORE INSERT ON cuspatlas.clinical_encounters
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_encounter_appointment_patient_guard();
