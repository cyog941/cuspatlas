-- C8: medical history, allergies and medications as append-only versions (synthetic data only).
-- Semantics are recommended-pending-clinical-approval. There is no drug database, no interaction
-- checking and no clinical decision support: text is stored as reported, codes are provisional
-- synthetic placeholders (SYN-...). Nothing is deleted or rewritten; removal is a state change with a
-- reason; verification is a separate fact that never alters the reported value.

-- One stream per source patient. A merge relinks only subject_patient_id (S6); the versions, items,
-- changes and verifications below carry no patient reference, so they are never touched by a merge,
-- and the stream keeps its source patient so merged histories stay distinguishable.
CREATE TABLE cuspatlas.clinical_history_streams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  origin_patient_id uuid NOT NULL,
  head_sequence integer NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (origin_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (tenant_id, origin_patient_id),
  UNIQUE (id, tenant_id)
);
CREATE INDEX clinical_history_streams_subject ON cuspatlas.clinical_history_streams (tenant_id, subject_patient_id);

CREATE FUNCTION cuspatlas.clinical_history_streams_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'history streams are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (NEW.id, NEW.tenant_id, NEW.origin_patient_id, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.origin_patient_id, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'history stream identity is immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.head_sequence NOT IN (OLD.head_sequence, OLD.head_sequence + 1) THEN
      RAISE EXCEPTION 'history versions are appended one at a time' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'history stream version must increase by one' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_history_streams_guard() FROM PUBLIC;
CREATE TRIGGER clinical_history_streams_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_history_streams
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_history_streams_guard();

-- One recorded change set: who reported it, who recorded it (authorship snapshot), from which source.
-- recorded_at is the insert-time clock (after the stream lock, so it follows the version order),
-- truncated to milliseconds so an as-of read at a returned instant includes it.
CREATE TABLE cuspatlas.clinical_history_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  provenance text NOT NULL CHECK (provenance IN ('staff', 'patient_reported', 'imported')),
  reported_by text NOT NULL CHECK (reported_by IN ('patient', 'guardian', 'caregiver', 'clinician', 'external_record')),
  source_ref text CHECK (source_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  encounter_id uuid,
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_by_role text NOT NULL CHECK (recorded_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  recorded_by_credential_ref text CHECK (recorded_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (stream_id, tenant_id) REFERENCES cuspatlas.clinical_history_streams (id, tenant_id),
  FOREIGN KEY (encounter_id, tenant_id) REFERENCES cuspatlas.clinical_encounters (id, tenant_id),
  UNIQUE (stream_id, sequence),
  UNIQUE (id, tenant_id),
  -- Provenance and reporter agree; an import always names its source.
  CHECK ((provenance = 'imported') = (reported_by = 'external_record')),
  CHECK (provenance <> 'imported' OR source_ref IS NOT NULL),
  CHECK (provenance <> 'patient_reported' OR reported_by IN ('patient', 'guardian', 'caregiver')),
  CHECK (provenance <> 'staff' OR reported_by = 'clinician')
);

-- Item identity: a kind and entry type fixed at creation. Its content lives only in changes.
CREATE TABLE cuspatlas.clinical_history_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('condition', 'allergy', 'medication', 'vital', 'social')),
  entry_type text NOT NULL CHECK (entry_type IN ('fact', 'none_known')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (stream_id, tenant_id) REFERENCES cuspatlas.clinical_history_streams (id, tenant_id),
  UNIQUE (id, tenant_id),
  CHECK (entry_type = 'fact' OR kind IN ('condition', 'allergy', 'medication'))
);
CREATE INDEX clinical_history_items_stream ON cuspatlas.clinical_history_items (tenant_id, stream_id);

-- Each change is a complete statement of one item at one version. State and reason are explicit:
-- discontinued without an end date stays discontinued; nothing reads a null date as ongoing.
CREATE TABLE cuspatlas.clinical_history_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  version_id uuid NOT NULL,
  item_id uuid NOT NULL,
  item_sequence integer NOT NULL CHECK (item_sequence >= 1),
  state text NOT NULL CHECK (state IN ('active', 'resolved', 'discontinued', 'entered_in_error')),
  display_text text CHECK (char_length(display_text) BETWEEN 1 AND 200),
  code_ref text CHECK (code_ref ~ '^SYN-[A-Z0-9-]{1,40}$'),
  detail_text text CHECK (char_length(detail_text) BETWEEN 1 AND 500),
  effective_from date,
  effective_until date,
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  FOREIGN KEY (version_id, tenant_id) REFERENCES cuspatlas.clinical_history_versions (id, tenant_id),
  FOREIGN KEY (item_id, tenant_id) REFERENCES cuspatlas.clinical_history_items (id, tenant_id),
  UNIQUE (item_id, item_sequence),
  UNIQUE (version_id, item_id),
  UNIQUE (id, tenant_id),
  CHECK ((state = 'active') = (reason_code IS NULL)),
  CHECK (effective_from IS NULL OR effective_until IS NULL OR effective_from <= effective_until)
);
CREATE INDEX clinical_history_changes_item ON cuspatlas.clinical_history_changes (tenant_id, item_id, item_sequence);

