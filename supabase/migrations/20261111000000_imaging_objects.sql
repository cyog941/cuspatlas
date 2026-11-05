-- I1: private object storage boundary with provenance and integrity. Synthetic data only; no device,
-- sensor SDK, DICOM library or acquisition software is qualified (I-S1, I-S2, I-S3). PostgreSQL holds
-- identity, provenance and state; bytes live in the object store under a content-addressed key bound to
-- the row's own tenant and digest, so no row can point at another tenant's bytes or at a free path.

CREATE TABLE cuspatlas.imaging_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  kind text NOT NULL CHECK (kind IN ('original', 'derived')),
  state text NOT NULL CHECK (state IN ('available', 'quarantined', 'deleted')),
  content_type text NOT NULL
    CHECK (content_type IN ('image/png', 'image/jpeg', 'image/tiff', 'application/pdf', 'application/dicom')),
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  digest_sha256 text NOT NULL CHECK (digest_sha256 ~ '^[0-9a-f]{64}$'),
  -- Content-addressed key inside the tenant's own prefix; never caller text, never returned.
  storage_key text NOT NULL,
  quarantine_reason text CHECK (quarantine_reason ~ '^[a-z_]{1,64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CHECK (storage_key = 't/' || tenant_id::text || '/sha256/' || substr(digest_sha256, 1, 2) || '/' || digest_sha256),
  CHECK (state <> 'quarantined' OR quarantine_reason IS NOT NULL)
);
CREATE INDEX imaging_objects_tenant_state ON cuspatlas.imaging_objects (tenant_id, state, received_at);
CREATE INDEX imaging_objects_storage_key ON cuspatlas.imaging_objects (tenant_id, storage_key);

-- Identity, bytes and their digest never change. State moves forward only (available -> quarantined
-- or deleted, quarantined -> deleted), version +1, nothing is deleted.
CREATE FUNCTION cuspatlas.imaging_objects_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'imaging objects are never deleted (deletion is a tombstone)' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.kind, NEW.content_type, NEW.byte_length, NEW.digest_sha256, NEW.storage_key,
      NEW.received_at, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.kind, OLD.content_type, OLD.byte_length, OLD.digest_sha256, OLD.storage_key,
      OLD.received_at, OLD.created_by, OLD.created_at)
     OR NEW.version <> OLD.version + 1
     OR NOT (NEW.state = OLD.state
             OR (OLD.state = 'available' AND NEW.state IN ('quarantined', 'deleted'))
             OR (OLD.state = 'quarantined' AND NEW.state = 'deleted')) THEN
    RAISE EXCEPTION 'imaging object change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_objects_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_objects
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_objects_guard();

-- Provenance is recorded once per ingress (or once for an object registered without one) and never
-- rewritten. The operator is the authenticated actor, checked by the insert policy.
CREATE TABLE cuspatlas.imaging_object_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  object_id uuid NOT NULL,
  ingress_id uuid,
  source text NOT NULL CHECK (source IN ('operatorUpload', 'bridgeImport', 'migrationArchive')),
  operator_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  device_ref text CHECK (device_ref ~ '^[A-Za-z0-9._:-]{1,64}$'),
  capture_software text CHECK (capture_software ~ '^[A-Za-z0-9._:-]{1,64}$'),
  original_filename text CHECK (char_length(original_filename) BETWEEN 1 AND 200
    AND original_filename !~ '[/\\[:cntrl:]]' AND original_filename !~ '^\.+$'),
  acquired_at timestamptz,
  acquired_time_zone text CHECK (acquired_time_zone ~ '^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2})$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (object_id, tenant_id) REFERENCES cuspatlas.imaging_objects (id, tenant_id),
  CHECK ((acquired_at IS NULL) = (acquired_time_zone IS NULL))
);
CREATE UNIQUE INDEX imaging_object_provenance_once ON cuspatlas.imaging_object_provenance
  (tenant_id, object_id, ingress_id) NULLS NOT DISTINCT;
CREATE TRIGGER imaging_object_provenance_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.imaging_object_provenance
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- Short-lived read grants: bound to one principal and one object, at most 300 s, revocable once.
CREATE TABLE cuspatlas.imaging_read_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  object_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (object_id, tenant_id) REFERENCES cuspatlas.imaging_objects (id, tenant_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '300 seconds'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX imaging_read_grants_object ON cuspatlas.imaging_read_grants (tenant_id, object_id);

CREATE FUNCTION cuspatlas.imaging_read_grants_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'read grants are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR (NEW.id, NEW.tenant_id, NEW.object_id, NEW.principal_id, NEW.expires_at, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.object_id, OLD.principal_id, OLD.expires_at, OLD.created_at)
     OR NEW.revoked_by IS DISTINCT FROM cuspatlas.current_actor_id() THEN
    RAISE EXCEPTION 'read grant change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_read_grants_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_read_grants
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_read_grants_guard();

ALTER TABLE cuspatlas.imaging_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_object_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_object_provenance FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_read_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_read_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY imaging_objects_select ON cuspatlas.imaging_objects
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_objects_insert ON cuspatlas.imaging_objects
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY imaging_objects_update ON cuspatlas.imaging_objects
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY imaging_object_provenance_select ON cuspatlas.imaging_object_provenance
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_object_provenance_insert ON cuspatlas.imaging_object_provenance
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND operator_id = cuspatlas.current_actor_id());

CREATE POLICY imaging_read_grants_select ON cuspatlas.imaging_read_grants
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_read_grants_insert ON cuspatlas.imaging_read_grants
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id());
CREATE POLICY imaging_read_grants_update ON cuspatlas.imaging_read_grants
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.imaging_objects TO cuspatlas_app;
GRANT UPDATE (state, quarantine_reason, version, updated_at) ON cuspatlas.imaging_objects TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.imaging_object_provenance TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.imaging_read_grants TO cuspatlas_app;
GRANT UPDATE (revoked_at, revoked_by) ON cuspatlas.imaging_read_grants TO cuspatlas_app;
