-- C7: periodontal exams as raw measurements (synthetic data only). Semantics are
-- recommended-pending-clinical-approval (ADR 0005, C-D3). The six-site scheme, the value bounds and
-- the grade scales are provisional engineering values (C-S1-Q5 blocking). An unmeasured value is
-- stored as not_measured, never as zero. Derived values are computed only from a tenant formula
-- registry whose every entry is pending approval (the only storable status); a derived value is
-- stored with its formula version and never rewritten. No diagnosis, no decision support.

-- Tenant configuration (runtime role: SELECT only; defined by practice configuration, test fixtures here).
CREATE TABLE cuspatlas.clinical_perio_grade_vocabulary (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  measure text NOT NULL CHECK (measure IN ('mobility', 'furcation')),
  grade_code text NOT NULL CHECK (grade_code ~ '^[a-z0-9_]{1,32}$'),
  PRIMARY KEY (tenant_id, measure, grade_code)
);

CREATE TABLE cuspatlas.clinical_perio_formulas (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  formula_ref text NOT NULL CHECK (formula_ref ~ '^SYN-[A-Z0-9-]{1,40}$'),
  version integer NOT NULL CHECK (version >= 1),
  operation text NOT NULL CHECK (operation IN ('sum')),
  inputs text[] NOT NULL CHECK (cardinality(inputs) BETWEEN 1 AND 2
    AND inputs <@ ARRAY['probing_depth', 'recession']::text[]),
  -- No clinician approval exists: pending is the only storable status (C-D3).
  approval_status text NOT NULL DEFAULT 'pending' CHECK (approval_status = 'pending'),
  withdrawn_at timestamptz,
  defined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, formula_ref, version)
);

-- One stream per source patient (the merge relinks only subject_patient_id).
CREATE TABLE cuspatlas.clinical_perio_streams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  origin_patient_id uuid NOT NULL,
  head_sequence integer NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (origin_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (tenant_id, origin_patient_id),
  UNIQUE (id, tenant_id)
);
CREATE INDEX clinical_perio_streams_subject ON cuspatlas.clinical_perio_streams (tenant_id, subject_patient_id);

CREATE FUNCTION cuspatlas.clinical_perio_streams_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'perio streams are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (NEW.id, NEW.tenant_id, NEW.origin_patient_id, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.origin_patient_id, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'perio stream identity is immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.head_sequence NOT IN (OLD.head_sequence, OLD.head_sequence + 1) THEN
      RAISE EXCEPTION 'perio exams are appended one at a time' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'perio stream version must increase by one' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_perio_streams_guard() FROM PUBLIC;
CREATE TRIGGER clinical_perio_streams_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_perio_streams
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_perio_streams_guard();

