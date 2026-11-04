-- E4: intake forms and the communications/portal intake consent (synthetic data only). Clinical
-- treatment consent is C13's and is not modelled here; an intake form never captures it.
--
-- Form versions are published configuration (synthetic content; clinical sign-off of real content is
-- pending). A submission is an append-only fact bound to one form version with its provenance (who
-- submitted, through which transport and, for a guardian or proxy, which S5 relationship). Consent
-- answers become E6 consent facts linked to the submission. Answers that would change the patient
-- record never write it: they open a staff review item (S4 demographics, applied through S4's own
-- command) or a hand-off item to C8 (medical history, by reference only). Every rule is
-- recommended-pending-approval.

CREATE TABLE cuspatlas.intake_form_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  form_ref text NOT NULL CHECK (form_ref ~ '^[a-z0-9-]{1,64}$'),
  version integer NOT NULL CHECK (version >= 1),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  content_review text NOT NULL DEFAULT 'pending_clinical_review'
    CHECK (content_review IN ('pending_clinical_review')),
  valid_until timestamptz,
  state text NOT NULL DEFAULT 'published' CHECK (state IN ('published', 'retired')),
  published_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_by uuid REFERENCES cuspatlas.principals (id),
  retired_at timestamptz,
  UNIQUE (tenant_id, form_ref, version),
  UNIQUE (id, tenant_id),
  CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);

-- Only the retirement may change a published version, and only once.
CREATE FUNCTION cuspatlas.intake_form_versions_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'form versions are never deleted' USING ERRCODE = '42501';
    END IF;
    IF OLD.state = 'retired' OR NEW.state <> 'retired'
        OR (to_jsonb(NEW) - 'state' - 'retired_by' - 'retired_at')
           IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'retired_by' - 'retired_at') THEN
      RAISE EXCEPTION 'a published form version is immutable except for its retirement'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.intake_form_versions_guard() FROM PUBLIC;
CREATE TRIGGER intake_form_versions_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.intake_form_versions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.intake_form_versions_guard();

CREATE TABLE cuspatlas.intake_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  form_version_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  submitted_via text NOT NULL CHECK (submitted_via IN ('portal', 'staff')),
  submitted_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  -- The S5 relationship a guardian or proxy acted under (null for self or staff).
  via_relationship_id uuid,
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (form_version_id, tenant_id) REFERENCES cuspatlas.intake_form_versions (id, tenant_id),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (via_relationship_id, tenant_id) REFERENCES cuspatlas.patient_relationships (id, tenant_id),
  UNIQUE (id, tenant_id)
);
CREATE INDEX intake_submissions_patient ON cuspatlas.intake_submissions (tenant_id, patient_id, submitted_at);
CREATE TRIGGER intake_submissions_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.intake_submissions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- The E6 consent facts a submission recorded (each recorded once, with the submission's provenance).
CREATE TABLE cuspatlas.intake_submission_consents (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  submission_id uuid NOT NULL,
  consent_id uuid NOT NULL REFERENCES cuspatlas.communication_consents (id),
  consent_key text NOT NULL CHECK (consent_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  PRIMARY KEY (submission_id, consent_key),
  FOREIGN KEY (submission_id, tenant_id) REFERENCES cuspatlas.intake_submissions (id, tenant_id)
);
CREATE TRIGGER intake_submission_consents_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.intake_submission_consents
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- Staff review of what a submission proposes for other records. kind demographics_update carries the
-- proposed S4 groups (the diff is computed against the live record at read time); kind
-- medical_history_handoff carries only a payload reference for C8 (no clinical write here).
CREATE TABLE cuspatlas.intake_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  submission_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('demographics_update', 'medical_history_handoff')),
  proposed jsonb NOT NULL CHECK (jsonb_typeof(proposed) = 'object'),
  payload_ref text NOT NULL CHECK (payload_ref ~ '^intake-submission:[0-9a-f-]{36}(#[a-z0-9_,]+)?$' AND char_length(payload_ref) <= 512),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'applied', 'rejected')),
  resolution_reason text CHECK (resolution_reason ~ '^[a-z_]{1,64}$'),
  applied_patient_version integer,
  resolved_by uuid REFERENCES cuspatlas.principals (id),
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (submission_id, tenant_id) REFERENCES cuspatlas.intake_submissions (id, tenant_id),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (submission_id, kind),
  CHECK ((state = 'open') = (resolved_at IS NULL)),
  CHECK (kind <> 'medical_history_handoff' OR state <> 'applied')
);
CREATE FUNCTION cuspatlas.intake_review_items_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'review items are never deleted' USING ERRCODE = '42501';
    END IF;
    IF OLD.state <> 'open' OR NEW.version <> OLD.version + 1
        OR (to_jsonb(NEW) - 'state' - 'resolution_reason' - 'applied_patient_version' - 'resolved_by'
            - 'resolved_at' - 'version')
           IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'resolution_reason' - 'applied_patient_version'
            - 'resolved_by' - 'resolved_at' - 'version') THEN
      RAISE EXCEPTION 'a review item is resolved once and its proposal never changes' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.intake_review_items_guard() FROM PUBLIC;
CREATE TRIGGER intake_review_items_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.intake_review_items
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.intake_review_items_guard();

ALTER TABLE cuspatlas.intake_form_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.intake_form_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.intake_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.intake_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.intake_submission_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.intake_submission_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.intake_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.intake_review_items FORCE ROW LEVEL SECURITY;

CREATE POLICY intake_form_versions_select ON cuspatlas.intake_form_versions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY intake_form_versions_insert ON cuspatlas.intake_form_versions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND published_by = cuspatlas.current_actor_id());
CREATE POLICY intake_form_versions_update ON cuspatlas.intake_form_versions
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND retired_by = cuspatlas.current_actor_id());
CREATE POLICY intake_submissions_select ON cuspatlas.intake_submissions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY intake_submissions_insert ON cuspatlas.intake_submissions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND submitted_by = cuspatlas.current_actor_id());
CREATE POLICY intake_submission_consents_select ON cuspatlas.intake_submission_consents
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY intake_submission_consents_insert ON cuspatlas.intake_submission_consents
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY intake_review_items_select ON cuspatlas.intake_review_items
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY intake_review_items_insert ON cuspatlas.intake_review_items
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY intake_review_items_update ON cuspatlas.intake_review_items
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND resolved_by = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.intake_form_versions, cuspatlas.intake_submissions,
  cuspatlas.intake_submission_consents, cuspatlas.intake_review_items TO cuspatlas_app;
GRANT UPDATE (state, retired_by, retired_at) ON cuspatlas.intake_form_versions TO cuspatlas_app;
GRANT UPDATE (state, resolution_reason, applied_patient_version, resolved_by, resolved_at, version)
  ON cuspatlas.intake_review_items TO cuspatlas_app;

