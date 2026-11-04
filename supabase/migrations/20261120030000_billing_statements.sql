-- B4: statements as audited snapshots (synthetic data only; ADR 0008, recommended-pending-billing-
-- approval). A statement row is written once by the generation command and never updated or
-- deleted: regeneration is a new version that names the one it supersedes. Staleness is derived at
-- read time from the snapshot and the journal; no stale, fresh or current-balance column exists.
-- Delivery belongs to E7; the row records only that no delivery channel was chosen here.
CREATE TABLE cuspatlas.billing_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  guarantor_id uuid NOT NULL,
  statement_version integer NOT NULL CHECK (statement_version >= 1),
  cutoff_at timestamptz NOT NULL,
  basis text NOT NULL CHECK (basis IN ('posted_through_cutoff')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Signed snapshot total at the cutoff (debit: amount due; credit: credit balance).
  snapshot_total_minor bigint NOT NULL CHECK (snapshot_total_minor BETWEEN -99999999999 AND 99999999999),
  total_class text NOT NULL CHECK (total_class IN ('due', 'zero', 'credit')),
  -- Identities the snapshot covered (not foreign keys: a merge never relinks them).
  covered_patient_ids uuid[] NOT NULL CHECK (cardinality(covered_patient_ids) BETWEEN 1 AND 200),
  -- Canonical snapshot content: references, kinds, dates and integer amounts only (no caller text).
  snapshot jsonb NOT NULL,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
  line_count integer NOT NULL CHECK (line_count BETWEEN 0 AND 2000),
  -- No self foreign key (row-by-row restore order); the domain names the latest version under lock.
  supersedes_id uuid,
  delivery_channel text NOT NULL DEFAULT 'none' CHECK (delivery_channel = 'none'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  correlation_id uuid NOT NULL,
  FOREIGN KEY (guarantor_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, guarantor_id, statement_version),
  -- Each statement is superseded at most once: the versions form one chain per guarantor.
  UNIQUE (tenant_id, supersedes_id),
  CHECK ((statement_version = 1) = (supersedes_id IS NULL)),
  CHECK (total_class = CASE WHEN snapshot_total_minor > 0 THEN 'due' WHEN snapshot_total_minor < 0 THEN 'credit'
    ELSE 'zero' END)
);
CREATE INDEX billing_statements_guarantor ON cuspatlas.billing_statements (tenant_id, guarantor_id, statement_version);

CREATE TRIGGER billing_statements_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.billing_statements
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.billing_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_statements FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_statements_select ON cuspatlas.billing_statements
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY billing_statements_insert ON cuspatlas.billing_statements
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.billing_statements TO cuspatlas_app;
