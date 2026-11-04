-- B6 claims against a FAKE clearinghouse only (synthetic data only; B-S2 open: no X12, no real payer
-- or clearinghouse identifier, no CDT; ADR 0008 pending billing approval). Every fact is its own
-- append-only row: claim versions are immutable, validations are bound to a version and its input
-- digest, transport outcomes, acknowledgements, rejections, adjudications and denials are distinct
-- events, and appeals are drafts that another human reviews before they are sent.

CREATE TABLE cuspatlas.rcm_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  patient_id uuid NOT NULL,
  coverage_id uuid NOT NULL,
  payer_ref text NOT NULL CHECK (payer_ref ~ '^syn-payer-[a-z0-9-]{1,40}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (coverage_id, tenant_id) REFERENCES cuspatlas.rcm_coverages (id, tenant_id),
  UNIQUE (id, tenant_id)
);
CREATE TRIGGER rcm_claims_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.rcm_claims
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_aggregate_guard();

CREATE TABLE cuspatlas.rcm_claim_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  claim_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  reason text NOT NULL CHECK (reason IN ('prepared', 'attachment', 'replacement')),
  reason_code text CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  supersedes_id uuid,
  coverage_version integer NOT NULL CHECK (coverage_version >= 1),
  billed_total_minor bigint NOT NULL CHECK (billed_total_minor >= 1),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  line_count integer NOT NULL CHECK (line_count BETWEEN 1 AND 50),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id, tenant_id) REFERENCES cuspatlas.rcm_claims (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, claim_id, version_no),
  CHECK ((version_no = 1) = (supersedes_id IS NULL))
);

CREATE TABLE cuspatlas.rcm_claim_lines (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  version_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 50),
  procedure_id uuid NOT NULL,
  charge_id uuid NOT NULL,
  code_ref text NOT NULL CHECK (code_ref ~ '^SYN-[A-Z0-9-]{1,40}$'),
  date_of_service date NOT NULL,
  tooth_ref text,
  rendering_provider_id uuid NOT NULL,
  billed_minor bigint NOT NULL CHECK (billed_minor >= 1),
  allowance_minor bigint CHECK (allowance_minor >= 0),
  FOREIGN KEY (version_id, tenant_id) REFERENCES cuspatlas.rcm_claim_versions (id, tenant_id),
  FOREIGN KEY (charge_id, tenant_id) REFERENCES cuspatlas.billing_charges (id, tenant_id),
  PRIMARY KEY (tenant_id, version_id, line_no)
);

-- Attachment package placeholder: object references only (I owns imaging; no bytes here).
CREATE TABLE cuspatlas.rcm_claim_attachments (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  version_id uuid NOT NULL,
  object_ref text NOT NULL CHECK (object_ref ~ '^syn-(img|obj)-[a-z0-9-]{1,60}$'),
  kind text NOT NULL CHECK (kind IN ('radiograph', 'photo', 'narrative', 'perio_chart')),
  FOREIGN KEY (version_id, tenant_id) REFERENCES cuspatlas.rcm_claim_versions (id, tenant_id),
  PRIMARY KEY (tenant_id, version_id, object_ref)
);

CREATE TABLE cuspatlas.rcm_claim_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  version_id uuid NOT NULL,
  valid boolean NOT NULL,
  issues jsonb NOT NULL CHECK (jsonb_typeof(issues) = 'array'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  validated_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  validated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (version_id, tenant_id) REFERENCES cuspatlas.rcm_claim_versions (id, tenant_id),
  CHECK (valid = (jsonb_array_length(issues) = 0))
);

-- A revocable standing submission policy (minimal billing record; the S standing-policy model is
-- scheduling-specific). Rechecked at execution: revoked, payer and amount limit.
CREATE TABLE cuspatlas.rcm_submission_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  payer_ref text CHECK (payer_ref ~ '^syn-payer-[a-z0-9-]{1,40}$'),
  max_billed_minor bigint NOT NULL CHECK (max_billed_minor >= 1),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE TABLE cuspatlas.rcm_submission_policy_revocations (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  policy_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  revoked_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  revoked_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (policy_id, tenant_id) REFERENCES cuspatlas.rcm_submission_policies (id, tenant_id),
  PRIMARY KEY (tenant_id, policy_id)
);

