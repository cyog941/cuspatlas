-- M3: idempotent import with dry run and staged application (workstream M; synthetic only).
-- One row per applied source record: the unique staged record makes every apply idempotent and
-- resumable (a re-run applies nothing twice). Patients are created only through S4 `createPatient`;
-- the row records which patient a source record became. Historical appointments and procedures are
-- archive references here, never S10 bookings, S11 attendance or C clinical facts: a legacy row
-- cannot assert that a visit was attended or a procedure performed in the new system.
CREATE TABLE cuspatlas.migration_applied_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  package_id uuid NOT NULL,
  staged_record_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('createPatient', 'linkPatient', 'historicalReference', 'sourceArchive',
    'openingBalance', 'unappliedCredit', 'openClaimReference')),
  target_kind text NOT NULL CHECK (target_kind ~ '^[a-z][A-Za-z]{0,63}$'),
  target_ref uuid,
  patient_id uuid,
  source_system text NOT NULL CHECK (source_system ~ '^syn-[a-z0-9-]{1,60}$'),
  source_id text CHECK (source_id ~ '^[A-Za-z0-9._:/-]{1,64}$'),
  time_precision text NOT NULL CHECK (time_precision IN ('minute', 'day', 'month', 'year', 'unknown', 'none')),
  provenance jsonb NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  applied_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (package_id, tenant_id) REFERENCES cuspatlas.migration_packages (id, tenant_id),
  FOREIGN KEY (staged_record_id, tenant_id) REFERENCES cuspatlas.migration_staged_records (id, tenant_id),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (staged_record_id),
  CHECK (action NOT IN ('createPatient', 'linkPatient') OR (patient_id IS NOT NULL AND target_ref = patient_id))
);
CREATE INDEX migration_applied_records_package ON cuspatlas.migration_applied_records (tenant_id, package_id);

-- Applied rows are facts with provenance: never updated or deleted by the runtime role.
CREATE FUNCTION cuspatlas.migration_applied_records_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION 'applied migration records are never changed' USING ERRCODE = '42501';
  END
  $$;
CREATE TRIGGER migration_applied_records_guard BEFORE UPDATE OR DELETE ON cuspatlas.migration_applied_records
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_applied_records_guard();

ALTER TABLE cuspatlas.migration_applied_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_applied_records FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_applied_records_select ON cuspatlas.migration_applied_records
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_applied_records_insert ON cuspatlas.migration_applied_records
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND applied_by = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.migration_applied_records TO cuspatlas_app;
