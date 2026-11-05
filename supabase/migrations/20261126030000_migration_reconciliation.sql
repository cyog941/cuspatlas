-- M6: reconciliation report versions and the staff sign-off gate (workstream M; synthetic only;
-- recommended-pending-approval). A report version is a projection over the run with a digest that
-- binds the package change sequence; a sign-off binds one report version and digest. Both are
-- append-only: a re-run produces a new superseding version, never an edit or a deletion. Cutover
-- readiness (migration_packages.cutover_state) is set only by the domain gate and is reset to
-- `reconciling` by any later import change.
CREATE TABLE cuspatlas.migration_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  package_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  change_seq integer NOT NULL CHECK (change_seq >= 1),
  body jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (package_id, tenant_id) REFERENCES cuspatlas.migration_packages (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (package_id, version)
);

CREATE TABLE cuspatlas.migration_signoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  package_id uuid NOT NULL,
  report_id uuid NOT NULL,
  report_digest text NOT NULL CHECK (report_digest ~ '^[0-9a-f]{64}$'),
  role text NOT NULL CHECK (role IN ('financialReviewer', 'operationsReviewer')),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  signed_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  signed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (package_id, tenant_id) REFERENCES cuspatlas.migration_packages (id, tenant_id),
  FOREIGN KEY (report_id, tenant_id) REFERENCES cuspatlas.migration_reports (id, tenant_id),
  UNIQUE (report_id, role),
  UNIQUE (report_id, signed_by)
);

CREATE FUNCTION cuspatlas.migration_append_only_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION 'reconciliation reports and sign-offs are never changed or deleted' USING ERRCODE = '42501';
  END
  $$;
CREATE TRIGGER migration_reports_guard BEFORE UPDATE OR DELETE ON cuspatlas.migration_reports
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_append_only_guard();
CREATE TRIGGER migration_signoffs_guard BEFORE UPDATE OR DELETE ON cuspatlas.migration_signoffs
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_append_only_guard();

ALTER TABLE cuspatlas.migration_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_signoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_signoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_reports_select ON cuspatlas.migration_reports
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_reports_insert ON cuspatlas.migration_reports
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY migration_signoffs_select ON cuspatlas.migration_signoffs
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_signoffs_insert ON cuspatlas.migration_signoffs
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND signed_by = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.migration_reports TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.migration_signoffs TO cuspatlas_app;
