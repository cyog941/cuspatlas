-- E1: portal principals. Synthetic data only. A portal principal is its own principal kind
-- ('portal'), bound to exactly one person record (a patient-identity record of the same tenant), and
-- never a staff member: the database refuses a membership for it. Authority over another patient is a
-- projection of S5 relationships (no grant table, no second expiry rule). The proofing level stays
-- 'unverified-synthetic' while E-S3 is blocked-on-discovery. Recommended-pending-approval throughout.

ALTER TABLE cuspatlas.principals DROP CONSTRAINT principals_kind_check;
ALTER TABLE cuspatlas.principals ADD CONSTRAINT principals_kind_check CHECK (kind IN ('human', 'service', 'portal'));

-- Audit and sensitive-read rows name the acting principal kind; portal commands and reads are audited.
ALTER TABLE cuspatlas.audit_events DROP CONSTRAINT audit_events_principal_check;
ALTER TABLE cuspatlas.audit_events ADD CONSTRAINT audit_events_principal_check
  CHECK (principal IN ('human', 'service', 'portal'));
ALTER TABLE cuspatlas.sensitive_read_events DROP CONSTRAINT sensitive_read_events_principal_check;
ALTER TABLE cuspatlas.sensitive_read_events ADD CONSTRAINT sensitive_read_events_principal_check
  CHECK (principal IN ('human', 'service', 'portal'));

-- A portal principal can never hold a staff membership (every role that cannot disable triggers).
CREATE FUNCTION cuspatlas.membership_not_portal() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM cuspatlas.principals p WHERE p.id = NEW.principal_id AND p.kind = 'portal') THEN
      RAISE EXCEPTION 'a portal principal cannot hold a staff membership' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END $$;
REVOKE ALL ON FUNCTION cuspatlas.membership_not_portal() FROM PUBLIC;
CREATE TRIGGER memberships_not_portal
  BEFORE INSERT OR UPDATE ON cuspatlas.memberships
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.membership_not_portal();

-- The runtime role may create portal principals only (enrollment command); never staff principals.
GRANT INSERT ON cuspatlas.principals TO cuspatlas_app;
CREATE POLICY principals_insert_portal ON cuspatlas.principals
  FOR INSERT TO cuspatlas_app
  WITH CHECK (kind = 'portal' AND cuspatlas.current_tenant_id() IS NOT NULL);

CREATE TABLE cuspatlas.portal_principals (
  principal_id uuid PRIMARY KEY REFERENCES cuspatlas.principals (id),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  person_patient_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  proofing_level text NOT NULL CHECK (proofing_level = 'unverified-synthetic'),
  contact_channel text NOT NULL CHECK (contact_channel IN ('email', 'phone')),
  -- Tenant-bound keyed digest of the invitation contact (S4 match key); never the value.
  contact_key text NOT NULL CHECK (contact_key ~ '^[a-z]{1,16}:[0-9a-f]{32}$'),
  verification_method text CHECK (verification_method = 'synthetic_attested'),
  verified_at timestamptz,
  verified_by uuid REFERENCES cuspatlas.principals (id),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES cuspatlas.principals (id),
  revoke_reason text CHECK (revoke_reason ~ '^[a-z_]{1,64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  enrolled_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (person_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  CHECK (state <> 'pending' OR verified_at IS NULL),
  CHECK ((verified_at IS NULL) = (verified_by IS NULL) AND (verified_at IS NULL) = (verification_method IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (state <> 'active' OR verified_at IS NOT NULL)
);
-- One live (pending or active) principal per person.
CREATE UNIQUE INDEX portal_principals_one_live_per_person
  ON cuspatlas.portal_principals (tenant_id, person_patient_id) WHERE state <> 'revoked';

-- The person binding, proofing level, contact digest and enrollment are immutable; a revocation is final.
CREATE FUNCTION cuspatlas.portal_principal_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'portal principals are never deleted' USING ERRCODE = '42501';
    END IF;
    IF NEW.principal_id <> OLD.principal_id OR NEW.tenant_id <> OLD.tenant_id
      OR NEW.person_patient_id <> OLD.person_patient_id OR NEW.contact_key <> OLD.contact_key
      OR NEW.contact_channel <> OLD.contact_channel OR NEW.enrolled_by <> OLD.enrolled_by
      OR NEW.created_at <> OLD.created_at OR OLD.state = 'revoked' OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'portal principal change refused' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END $$;
REVOKE ALL ON FUNCTION cuspatlas.portal_principal_guard() FROM PUBLIC;
CREATE TRIGGER portal_principals_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.portal_principals
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.portal_principal_guard();

ALTER TABLE cuspatlas.portal_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.portal_principals FORCE ROW LEVEL SECURITY;

-- Before a tenant context exists, a verified token subject may read only its own row.
CREATE POLICY portal_principals_select ON cuspatlas.portal_principals
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() OR principal_id = cuspatlas.current_auth_principal_id());
CREATE POLICY portal_principals_insert ON cuspatlas.portal_principals
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND enrolled_by = cuspatlas.current_actor_id());
CREATE POLICY portal_principals_update ON cuspatlas.portal_principals
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.portal_principals TO cuspatlas_app;
GRANT UPDATE (state, verification_method, verified_at, verified_by, revoked_at, revoked_by, revoke_reason,
  version, updated_at) ON cuspatlas.portal_principals TO cuspatlas_app;
