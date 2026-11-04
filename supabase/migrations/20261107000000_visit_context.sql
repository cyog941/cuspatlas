-- S12: the appointment visit context is a container of references to records owned by the clinical
-- workstream (C8 medical history, C13 consent/forms, C16 lab cases). Synthetic data only. This table
-- holds producer references, the pinned version and the provenance reference, never clinical content:
-- a pin is a version reference, not a copy. No clinical producer exists yet, so the deployed service
-- refuses every command here with `producer_unavailable`; the table is exercised only against a
-- synthetic producer stub in tests.

CREATE TABLE cuspatlas.visit_context_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  item_kind text NOT NULL CHECK (item_kind IN ('medical_history_pin', 'form_assignment', 'lab_case_link')),
  -- The owning workstream task of the referenced record.
  producer text NOT NULL CHECK (producer IN ('C8', 'C13', 'C16')),
  -- Opaque reference into the producer; resolved through the producer at read time.
  item_ref uuid NOT NULL,
  -- The captured version (medical-history pin only).
  item_version integer CHECK (item_version >= 1),
  provenance_ref text CHECK (provenance_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'ended')),
  end_kind text CHECK (end_kind IN ('unassigned', 'relinked')),
  end_reason text CHECK (end_reason ~ '^[a-z_]{1,64}$'),
  -- Relink history in both directions (no foreign keys: the logical restore cannot load a cycle).
  relinked_to_id uuid,
  relinked_from_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_by uuid REFERENCES cuspatlas.principals (id),
  ended_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES cuspatlas.appointments (id, tenant_id),
  CHECK ((item_kind = 'medical_history_pin') = (item_version IS NOT NULL)),
  CHECK (
    (item_kind = 'medical_history_pin' AND producer = 'C8')
    OR (item_kind = 'form_assignment' AND producer = 'C13')
    OR (item_kind = 'lab_case_link' AND producer = 'C16')
  ),
  CHECK ((state = 'ended') = (end_kind IS NOT NULL AND end_reason IS NOT NULL AND ended_at IS NOT NULL
    AND ended_by IS NOT NULL)),
  CHECK (end_kind IS DISTINCT FROM 'relinked' OR relinked_to_id IS NOT NULL),
  CHECK (item_kind <> 'medical_history_pin' OR state = 'active')
);
CREATE INDEX visit_context_items_appointment ON cuspatlas.visit_context_items (tenant_id, appointment_id);
-- One pin per appointment, one active assignment per form and appointment, one active binding per lab case.
CREATE UNIQUE INDEX visit_context_items_one_pin ON cuspatlas.visit_context_items (tenant_id, appointment_id)
  WHERE item_kind = 'medical_history_pin';
CREATE UNIQUE INDEX visit_context_items_one_form ON cuspatlas.visit_context_items (tenant_id, appointment_id, item_ref)
  WHERE item_kind = 'form_assignment' AND state = 'active';
CREATE UNIQUE INDEX visit_context_items_one_lab ON cuspatlas.visit_context_items (tenant_id, item_ref)
  WHERE item_kind = 'lab_case_link' AND state = 'active';

-- Only the end of an active item may be recorded (once, by the acting principal, version +1); every
-- identity column and the pin are immutable; nothing is deleted.
CREATE FUNCTION cuspatlas.visit_context_items_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'visit context items are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'active' OR NEW.state <> 'ended'
     OR (NEW.id, NEW.tenant_id, NEW.appointment_id, NEW.item_kind, NEW.producer, NEW.item_ref, NEW.item_version,
         NEW.provenance_ref, NEW.relinked_from_id, NEW.actor_id, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.tenant_id, OLD.appointment_id, OLD.item_kind, OLD.producer, OLD.item_ref, OLD.item_version,
         OLD.provenance_ref, OLD.relinked_from_id, OLD.actor_id, OLD.created_at)
     OR NEW.version <> OLD.version + 1
     OR NEW.ended_by IS DISTINCT FROM cuspatlas.current_actor_id() THEN
    RAISE EXCEPTION 'visit context item change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER visit_context_items_guard BEFORE UPDATE OR DELETE ON cuspatlas.visit_context_items
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.visit_context_items_guard();

ALTER TABLE cuspatlas.visit_context_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.visit_context_items FORCE ROW LEVEL SECURITY;

CREATE POLICY visit_context_items_select ON cuspatlas.visit_context_items
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY visit_context_items_insert ON cuspatlas.visit_context_items
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());
CREATE POLICY visit_context_items_update ON cuspatlas.visit_context_items
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.visit_context_items TO cuspatlas_app;
GRANT UPDATE (state, end_kind, end_reason, relinked_to_id, ended_by, ended_at, version, updated_at)
  ON cuspatlas.visit_context_items TO cuspatlas_app;
