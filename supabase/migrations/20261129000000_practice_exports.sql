-- M1 practice export (workstream M; synthetic only; M-S1 blocks a real incumbent export). One row per
-- export: the manifest (counts, digests and terminology refs only, no record content) and the digest
-- of the stored package bytes (content-addressed in the object store; the key never leaves the
-- service). Delivery grants are short-lived (at most 300 s), bound to one principal and one export,
-- and revocable; the token itself is never stored. Exports are append-only.
CREATE TABLE cuspatlas.practice_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  format text NOT NULL CHECK (format = 'cuspatlas-practice-export/1'),
  purpose text NOT NULL CHECK (purpose IN ('practiceExit', 'verification', 'archiveCopy')),
  manifest jsonb NOT NULL,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  package_digest text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  storage_key text NOT NULL,
  document_count integer NOT NULL CHECK (document_count >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE cuspatlas.practice_export_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  export_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '300 seconds'),
  FOREIGN KEY (export_id, tenant_id) REFERENCES cuspatlas.practice_exports (id, tenant_id)
);

CREATE FUNCTION cuspatlas.practice_export_append_only_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION 'practice exports and their grants are never changed or deleted' USING ERRCODE = '42501';
  END
  $$;
CREATE TRIGGER practice_exports_guard BEFORE UPDATE OR DELETE ON cuspatlas.practice_exports
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.practice_export_append_only_guard();
CREATE TRIGGER practice_export_grants_guard BEFORE UPDATE OR DELETE ON cuspatlas.practice_export_grants
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.practice_export_append_only_guard();

ALTER TABLE cuspatlas.practice_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.practice_exports FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.practice_export_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.practice_export_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_exports_select ON cuspatlas.practice_exports
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY practice_exports_insert ON cuspatlas.practice_exports
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY practice_export_grants_select ON cuspatlas.practice_export_grants
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY practice_export_grants_insert ON cuspatlas.practice_export_grants
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.practice_exports TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.practice_export_grants TO cuspatlas_app;
