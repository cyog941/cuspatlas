-- I3: patient matching, association correction and the imageRef. Synthetic data only. An association
-- is a recorded human decision; a correction appends a superseding decision (the earlier one stays);
-- one current decision per object; the imageRef is minted once per object and never changes.

-- Upload metadata hints are stored only as tenant-bound HMAC match keys (the same keys S stores for
-- patients), never as text. Fixed at insert (no UPDATE grant; the session guard keeps identity fixed).
ALTER TABLE cuspatlas.imaging_ingress_sessions
  ADD COLUMN hint_match_keys text[] NOT NULL DEFAULT '{}' CHECK (cardinality(hint_match_keys) <= 8);

CREATE TABLE cuspatlas.imaging_match_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  object_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  basis text NOT NULL CHECK (basis IN ('operatorSelected', 'metadataExact', 'metadataAssisted')),
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  -- No self foreign keys: the logical restore loads parents before children and cannot load a cycle.
  supersedes_id uuid,
  superseded_by_id uuid,
  superseded_at timestamptz,
  decided_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (object_id, tenant_id) REFERENCES cuspatlas.imaging_objects (id, tenant_id),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  CHECK ((superseded_by_id IS NULL) = (superseded_at IS NULL)),
  CHECK (supersedes_id IS NULL OR reason_code IS NOT NULL)
);
-- Never simultaneously current for two patients.
CREATE UNIQUE INDEX imaging_match_decisions_current ON cuspatlas.imaging_match_decisions (tenant_id, object_id)
  WHERE superseded_by_id IS NULL;
CREATE INDEX imaging_match_decisions_patient ON cuspatlas.imaging_match_decisions (tenant_id, subject_patient_id);

-- A decision is never deleted or rewritten. Allowed: superseding it once (version +1), or a merge
-- relinking its patient reference (version +1, nothing else changes).
CREATE FUNCTION cuspatlas.imaging_match_decisions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'association decisions are never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.object_id, NEW.basis, NEW.reason_code, NEW.supersedes_id, NEW.decided_by,
      NEW.decided_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.object_id, OLD.basis, OLD.reason_code, OLD.supersedes_id, OLD.decided_by,
      OLD.decided_at)
     OR NEW.version <> OLD.version + 1
     OR (OLD.superseded_by_id IS NOT NULL
         AND (NEW.superseded_by_id, NEW.superseded_at) IS DISTINCT FROM (OLD.superseded_by_id, OLD.superseded_at))
     OR ((NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id)
         AND NEW.subject_patient_id IS DISTINCT FROM OLD.subject_patient_id) THEN
    RAISE EXCEPTION 'association decision change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_match_decisions_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_match_decisions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_match_decisions_guard();

CREATE TABLE cuspatlas.imaging_image_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  object_id uuid NOT NULL,
  minted_decision_id uuid NOT NULL REFERENCES cuspatlas.imaging_match_decisions (id),
  minted_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  minted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (object_id, tenant_id) REFERENCES cuspatlas.imaging_objects (id, tenant_id),
  UNIQUE (tenant_id, object_id)
);
CREATE TRIGGER imaging_image_refs_append_only BEFORE UPDATE OR DELETE ON cuspatlas.imaging_image_refs
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.imaging_match_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_match_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_image_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_image_refs FORCE ROW LEVEL SECURITY;

CREATE POLICY imaging_match_decisions_select ON cuspatlas.imaging_match_decisions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_match_decisions_insert ON cuspatlas.imaging_match_decisions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND decided_by = cuspatlas.current_actor_id()
    AND superseded_by_id IS NULL);
CREATE POLICY imaging_match_decisions_update ON cuspatlas.imaging_match_decisions
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_image_refs_select ON cuspatlas.imaging_image_refs
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_image_refs_insert ON cuspatlas.imaging_image_refs
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND minted_by = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.imaging_match_decisions TO cuspatlas_app;
-- subject_patient_id: the S6 merge relink only (registered in MERGE_RECORD_CLASSES).
GRANT UPDATE (subject_patient_id, superseded_by_id, superseded_at, version, updated_at)
  ON cuspatlas.imaging_match_decisions TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.imaging_image_refs TO cuspatlas_app;
