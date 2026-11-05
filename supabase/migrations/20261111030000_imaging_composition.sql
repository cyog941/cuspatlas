-- I4: mounts, annotations and derived images as separate records. Synthetic data only. Nothing here
-- can change an original: a mount version references objects, an annotation is its own row, and a
-- derived image is a new object (kind 'derived') with its own content-addressed bytes and provenance.

-- Derived objects name their source and transform; fixed at creation (guard below). No self foreign
-- key: the logical restore loads rows of a table in one pass and cannot order a self reference.
ALTER TABLE cuspatlas.imaging_objects ADD COLUMN source_object_id uuid;
ALTER TABLE cuspatlas.imaging_objects ADD COLUMN derivation_key text CHECK (derivation_key ~ '^[0-9a-f]{64}$');
ALTER TABLE cuspatlas.imaging_objects ADD CONSTRAINT imaging_objects_derived_shape
  CHECK ((kind = 'derived') = (source_object_id IS NOT NULL AND derivation_key IS NOT NULL));
-- One available derivation per source and canonical transform.
CREATE UNIQUE INDEX imaging_objects_one_derivation ON cuspatlas.imaging_objects (tenant_id, source_object_id, derivation_key)
  WHERE kind = 'derived' AND state = 'available';
CREATE INDEX imaging_objects_source ON cuspatlas.imaging_objects (tenant_id, source_object_id);

CREATE OR REPLACE FUNCTION cuspatlas.imaging_objects_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'imaging objects are never deleted (deletion is a tombstone)' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.kind, NEW.content_type, NEW.byte_length, NEW.digest_sha256, NEW.storage_key,
      NEW.received_at, NEW.created_by, NEW.created_at, NEW.dedupe_patient_id, NEW.source_object_id, NEW.derivation_key)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.kind, OLD.content_type, OLD.byte_length, OLD.digest_sha256, OLD.storage_key,
      OLD.received_at, OLD.created_by, OLD.created_at, OLD.dedupe_patient_id, OLD.source_object_id, OLD.derivation_key)
     OR NEW.version <> OLD.version + 1
     OR NOT (NEW.state = OLD.state
             OR (OLD.state = 'available' AND NEW.state IN ('quarantined', 'deleted'))
             OR (OLD.state = 'quarantined' AND NEW.state = 'deleted')) THEN
    RAISE EXCEPTION 'imaging object change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Every derivation attempt, successful or failed, with its author and the source digest it read.
CREATE TABLE cuspatlas.imaging_derivations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  source_object_id uuid NOT NULL,
  source_digest_sha256 text NOT NULL CHECK (source_digest_sha256 ~ '^[0-9a-f]{64}$'),
  transform jsonb NOT NULL CHECK (octet_length(transform::text) <= 256),
  derivation_key text NOT NULL CHECK (derivation_key ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('succeeded', 'failed')),
  failure_reason text CHECK (failure_reason ~ '^[a-z_]{1,64}$'),
  derived_object_id uuid,
  author_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_object_id, tenant_id) REFERENCES cuspatlas.imaging_objects (id, tenant_id),
  FOREIGN KEY (derived_object_id, tenant_id) REFERENCES cuspatlas.imaging_objects (id, tenant_id),
  CHECK ((state = 'succeeded') = (derived_object_id IS NOT NULL)),
  CHECK ((state = 'failed') = (failure_reason IS NOT NULL))
);
CREATE INDEX imaging_derivations_source ON cuspatlas.imaging_derivations (tenant_id, source_object_id);
CREATE TRIGGER imaging_derivations_append_only BEFORE UPDATE OR DELETE ON cuspatlas.imaging_derivations
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

CREATE TABLE cuspatlas.imaging_mounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  template text NOT NULL CHECK (template IN ('pa-1', 'pano-1', 'bitewing-2', 'bitewing-4', 'photo-8', 'fmx-18')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
-- Only the current version pointer moves (by one); the template never changes; nothing is deleted.
CREATE FUNCTION cuspatlas.imaging_mounts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.id, NEW.tenant_id, NEW.template, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.template, OLD.created_by, OLD.created_at)
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'mount change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_mounts_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_mounts
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_mounts_guard();

