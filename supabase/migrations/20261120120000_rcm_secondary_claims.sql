-- B8 secondary claims and coordination of benefits against the FAKE clearinghouse only (synthetic data
-- only; B-S2 open: no real COB rules, no X12; ADR 0008 pending billing approval). A secondary claim is
-- an ordinary claim lineage (own versions, validation, submission, events, remittance) plus one fact
-- naming the primary claim, the primary submission whose paid adjudication it relies on and the COB
-- evidence (primary remittance lines with paid, contractual and patient-responsibility amounts) with
-- its digest. One secondary per primary. Tertiary coordination is not supported.
CREATE TABLE cuspatlas.rcm_secondary_claims (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  claim_id uuid NOT NULL,
  primary_claim_id uuid NOT NULL,
  primary_submission_id uuid NOT NULL,
  cob_evidence jsonb NOT NULL CHECK (jsonb_typeof(cob_evidence) = 'array' AND jsonb_array_length(cob_evidence) >= 1),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id, tenant_id) REFERENCES cuspatlas.rcm_claims (id, tenant_id),
  FOREIGN KEY (primary_claim_id, tenant_id) REFERENCES cuspatlas.rcm_claims (id, tenant_id),
  FOREIGN KEY (primary_submission_id, tenant_id) REFERENCES cuspatlas.rcm_claim_submissions (id, tenant_id),
  PRIMARY KEY (tenant_id, claim_id),
  UNIQUE (tenant_id, primary_claim_id),
  CHECK (claim_id <> primary_claim_id)
);
ALTER TABLE cuspatlas.rcm_secondary_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.rcm_secondary_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY rcm_secondary_claims_select ON cuspatlas.rcm_secondary_claims FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY rcm_secondary_claims_insert ON cuspatlas.rcm_secondary_claims FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
GRANT SELECT, INSERT ON cuspatlas.rcm_secondary_claims TO cuspatlas_app;
CREATE TRIGGER rcm_secondary_claims_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.rcm_secondary_claims
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