CREATE TABLE cuspatlas.clinical_perio_exams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  site_scheme text NOT NULL CHECK (site_scheme IN ('six_site_provisional')),
  exam_date date,
  tooth_count integer NOT NULL CHECK (tooth_count BETWEEN 1 AND 52),
  encounter_id uuid,
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_by_role text NOT NULL CHECK (recorded_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  recorded_by_credential_ref text CHECK (recorded_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (stream_id, tenant_id) REFERENCES cuspatlas.clinical_perio_streams (id, tenant_id),
  FOREIGN KEY (encounter_id, tenant_id) REFERENCES cuspatlas.clinical_encounters (id, tenant_id),
  UNIQUE (stream_id, sequence),
  UNIQUE (id, tenant_id)
);

-- One value per tooth, site (null for tooth-level mobility and furcation) and measure; a correction
-- is a superseding row in the same exam with a reason, at most one successor per row.
CREATE TABLE cuspatlas.clinical_perio_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  exam_id uuid NOT NULL,
  tooth_canonical_ref text NOT NULL CHECK (tooth_canonical_ref ~ '^(perm-(ur|ul|ll|lr)-[1-8]|prim-(ur|ul|ll|lr)-[1-5])$'),
  site text CHECK (site IN ('db', 'b', 'mb', 'dl', 'l', 'ml')),
  measure text NOT NULL CHECK (measure IN ('probing_depth', 'recession', 'bleeding', 'mobility', 'furcation')),
  status text NOT NULL CHECK (status IN ('measured', 'not_measured')),
  value_mm integer,
  value_flag boolean,
  value_grade text,
  supersedes_measurement_id uuid,
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_by_role text NOT NULL CHECK (recorded_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  recorded_by_credential_ref text CHECK (recorded_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (exam_id, tenant_id) REFERENCES cuspatlas.clinical_perio_exams (id, tenant_id),
  FOREIGN KEY (supersedes_measurement_id, exam_id, tenant_id)
    REFERENCES cuspatlas.clinical_perio_measurements (id, exam_id, tenant_id),
  -- A grade must be in the tenant vocabulary for that measure (skipped when no grade is stored).
  FOREIGN KEY (tenant_id, measure, value_grade)
    REFERENCES cuspatlas.clinical_perio_grade_vocabulary (tenant_id, measure, grade_code),
  UNIQUE (id, tenant_id),
  UNIQUE (id, exam_id, tenant_id),
  UNIQUE (tenant_id, supersedes_measurement_id),
  CHECK ((site IS NULL) = (measure IN ('mobility', 'furcation'))),
  CHECK ((supersedes_measurement_id IS NULL) = (reason_code IS NULL)),
  CHECK (status = 'measured' OR (value_mm IS NULL AND value_flag IS NULL AND value_grade IS NULL)),
  CHECK (status = 'not_measured' OR CASE measure
    WHEN 'probing_depth' THEN value_mm BETWEEN 0 AND 20 AND value_flag IS NULL AND value_grade IS NULL
    WHEN 'recession' THEN value_mm BETWEEN -10 AND 20 AND value_flag IS NULL AND value_grade IS NULL
    WHEN 'bleeding' THEN value_flag IS NOT NULL AND value_mm IS NULL AND value_grade IS NULL
    ELSE value_grade IS NOT NULL AND value_mm IS NULL AND value_flag IS NULL END)
);
CREATE UNIQUE INDEX clinical_perio_measurements_original
  ON cuspatlas.clinical_perio_measurements (exam_id, tooth_canonical_ref, coalesce(site, '-'), measure)
  WHERE supersedes_measurement_id IS NULL;
CREATE INDEX clinical_perio_measurements_exam ON cuspatlas.clinical_perio_measurements (tenant_id, exam_id);

CREATE TABLE cuspatlas.clinical_perio_derivations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  exam_id uuid NOT NULL,
  formula_ref text NOT NULL,
  formula_version integer NOT NULL,
  computed_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  computed_by_role text NOT NULL CHECK (computed_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  computed_by_credential_ref text CHECK (computed_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  computed_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (exam_id, tenant_id) REFERENCES cuspatlas.clinical_perio_exams (id, tenant_id),
  FOREIGN KEY (tenant_id, formula_ref, formula_version)
    REFERENCES cuspatlas.clinical_perio_formulas (tenant_id, formula_ref, version),
  UNIQUE (id, tenant_id)
);

CREATE TABLE cuspatlas.clinical_perio_derived_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  derivation_id uuid NOT NULL,
  tooth_canonical_ref text NOT NULL,
  site text NOT NULL CHECK (site IN ('db', 'b', 'mb', 'dl', 'l', 'ml')),
  status text NOT NULL CHECK (status IN ('derived', 'not_computable')),
  value integer,
  missing_inputs text[] NOT NULL DEFAULT '{}' CHECK (missing_inputs <@ ARRAY['probing_depth', 'recession']::text[]),
  FOREIGN KEY (derivation_id, tenant_id) REFERENCES cuspatlas.clinical_perio_derivations (id, tenant_id),
  UNIQUE (derivation_id, tooth_canonical_ref, site),
  CHECK ((status = 'derived') = (value IS NOT NULL)),
  CHECK ((status = 'derived') = (cardinality(missing_inputs) = 0))
);

CREATE TRIGGER clinical_perio_exams_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_perio_exams
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_perio_measurements_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_perio_measurements
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_perio_derivations_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_perio_derivations
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_perio_derived_values_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_perio_derived_values
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_perio_exams_author
  BEFORE INSERT ON cuspatlas.clinical_perio_exams
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'recorded_by', 'recorded_by_role', 'recorded_by_credential_ref');
CREATE TRIGGER clinical_perio_exams_encounter
  BEFORE INSERT ON cuspatlas.clinical_perio_exams
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_open_encounter_guard('encounter_id');
CREATE TRIGGER clinical_perio_measurements_author
  BEFORE INSERT ON cuspatlas.clinical_perio_measurements
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'recorded_by', 'recorded_by_role', 'recorded_by_credential_ref');
CREATE TRIGGER clinical_perio_derivations_author
  BEFORE INSERT ON cuspatlas.clinical_perio_derivations
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'computed_by', 'computed_by_role', 'computed_by_credential_ref');

