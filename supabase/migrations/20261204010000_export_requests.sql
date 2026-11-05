-- A15 export requests (workstream A batch 4; synthetic only; A-D8 recommended-pending-approval). One row
-- per requested export: a practice export (composed over the M1 practice export, linked by reference),
-- a patient export (right of access across S, I, C, E and B) or a single-domain export. The request is
-- a job: `building` when recorded, then `ready` with its manifest and private storage digest, or
-- `failed` with a fixed diagnostic code and no artifact. The package bytes live in the private object
-- store; delivery grants are short-lived (at most 300 s) and bound to the caller. No licence, plan or
-- feature key exists on this path. Nothing is ever deleted.

CREATE TABLE cuspatlas.export_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  scope text NOT NULL CHECK (scope IN ('practice', 'patient', 'domain')),
  subject_id uuid,
  domain text CHECK (domain IN ('scheduling', 'imaging', 'clinical', 'engagement', 'billing')),
  format_version text NOT NULL CHECK (format_version = 'cuspatlas-export/1'),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][A-Za-z]{0,63}$'),
  state text NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'ready', 'failed')),
  artifact_format text CHECK (artifact_format ~ '^[a-z0-9-]{1,64}/[0-9]{1,3}$'),
  practice_export_id uuid,
  manifest jsonb CHECK (manifest IS NULL OR jsonb_typeof(manifest) = 'object'),
  manifest_digest text CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  package_digest text CHECK (package_digest ~ '^[0-9a-f]{64}$'),
  byte_length bigint CHECK (byte_length >= 0),
  document_count integer CHECK (document_count >= 0),
  storage_key text CHECK (octet_length(storage_key) <= 512),
  diagnostic text CHECK (diagnostic ~ '^[a-z_]{1,64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (id, tenant_id),
  CHECK ((scope = 'patient') = (subject_id IS NOT NULL)),
  CHECK ((scope = 'domain') = (domain IS NOT NULL)),
  CHECK (state <> 'ready' OR (artifact_format IS NOT NULL AND package_digest IS NOT NULL)),
  CHECK (state <> 'failed' OR diagnostic IS NOT NULL),
  FOREIGN KEY (practice_export_id, tenant_id) REFERENCES cuspatlas.practice_exports (id, tenant_id)
);
CREATE INDEX export_requests_list ON cuspatlas.export_requests (tenant_id, created_at DESC);

CREATE TABLE cuspatlas.export_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  export_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '300 seconds'),
  FOREIGN KEY (export_id, tenant_id) REFERENCES cuspatlas.export_requests (id, tenant_id)
);

CREATE FUNCTION cuspatlas.export_records_no_delete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'export requests and grants are never deleted' USING ERRCODE = '42501'; END $$;
REVOKE ALL ON FUNCTION cuspatlas.export_records_no_delete() FROM PUBLIC;
CREATE TRIGGER export_requests_no_delete BEFORE DELETE ON cuspatlas.export_requests
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.export_records_no_delete();
-- The runtime role has no UPDATE on grants at all; only deletes are refused for every role.
CREATE TRIGGER export_grants_no_delete BEFORE DELETE ON cuspatlas.export_grants
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.export_records_no_delete();

ALTER TABLE cuspatlas.export_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.export_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.export_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.export_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY export_requests_select ON cuspatlas.export_requests
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY export_requests_insert ON cuspatlas.export_requests
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY export_requests_update ON cuspatlas.export_requests
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY export_grants_select ON cuspatlas.export_grants
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY export_grants_insert ON cuspatlas.export_grants
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.export_requests TO cuspatlas_app;
GRANT UPDATE (state, artifact_format, practice_export_id, manifest, manifest_digest, package_digest, byte_length,
  document_count, storage_key, diagnostic, version, completed_at) ON cuspatlas.export_requests TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.export_grants TO cuspatlas_app;
