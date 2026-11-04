-- C5: encounters and clinical authorship (synthetic data only). Clinical semantics are
-- recommended-pending-clinical-approval (docs/adr/0005-chart-semantics.md, 0006-note-signing.md).
-- An encounter is a separate fact from the booking (S10), from attendance (S11), from rendered
-- procedures (C14) and from billing (B1): no column here records any of those. Nothing is deleted;
-- the runtime role has no DELETE anywhere and cannot update identity or authorship columns.

-- Clinical author profile of a tenant member: the clinical role (and an optional credential
-- reference held by the staff module) that every clinical mutation by that member records. The
-- foreign key to memberships proves the actor is a member of this tenant without letting the caller
-- read anyone's membership (referential checks are not subject to row security).
CREATE TABLE cuspatlas.clinical_author_profiles (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  actor_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  credential_ref text CHECK (credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  defined_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  updated_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES cuspatlas.memberships (tenant_id, principal_id)
);

-- Configured disposition vocabulary per tenant. Runtime role reads only; no write command until
-- practice configuration exists (same pattern as scheduling_attendance_reasons).
CREATE TABLE cuspatlas.clinical_encounter_dispositions (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  disposition_code text NOT NULL CHECK (disposition_code ~ '^[a-z_]{1,64}$'),
  PRIMARY KEY (tenant_id, disposition_code)
);

CREATE TABLE cuspatlas.clinical_encounters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  -- The visit this encounter documents, if any. Kept as opened: a reschedule or cancellation is read
  -- from the appointment and reported, never re-pointed.
  appointment_id uuid,
  appointment_status_at_open text CHECK (appointment_status_at_open IN ('booked', 'cancelled', 'rescheduled')),
  location_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  disposition_code text CHECK (disposition_code ~ '^[a-z_]{1,64}$'),
  closed_by uuid REFERENCES cuspatlas.principals (id),
  closed_by_role text CHECK (closed_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  closed_by_credential_ref text CHECK (closed_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  closed_at timestamptz,
  -- Authorship snapshot: the clinical role configured for the author when the encounter was opened.
  opened_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  opened_by_role text NOT NULL CHECK (opened_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  opened_by_credential_ref text CHECK (opened_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  opened_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((appointment_id IS NULL) = (appointment_status_at_open IS NULL)),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((closed_at IS NULL) = (closed_by IS NULL)),
  CHECK ((closed_at IS NULL) = (closed_by_role IS NULL)),
  CHECK ((closed_at IS NULL) = (disposition_code IS NULL)),
  CHECK (closed_at IS NULL OR closed_by_credential_ref IS NULL OR closed_by IS NOT NULL),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (appointment_id, tenant_id) REFERENCES cuspatlas.appointments (id, tenant_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (id, location_id, tenant_id)
);
-- One encounter per visit: a second open for the same appointment returns the first (C5 case 1).
CREATE UNIQUE INDEX clinical_encounters_one_per_appointment
  ON cuspatlas.clinical_encounters (tenant_id, appointment_id);
CREATE INDEX clinical_encounters_patient ON cuspatlas.clinical_encounters (tenant_id, subject_patient_id, id);

-- Identity and authorship are immutable; closing is one-way and its record is written once. The
-- only change allowed on a closed encounter is the merge relink of its patient reference (S6), whose
-- content digest excludes exactly the columns below that a later command may set.
CREATE FUNCTION cuspatlas.clinical_encounters_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'encounters are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (NEW.id, NEW.tenant_id, NEW.appointment_id, NEW.appointment_status_at_open, NEW.location_id,
        NEW.opened_by, NEW.opened_by_role, NEW.opened_by_credential_ref, NEW.opened_at)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.appointment_id, OLD.appointment_status_at_open, OLD.location_id,
        OLD.opened_by, OLD.opened_by_role, OLD.opened_by_credential_ref, OLD.opened_at) THEN
      RAISE EXCEPTION 'encounter identity and authorship are immutable' USING ERRCODE = '42501';
    END IF;
    IF OLD.state = 'closed' AND (NEW.state, NEW.disposition_code, NEW.closed_by, NEW.closed_by_role,
        NEW.closed_by_credential_ref, NEW.closed_at)
       IS DISTINCT FROM (OLD.state, OLD.disposition_code, OLD.closed_by, OLD.closed_by_role,
        OLD.closed_by_credential_ref, OLD.closed_at) THEN
      RAISE EXCEPTION 'a closed encounter cannot be reopened or its closure rewritten' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'encounter version must increase by one' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_encounters_guard() FROM PUBLIC;
CREATE TRIGGER clinical_encounters_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_encounters
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_encounters_guard();

-- Role assignments (treating, secondary, supervising, staff, completing), append-only. The current
-- assignment of a role is its latest row; a NULL resource records an explicit unassignment. The
-- assignee must be a scheduling resource at the encounter location (enforced by the foreign key).
CREATE TABLE cuspatlas.clinical_encounter_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  location_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  role text NOT NULL CHECK (role IN ('treating_provider', 'secondary_provider', 'supervising_provider', 'staff',
    'completing_provider')),
  resource_id uuid,
  assigned_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  assigned_by_role text NOT NULL CHECK (assigned_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  assigned_by_credential_ref text CHECK (assigned_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (encounter_id, location_id, tenant_id)
    REFERENCES cuspatlas.clinical_encounters (id, location_id, tenant_id),
  FOREIGN KEY (resource_id, location_id, tenant_id)
    REFERENCES cuspatlas.scheduling_resources (id, location_id, tenant_id),
  UNIQUE (tenant_id, encounter_id, sequence)
);
CREATE TRIGGER clinical_encounter_assignments_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_encounter_assignments
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.clinical_author_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_author_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_encounter_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_encounter_dispositions FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_encounters ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_encounters FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_encounter_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_encounter_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY clinical_author_profiles_select ON cuspatlas.clinical_author_profiles
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_author_profiles_insert ON cuspatlas.clinical_author_profiles
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND defined_by = cuspatlas.current_actor_id()
    AND updated_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_author_profiles_update ON cuspatlas.clinical_author_profiles
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND updated_by = cuspatlas.current_actor_id());

CREATE POLICY clinical_encounter_dispositions_select ON cuspatlas.clinical_encounter_dispositions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY clinical_encounters_select ON cuspatlas.clinical_encounters
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_encounters_insert ON cuspatlas.clinical_encounters
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND opened_by = cuspatlas.current_actor_id()
    AND state = 'open');
CREATE POLICY clinical_encounters_update ON cuspatlas.clinical_encounters
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id()
    AND (closed_by IS NULL OR closed_by = cuspatlas.current_actor_id() OR closed_at < now()));

CREATE POLICY clinical_encounter_assignments_select ON cuspatlas.clinical_encounter_assignments
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_encounter_assignments_insert ON cuspatlas.clinical_encounter_assignments
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND assigned_by = cuspatlas.current_actor_id());

-- Explicit grants. Encounters: only lifecycle, the merge reference and bookkeeping are updatable;
-- identity and authorship columns are not. Assignments are append-only. No DELETE or TRUNCATE.
GRANT SELECT, INSERT ON cuspatlas.clinical_author_profiles TO cuspatlas_app;
GRANT UPDATE (role, credential_ref, active, version, updated_by, updated_at)
  ON cuspatlas.clinical_author_profiles TO cuspatlas_app;
GRANT SELECT ON cuspatlas.clinical_encounter_dispositions TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.clinical_encounters TO cuspatlas_app;
GRANT UPDATE (subject_patient_id, state, disposition_code, closed_by, closed_by_role, closed_by_credential_ref,
  closed_at, version, updated_at) ON cuspatlas.clinical_encounters TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.clinical_encounter_assignments TO cuspatlas_app;
