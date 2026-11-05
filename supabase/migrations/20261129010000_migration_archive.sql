-- M7 historical archive packages (workstream M; synthetic only; the real archive arrangement is
-- blocked on M-S2). Source history that does not import as live facts (M3 archive references:
-- historical appointments and procedures, archived future appointments) is copied into a read-only
-- archive package: one entry per applied archive reference with the source row and its digest,
-- linked to the patient it became. Never a live clinical, scheduling or financial fact. A
-- re-registration is a new version; a prior version stays readable under its own identity.
-- Retention (recommended-pending-approval, policy `archive-retention.pending-approval.1`): retained
-- at least ten years from registration; nothing is deleted while a legal hold (an archive hold, or an
-- I8 patient hold on an entry's patient) is active or inside the retention period, whoever deletes.
CREATE TABLE cuspatlas.migration_archive_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  package_id uuid NOT NULL,
  archive_version integer NOT NULL CHECK (archive_version >= 1),
  state text NOT NULL CHECK (state IN ('verified', 'partial', 'failed')),
  archive_digest text NOT NULL CHECK (archive_digest ~ '^[0-9a-f]{64}$'),
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  retention_policy text NOT NULL CHECK (retention_policy ~ '^[a-z0-9.-]{1,64}$'),
  retain_until timestamptz NOT NULL,
  registered_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  registered_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  FOREIGN KEY (package_id, tenant_id) REFERENCES cuspatlas.migration_packages (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (package_id, archive_version)
);

CREATE TABLE cuspatlas.migration_archive_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  archive_id uuid NOT NULL,
  applied_record_id uuid NOT NULL,
  patient_id uuid,
  entity text NOT NULL CHECK (entity ~ '^[a-z][a-z0-9_]{0,40}$'),
  source_id text CHECK (source_id ~ '^[A-Za-z0-9._:/-]{1,64}$'),
  time_precision text NOT NULL CHECK (time_precision IN ('minute', 'day', 'month', 'year', 'unknown', 'none')),
  content jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (archive_id, tenant_id) REFERENCES cuspatlas.migration_archive_packages (id, tenant_id),
  FOREIGN KEY (applied_record_id, tenant_id) REFERENCES cuspatlas.migration_applied_records (id, tenant_id),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (archive_id, applied_record_id)
);
CREATE INDEX migration_archive_entries_patient ON cuspatlas.migration_archive_entries (tenant_id, patient_id);

CREATE TABLE cuspatlas.migration_archive_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  archive_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  placed_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES cuspatlas.principals (id),
  released_at timestamptz,
  release_reason text CHECK (release_reason ~ '^[a-z_]{1,64}$'),
  FOREIGN KEY (archive_id, tenant_id) REFERENCES cuspatlas.migration_archive_packages (id, tenant_id),
  CHECK ((released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (release_reason IS NULL))
);

-- Entries are never edited; a package changes only its verification state; a hold is released once.
CREATE FUNCTION cuspatlas.migration_archive_update_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    -- Nested: a record field of another table must not be referenced (PL/pgSQL resolves every field).
    IF TG_TABLE_NAME = 'migration_archive_packages' THEN
      IF (NEW.id, NEW.tenant_id, NEW.package_id, NEW.archive_version, NEW.archive_digest, NEW.entry_count,
            NEW.retention_policy, NEW.retain_until, NEW.registered_by, NEW.registered_at)
         IS NOT DISTINCT FROM
           (OLD.id, OLD.tenant_id, OLD.package_id, OLD.archive_version, OLD.archive_digest, OLD.entry_count,
            OLD.retention_policy, OLD.retain_until, OLD.registered_by, OLD.registered_at) THEN
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'migration_archive_holds' THEN
      IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
       AND (NEW.id, NEW.tenant_id, NEW.archive_id, NEW.reason_code, NEW.placed_by, NEW.placed_at)
         IS NOT DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.archive_id, OLD.reason_code, OLD.placed_by, OLD.placed_at) THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'archive records are read-only' USING ERRCODE = '42501';
  END
  $$;
CREATE TRIGGER migration_archive_packages_update BEFORE UPDATE ON cuspatlas.migration_archive_packages
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_archive_update_guard();
CREATE TRIGGER migration_archive_entries_update BEFORE UPDATE ON cuspatlas.migration_archive_entries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_archive_update_guard();
CREATE TRIGGER migration_archive_holds_update BEFORE UPDATE ON cuspatlas.migration_archive_holds
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_archive_update_guard();

-- Deletion (operator disposal only; the runtime role has no DELETE grant) is refused while held or
-- retained, for every role that fires triggers.
CREATE FUNCTION cuspatlas.migration_archive_delete_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    a uuid;
  BEGIN
    IF TG_TABLE_NAME = 'migration_archive_holds' THEN
      RAISE EXCEPTION 'archive holds are never deleted' USING ERRCODE = '42501';
    END IF;
    IF TG_TABLE_NAME = 'migration_archive_packages' THEN
      a := OLD.id;
    ELSE
      a := OLD.archive_id;
    END IF;
    IF EXISTS (SELECT 1 FROM cuspatlas.migration_archive_holds h WHERE h.archive_id = a AND h.released_at IS NULL)
       OR EXISTS (SELECT 1 FROM cuspatlas.migration_archive_entries e JOIN cuspatlas.imaging_legal_holds l
            ON l.tenant_id = e.tenant_id AND l.subject_kind = 'patient' AND l.subject_ref = e.patient_id
            AND l.released_at IS NULL WHERE e.archive_id = a) THEN
      RAISE EXCEPTION 'archive under legal hold' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM cuspatlas.migration_archive_packages p WHERE p.id = a AND p.retain_until > now()) THEN
      RAISE EXCEPTION 'archive retention required' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END
  $$;
CREATE TRIGGER migration_archive_packages_delete BEFORE DELETE ON cuspatlas.migration_archive_packages
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_archive_delete_guard();
CREATE TRIGGER migration_archive_entries_delete BEFORE DELETE ON cuspatlas.migration_archive_entries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_archive_delete_guard();
CREATE TRIGGER migration_archive_holds_delete BEFORE DELETE ON cuspatlas.migration_archive_holds
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_archive_delete_guard();

ALTER TABLE cuspatlas.migration_archive_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_archive_packages FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_archive_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_archive_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_archive_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_archive_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_archive_packages_select ON cuspatlas.migration_archive_packages
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_archive_packages_insert ON cuspatlas.migration_archive_packages
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND registered_by = cuspatlas.current_actor_id());
CREATE POLICY migration_archive_packages_update ON cuspatlas.migration_archive_packages
  FOR UPDATE TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_archive_entries_select ON cuspatlas.migration_archive_entries
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_archive_entries_insert ON cuspatlas.migration_archive_entries
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_archive_holds_select ON cuspatlas.migration_archive_holds
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_archive_holds_insert ON cuspatlas.migration_archive_holds
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND placed_by = cuspatlas.current_actor_id());
CREATE POLICY migration_archive_holds_update ON cuspatlas.migration_archive_holds
  FOR UPDATE TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND released_by = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.migration_archive_packages TO cuspatlas_app;
GRANT UPDATE (state, verified_at, version) ON cuspatlas.migration_archive_packages TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.migration_archive_entries TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.migration_archive_holds TO cuspatlas_app;
GRANT UPDATE (released_by, released_at, release_reason) ON cuspatlas.migration_archive_holds TO cuspatlas_app;
