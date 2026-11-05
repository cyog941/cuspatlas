-- B7 remittance ingestion and reconciliation against a FAKE clearinghouse (synthetic ERA-like
-- structure, not X12; synthetic data only; B-S2 open; ADR 0008 pending billing approval). An ERA is
-- never cash: posted lines move insurer receivable to `insurer_clearing`; the EFT/check settlement is
-- a separate fact (`insurer_cash`). Idempotent per remittance reference; corrections by reversal.
CREATE TABLE cuspatlas.rcm_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  remittance_ref text NOT NULL CHECK (remittance_ref ~ '^syn-era-[a-z0-9-]{1,60}$'),
  payer_ref text NOT NULL CHECK (payer_ref ~ '^syn-payer-[a-z0-9-]{1,40}$'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_paid_minor bigint NOT NULL CHECK (total_paid_minor >= 0),
  line_count integer NOT NULL CHECK (line_count BETWEEN 1 AND 500),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  ingested_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, remittance_ref)
);
CREATE TRIGGER rcm_remittances_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.rcm_remittances
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_aggregate_guard();

CREATE TABLE cuspatlas.rcm_remittance_lines (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  remittance_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 500),
  claim_id uuid,
  claim_line_no integer NOT NULL CHECK (claim_line_no >= 1),
  charge_id uuid,
  paid_minor bigint NOT NULL CHECK (paid_minor >= 0),
  contractual_minor bigint NOT NULL CHECK (contractual_minor >= 0),
  patient_responsibility_minor bigint NOT NULL CHECK (patient_responsibility_minor >= 0),
  denial_code text CHECK (denial_code ~ '^SYN-DN-[0-9]{3}$'),
  status text NOT NULL CHECK (status IN ('posted', 'denied', 'review')),
  review_reason text CHECK (review_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  FOREIGN KEY (remittance_id, tenant_id) REFERENCES cuspatlas.rcm_remittances (id, tenant_id),
  PRIMARY KEY (tenant_id, remittance_id, line_no),
  CHECK ((status = 'review') = (review_reason IS NOT NULL))
);

CREATE TABLE cuspatlas.rcm_remittance_settlements (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  remittance_id uuid NOT NULL,
  settlement_ref text NOT NULL CHECK (settlement_ref ~ '^syn-(eft|chk)-[a-z0-9-]{1,60}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 1),
  entry_id uuid NOT NULL,
  settled_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  settled_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (remittance_id, tenant_id) REFERENCES cuspatlas.rcm_remittances (id, tenant_id),
  PRIMARY KEY (tenant_id, settlement_ref)
);

CREATE TABLE cuspatlas.rcm_remittance_reversals (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  remittance_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  reversed_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  reversed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (remittance_id, tenant_id) REFERENCES cuspatlas.rcm_remittances (id, tenant_id),
  PRIMARY KEY (tenant_id, remittance_id)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rcm_remittances', 'rcm_remittance_lines', 'rcm_remittance_settlements',
    'rcm_remittance_reversals'] LOOP
    EXECUTE format('ALTER TABLE cuspatlas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE cuspatlas.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON cuspatlas.%I FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id())', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON cuspatlas.%I FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id())', t || '_insert', t);
    EXECUTE format('GRANT SELECT, INSERT ON cuspatlas.%I TO cuspatlas_app', t);
    IF t <> 'rcm_remittances' THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON cuspatlas.%I FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only()', t || '_append_only', t);
    END IF;
  END LOOP;
END
$$;
CREATE POLICY rcm_remittances_update ON cuspatlas.rcm_remittances FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
GRANT UPDATE (version, updated_at) ON cuspatlas.rcm_remittances TO cuspatlas_app;