-- A derivation needs a formula that is not withdrawn (a withdrawn one keeps its past derivations).
CREATE FUNCTION cuspatlas.clinical_perio_derivations_formula_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM cuspatlas.clinical_perio_formulas f WHERE f.tenant_id = NEW.tenant_id
               AND f.formula_ref = NEW.formula_ref AND f.version = NEW.formula_version AND f.withdrawn_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a withdrawn formula takes no new derivation' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_perio_derivations_formula_guard() FROM PUBLIC;
CREATE TRIGGER clinical_perio_derivations_formula
  BEFORE INSERT ON cuspatlas.clinical_perio_derivations
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_perio_derivations_formula_guard();

ALTER TABLE cuspatlas.clinical_perio_grade_vocabulary ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_perio_grade_vocabulary FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_perio_formulas ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_perio_formulas FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_perio_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_perio_streams FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_perio_exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_perio_exams FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_perio_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_perio_measurements FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_perio_derivations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_perio_derivations FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_perio_derived_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_perio_derived_values FORCE ROW LEVEL SECURITY;

CREATE POLICY clinical_perio_grade_vocabulary_select ON cuspatlas.clinical_perio_grade_vocabulary
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_perio_formulas_select ON cuspatlas.clinical_perio_formulas
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_perio_streams_select ON cuspatlas.clinical_perio_streams
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_perio_streams_insert ON cuspatlas.clinical_perio_streams
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND subject_patient_id = origin_patient_id AND head_sequence = 0);
CREATE POLICY clinical_perio_streams_update ON cuspatlas.clinical_perio_streams
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_perio_exams_select ON cuspatlas.clinical_perio_exams
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_perio_exams_insert ON cuspatlas.clinical_perio_exams
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_perio_measurements_select ON cuspatlas.clinical_perio_measurements
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_perio_measurements_insert ON cuspatlas.clinical_perio_measurements
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_perio_derivations_select ON cuspatlas.clinical_perio_derivations
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_perio_derivations_insert ON cuspatlas.clinical_perio_derivations
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND computed_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_perio_derived_values_select ON cuspatlas.clinical_perio_derived_values
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_perio_derived_values_insert ON cuspatlas.clinical_perio_derived_values
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT ON cuspatlas.clinical_perio_grade_vocabulary, cuspatlas.clinical_perio_formulas TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.clinical_perio_streams, cuspatlas.clinical_perio_exams,
  cuspatlas.clinical_perio_measurements, cuspatlas.clinical_perio_derivations,
  cuspatlas.clinical_perio_derived_values TO cuspatlas_app;
GRANT UPDATE (subject_patient_id, head_sequence, version, updated_at)
  ON cuspatlas.clinical_perio_streams TO cuspatlas_app;
