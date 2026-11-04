-- C13: consent capture (synthetic data only). C-D6 recommended-pending-approval: a structured
-- attestation with an optional artifact reference; paper and portal captures record an artifact
-- reference and digest, never bytes or a signature image; witness requirements are configured per
-- method. Signer authority (the patient, or a related person through an active S5 relationship
-- with the `consent` scope) is evaluated at capture and recorded, never inherited. A withdrawal is
-- a new record; the consent row is never rewritten. Treatment consent is a different concept from
-- E's messaging consent and suppression (SHARED-CONTRACTS ownership): nothing here reads or writes
-- E's consent state, and E never reads this.

-- Consent template versions are identified by digest; the text lives elsewhere. A text change is a
-- new digest, so earlier consents keep the digest they were captured against.
CREATE TABLE cuspatlas.clinical_consent_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  template_ref text NOT NULL CHECK (template_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  registered_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  registered_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  UNIQUE (tenant_id, template_ref, digest)
);

-- Per-method witness policy (tenant configuration; runtime role reads only; no command yet).
CREATE TABLE cuspatlas.clinical_consent_method_policies (
  tenant_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('in_person', 'portal', 'paper', 'verbal_attested')),
  witness_required boolean NOT NULL,
  PRIMARY KEY (tenant_id, method)
);

CREATE TABLE cuspatlas.clinical_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  origin_patient_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('treatment_plan', 'procedure', 'general_treatment')),
  plan_version_id uuid,
  plan_item_id uuid,
  acceptance_id uuid,
  method text NOT NULL CHECK (method IN ('in_person', 'portal', 'paper', 'verbal_attested')),
  template_ref text NOT NULL CHECK (template_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  template_digest text NOT NULL CHECK (template_digest ~ '^sha256:[0-9a-f]{64}$'),
  attestation_code text NOT NULL CHECK (attestation_code ~ '^[a-z_]{1,64}$'),
  evidence_ref text CHECK (evidence_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  evidence_digest text CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  signer_kind text NOT NULL CHECK (signer_kind IN ('patient', 'related_person')),
  signer_patient_id uuid NOT NULL,
  signer_basis text NOT NULL CHECK (signer_basis IN ('self_adult', 'self_age_unknown', 'relationship_consent_scope')),
  signer_relationship_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(signer_relationship_ids) <= 20),
  access_policy_version text CHECK (access_policy_version ~ '^[A-Za-z0-9._:-]{1,64}$'),
  authority_evaluated_at timestamptz NOT NULL,
  witness_ref uuid REFERENCES cuspatlas.principals (id),
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  effective_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (origin_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (signer_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (plan_version_id, tenant_id) REFERENCES cuspatlas.clinical_plan_versions (id, tenant_id),
  FOREIGN KEY (plan_item_id, plan_version_id, tenant_id)
    REFERENCES cuspatlas.clinical_plan_items (id, plan_version_id, tenant_id),
  FOREIGN KEY (acceptance_id, plan_version_id, tenant_id)
    REFERENCES cuspatlas.clinical_plan_acceptances (id, plan_version_id, tenant_id),
  UNIQUE (id, tenant_id),
  CHECK ((scope = 'general_treatment') = (plan_version_id IS NULL)),
  CHECK ((scope = 'procedure') = (plan_item_id IS NOT NULL)),
  CHECK ((evidence_ref IS NULL) = (evidence_digest IS NULL)),
  -- Paper and portal captures always carry the artifact reference and its digest (C-D6).
  CHECK (method NOT IN ('paper', 'portal') OR evidence_ref IS NOT NULL),
  CHECK ((signer_kind = 'patient') = (signer_patient_id = origin_patient_id)),
  CHECK ((signer_kind = 'related_person') = (signer_basis = 'relationship_consent_scope')),
  CHECK (signer_kind = 'patient' OR cardinality(signer_relationship_ids) >= 1)
);
CREATE INDEX clinical_consents_subject ON cuspatlas.clinical_consents (tenant_id, subject_patient_id);
CREATE INDEX clinical_consents_plan_version ON cuspatlas.clinical_consents (tenant_id, plan_version_id);

-- Identity and content are immutable; only the merge reference and bookkeeping change (= the merge
-- digest exclusions). A consent is never deleted.
CREATE FUNCTION cuspatlas.clinical_consents_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'consents are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['subject_patient_id', 'version', 'updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['subject_patient_id', 'version', 'updated_at']) THEN
      RAISE EXCEPTION 'a consent record is immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'consent version must increase by one' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_consents_guard() FROM PUBLIC;
CREATE TRIGGER clinical_consents_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_consents
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_consents_guard();
CREATE CONSTRAINT TRIGGER clinical_consents_relink
  AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_consents DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_subject_relink_guard();

-- Withdrawal: at most one per consent, with its own signer authority, reason and instant.
CREATE TABLE cuspatlas.clinical_consent_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  consent_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  signer_kind text NOT NULL CHECK (signer_kind IN ('patient', 'related_person')),
  signer_patient_id uuid NOT NULL,
  signer_basis text NOT NULL CHECK (signer_basis IN ('self_adult', 'self_age_unknown', 'relationship_consent_scope')),
  signer_relationship_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(signer_relationship_ids) <= 20),
  evidence_ref text CHECK (evidence_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  evidence_digest text CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  effective_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (consent_id, tenant_id) REFERENCES cuspatlas.clinical_consents (id, tenant_id),
  FOREIGN KEY (signer_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (tenant_id, consent_id),
  CHECK ((evidence_ref IS NULL) = (evidence_digest IS NULL)),
  CHECK ((signer_kind = 'related_person') = (signer_basis = 'relationship_consent_scope')),
  CHECK (signer_kind = 'patient' OR cardinality(signer_relationship_ids) >= 1)
);

CREATE TRIGGER clinical_consent_templates_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_consent_templates
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_consent_withdrawals_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_consent_withdrawals
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.clinical_consent_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_consent_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_consent_method_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_consent_method_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_consent_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_consent_withdrawals FORCE ROW LEVEL SECURITY;

CREATE POLICY clinical_consent_templates_select ON cuspatlas.clinical_consent_templates
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_consent_templates_insert ON cuspatlas.clinical_consent_templates
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND registered_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_consent_method_policies_select ON cuspatlas.clinical_consent_method_policies
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_consents_select ON cuspatlas.clinical_consents
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_consents_insert ON cuspatlas.clinical_consents
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id()
    AND subject_patient_id = origin_patient_id AND version = 1);
CREATE POLICY clinical_consents_update ON cuspatlas.clinical_consents
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_consent_withdrawals_select ON cuspatlas.clinical_consent_withdrawals
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_consent_withdrawals_insert ON cuspatlas.clinical_consent_withdrawals
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.clinical_consent_templates, cuspatlas.clinical_consents,
  cuspatlas.clinical_consent_withdrawals TO cuspatlas_app;
GRANT SELECT ON cuspatlas.clinical_consent_method_policies TO cuspatlas_app;
GRANT UPDATE (subject_patient_id, version, updated_at) ON cuspatlas.clinical_consents TO cuspatlas_app;
