-- C14: rendered procedures and the billing boundary (synthetic data only). A rendered procedure is
-- the clinical fact that a procedure was actually performed: encounter, rendering provider, date of
-- service, provisional SYN- code, tooth and surfaces, the plan item it completes (or none:
-- unscheduled treatment), and its human clinical author. It carries no amount and no narrative.
-- Corrections are a reversal row plus an optional replacement row, both linked; nothing is updated
-- or deleted. Each row is its own outbox aggregate; billing (B) consumes the outbox event and reads
-- the immutable row it names (the C14 -> B boundary in foundation-contract-decisions.md).
-- Attendance (S11), booking (S10) and encounter close (C5) never complete a plan item: only a
-- rendered procedure does.

CREATE TABLE cuspatlas.clinical_rendered_procedures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rendered', 'reversal')),
  encounter_id uuid NOT NULL,
  -- The encounter's patient when the fact was recorded (the event's patientRef). The current patient
  -- is the encounter's, which follows merges; this column never moves.
  origin_patient_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 999),
  plan_item_id uuid,
  provenance text NOT NULL CHECK (provenance IN ('planned', 'unscheduled', 'correction')),
  code_ref text NOT NULL CHECK (code_ref ~ '^SYN-[A-Z0-9-]{1,40}$'),
  tooth_canonical_ref text CHECK (tooth_canonical_ref ~ '^(perm-(ur|ul|ll|lr)-[1-8]|prim-(ur|ul|ll|lr)-[1-5]|sn-(ur|ul|ll|lr)-[1-4])$'),
  tooth_vocabulary text CHECK (tooth_vocabulary IN ('cuspatlas-tooth.v1')),
  surfaces text[] CHECK (cardinality(surfaces) BETWEEN 1 AND 7),
  chart_entry_id uuid,
  date_of_service date NOT NULL,
  rendering_provider_id uuid NOT NULL,
  provider_override_reason text CHECK (provider_override_reason ~ '^[a-z_]{1,64}$'),
  duplicate_intent text CHECK (duplicate_intent IN ('repeat_in_visit', 'additional_visit')),
  reverses_procedure_id uuid,
  replaces_procedure_id uuid,
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_by_role text NOT NULL CHECK (recorded_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  recorded_by_credential_ref text CHECK (recorded_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (encounter_id, tenant_id) REFERENCES cuspatlas.clinical_encounters (id, tenant_id),
  FOREIGN KEY (origin_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (plan_item_id, tenant_id) REFERENCES cuspatlas.clinical_plan_items (id, tenant_id),
  FOREIGN KEY (chart_entry_id, tenant_id) REFERENCES cuspatlas.clinical_chart_entries (id, tenant_id),
  FOREIGN KEY (rendering_provider_id, tenant_id) REFERENCES cuspatlas.scheduling_resources (id, tenant_id),
  FOREIGN KEY (reverses_procedure_id, tenant_id) REFERENCES cuspatlas.clinical_rendered_procedures (id, tenant_id),
  FOREIGN KEY (replaces_procedure_id, tenant_id) REFERENCES cuspatlas.clinical_rendered_procedures (id, tenant_id),
  UNIQUE (id, tenant_id),
  -- One reversal per procedure, one replacement per reversed procedure.
  UNIQUE (tenant_id, reverses_procedure_id),
  UNIQUE (tenant_id, replaces_procedure_id),
  CHECK ((tooth_canonical_ref IS NULL) = (tooth_vocabulary IS NULL)),
  CHECK (surfaces IS NULL OR tooth_canonical_ref IS NOT NULL),
  CHECK (cuspatlas.tooth_surfaces_valid(tooth_canonical_ref, surfaces)),
  CHECK ((kind = 'reversal') = (reverses_procedure_id IS NOT NULL)),
  CHECK (kind = 'rendered' OR replaces_procedure_id IS NULL),
  CHECK ((kind = 'reversal' OR replaces_procedure_id IS NOT NULL) = (reason_code IS NOT NULL)),
  CHECK ((provenance = 'planned') = (plan_item_id IS NOT NULL AND kind = 'rendered' AND replaces_procedure_id IS NULL)
         OR (provenance = 'correction' AND (kind = 'reversal' OR replaces_procedure_id IS NOT NULL))),
  CHECK (provenance <> 'unscheduled' OR plan_item_id IS NULL)
);
CREATE INDEX clinical_rendered_procedures_encounter ON cuspatlas.clinical_rendered_procedures (tenant_id, encounter_id);
CREATE INDEX clinical_rendered_procedures_item ON cuspatlas.clinical_rendered_procedures (tenant_id, plan_item_id);

-- Insert-side rules the domain also enforces: the provider is a provider resource; a reversal mirrors
-- the procedure it reverses (same encounter, patient, code, tooth, surfaces, item, provider and date);
-- a reversal targets a rendered row that is not itself reversed; a replacement names a reversed row of
-- the same encounter; a new rendering (not a correction) needs an open encounter; the origin patient
-- is the encounter's patient at insert.
CREATE FUNCTION cuspatlas.clinical_rendered_procedures_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    target record;
    enc record;
  BEGIN
    SELECT e.subject_patient_id, e.state INTO enc FROM cuspatlas.clinical_encounters e
     WHERE e.id = NEW.encounter_id AND e.tenant_id = NEW.tenant_id;
    IF NOT EXISTS (SELECT 1 FROM cuspatlas.scheduling_resources r WHERE r.id = NEW.rendering_provider_id
                   AND r.tenant_id = NEW.tenant_id AND r.kind = 'provider') THEN
      RAISE EXCEPTION 'a rendering provider is a provider resource' USING ERRCODE = '42501';
    END IF;
    IF NEW.kind = 'reversal' THEN
      SELECT * INTO target FROM cuspatlas.clinical_rendered_procedures p
       WHERE p.id = NEW.reverses_procedure_id AND p.tenant_id = NEW.tenant_id;
      IF target.kind <> 'rendered'
         OR (NEW.encounter_id, NEW.origin_patient_id, NEW.code_ref, NEW.tooth_canonical_ref, NEW.surfaces, NEW.plan_item_id,
             NEW.rendering_provider_id, NEW.date_of_service, NEW.sequence)
            IS DISTINCT FROM (target.encounter_id, target.origin_patient_id, target.code_ref, target.tooth_canonical_ref,
             target.surfaces, target.plan_item_id, target.rendering_provider_id, target.date_of_service, target.sequence) THEN
        RAISE EXCEPTION 'a reversal mirrors the rendered procedure it reverses' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.replaces_procedure_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_rendered_procedures p
                     JOIN cuspatlas.clinical_rendered_procedures r ON r.reverses_procedure_id = p.id AND r.tenant_id = p.tenant_id
                     WHERE p.id = NEW.replaces_procedure_id AND p.tenant_id = NEW.tenant_id
                       AND p.encounter_id = NEW.encounter_id) THEN
        RAISE EXCEPTION 'a replacement names a reversed procedure of the same encounter' USING ERRCODE = '42501';
      END IF;
    ELSIF enc.state IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'a procedure is rendered in an open encounter' USING ERRCODE = '42501';
    END IF;
    IF NEW.origin_patient_id IS DISTINCT FROM enc.subject_patient_id THEN
      RAISE EXCEPTION 'a rendered procedure names its encounter patient' USING ERRCODE = '42501';
    END IF;
    IF NEW.plan_item_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM cuspatlas.clinical_plan_items i
         JOIN cuspatlas.clinical_plan_versions v ON v.id = i.plan_version_id AND v.tenant_id = i.tenant_id
         JOIN cuspatlas.clinical_treatment_plans pl ON pl.id = v.plan_id AND pl.tenant_id = v.tenant_id
         WHERE i.id = NEW.plan_item_id AND i.tenant_id = NEW.tenant_id AND pl.subject_patient_id = enc.subject_patient_id
           AND i.procedure_code_ref = NEW.code_ref) THEN
      RAISE EXCEPTION 'a planned procedure renders an item of the encounter patient with its code' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_rendered_procedures_insert_guard() FROM PUBLIC;
