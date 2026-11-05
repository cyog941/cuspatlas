-- M2: authorised source export intake and mapping (workstream M; synthetic source packages only).
-- Real source exports remain blocked on M-S1/M-S2: only `syn-` source systems, `syn-practice-`
-- practices and `syn-auth-` authorisation references are accepted, and the only registered format is
-- the fabricated `cuspatlas-synthetic-legacy/1`. Mapping and reconciliation rules are
-- recommended-pending-approval. Nothing here writes a patient, clinical, scheduling or billing row;
-- those are created later (M3) only through the owning workstream commands.

-- A versioned source profile: which source system and practice a tenant migrates from, and with
-- which adapter format. A correction is a new version; an intake must name the latest version.
CREATE TABLE cuspatlas.migration_source_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  source_system text NOT NULL CHECK (source_system ~ '^syn-[a-z0-9-]{1,60}$'),
  format text NOT NULL CHECK (format IN ('cuspatlas-synthetic-legacy/1')),
  practice_ref text NOT NULL CHECK (practice_ref ~ '^syn-practice-[a-z0-9-]{1,40}$'),
  version integer NOT NULL CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, source_system, version)
);

-- One staged source package. The raw tables are kept for diagnosis and re-planning (synthetic only);
-- the same package (same digest) is staged once per tenant.
CREATE TABLE cuspatlas.migration_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  profile_id uuid NOT NULL,
  package_digest text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  authorisation_ref text NOT NULL CHECK (authorisation_ref ~ '^syn-auth-[a-z0-9-]{1,60}$'),
  produced_at timestamptz NOT NULL,
  raw jsonb NOT NULL,
  -- Bumped by every change that alters the reconciliation (apply batch, review decision): a sign-off
  -- binds the report digest, which includes it, so any later change invalidates the sign-off.
  change_seq integer NOT NULL DEFAULT 1 CHECK (change_seq >= 1),
  cutover_state text NOT NULL DEFAULT 'reconciling' CHECK (cutover_state IN ('reconciling', 'readyForCutover')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (profile_id, tenant_id) REFERENCES cuspatlas.migration_source_profiles (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, package_digest)
);

-- One source row. `mapped` is false for an entity the adapter does not know (staged, never dropped).
-- An empty or malformed source identifier is kept per row (never collapsed) with an issue code.
CREATE TABLE cuspatlas.migration_staged_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  package_id uuid NOT NULL,
  entity text NOT NULL CHECK (entity ~ '^[a-z][a-z0-9_]{0,40}$'),
  row_no integer NOT NULL CHECK (row_no >= 1),
  source_id text CHECK (source_id ~ '^[A-Za-z0-9._:/-]{1,64}$'),
  mapped boolean NOT NULL,
  payload jsonb NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  issue_code text CHECK (issue_code ~ '^[a-z_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (package_id, tenant_id) REFERENCES cuspatlas.migration_packages (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (package_id, entity, row_no)
);
CREATE INDEX migration_staged_records_package ON cuspatlas.migration_staged_records (tenant_id, package_id, entity);

-- Staff review queue (MG-02): unknown fields and entities, unmapped terminology, ambiguous monetary
-- semantics, unusable identifiers, identity candidates and future appointments. Resolved once.
CREATE TABLE cuspatlas.migration_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  package_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('unknown_field', 'unmapped_entity', 'terminology',
    'monetary_semantics', 'missing_source_id', 'duplicate_source_id', 'identity', 'future_appointment')),
  entity text NOT NULL CHECK (entity ~ '^[a-z][a-z0-9_]{0,40}$'),
  field text CHECK (field ~ '^[a-z][a-z0-9_]{0,40}$'),
  subject_key text NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 200),
  staged_record_ids uuid[] NOT NULL DEFAULT '{}',
  proposal jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  decision text CHECK (decision IN ('exclude', 'archiveOnly', 'acceptProposal', 'distinct', 'sameAsExisting',
    'mergeAfterImport')),
  decision_patient_id uuid,
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  resolved_by uuid REFERENCES cuspatlas.principals (id),
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (package_id, tenant_id) REFERENCES cuspatlas.migration_packages (id, tenant_id),
  FOREIGN KEY (decision_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (package_id, category, entity, subject_key),
  CHECK ((state = 'open') = (decision IS NULL)),
  CHECK ((state = 'open') = (resolved_by IS NULL)),
  CHECK (decision_patient_id IS NULL OR decision = 'sameAsExisting')
);

-- A review item is resolved once; its subject and proposal never change; nothing is deleted.
CREATE FUNCTION cuspatlas.migration_review_items_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'review items are never deleted' USING ERRCODE = '42501';
    END IF;
    IF OLD.state <> 'open' OR NEW.version <> OLD.version + 1
        OR (to_jsonb(NEW) - 'state' - 'decision' - 'decision_patient_id' - 'reason_code' - 'resolved_by'
            - 'resolved_at' - 'version')
           IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'decision' - 'decision_patient_id' - 'reason_code'
            - 'resolved_by' - 'resolved_at' - 'version') THEN
      RAISE EXCEPTION 'a review item is resolved once and its proposal never changes' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER migration_review_items_guard BEFORE UPDATE OR DELETE ON cuspatlas.migration_review_items
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_review_items_guard();

ALTER TABLE cuspatlas.migration_source_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_source_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_packages FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_staged_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_staged_records FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_review_items FORCE ROW LEVEL SECURITY;

CREATE POLICY migration_source_profiles_select ON cuspatlas.migration_source_profiles
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_source_profiles_insert ON cuspatlas.migration_source_profiles
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY migration_packages_select ON cuspatlas.migration_packages
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_packages_insert ON cuspatlas.migration_packages
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY migration_packages_update ON cuspatlas.migration_packages
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_staged_records_select ON cuspatlas.migration_staged_records
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_staged_records_insert ON cuspatlas.migration_staged_records
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_review_items_select ON cuspatlas.migration_review_items
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_review_items_insert ON cuspatlas.migration_review_items
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_review_items_update ON cuspatlas.migration_review_items
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND resolved_by = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.migration_source_profiles TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.migration_packages TO cuspatlas_app;
GRANT UPDATE (change_seq, cutover_state, version, updated_at) ON cuspatlas.migration_packages TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.migration_staged_records TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.migration_review_items TO cuspatlas_app;
GRANT UPDATE (state, decision, decision_patient_id, reason_code, resolved_by, resolved_at, version)
  ON cuspatlas.migration_review_items TO cuspatlas_app;
