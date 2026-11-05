-- Closeout A6 (H2 M-5 open item; workstream M; synthetic only; recommended-pending-approval): the
-- administrator-facing reviewer assignment commands `migration.reviewers.assign` / `.unassign`. Until now
-- the list was written only by the operator provisioning path. The runtime role may now insert an
-- assignment and end one, under database checks that repeat the domain's:
-- - only a live, tenant-wide human administrator (admin.configure) of the current tenant writes;
-- - the assignee is a live human member of the same tenant (never a service, agent or portal principal,
--   never a revoked or other-tenant member), and never the administrator themself;
-- - an assignment is never deleted or edited: ending it sets revoked_at, revoked_by and a reason code once,
--   one version step, so the history of who could sign off stays readable.
-- The operator path (owner role, outside RLS) keeps working for provisioning; its rows start at version 1.
ALTER TABLE cuspatlas.migration_reviewer_assignments
  ADD COLUMN revoked_by uuid REFERENCES cuspatlas.principals (id),
  ADD COLUMN revocation_reason text CHECK (revocation_reason ~ '^[a-z_]{1,64}$'),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD CONSTRAINT migration_reviewer_assignments_revocation CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND (revoked_by IS NULL) = (revocation_reason IS NULL)));

-- The caller is a live human member of the current tenant holding admin.configure for every location.
CREATE FUNCTION cuspatlas.migration_reviewer_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT cuspatlas.current_tenant_id() IS NOT NULL AND EXISTS (
      SELECT 1 FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
      WHERE m.tenant_id = cuspatlas.current_tenant_id() AND m.principal_id = cuspatlas.current_actor_id()
        AND m.revoked_at IS NULL AND p.kind = 'human' AND 'admin.configure' = ANY (m.scopes)
        AND m.location_refs IS NULL)
  $$;
-- Whether the current caller is a live tenant-wide human administrator and `p_principal` a live human
-- member of the current tenant other than the caller. Definer: the runtime role sees only its own
-- membership row. It answers one boolean to an administrator only, so it discloses nothing else.
CREATE FUNCTION cuspatlas.migration_reviewer_assignable(p_principal uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT cuspatlas.current_tenant_id() IS NOT NULL AND cuspatlas.migration_reviewer_admin()
      AND p_principal <> cuspatlas.current_actor_id()
      AND EXISTS (
        SELECT 1 FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
        WHERE m.tenant_id = cuspatlas.current_tenant_id() AND m.principal_id = p_principal
          AND m.revoked_at IS NULL AND p.kind = 'human')
  $$;

REVOKE ALL ON FUNCTION cuspatlas.migration_reviewer_assignable(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cuspatlas.migration_reviewer_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.migration_reviewer_assignable(uuid) TO cuspatlas_app;
GRANT EXECUTE ON FUNCTION cuspatlas.migration_reviewer_admin() TO cuspatlas_app;

-- An assignment only ends (live -> revoked, one version step, by someone); nothing else ever changes.
CREATE FUNCTION cuspatlas.migration_reviewer_assignments_update_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'reviewer assignments are never deleted' USING ERRCODE = '42501';
    END IF;
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL
      OR NEW.revocation_reason IS NULL OR NEW.version <> OLD.version + 1
      OR (NEW.id, NEW.tenant_id, NEW.principal_id, NEW.role, NEW.assigned_by, NEW.assigned_at)
        IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.principal_id, OLD.role, OLD.assigned_by, OLD.assigned_at) THEN
      RAISE EXCEPTION 'a reviewer assignment only ends, once' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER migration_reviewer_assignments_update BEFORE UPDATE OR DELETE
  ON cuspatlas.migration_reviewer_assignments
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_reviewer_assignments_update_guard();

CREATE POLICY migration_reviewer_assignments_insert ON cuspatlas.migration_reviewer_assignments
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND assigned_by = cuspatlas.current_actor_id()
    AND revoked_at IS NULL AND version = 1 AND cuspatlas.migration_reviewer_assignable(principal_id));
CREATE POLICY migration_reviewer_assignments_update ON cuspatlas.migration_reviewer_assignments
  FOR UPDATE TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND revoked_by = cuspatlas.current_actor_id()
    AND cuspatlas.migration_reviewer_admin());
GRANT INSERT ON cuspatlas.migration_reviewer_assignments TO cuspatlas_app;
GRANT UPDATE (revoked_at, revoked_by, revocation_reason, version) ON cuspatlas.migration_reviewer_assignments
  TO cuspatlas_app;