CREATE TRIGGER clinical_rendered_procedures_insert
  BEFORE INSERT ON cuspatlas.clinical_rendered_procedures
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_rendered_procedures_insert_guard();
CREATE TRIGGER clinical_rendered_procedures_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_rendered_procedures
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_rendered_procedures_author
  BEFORE INSERT ON cuspatlas.clinical_rendered_procedures
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'recorded_by', 'recorded_by_role', 'recorded_by_credential_ref');

-- Item completion: the item-event CHECK and the transition guard are extended. `completed` is
-- reachable only from accepted or scheduled with cause `rendered`, naming a rendered procedure of
-- that very item; a reversal of that procedure returns the item to `accepted` (cause
-- `render_reversed`, naming the reversal). Completed is otherwise terminal.
ALTER TABLE cuspatlas.clinical_plan_item_events ADD COLUMN rendered_procedure_id uuid;
ALTER TABLE cuspatlas.clinical_plan_item_events ADD CONSTRAINT clinical_plan_item_events_procedure
  FOREIGN KEY (rendered_procedure_id, tenant_id) REFERENCES cuspatlas.clinical_rendered_procedures (id, tenant_id);
ALTER TABLE cuspatlas.clinical_plan_item_events DROP CONSTRAINT clinical_plan_item_events_cause_check;
ALTER TABLE cuspatlas.clinical_plan_item_events ADD CONSTRAINT clinical_plan_item_events_cause_check
  CHECK (cause IN ('created', 'direct', 'detail_declined', 'detail_discontinued', 'carried_forward', 'rendered',
    'render_reversed'));
