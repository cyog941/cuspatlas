-- C11: treatment plan, detail and item (synthetic data only). Semantics are
-- recommended-pending-clinical-approval: provisional SYN- procedure codes (C-D2, no licensed code
-- set), a designed item transition set, and a provisional area vocabulary. Three addressable
-- levels: a plan version contains details; a detail contains items. No level stores an amount: an
-- item names a fee schedule reference or nothing (estimate-incomplete). Plan-version acceptance is
-- recorded by C12 through its seam; accepted content is immutable and a change is a new version.
-- Item state changes are append-only events; completion belongs to rendered procedures (C14).

-- The plan identity follows its patient (S6 relinks only subject_patient_id); versions, details,
-- items and events reference the plan, never the patient.
CREATE TABLE cuspatlas.clinical_treatment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  origin_patient_id uuid NOT NULL,
  head_version integer NOT NULL DEFAULT 1 CHECK (head_version >= 1),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_by_role text NOT NULL CHECK (created_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  created_by_credential_ref text CHECK (created_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (origin_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (id, tenant_id)
);
CREATE INDEX clinical_treatment_plans_subject ON cuspatlas.clinical_treatment_plans (tenant_id, subject_patient_id);

CREATE FUNCTION cuspatlas.clinical_treatment_plans_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'treatment plans are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (NEW.id, NEW.tenant_id, NEW.origin_patient_id, NEW.created_by, NEW.created_by_role,
        NEW.created_by_credential_ref, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.origin_patient_id, OLD.created_by, OLD.created_by_role,
        OLD.created_by_credential_ref, OLD.created_at) THEN
      RAISE EXCEPTION 'treatment plan identity is immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.head_version NOT IN (OLD.head_version, OLD.head_version + 1) THEN
      RAISE EXCEPTION 'plan versions are appended one at a time' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'plan version counter must increase by one' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_treatment_plans_guard() FROM PUBLIC;
CREATE TRIGGER clinical_treatment_plans_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_treatment_plans
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_treatment_plans_guard();

-- A plan version: number, the version it supersedes (one successor at most), its revision (the
-- optimistic-concurrency token of every edit) and, once C12 records it, the acceptance.
CREATE TABLE cuspatlas.clinical_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  number integer NOT NULL CHECK (number >= 1),
  supersedes_version_id uuid,
  supersede_reason_code text CHECK (supersede_reason_code ~ '^[a-z_]{1,64}$'),
  display_text text CHECK (char_length(display_text) BETWEEN 1 AND 200),
  encounter_id uuid,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'accepted')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  acceptance_ref uuid,
  accepted_at timestamptz,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_by_role text NOT NULL CHECK (created_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  created_by_credential_ref text CHECK (created_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (plan_id, tenant_id) REFERENCES cuspatlas.clinical_treatment_plans (id, tenant_id),
  FOREIGN KEY (encounter_id, tenant_id) REFERENCES cuspatlas.clinical_encounters (id, tenant_id),
  FOREIGN KEY (supersedes_version_id, plan_id, tenant_id)
    REFERENCES cuspatlas.clinical_plan_versions (id, plan_id, tenant_id),
  UNIQUE (plan_id, number),
  UNIQUE (id, tenant_id),
  UNIQUE (id, plan_id, tenant_id),
  UNIQUE (tenant_id, supersedes_version_id),
  CHECK ((supersedes_version_id IS NULL) = (number = 1)),
  CHECK ((supersedes_version_id IS NULL) = (supersede_reason_code IS NULL)),
  CHECK ((state = 'accepted') = (accepted_at IS NOT NULL) AND (state = 'accepted') = (acceptance_ref IS NOT NULL))
);

CREATE FUNCTION cuspatlas.clinical_plan_versions_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'plan versions are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (NEW.id, NEW.tenant_id, NEW.plan_id, NEW.number, NEW.supersedes_version_id, NEW.supersede_reason_code,
        NEW.display_text, NEW.encounter_id, NEW.created_by, NEW.created_by_role, NEW.created_by_credential_ref,
        NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.plan_id, OLD.number, OLD.supersedes_version_id,
        OLD.supersede_reason_code, OLD.display_text, OLD.encounter_id, OLD.created_by, OLD.created_by_role,
        OLD.created_by_credential_ref, OLD.created_at) THEN
      RAISE EXCEPTION 'plan version content is immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'plan revision must increase by one' USING ERRCODE = '42501';
    END IF;
    IF OLD.state = 'accepted' AND (NEW.state, NEW.acceptance_ref, NEW.accepted_at)
       IS DISTINCT FROM (OLD.state, OLD.acceptance_ref, OLD.accepted_at) THEN
      RAISE EXCEPTION 'an accepted plan version stays accepted' USING ERRCODE = '42501';
    END IF;
    IF OLD.state = 'draft' AND NEW.state = 'accepted' AND EXISTS (
      SELECT 1 FROM cuspatlas.clinical_plan_versions s WHERE s.supersedes_version_id = OLD.id) THEN
      RAISE EXCEPTION 'a superseded plan version cannot be accepted' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_plan_versions_guard() FROM PUBLIC;
