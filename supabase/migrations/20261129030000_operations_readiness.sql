-- M9 operator ownership and backup verification records (workstream M; synthetic only; the named
-- operator, hosting model and objectives are open decisions under M-S3; nothing is deployed).
-- Operator profiles are versioned: a change of operator is a new version and the prior one stays.
-- Names and contacts are placeholders only. Backup verifications are append-only results of the
-- verification job; the result is derived by the domain (verified only with an isolated restore).
CREATE TABLE cuspatlas.ops_operator_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  profile_version integer NOT NULL CHECK (profile_version >= 1),
  operator_ref text NOT NULL CHECK (operator_ref ~ '^placeholder:[a-z0-9-]{1,48}$'),
  hosting_model text NOT NULL CHECK (hosting_model IN ('managed', 'selfHosted', 'contracted', 'undecided')),
  body jsonb NOT NULL,
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, profile_version)
);

CREATE TABLE cuspatlas.ops_backup_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  backup_digest text NOT NULL CHECK (backup_digest ~ '^[0-9a-f]{64}$'),
  manifest_verified boolean NOT NULL,
  isolated_restore text NOT NULL CHECK (isolated_restore IN ('passed', 'failed', 'not_run')),
  restore_seconds numeric(12, 2) CHECK (restore_seconds >= 0),
  failure_code text CHECK (failure_code ~ '^[a-z_]{1,64}$'),
  result text NOT NULL CHECK (result IN ('verified', 'checksum_only', 'failed')),
  CHECK (result <> 'verified' OR (manifest_verified AND isolated_restore = 'passed')),
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_backup_verifications_latest ON cuspatlas.ops_backup_verifications (tenant_id, checked_at DESC);

CREATE FUNCTION cuspatlas.ops_records_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION 'operator profiles and backup verifications are never changed' USING ERRCODE = '42501';
  END
  $$;
CREATE TRIGGER ops_operator_profiles_guard BEFORE UPDATE OR DELETE ON cuspatlas.ops_operator_profiles
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.ops_records_append_only();
CREATE TRIGGER ops_backup_verifications_guard BEFORE UPDATE OR DELETE ON cuspatlas.ops_backup_verifications
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.ops_records_append_only();

ALTER TABLE cuspatlas.ops_operator_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.ops_operator_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.ops_backup_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.ops_backup_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY ops_operator_profiles_select ON cuspatlas.ops_operator_profiles
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY ops_operator_profiles_insert ON cuspatlas.ops_operator_profiles
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());
CREATE POLICY ops_backup_verifications_select ON cuspatlas.ops_backup_verifications
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY ops_backup_verifications_insert ON cuspatlas.ops_backup_verifications
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.ops_operator_profiles TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.ops_backup_verifications TO cuspatlas_app;
