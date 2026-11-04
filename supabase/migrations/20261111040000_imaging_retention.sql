-- I8: retention, deletion and legal hold (mechanism only). Synthetic data only. Retention values need
-- legal and clinical review per jurisdiction (I-D5): every policy row is recommended_pending_approval and
-- no universal default ships, so without a policy nothing can be deleted. Deletion is a tombstone (the
-- object row, provenance and audit stay) plus removal of the bytes; holds override retention.

CREATE TABLE cuspatlas.imaging_retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  record_class text NOT NULL CHECK (record_class IN ('associated_original', 'unassociated_original', 'derived')),
  version integer NOT NULL CHECK (version >= 1),
  minimum_retention_months integer NOT NULL CHECK (minimum_retention_months BETWEEN 0 AND 1200),
  basis_code text NOT NULL CHECK (basis_code ~ '^[a-z_]{1,64}$'),
  jurisdiction_code text NOT NULL CHECK (jurisdiction_code ~ '^[a-z]{2}(-[a-z0-9]{1,16})?$'),
  approval_status text NOT NULL DEFAULT 'recommended_pending_approval'
    CHECK (approval_status = 'recommended_pending_approval'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, record_class, version)
);
CREATE TRIGGER imaging_retention_policies_append_only BEFORE UPDATE OR DELETE ON cuspatlas.imaging_retention_policies
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- Polymorphic subject (an object or a patient), so no foreign key; the subject is checked in the domain.
CREATE TABLE cuspatlas.imaging_legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('object', 'patient')),
  subject_ref uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  placed_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES cuspatlas.principals (id),
  released_at timestamptz,
  release_reason text CHECK (release_reason ~ '^[a-z_]{1,64}$'),
  CHECK ((released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (release_reason IS NULL))
);
CREATE INDEX imaging_legal_holds_subject ON cuspatlas.imaging_legal_holds (tenant_id, subject_kind, subject_ref)
  WHERE released_at IS NULL;
-- A hold is released once, by the acting principal; nothing else changes; nothing is deleted.
CREATE FUNCTION cuspatlas.imaging_legal_holds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
     OR (NEW.id, NEW.tenant_id, NEW.subject_kind, NEW.subject_ref, NEW.reason_code, NEW.placed_by, NEW.placed_at)
        IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.subject_kind, OLD.subject_ref, OLD.reason_code, OLD.placed_by,
          OLD.placed_at)
     OR NEW.released_by IS DISTINCT FROM cuspatlas.current_actor_id() THEN
    RAISE EXCEPTION 'legal hold change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_legal_holds_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_legal_holds
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_legal_holds_guard();

CREATE TABLE cuspatlas.imaging_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  object_id uuid NOT NULL,
  record_class text NOT NULL CHECK (record_class IN ('associated_original', 'unassociated_original', 'derived')),
  requires_second_actor boolean NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'executed')),
  bytes_state text CHECK (bytes_state IN ('pending', 'removed', 'retained_shared')),
  deleted_objects integer CHECK (deleted_objects >= 0),
  requested_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  executed_by uuid REFERENCES cuspatlas.principals (id),
  executed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (object_id, tenant_id) REFERENCES cuspatlas.imaging_objects (id, tenant_id),
  CHECK ((state = 'executed') = (executed_at IS NOT NULL AND executed_by IS NOT NULL AND bytes_state IS NOT NULL)),
  -- I-D6 (pending approval): dual approval for images ever associated with a patient.
  CHECK (NOT requires_second_actor OR executed_by IS NULL OR executed_by <> requested_by)
);
CREATE UNIQUE INDEX imaging_deletion_requests_one_pending ON cuspatlas.imaging_deletion_requests (tenant_id, object_id)
  WHERE state = 'pending';
CREATE FUNCTION cuspatlas.imaging_deletion_requests_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR (NEW.id, NEW.tenant_id, NEW.object_id, NEW.record_class, NEW.requires_second_actor, NEW.reason_code,
         NEW.requested_by, NEW.requested_at)
        IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.object_id, OLD.record_class, OLD.requires_second_actor,
          OLD.reason_code, OLD.requested_by, OLD.requested_at)
     OR NEW.version <> OLD.version + 1
     OR (OLD.state = 'executed' AND (NEW.state, NEW.executed_by, NEW.executed_at, NEW.deleted_objects)
         IS DISTINCT FROM (OLD.state, OLD.executed_by, OLD.executed_at, OLD.deleted_objects))
     OR (OLD.state = 'executed' AND OLD.bytes_state <> 'pending' AND NEW.bytes_state IS DISTINCT FROM OLD.bytes_state) THEN
    RAISE EXCEPTION 'deletion request change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_deletion_requests_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_deletion_requests_guard();

-- The tombstone records which deletion removed the object and when (state 'deleted' already exists).
ALTER TABLE cuspatlas.imaging_objects ADD COLUMN deleted_at timestamptz;
ALTER TABLE cuspatlas.imaging_objects ADD COLUMN deletion_id uuid;
ALTER TABLE cuspatlas.imaging_objects ADD CONSTRAINT imaging_objects_tombstone
  CHECK ((state = 'deleted') = (deleted_at IS NOT NULL));
GRANT UPDATE (deleted_at, deletion_id) ON cuspatlas.imaging_objects TO cuspatlas_app;

ALTER TABLE cuspatlas.imaging_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_retention_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_legal_holds FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_deletion_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY imaging_retention_policies_select ON cuspatlas.imaging_retention_policies
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_retention_policies_insert ON cuspatlas.imaging_retention_policies
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY imaging_legal_holds_select ON cuspatlas.imaging_legal_holds
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_legal_holds_insert ON cuspatlas.imaging_legal_holds
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND placed_by = cuspatlas.current_actor_id()
    AND released_at IS NULL);
CREATE POLICY imaging_legal_holds_update ON cuspatlas.imaging_legal_holds
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_deletion_requests_select ON cuspatlas.imaging_deletion_requests
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_deletion_requests_insert ON cuspatlas.imaging_deletion_requests
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND requested_by = cuspatlas.current_actor_id()
    AND state = 'pending');
CREATE POLICY imaging_deletion_requests_update ON cuspatlas.imaging_deletion_requests
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.imaging_retention_policies TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.imaging_legal_holds TO cuspatlas_app;
GRANT UPDATE (released_by, released_at, release_reason) ON cuspatlas.imaging_legal_holds TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.imaging_deletion_requests TO cuspatlas_app;
GRANT UPDATE (state, bytes_state, deleted_objects, executed_by, executed_at, version, updated_at)
  ON cuspatlas.imaging_deletion_requests TO cuspatlas_app;
