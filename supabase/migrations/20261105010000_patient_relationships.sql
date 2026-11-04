-- S5: guardian, guarantor, dependent and proxy relationships. Synthetic data only. Rules per ADR 0003
-- (recommended-pending-approval, S-D4): guardian authority until the per-tenant age of majority,
-- proxy grants time-boxed, guarantor exclusive. The five relationship scopes are the complete set
-- registered in docs/SHARED-CONTRACTS.md. Revocation sets an end instant and never deletes.

-- Per-tenant policy values (S-D4, S-D2). No write command exists yet: the owner of
-- admin.configure adds one; until then a row is created by the privileged role only.
CREATE TABLE cuspatlas.patient_policy_settings (
  tenant_id uuid PRIMARY KEY REFERENCES cuspatlas.tenants (id),
  age_of_majority_years integer NOT NULL DEFAULT 18 CHECK (age_of_majority_years BETWEEN 1 AND 30),
  proxy_max_days integer NOT NULL DEFAULT 365 CHECK (proxy_max_days BETWEEN 1 AND 1830),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cuspatlas.patient_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  -- The counterparty holds the relationship towards the subject; scopes flow counterparty -> subject.
  subject_patient_id uuid NOT NULL,
  counterparty_patient_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('guardian', 'guarantor', 'dependent', 'proxy')),
  scopes text[] NOT NULL CHECK (
    scopes <@ ARRAY['demographics', 'scheduling', 'clinical_read', 'financial', 'consent']::text[]
    AND cardinality(scopes) <= 5
  ),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  evidence_ref text CHECK (evidence_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES cuspatlas.principals (id),
  revoke_reason text CHECK (revoke_reason ~ '^[a-z_]{1,64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (counterparty_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (id, tenant_id),
  CHECK (subject_patient_id <> counterparty_patient_id),
  CHECK (effective_until IS NULL OR effective_until > effective_from),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK (kind <> 'proxy' OR effective_until IS NOT NULL),
  CHECK (kind NOT IN ('guardian', 'proxy') OR cardinality(scopes) >= 1),
  CHECK (kind <> 'guarantor' OR scopes <@ ARRAY['financial']::text[]),
  CHECK (kind <> 'dependent' OR cardinality(scopes) = 0)
);
CREATE INDEX patient_relationships_subject ON cuspatlas.patient_relationships (tenant_id, subject_patient_id);
CREATE INDEX patient_relationships_counterparty
  ON cuspatlas.patient_relationships (tenant_id, counterparty_patient_id);
-- At most one unrevoked guarantor per patient, and no duplicate unrevoked relationship.
CREATE UNIQUE INDEX patient_relationships_one_guarantor
  ON cuspatlas.patient_relationships (tenant_id, subject_patient_id)
  WHERE kind = 'guarantor' AND revoked_at IS NULL;
CREATE UNIQUE INDEX patient_relationships_unique_unrevoked
  ON cuspatlas.patient_relationships (tenant_id, subject_patient_id, counterparty_patient_id, kind)
  WHERE revoked_at IS NULL;

-- Revocation is one-way and every change bumps the version by one; rows are never deleted.
CREATE FUNCTION cuspatlas.patient_relationships_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'patient relationships are never deleted' USING ERRCODE = '42501';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
        OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
      RAISE EXCEPTION 'a revocation cannot be undone or rewritten' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'relationship version must increase by one' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.patient_relationships_guard() FROM PUBLIC;
CREATE TRIGGER patient_relationships_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.patient_relationships
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.patient_relationships_guard();

ALTER TABLE cuspatlas.patient_policy_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.patient_policy_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.patient_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.patient_relationships FORCE ROW LEVEL SECURITY;

CREATE POLICY patient_policy_settings_select ON cuspatlas.patient_policy_settings
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY patient_relationships_select ON cuspatlas.patient_relationships
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY patient_relationships_insert ON cuspatlas.patient_relationships
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND revoked_at IS NULL);
CREATE POLICY patient_relationships_update ON cuspatlas.patient_relationships
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id()
    AND (revoked_by IS NULL OR revoked_by = cuspatlas.current_actor_id() OR revoked_at < now()));

-- Explicit grants. The window, kind and scopes are not updatable: no caller can extend a grant;
-- renewal is a new relationship. No DELETE or TRUNCATE.
GRANT SELECT ON cuspatlas.patient_policy_settings TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.patient_relationships TO cuspatlas_app;
GRANT UPDATE (revoked_at, revoked_by, revoke_reason, version, updated_at)
  ON cuspatlas.patient_relationships TO cuspatlas_app;