CREATE TRIGGER clinical_plan_versions_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_plan_versions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_plan_versions_guard();

CREATE TABLE cuspatlas.clinical_plan_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  plan_version_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  phase integer CHECK (phase BETWEEN 1 AND 99),
  scope text NOT NULL CHECK (scope IN ('tooth', 'surface_set', 'area', 'whole_mouth')),
  tooth_canonical_ref text CHECK (tooth_canonical_ref ~ '^(perm-(ur|ul|ll|lr)-[1-8]|prim-(ur|ul|ll|lr)-[1-5]|sn-(ur|ul|ll|lr)-[1-4])$'),
  tooth_vocabulary text CHECK (tooth_vocabulary IN ('cuspatlas-tooth.v1')),
  surfaces text[] CHECK (cardinality(surfaces) BETWEEN 1 AND 7 AND surfaces <@ ARRAY['M', 'D', 'O', 'I', 'B', 'F', 'L']::text[]),
  area_code text CHECK (area_code IN ('ur', 'ul', 'll', 'lr', 'upper', 'lower')),
  chart_entry_id uuid,
  display_text text CHECK (char_length(display_text) BETWEEN 1 AND 200),
  derived_from_detail_id uuid,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_by_role text NOT NULL CHECK (created_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  created_by_credential_ref text CHECK (created_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (plan_version_id, tenant_id) REFERENCES cuspatlas.clinical_plan_versions (id, tenant_id),
  FOREIGN KEY (chart_entry_id, tenant_id) REFERENCES cuspatlas.clinical_chart_entries (id, tenant_id),
  FOREIGN KEY (derived_from_detail_id, tenant_id) REFERENCES cuspatlas.clinical_plan_details (id, tenant_id),
  UNIQUE (plan_version_id, sequence),
  UNIQUE (id, tenant_id),
  UNIQUE (id, plan_version_id, tenant_id),
  CHECK ((tooth_canonical_ref IS NULL) = (tooth_vocabulary IS NULL)),
  CHECK ((scope IN ('tooth', 'surface_set')) = (tooth_canonical_ref IS NOT NULL)),
  CHECK ((scope = 'surface_set') = (surfaces IS NOT NULL)),
  CHECK ((scope = 'area') = (area_code IS NOT NULL))
);

-- An item always belongs to a detail of the same version (composite key), and carries no amount.
CREATE TABLE cuspatlas.clinical_plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  detail_id uuid NOT NULL,
  plan_version_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 999),
  procedure_code_ref text NOT NULL CHECK (procedure_code_ref ~ '^SYN-[A-Z0-9-]{1,40}$'),
  tooth_canonical_ref text CHECK (tooth_canonical_ref ~ '^(perm-(ur|ul|ll|lr)-[1-8]|prim-(ur|ul|ll|lr)-[1-5]|sn-(ur|ul|ll|lr)-[1-4])$'),
  tooth_vocabulary text CHECK (tooth_vocabulary IN ('cuspatlas-tooth.v1')),
  surfaces text[] CHECK (cardinality(surfaces) BETWEEN 1 AND 7 AND surfaces <@ ARRAY['M', 'D', 'O', 'I', 'B', 'F', 'L']::text[]),
  area_code text CHECK (area_code IN ('ur', 'ul', 'll', 'lr', 'upper', 'lower')),
  fee_schedule_ref text CHECK (fee_schedule_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  chart_entry_id uuid,
  display_text text CHECK (char_length(display_text) BETWEEN 1 AND 200),
  derived_from_item_id uuid,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_by_role text NOT NULL CHECK (created_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  created_by_credential_ref text CHECK (created_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (detail_id, plan_version_id, tenant_id)
    REFERENCES cuspatlas.clinical_plan_details (id, plan_version_id, tenant_id),
  FOREIGN KEY (chart_entry_id, tenant_id) REFERENCES cuspatlas.clinical_chart_entries (id, tenant_id),
  FOREIGN KEY (derived_from_item_id, tenant_id) REFERENCES cuspatlas.clinical_plan_items (id, tenant_id),
  UNIQUE (id, tenant_id),
  CHECK ((tooth_canonical_ref IS NULL) = (tooth_vocabulary IS NULL)),
  CHECK (surfaces IS NULL OR tooth_canonical_ref IS NOT NULL),
  CHECK (area_code IS NULL OR tooth_canonical_ref IS NULL)
);
CREATE INDEX clinical_plan_items_detail ON cuspatlas.clinical_plan_items (tenant_id, detail_id);

-- A detail takes at most one terminal state (declined or discontinued), with a reason and author.
CREATE TABLE cuspatlas.clinical_plan_detail_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  detail_id uuid NOT NULL,
  to_state text NOT NULL CHECK (to_state IN ('declined', 'discontinued')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  carried_from_event_id uuid,
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_by_role text NOT NULL CHECK (recorded_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  recorded_by_credential_ref text CHECK (recorded_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (detail_id, tenant_id) REFERENCES cuspatlas.clinical_plan_details (id, tenant_id),
  FOREIGN KEY (carried_from_event_id, tenant_id) REFERENCES cuspatlas.clinical_plan_detail_events (id, tenant_id),
  UNIQUE (detail_id),
  UNIQUE (id, tenant_id)
);

-- Item state history. The transition set is designed (pending clinical approval) and enforced by
-- the guard below: completed is never written here (C14 records rendered procedures).
CREATE TABLE cuspatlas.clinical_plan_item_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  from_state text CHECK (from_state IN ('proposed', 'accepted', 'scheduled', 'completed', 'declined', 'discontinued')),
  to_state text NOT NULL CHECK (to_state IN ('proposed', 'accepted', 'scheduled', 'completed', 'declined', 'discontinued')),
  cause text NOT NULL CHECK (cause IN ('created', 'direct', 'detail_declined', 'detail_discontinued', 'carried_forward')),
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  parent_detail_id uuid,
  appointment_id uuid,
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_by_role text NOT NULL CHECK (recorded_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  recorded_by_credential_ref text CHECK (recorded_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (item_id, tenant_id) REFERENCES cuspatlas.clinical_plan_items (id, tenant_id),
  FOREIGN KEY (parent_detail_id, tenant_id) REFERENCES cuspatlas.clinical_plan_details (id, tenant_id),
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES cuspatlas.appointments (id, tenant_id),
  UNIQUE (item_id, sequence),
  CHECK ((to_state = 'scheduled') = (appointment_id IS NOT NULL)),
  CHECK ((cause IN ('detail_declined', 'detail_discontinued')) = (parent_detail_id IS NOT NULL)),
  CHECK (to_state NOT IN ('declined', 'discontinued') OR reason_code IS NOT NULL)
);

-- Content of an accepted or superseded version is closed (details and items).
CREATE FUNCTION cuspatlas.clinical_plan_content_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_versions v WHERE v.id = NEW.plan_version_id
                 AND v.tenant_id = NEW.tenant_id AND v.state = 'accepted')
       OR EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_versions s WHERE s.supersedes_version_id = NEW.plan_version_id
                 AND s.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'an accepted or superseded plan version takes no new content' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_plan_content_guard() FROM PUBLIC;

CREATE FUNCTION cuspatlas.clinical_plan_item_events_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    last record;
  BEGIN
    SELECT e.sequence, e.to_state INTO last FROM cuspatlas.clinical_plan_item_events e
     WHERE e.item_id = NEW.item_id AND e.tenant_id = NEW.tenant_id ORDER BY e.sequence DESC LIMIT 1;
    IF NEW.to_state = 'completed' THEN
      RAISE EXCEPTION 'completion is recorded by a rendered procedure (C14)' USING ERRCODE = '42501';
    END IF;
    IF NEW.cause IN ('created', 'carried_forward') THEN
      IF last IS NOT NULL OR NEW.sequence <> 1 OR NEW.from_state IS NOT NULL
         OR (NEW.cause = 'created' AND NEW.to_state <> 'proposed') THEN
        RAISE EXCEPTION 'an item starts with exactly one initial state' USING ERRCODE = '42501';
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
    IF EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_items i
               JOIN cuspatlas.clinical_plan_versions s ON s.supersedes_version_id = i.plan_version_id
                 AND s.tenant_id = i.tenant_id
               WHERE i.id = NEW.item_id AND i.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'items of a superseded plan version are frozen' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_plan_item_events_guard() FROM PUBLIC;

CREATE TRIGGER clinical_plan_details_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_plan_details
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_plan_items_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_plan_items
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_plan_detail_events_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_plan_detail_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_plan_item_events_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_plan_item_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_plan_details_content
  BEFORE INSERT ON cuspatlas.clinical_plan_details
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_plan_content_guard();
CREATE TRIGGER clinical_plan_items_content
  BEFORE INSERT ON cuspatlas.clinical_plan_items
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_plan_content_guard();
CREATE TRIGGER clinical_plan_item_events_transition
  BEFORE INSERT ON cuspatlas.clinical_plan_item_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_plan_item_events_guard();
CREATE TRIGGER clinical_treatment_plans_author
  BEFORE INSERT ON cuspatlas.clinical_treatment_plans
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'created_by', 'created_by_role', 'created_by_credential_ref');
CREATE TRIGGER clinical_plan_versions_author
  BEFORE INSERT ON cuspatlas.clinical_plan_versions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'created_by', 'created_by_role', 'created_by_credential_ref');
CREATE TRIGGER clinical_plan_versions_encounter
  BEFORE INSERT ON cuspatlas.clinical_plan_versions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_open_encounter_guard('encounter_id');
CREATE TRIGGER clinical_plan_details_author
  BEFORE INSERT ON cuspatlas.clinical_plan_details
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'created_by', 'created_by_role', 'created_by_credential_ref');
CREATE TRIGGER clinical_plan_items_author
  BEFORE INSERT ON cuspatlas.clinical_plan_items
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'created_by', 'created_by_role', 'created_by_credential_ref');
CREATE TRIGGER clinical_plan_detail_events_author
  BEFORE INSERT ON cuspatlas.clinical_plan_detail_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'recorded_by', 'recorded_by_role', 'recorded_by_credential_ref');