-- Clinician verification of one exact change. A later change needs its own verification; this row is
-- never edited and the reported value is never overwritten.
CREATE TABLE cuspatlas.clinical_history_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  change_id uuid NOT NULL,
  encounter_id uuid,
  verified_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  verified_by_role text NOT NULL CHECK (verified_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  verified_by_credential_ref text CHECK (verified_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  verified_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (change_id, tenant_id) REFERENCES cuspatlas.clinical_history_changes (id, tenant_id),
  FOREIGN KEY (encounter_id, tenant_id) REFERENCES cuspatlas.clinical_encounters (id, tenant_id),
  UNIQUE (tenant_id, change_id)
);

-- Reviewed-at attestation per encounter: per kind, "reviewed, none present" or "reviewed, list confirmed".
CREATE TABLE cuspatlas.clinical_history_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  allergy_outcome text CHECK (allergy_outcome IN ('none', 'confirmed')),
  condition_outcome text CHECK (condition_outcome IN ('none', 'confirmed')),
  medication_outcome text CHECK (medication_outcome IN ('none', 'confirmed')),
  reviewed_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  reviewed_by_role text NOT NULL CHECK (reviewed_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  reviewed_by_credential_ref text CHECK (reviewed_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  reviewed_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (encounter_id, tenant_id) REFERENCES cuspatlas.clinical_encounters (id, tenant_id),
  CHECK (allergy_outcome IS NOT NULL OR condition_outcome IS NOT NULL OR medication_outcome IS NOT NULL)
);
CREATE INDEX clinical_history_reviews_encounter ON cuspatlas.clinical_history_reviews (tenant_id, encounter_id);

CREATE TRIGGER clinical_history_versions_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_history_versions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_history_items_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_history_items
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_history_changes_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_history_changes
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_history_verifications_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_history_verifications
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_history_reviews_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_history_reviews
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.clinical_history_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_history_streams FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_history_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_history_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_history_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_history_items FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_history_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_history_changes FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_history_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_history_verifications FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_history_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_history_reviews FORCE ROW LEVEL SECURITY;

CREATE POLICY clinical_history_streams_select ON cuspatlas.clinical_history_streams
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_history_streams_insert ON cuspatlas.clinical_history_streams
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND subject_patient_id = origin_patient_id AND head_sequence = 0);
CREATE POLICY clinical_history_streams_update ON cuspatlas.clinical_history_streams
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY clinical_history_versions_select ON cuspatlas.clinical_history_versions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_history_versions_insert ON cuspatlas.clinical_history_versions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_history_items_select ON cuspatlas.clinical_history_items
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_history_items_insert ON cuspatlas.clinical_history_items
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_history_changes_select ON cuspatlas.clinical_history_changes
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_history_changes_insert ON cuspatlas.clinical_history_changes
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_history_verifications_select ON cuspatlas.clinical_history_verifications
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_history_verifications_insert ON cuspatlas.clinical_history_verifications
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND verified_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_history_reviews_select ON cuspatlas.clinical_history_reviews
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_history_reviews_insert ON cuspatlas.clinical_history_reviews
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND reviewed_by = cuspatlas.current_actor_id());

-- Explicit grants: append-only everywhere; the stream allows only the merge reference, its head and
-- bookkeeping to change. No DELETE or TRUNCATE.
GRANT SELECT, INSERT ON cuspatlas.clinical_history_streams, cuspatlas.clinical_history_versions,
  cuspatlas.clinical_history_items, cuspatlas.clinical_history_changes, cuspatlas.clinical_history_verifications,
  cuspatlas.clinical_history_reviews TO cuspatlas_app;
GRANT UPDATE (subject_patient_id, head_sequence, version, updated_at)
  ON cuspatlas.clinical_history_streams TO cuspatlas_app;
