-- S6: duplicate review, merge and unmerge. Synthetic data only. Rules per ADR 0003
-- (recommended-pending-approval, S-D2, S-D3). A merge only relinks patient references of registered
-- record classes and records each moved record with a content digest that must not change; the merged
-- patient row is kept (both source identifiers survive). Unmerge appends a reversal and never deletes
-- the merge link. All three tables are append-only.

ALTER TABLE cuspatlas.patient_policy_settings
  ADD COLUMN unmerge_window_days integer NOT NULL DEFAULT 30 CHECK (unmerge_window_days BETWEEN 0 AND 3650),
  ADD COLUMN candidate_min_score integer NOT NULL DEFAULT 40 CHECK (candidate_min_score BETWEEN 1 AND 300);

CREATE TABLE cuspatlas.patient_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  survivor_patient_id uuid NOT NULL,
  merged_patient_id uuid NOT NULL,
  survivor_version_before integer NOT NULL CHECK (survivor_version_before >= 1),
  merged_version_before integer NOT NULL CHECK (merged_version_before >= 1),
  -- SHA-256 of each identity row before the merge (bookkeeping columns excluded): evidence that the
  -- merge itself did not edit either identity.
  survivor_digest text NOT NULL CHECK (survivor_digest ~ '^[0-9a-f]{64}$'),
  merged_digest text NOT NULL CHECK (merged_digest ~ '^[0-9a-f]{64}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  move_count integer NOT NULL CHECK (move_count >= 0),
  merged_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  merged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CHECK (survivor_patient_id <> merged_patient_id),
  FOREIGN KEY (survivor_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (merged_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id)
);
CREATE INDEX patient_merges_survivor ON cuspatlas.patient_merges (tenant_id, survivor_patient_id);
CREATE INDEX patient_merges_merged ON cuspatlas.patient_merges (tenant_id, merged_patient_id);

CREATE TABLE cuspatlas.patient_merge_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  merge_id uuid NOT NULL,
  record_class text NOT NULL CHECK (record_class ~ '^[a-z][A-Za-z]{0,63}$'),
  record_ref uuid NOT NULL,
  reference_column text NOT NULL CHECK (reference_column ~ '^[a-z][a-z_]{0,62}$'),
  prior_patient_id uuid NOT NULL,
  new_patient_id uuid NOT NULL,
  content_digest_before text NOT NULL CHECK (content_digest_before ~ '^[0-9a-f]{64}$'),
  content_digest_after text NOT NULL CHECK (content_digest_after ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (merge_id, tenant_id) REFERENCES cuspatlas.patient_merges (id, tenant_id),
  UNIQUE (merge_id, record_class, record_ref, reference_column),
  -- Relinking never changes content: only the patient reference moves.
  CHECK (content_digest_before = content_digest_after),
  CHECK (prior_patient_id <> new_patient_id)
);

CREATE TABLE cuspatlas.patient_merge_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  merge_id uuid NOT NULL UNIQUE,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  elevated boolean NOT NULL,
  reconciliation_review_ref text CHECK (reconciliation_review_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  move_count integer NOT NULL CHECK (move_count >= 0),
  reversed_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  reversed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (merge_id, tenant_id) REFERENCES cuspatlas.patient_merges (id, tenant_id),
  CHECK (NOT elevated OR reconciliation_review_ref IS NOT NULL)
);

CREATE TRIGGER patient_merges_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.patient_merges
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER patient_merge_moves_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.patient_merge_moves
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER patient_merge_reversals_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.patient_merge_reversals
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.patient_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.patient_merges FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.patient_merge_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.patient_merge_moves FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.patient_merge_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.patient_merge_reversals FORCE ROW LEVEL SECURITY;

CREATE POLICY patient_merges_select ON cuspatlas.patient_merges
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY patient_merges_insert ON cuspatlas.patient_merges
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND merged_by = cuspatlas.current_actor_id());
CREATE POLICY patient_merge_moves_select ON cuspatlas.patient_merge_moves
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY patient_merge_moves_insert ON cuspatlas.patient_merge_moves
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY patient_merge_reversals_select ON cuspatlas.patient_merge_reversals
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY patient_merge_reversals_insert ON cuspatlas.patient_merge_reversals
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND reversed_by = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.patient_merges, cuspatlas.patient_merge_moves,
  cuspatlas.patient_merge_reversals TO cuspatlas_app;
-- Merge relinks the patient references of relationships (and nothing else on them).
GRANT UPDATE (subject_patient_id, counterparty_patient_id) ON cuspatlas.patient_relationships TO cuspatlas_app;