CREATE TABLE cuspatlas.imaging_mount_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  mount_id uuid NOT NULL,
  mount_version integer NOT NULL CHECK (mount_version >= 1),
  slot integer NOT NULL CHECK (slot BETWEEN 1 AND 64),
  object_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mount_id, tenant_id) REFERENCES cuspatlas.imaging_mounts (id, tenant_id),
  FOREIGN KEY (object_id, tenant_id) REFERENCES cuspatlas.imaging_objects (id, tenant_id),
  UNIQUE (mount_id, mount_version, slot),
  UNIQUE (mount_id, mount_version, object_id)
);
CREATE INDEX imaging_mount_slots_object ON cuspatlas.imaging_mount_slots (tenant_id, object_id);
CREATE TRIGGER imaging_mount_slots_append_only BEFORE UPDATE OR DELETE ON cuspatlas.imaging_mount_slots
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- Annotation versions: one row per version of a lineage (annotation_ref); never burned into an object.
CREATE TABLE cuspatlas.imaging_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  annotation_ref uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  object_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('marker', 'region', 'line', 'label')),
  state text NOT NULL CHECK (state IN ('current', 'superseded', 'withdrawn')),
  geometry jsonb CHECK (octet_length(geometry::text) <= 4096),
  label text CHECK (char_length(label) BETWEEN 1 AND 200 AND label !~ '[[:cntrl:]]'),
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  author_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (object_id, tenant_id) REFERENCES cuspatlas.imaging_objects (id, tenant_id),
  UNIQUE (tenant_id, annotation_ref, version),
  CHECK ((state = 'withdrawn') = (geometry IS NULL)),
  CHECK (version = 1 OR reason_code IS NOT NULL)
);
CREATE UNIQUE INDEX imaging_annotations_one_current ON cuspatlas.imaging_annotations (tenant_id, annotation_ref)
  WHERE state = 'current';
CREATE INDEX imaging_annotations_object ON cuspatlas.imaging_annotations (tenant_id, object_id);
-- A version is immutable except that a current version may be marked superseded once.
CREATE FUNCTION cuspatlas.imaging_annotations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state <> 'current' OR NEW.state <> 'superseded'
     OR (NEW.id, NEW.tenant_id, NEW.annotation_ref, NEW.version, NEW.object_id, NEW.kind, NEW.geometry, NEW.label,
         NEW.reason_code, NEW.author_id, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.tenant_id, OLD.annotation_ref, OLD.version, OLD.object_id, OLD.kind, OLD.geometry, OLD.label,
         OLD.reason_code, OLD.author_id, OLD.created_at) THEN
    RAISE EXCEPTION 'annotation change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_annotations_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_annotations
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_annotations_guard();

ALTER TABLE cuspatlas.imaging_derivations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_derivations FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_mounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_mounts FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_mount_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_mount_slots FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_annotations FORCE ROW LEVEL SECURITY;

CREATE POLICY imaging_derivations_select ON cuspatlas.imaging_derivations
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_derivations_insert ON cuspatlas.imaging_derivations
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND author_id = cuspatlas.current_actor_id());
CREATE POLICY imaging_mounts_select ON cuspatlas.imaging_mounts
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_mounts_insert ON cuspatlas.imaging_mounts
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY imaging_mounts_update ON cuspatlas.imaging_mounts
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_mount_slots_select ON cuspatlas.imaging_mount_slots
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_mount_slots_insert ON cuspatlas.imaging_mount_slots
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY imaging_annotations_select ON cuspatlas.imaging_annotations
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_annotations_insert ON cuspatlas.imaging_annotations
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND author_id = cuspatlas.current_actor_id());
CREATE POLICY imaging_annotations_update ON cuspatlas.imaging_annotations
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.imaging_derivations TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.imaging_mounts TO cuspatlas_app;
GRANT UPDATE (version, updated_at) ON cuspatlas.imaging_mounts TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.imaging_mount_slots TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.imaging_annotations TO cuspatlas_app;
GRANT UPDATE (state) ON cuspatlas.imaging_annotations TO cuspatlas_app;