CREATE TRIGGER clinical_plan_item_events_author
  BEFORE INSERT ON cuspatlas.clinical_plan_item_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'recorded_by', 'recorded_by_role', 'recorded_by_credential_ref');

ALTER TABLE cuspatlas.clinical_treatment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_treatment_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_plan_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_plan_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_plan_details FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_plan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_plan_items FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_plan_detail_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_plan_detail_events FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_plan_item_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_plan_item_events FORCE ROW LEVEL SECURITY;

CREATE POLICY clinical_treatment_plans_select ON cuspatlas.clinical_treatment_plans
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_treatment_plans_insert ON cuspatlas.clinical_treatment_plans
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND subject_patient_id = origin_patient_id AND head_version = 1);
CREATE POLICY clinical_treatment_plans_update ON cuspatlas.clinical_treatment_plans
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_plan_versions_select ON cuspatlas.clinical_plan_versions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_plan_versions_insert ON cuspatlas.clinical_plan_versions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND state = 'draft' AND revision = 1);
CREATE POLICY clinical_plan_versions_update ON cuspatlas.clinical_plan_versions
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_plan_details_select ON cuspatlas.clinical_plan_details
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_plan_details_insert ON cuspatlas.clinical_plan_details
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_plan_items_select ON cuspatlas.clinical_plan_items
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_plan_items_insert ON cuspatlas.clinical_plan_items
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_plan_detail_events_select ON cuspatlas.clinical_plan_detail_events
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_plan_detail_events_insert ON cuspatlas.clinical_plan_detail_events
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_plan_item_events_select ON cuspatlas.clinical_plan_item_events
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_plan_item_events_insert ON cuspatlas.clinical_plan_item_events
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());

-- Explicit grants. The plan identity allows only the merge reference, its head and bookkeeping to
-- change (= the merge digest exclusions); a version allows only its revision, the one-way
-- acceptance and bookkeeping; everything else is append-only. No DELETE or TRUNCATE.
GRANT SELECT, INSERT ON cuspatlas.clinical_treatment_plans, cuspatlas.clinical_plan_versions,
  cuspatlas.clinical_plan_details, cuspatlas.clinical_plan_items, cuspatlas.clinical_plan_detail_events,
  cuspatlas.clinical_plan_item_events TO cuspatlas_app;
GRANT UPDATE (subject_patient_id, head_version, version, updated_at) ON cuspatlas.clinical_treatment_plans TO cuspatlas_app;
GRANT UPDATE (state, revision, acceptance_ref, accepted_at, updated_at) ON cuspatlas.clinical_plan_versions TO cuspatlas_app;
