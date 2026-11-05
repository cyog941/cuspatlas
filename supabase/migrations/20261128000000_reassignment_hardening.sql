-- Hardening H1 (R1, R3): S22 reassignment refuses linked scheduling facts and the relink guard
-- re-checks every blocker itself. Synthetic data only. New migration; applied migrations are never
-- edited.
--
-- appointment_reassignment_blocker(tenant, appointment, target) names the first blocker or NULL:
--   attendance (non-booking) or clinical encounter facts; an active visit context item; a series
--   occurrence or exception; a waitlist entry, offer or cancellation recovery; a target patient that is
--   merged or not active.

CREATE FUNCTION cuspatlas.appointment_reassignment_blocker(t uuid, appt uuid, target uuid) RETURNS text
  LANGUAGE sql STABLE
  AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM cuspatlas.appointment_attendance_transitions x
                 WHERE x.tenant_id = t AND x.appointment_id = appt AND x.source <> 'booking_command')
      THEN 'attendance_recorded'
    WHEN EXISTS (SELECT 1 FROM cuspatlas.clinical_encounters e WHERE e.tenant_id = t AND e.appointment_id = appt)
      THEN 'clinical_facts_attached'
    WHEN EXISTS (SELECT 1 FROM cuspatlas.visit_context_items v
                 WHERE v.tenant_id = t AND v.appointment_id = appt AND v.state = 'active')
      THEN 'visit_context_active'
    WHEN EXISTS (SELECT 1 FROM cuspatlas.appointment_series_occurrences o WHERE o.tenant_id = t AND o.appointment_id = appt)
      OR EXISTS (SELECT 1 FROM cuspatlas.appointment_series_exceptions x WHERE x.tenant_id = t AND x.appointment_id = appt)
      THEN 'series_linked'
    WHEN EXISTS (SELECT 1 FROM cuspatlas.waitlist_entries w WHERE w.tenant_id = t AND w.appointment_id = appt)
      OR EXISTS (SELECT 1 FROM cuspatlas.waitlist_offers w WHERE w.tenant_id = t AND w.appointment_id = appt)
      OR EXISTS (SELECT 1 FROM cuspatlas.cancellation_recoveries c
                 WHERE c.tenant_id = t AND (c.appointment_id = appt OR c.filled_appointment_id = appt))
      THEN 'waitlist_linked'
    WHEN NOT EXISTS (SELECT 1 FROM cuspatlas.patients p
                     WHERE p.tenant_id = t AND p.id = target AND p.status = 'active' AND p.merged_into IS NULL)
      THEN 'target_patient_not_active'
    ELSE NULL
  END
$$;
REVOKE ALL ON FUNCTION cuspatlas.appointment_reassignment_blocker(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.appointment_reassignment_blocker(uuid, uuid, uuid) TO cuspatlas_app;

CREATE OR REPLACE FUNCTION cuspatlas.appointment_patient_reassignments_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  blocker text := cuspatlas.appointment_reassignment_blocker(NEW.tenant_id, NEW.appointment_id, NEW.new_patient_id);
BEGIN
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'appointment reassignment refused: %', blocker USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cuspatlas.appointment_patient_reassignments_guard() FROM PUBLIC;

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
      -- R3 (hardening H1): self-contained; the move is re-checked here, not only at the reassignment
      -- insert, so a fact written between the two statements still refuses it.
      IF cuspatlas.appointment_reassignment_blocker(NEW.tenant_id, NEW.id, n) IS NOT NULL THEN
        RAISE EXCEPTION 'appointment patient move refused: %',
          cuspatlas.appointment_reassignment_blocker(NEW.tenant_id, NEW.id, n) USING ERRCODE = '42501';
      END IF;
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