ALTER TABLE cuspatlas.clinical_plan_item_events ADD CONSTRAINT clinical_plan_item_events_procedure_cause
  CHECK ((cause IN ('rendered', 'render_reversed')) = (rendered_procedure_id IS NOT NULL));

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
      ELSIF NEW.to_state = 'completed' THEN
        RAISE EXCEPTION 'completion is recorded by a rendered procedure (C14)' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF last IS NULL OR NEW.sequence <> last.sequence + 1 OR NEW.from_state IS DISTINCT FROM last.to_state THEN
      RAISE EXCEPTION 'item transitions are appended in order from the current state' USING ERRCODE = '42501';
    END IF;
    IF NEW.cause = 'rendered' THEN
      IF NEW.to_state <> 'completed' OR NEW.from_state NOT IN ('accepted', 'scheduled') OR NOT EXISTS (
           SELECT 1 FROM cuspatlas.clinical_rendered_procedures p WHERE p.id = NEW.rendered_procedure_id
             AND p.tenant_id = NEW.tenant_id AND p.kind = 'rendered' AND p.plan_item_id = NEW.item_id) THEN
        RAISE EXCEPTION 'completion names a rendered procedure of this item' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.cause = 'render_reversed' THEN
      IF NEW.from_state <> 'completed' OR NEW.to_state <> 'accepted' OR NOT EXISTS (
           SELECT 1 FROM cuspatlas.clinical_rendered_procedures r
           JOIN cuspatlas.clinical_rendered_procedures p ON p.id = r.reverses_procedure_id AND p.tenant_id = r.tenant_id
           WHERE r.id = NEW.rendered_procedure_id AND r.tenant_id = NEW.tenant_id AND p.plan_item_id = NEW.item_id) THEN
        RAISE EXCEPTION 'a reversed completion names the reversal of this item' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NEW.to_state = 'completed' THEN
        RAISE EXCEPTION 'completion is recorded by a rendered procedure (C14)' USING ERRCODE = '42501';
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

ALTER TABLE cuspatlas.clinical_rendered_procedures ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_rendered_procedures FORCE ROW LEVEL SECURITY;
CREATE POLICY clinical_rendered_procedures_select ON cuspatlas.clinical_rendered_procedures
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_rendered_procedures_insert ON cuspatlas.clinical_rendered_procedures
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.clinical_rendered_procedures TO cuspatlas_app;
