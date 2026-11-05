-- Hardening H2 M-5 (workstream M; synthetic only; recommended-pending-approval): a sign-off role comes
-- from server-side configuration, never from the payload alone. Each tenant keeps a reviewer list per
-- role (`financialReviewer`, `operationsReviewer`); the recommended default is "any holder of
-- migration.signoff whom an administrator assigned to the role". The list is written by the
-- administrator/operator provisioning path only: the runtime role may read its tenant's list but holds
-- no INSERT/UPDATE grant, so no API caller can assign itself a role. A sign-off is accepted only for a
-- role its signer is assigned to (checked by the domain and again by the sign-off trigger).
CREATE TABLE cuspatlas.migration_reviewer_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  principal_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  role text NOT NULL CHECK (role IN ('financialReviewer', 'operationsReviewer')),
  assigned_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX migration_reviewer_assignments_live
  ON cuspatlas.migration_reviewer_assignments (tenant_id, principal_id, role) WHERE revoked_at IS NULL;
ALTER TABLE cuspatlas.migration_reviewer_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_reviewer_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_reviewer_assignments_select ON cuspatlas.migration_reviewer_assignments
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
GRANT SELECT ON cuspatlas.migration_reviewer_assignments TO cuspatlas_app;

CREATE OR REPLACE FUNCTION cuspatlas.migration_signoffs_bind() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  DECLARE
    r cuspatlas.migration_reports%ROWTYPE;
  BEGIN
    SELECT * INTO r FROM cuspatlas.migration_reports
      WHERE package_id = NEW.package_id AND tenant_id = NEW.tenant_id ORDER BY version DESC LIMIT 1;
    IF NOT FOUND OR r.id <> NEW.report_id OR r.digest <> NEW.report_digest OR r.change_seq <> (
        SELECT p.change_seq FROM cuspatlas.migration_packages p
        WHERE p.id = NEW.package_id AND p.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'a sign-off binds the current report version and digest' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cuspatlas.principals pr
        JOIN cuspatlas.memberships m ON m.principal_id = pr.id AND m.tenant_id = NEW.tenant_id
        WHERE pr.id = NEW.signed_by AND pr.kind = 'human' AND m.revoked_at IS NULL
          AND 'migration.signoff' = ANY (m.scopes)) THEN
      RAISE EXCEPTION 'a sign-off is made by a human reviewer with a live membership' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cuspatlas.migration_reviewer_assignments a
        WHERE a.tenant_id = NEW.tenant_id AND a.principal_id = NEW.signed_by AND a.role = NEW.role
          AND a.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'a sign-off role is one the signer is assigned to' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
