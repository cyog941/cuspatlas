-- A22 (OR-12, OR-D5 accepted): per-user server-side preferences (synthetic only). Saved list and report
-- views hold filters only (the domain refuses sensitive filters and identifying names), favourite
-- reports name catalog operations, and recently opened patients hold references only with a 7-day
-- retention, user-clearable. Every row belongs to ONE principal in ONE tenant: RLS binds each statement
-- to the current tenant AND the current actor, so a preference is never shared across users or tenants.
-- Retention: expired recent-patient rows (older than 7 days) are never returned and are purged for the
-- whole tenant on every recent-patients access through a SECURITY DEFINER function whose policy admits
-- only the function owner and only expired rows of the current tenant (the runtime role gains nothing).
CREATE TABLE cuspatlas.user_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  principal_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  operation text NOT NULL CHECK (operation ~ '^[a-z][A-Za-z]{0,40}(\.[a-z][A-Za-z]{0,40}){0,3}$'),
  name text NOT NULL CHECK (name ~ '^[A-Za-z][A-Za-z ._-]{0,59}$'),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters) = 'object' AND octet_length(filters::text) <= 2048),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, principal_id, name)
);

CREATE TABLE cuspatlas.user_favourite_reports (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  principal_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  operation text NOT NULL CHECK (operation ~ '^[a-z][A-Za-z]{0,40}(\.[a-z][A-Za-z]{0,40}){0,3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id, operation)
);

CREATE TABLE cuspatlas.user_recent_patients (
  tenant_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  patient_id uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id, patient_id),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id)
);
CREATE INDEX user_recent_patients_expiry ON cuspatlas.user_recent_patients (tenant_id, opened_at);

ALTER TABLE cuspatlas.user_saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.user_saved_views FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.user_favourite_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.user_favourite_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.user_recent_patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.user_recent_patients FORCE ROW LEVEL SECURITY;

CREATE POLICY user_saved_views_own ON cuspatlas.user_saved_views TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());
CREATE POLICY user_favourite_reports_own ON cuspatlas.user_favourite_reports TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());
CREATE POLICY user_recent_patients_own ON cuspatlas.user_recent_patients TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());
CREATE POLICY user_recent_patients_retention ON cuspatlas.user_recent_patients
  USING (current_user <> 'cuspatlas_app' AND tenant_id = cuspatlas.current_tenant_id()
         AND opened_at < now() - interval '7 days');

CREATE FUNCTION cuspatlas.purge_expired_recent_patients() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  DECLARE
    n integer;
  BEGIN
    DELETE FROM cuspatlas.user_recent_patients
      WHERE tenant_id = cuspatlas.current_tenant_id() AND opened_at < now() - interval '7 days';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.purge_expired_recent_patients() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.purge_expired_recent_patients() TO cuspatlas_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON cuspatlas.user_saved_views TO cuspatlas_app;
GRANT SELECT, INSERT, DELETE ON cuspatlas.user_favourite_reports TO cuspatlas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cuspatlas.user_recent_patients TO cuspatlas_app;