-- One submission per claim version (never a blind resubmission). Recorded `pending` before the
-- adapter is called; the transport outcome is recorded once, and an `unknown` outcome is resolved
-- once by lookup with the same key.
CREATE TABLE cuspatlas.rcm_claim_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  claim_id uuid NOT NULL,
  version_id uuid NOT NULL,
  submission_key text NOT NULL CHECK (submission_key ~ '^[0-9a-f]{64}$'),
  authorization_mode text NOT NULL CHECK (authorization_mode IN ('explicit', 'policy')),
  policy_id uuid,
  validation_id uuid NOT NULL REFERENCES cuspatlas.rcm_claim_validations (id),
  outcome text NOT NULL CHECK (outcome IN ('pending', 'transmitted', 'rejected', 'unknown')),
  transport_ref text CHECK (transport_ref ~ '^syn-tx-[a-z0-9-]{1,64}$'),
  rejection_code text CHECK (rejection_code ~ '^SYN-RJ-[0-9]{3}$'),
  resolved_by_lookup boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  submitted_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id, tenant_id) REFERENCES cuspatlas.rcm_claims (id, tenant_id),
  FOREIGN KEY (version_id, tenant_id) REFERENCES cuspatlas.rcm_claim_versions (id, tenant_id),
  FOREIGN KEY (policy_id, tenant_id) REFERENCES cuspatlas.rcm_submission_policies (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, version_id),
  UNIQUE (tenant_id, submission_key),
  CHECK ((authorization_mode = 'policy') = (policy_id IS NOT NULL)),
  CHECK ((outcome = 'rejected') = (rejection_code IS NOT NULL)),
  CHECK ((outcome = 'transmitted') = (transport_ref IS NOT NULL))
);
CREATE FUNCTION cuspatlas.rcm_submission_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    lifecycle text[] := ARRAY['outcome', 'transport_ref', 'rejection_code', 'resolved_by_lookup', 'version',
      'updated_at'];
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'claim submissions are never deleted' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 OR (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle)
       OR NOT ((OLD.outcome = 'pending' AND NEW.outcome <> 'pending' AND NOT NEW.resolved_by_lookup)
            OR (OLD.outcome = 'unknown' AND NEW.outcome IN ('transmitted', 'rejected') AND NEW.resolved_by_lookup)) THEN
      RAISE EXCEPTION 'a submission outcome is recorded once (and an unknown one resolved once)' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.rcm_submission_guard() FROM PUBLIC;
CREATE TRIGGER rcm_claim_submissions_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.rcm_claim_submissions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.rcm_submission_guard();

-- Distinct response facts from the (fake) clearinghouse and payer, idempotent per external event.
CREATE TABLE cuspatlas.rcm_claim_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  claim_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('transport_acknowledged', 'transport_rejected', 'payer_acknowledged',
    'payer_rejected', 'adjudicated_paid', 'adjudicated_denied')),
  external_ref text NOT NULL CHECK (external_ref ~ '^syn-evt-[a-z0-9-]{1,64}$'),
  code text CHECK (code ~ '^SYN-(RJ|DN)-[0-9]{3}$'),
  code_source text CHECK (code_source IN ('syn-clearinghouse-rejections', 'syn-denial-codes')),
  code_version text CHECK (code_version ~ '^v[0-9]{1,3}$'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id, tenant_id) REFERENCES cuspatlas.rcm_claims (id, tenant_id),
  FOREIGN KEY (submission_id, tenant_id) REFERENCES cuspatlas.rcm_claim_submissions (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, external_ref),
  CHECK ((code IS NULL) = (code_source IS NULL) AND (code IS NULL) = (code_version IS NULL)),
  CHECK (kind NOT IN ('transport_rejected', 'payer_rejected', 'adjudicated_denied') OR code IS NOT NULL)
);

CREATE TABLE cuspatlas.rcm_appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  claim_id uuid NOT NULL,
  denial_event_id uuid NOT NULL,
  basis_code text NOT NULL CHECK (basis_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  package_digest text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
  drafted_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id, tenant_id) REFERENCES cuspatlas.rcm_claims (id, tenant_id),
  FOREIGN KEY (denial_event_id, tenant_id) REFERENCES cuspatlas.rcm_claim_events (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, claim_id, basis_code)
);
CREATE TABLE cuspatlas.rcm_appeal_reviews (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  appeal_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  sent_ref text CHECK (sent_ref ~ '^syn-appeal-[a-z0-9-]{1,64}$'),
  reviewed_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (appeal_id, tenant_id) REFERENCES cuspatlas.rcm_appeals (id, tenant_id),
  PRIMARY KEY (tenant_id, appeal_id),
  CHECK (decision = 'approved' OR sent_ref IS NULL)
);
CREATE FUNCTION cuspatlas.rcm_appeal_review_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM cuspatlas.rcm_appeals a
               WHERE a.id = NEW.appeal_id AND a.tenant_id = NEW.tenant_id AND a.drafted_by = NEW.reviewed_by) THEN
      RAISE EXCEPTION 'an appeal is reviewed by someone other than its drafter' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.rcm_appeal_review_guard() FROM PUBLIC;
CREATE TRIGGER rcm_appeal_reviews_guard
  BEFORE INSERT ON cuspatlas.rcm_appeal_reviews
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.rcm_appeal_review_guard();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rcm_claims', 'rcm_claim_versions', 'rcm_claim_lines', 'rcm_claim_attachments',
    'rcm_claim_validations', 'rcm_submission_policies', 'rcm_submission_policy_revocations', 'rcm_claim_submissions',
    'rcm_claim_events', 'rcm_appeals', 'rcm_appeal_reviews'] LOOP
    EXECUTE format('ALTER TABLE cuspatlas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE cuspatlas.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON cuspatlas.%I FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id())', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON cuspatlas.%I FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id())', t || '_insert', t);
    EXECUTE format('GRANT SELECT, INSERT ON cuspatlas.%I TO cuspatlas_app', t);
    IF t NOT IN ('rcm_claims', 'rcm_claim_submissions') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON cuspatlas.%I FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only()', t || '_append_only', t);
    END IF;
  END LOOP;
END
$$;
CREATE POLICY rcm_claims_update ON cuspatlas.rcm_claims FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
GRANT UPDATE (version, updated_at) ON cuspatlas.rcm_claims TO cuspatlas_app;
CREATE POLICY rcm_claim_submissions_update ON cuspatlas.rcm_claim_submissions FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
GRANT UPDATE (outcome, transport_ref, rejection_code, resolved_by_lookup, version, updated_at)
  ON cuspatlas.rcm_claim_submissions TO cuspatlas_app;
