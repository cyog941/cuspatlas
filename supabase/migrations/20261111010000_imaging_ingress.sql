-- I2: ingress pipeline with staging, gating and dedupe. Synthetic data only. A session holds what the
-- uploader declared (media type, exact length, SHA-256, provenance) and the staged bytes' key; only a
-- fully gated session yields an available object. Rejected bytes move to quarantine with a reason.

CREATE TABLE cuspatlas.imaging_ingress_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  state text NOT NULL DEFAULT 'awaiting_bytes'
    CHECK (state IN ('awaiting_bytes', 'staged', 'accepted', 'quarantined', 'abandoned')),
  declared_content_type text NOT NULL
    CHECK (declared_content_type IN ('image/png', 'image/jpeg', 'image/tiff', 'application/pdf', 'application/dicom')),
  declared_byte_length bigint NOT NULL CHECK (declared_byte_length > 0),
  declared_digest text NOT NULL CHECK (declared_digest ~ '^[0-9a-f]{64}$'),
  observed_digest text CHECK (observed_digest ~ '^[0-9a-f]{64}$'),
  observed_byte_length bigint CHECK (observed_byte_length > 0),
  -- Server-built keys inside the session's own tenant prefix only.
  staging_key text CHECK (staging_key ~ ('^staging/' || tenant_id::text || '/[0-9a-f-]{36}$')),
  quarantine_key text CHECK (quarantine_key ~ ('^quarantine/' || tenant_id::text || '/[0-9a-f-]{36}$')),
  scan_verdict text CHECK (scan_verdict IN ('clean', 'infected', 'unknown')),
  quarantine_reason text CHECK (quarantine_reason ~ '^[a-z_]{1,64}$'),
  object_id uuid,
  intended_patient_id uuid,
  source text NOT NULL CHECK (source IN ('operatorUpload', 'bridgeImport', 'migrationArchive')),
  device_ref text CHECK (device_ref ~ '^[A-Za-z0-9._:-]{1,64}$'),
  capture_software text CHECK (capture_software ~ '^[A-Za-z0-9._:-]{1,64}$'),
  original_filename text CHECK (char_length(original_filename) BETWEEN 1 AND 200
    AND original_filename !~ '[/\\[:cntrl:]]' AND original_filename !~ '^\.+$'),
  acquired_at timestamptz,
  acquired_time_zone text CHECK (acquired_time_zone ~ '^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2})$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (object_id, tenant_id) REFERENCES cuspatlas.imaging_objects (id, tenant_id),
  FOREIGN KEY (intended_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  CHECK ((state = 'accepted') = (object_id IS NOT NULL)),
  CHECK ((state = 'quarantined') = (quarantine_reason IS NOT NULL)),
  CHECK (state <> 'staged' OR (staging_key IS NOT NULL AND observed_digest IS NOT NULL)),
  CHECK ((acquired_at IS NULL) = (acquired_time_zone IS NULL))
);
CREATE INDEX imaging_ingress_sessions_state ON cuspatlas.imaging_ingress_sessions (tenant_id, state, created_at);

-- What was declared never changes; state moves forward only; version +1; nothing is deleted.
CREATE FUNCTION cuspatlas.imaging_ingress_sessions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ingress sessions are never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.declared_content_type, NEW.declared_byte_length, NEW.declared_digest,
      NEW.intended_patient_id, NEW.source, NEW.device_ref, NEW.capture_software, NEW.original_filename,
      NEW.acquired_at, NEW.acquired_time_zone, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.declared_content_type, OLD.declared_byte_length, OLD.declared_digest,
      OLD.intended_patient_id, OLD.source, OLD.device_ref, OLD.capture_software, OLD.original_filename,
      OLD.acquired_at, OLD.acquired_time_zone, OLD.created_by, OLD.created_at)
     OR NEW.version <> OLD.version + 1
     OR NOT (NEW.state = OLD.state AND OLD.state = 'staged'
             OR (OLD.state = 'awaiting_bytes' AND NEW.state IN ('staged', 'abandoned'))
             OR (OLD.state = 'staged' AND NEW.state IN ('accepted', 'quarantined', 'abandoned'))) THEN
    RAISE EXCEPTION 'ingress session change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_ingress_sessions_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_ingress_sessions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_ingress_sessions_guard();

ALTER TABLE cuspatlas.imaging_ingress_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_ingress_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY imaging_ingress_sessions_select ON cuspatlas.imaging_ingress_sessions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_ingress_sessions_insert ON cuspatlas.imaging_ingress_sessions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND state = 'awaiting_bytes');
CREATE POLICY imaging_ingress_sessions_update ON cuspatlas.imaging_ingress_sessions
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.imaging_ingress_sessions TO cuspatlas_app;
GRANT UPDATE (state, observed_digest, observed_byte_length, staging_key, quarantine_key, scan_verdict,
  quarantine_reason, object_id, version, updated_at) ON cuspatlas.imaging_ingress_sessions TO cuspatlas_app;

-- Patient-scoped dedupe (implementation review focus: the same bytes for two patients never merge into
-- one association): one available original per tenant, digest and named patient (or none).
ALTER TABLE cuspatlas.imaging_objects ADD COLUMN dedupe_patient_id uuid;
ALTER TABLE cuspatlas.imaging_objects ADD FOREIGN KEY (dedupe_patient_id, tenant_id)
  REFERENCES cuspatlas.patients (id, tenant_id);
CREATE UNIQUE INDEX imaging_objects_dedupe ON cuspatlas.imaging_objects (tenant_id, digest_sha256, dedupe_patient_id)
  NULLS NOT DISTINCT WHERE kind = 'original' AND state = 'available';

-- The dedupe scope is fixed at creation like the rest of the object's identity.
CREATE OR REPLACE FUNCTION cuspatlas.imaging_objects_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'imaging objects are never deleted (deletion is a tombstone)' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.kind, NEW.content_type, NEW.byte_length, NEW.digest_sha256, NEW.storage_key,
      NEW.received_at, NEW.created_by, NEW.created_at, NEW.dedupe_patient_id)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.kind, OLD.content_type, OLD.byte_length, OLD.digest_sha256, OLD.storage_key,
      OLD.received_at, OLD.created_by, OLD.created_at, OLD.dedupe_patient_id)
     OR NEW.version <> OLD.version + 1
     OR NOT (NEW.state = OLD.state
             OR (OLD.state = 'available' AND NEW.state IN ('quarantined', 'deleted'))
             OR (OLD.state = 'quarantined' AND NEW.state = 'deleted')) THEN
    RAISE EXCEPTION 'imaging object change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
