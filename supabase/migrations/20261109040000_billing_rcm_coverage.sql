-- B5: coverage records, coverage versions and eligibility records (synthetic data only; ADR 0008,
-- recommended-pending-billing-approval; live eligibility blocked-on-discovery, B-S3). Every row is
-- append-only except the coverage version counter. Freshness and the coverage status an estimate
-- reads are derived; no current, fresh, stale or active column exists. Payers, members, groups and
-- fee schedules are synthetic opaque references (no carrier catalog, no licensed code set, B-S4).

CREATE TABLE cuspatlas.rcm_coverages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  patient_id uuid NOT NULL,
  payer_ref text NOT NULL CHECK (payer_ref ~ '^syn-payer-[a-z0-9-]{1,40}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (id, tenant_id)
);
CREATE INDEX rcm_coverages_patient ON cuspatlas.rcm_coverages (tenant_id, patient_id);

-- One row per version of a coverage. The latest version is authoritative; earlier versions are the
-- coverage history an estimate or claim may still cite by (coverage, version).
CREATE TABLE cuspatlas.rcm_coverage_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  coverage_id uuid NOT NULL,
  coverage_version integer NOT NULL CHECK (coverage_version >= 1),
  benefit_rank smallint NOT NULL CHECK (benefit_rank BETWEEN 1 AND 3),
  subscriber_patient_id uuid NOT NULL,
  relationship_to_subscriber text NOT NULL CHECK (relationship_to_subscriber IN ('self', 'spouse', 'child', 'other')),
  member_ref text NOT NULL CHECK (member_ref ~ '^syn-member-[a-z0-9-]{1,40}$'),
  group_ref text CHECK (group_ref ~ '^syn-group-[a-z0-9-]{1,40}$'),
  fee_schedule_ref text CHECK (fee_schedule_ref ~ '^syn-fee-[a-z0-9-]{1,40}$'),
  effective_from date NOT NULL,
  effective_until date,
  overlap_override_reason text CHECK (overlap_override_reason ~ '^[a-z_]{1,64}$'),
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (coverage_id, tenant_id) REFERENCES cuspatlas.rcm_coverages (id, tenant_id),
  FOREIGN KEY (subscriber_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, coverage_id, coverage_version),
  CHECK (effective_until IS NULL OR effective_until >= effective_from),
  CHECK ((coverage_version = 1) = (reason_code IS NULL))
);

-- An eligibility result: its source (staff entry or the fake adapter), capture instant, freshness
-- window and state. A timeout is `unknown` (never ineligible); an unmappable response is `unparsed`
-- with its raw synthetic evidence and digest, never partially interpreted.
CREATE TABLE cuspatlas.rcm_eligibility_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  coverage_id uuid NOT NULL,
  coverage_version integer NOT NULL,
  source text NOT NULL CHECK (source IN ('entered', 'fake_adapter')),
  state text NOT NULL CHECK (state IN ('verified', 'unverified', 'unknown', 'unparsed')),
  service_date date NOT NULL,
  retrieved_at timestamptz NOT NULL,
  freshness_hours integer NOT NULL CHECK (freshness_hours BETWEEN 1 AND 8760),
  -- Field groups (status, limits, frequencies), each with its own provenance. Closed patterns only.
  benefits jsonb NOT NULL DEFAULT '{}'::jsonb,
  adapter_receipt text CHECK (adapter_receipt ~ '^syn-elig-[a-z0-9]{1,64}$'),
  raw_evidence jsonb,
  raw_evidence_digest text CHECK (raw_evidence_digest ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (coverage_id, tenant_id) REFERENCES cuspatlas.rcm_coverages (id, tenant_id),
  FOREIGN KEY (tenant_id, coverage_id, coverage_version)
    REFERENCES cuspatlas.rcm_coverage_versions (tenant_id, coverage_id, coverage_version),
  UNIQUE (id, tenant_id),
  CHECK ((state = 'unparsed') = (raw_evidence IS NOT NULL) AND (raw_evidence IS NULL) = (raw_evidence_digest IS NULL)),
  CHECK ((source = 'entered') = (state = 'unverified')),
  CHECK (state NOT IN ('unknown', 'unparsed') OR benefits = '{}'::jsonb)
);
CREATE INDEX rcm_eligibility_records_coverage ON cuspatlas.rcm_eligibility_records (tenant_id, coverage_id, retrieved_at);

CREATE TRIGGER rcm_coverages_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.rcm_coverages
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_aggregate_guard();
CREATE TRIGGER rcm_coverage_versions_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.rcm_coverage_versions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER rcm_eligibility_records_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.rcm_eligibility_records
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.rcm_coverages ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.rcm_coverages FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.rcm_coverage_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.rcm_coverage_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.rcm_eligibility_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.rcm_eligibility_records FORCE ROW LEVEL SECURITY;

CREATE POLICY rcm_coverages_select ON cuspatlas.rcm_coverages
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY rcm_coverages_insert ON cuspatlas.rcm_coverages
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY rcm_coverages_update ON cuspatlas.rcm_coverages
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY rcm_coverage_versions_select ON cuspatlas.rcm_coverage_versions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY rcm_coverage_versions_insert ON cuspatlas.rcm_coverage_versions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY rcm_eligibility_records_select ON cuspatlas.rcm_eligibility_records
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY rcm_eligibility_records_insert ON cuspatlas.rcm_eligibility_records
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.rcm_coverages TO cuspatlas_app;
GRANT UPDATE (version, updated_at) ON cuspatlas.rcm_coverages TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.rcm_coverage_versions TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.rcm_eligibility_records TO cuspatlas_app;

-- The B1/B2 seam: insurer receivable lines name a coverage instead of a bare synthetic payer
-- reference. Posted lines are never rewritten: legacy lines keep their payer reference, and every
-- new insurer line must name a coverage (NOT VALID checks apply to new rows only). The payer
-- reference is copied from the coverage for readability; the sign rule keys on the coverage.
ALTER TABLE cuspatlas.billing_journal_lines ADD COLUMN coverage_id uuid;
ALTER TABLE cuspatlas.billing_journal_lines
  ADD CONSTRAINT billing_journal_lines_coverage
  FOREIGN KEY (coverage_id, tenant_id) REFERENCES cuspatlas.rcm_coverages (id, tenant_id);
CREATE INDEX billing_journal_lines_coverage ON cuspatlas.billing_journal_lines (tenant_id, charge_id, coverage_id)
  WHERE coverage_id IS NOT NULL;
ALTER TABLE cuspatlas.billing_journal_lines DROP CONSTRAINT billing_journal_lines_dimensions;
ALTER TABLE cuspatlas.billing_journal_lines ADD CONSTRAINT billing_journal_lines_dimensions CHECK (CASE account
  WHEN 'patient_receivable' THEN charge_id IS NOT NULL AND payer_ref IS NULL AND coverage_id IS NULL
  WHEN 'insurer_receivable' THEN charge_id IS NOT NULL AND payer_ref IS NOT NULL
  WHEN 'production_revenue' THEN charge_id IS NOT NULL AND payer_ref IS NULL AND payment_id IS NULL
    AND coverage_id IS NULL
  WHEN 'unapplied_credit' THEN payment_id IS NOT NULL AND charge_id IS NULL AND payer_ref IS NULL
    AND coverage_id IS NULL
  WHEN 'undeposited_funds' THEN payment_id IS NOT NULL AND charge_id IS NULL AND payer_ref IS NULL
    AND coverage_id IS NULL
  WHEN 'settled_cash' THEN payment_id IS NOT NULL AND charge_id IS NULL AND payer_ref IS NULL AND coverage_id IS NULL
  ELSE false END);
ALTER TABLE cuspatlas.billing_journal_lines
  ADD CONSTRAINT billing_journal_lines_insurer_coverage
  CHECK (account <> 'insurer_receivable' OR coverage_id IS NOT NULL) NOT VALID;

-- Sign rules keyed on the coverage (or, for legacy lines, the payer reference).
CREATE OR REPLACE FUNCTION cuspatlas.billing_check_signs(p_tenant uuid, p_entry uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
  DECLARE
    v integer;
  BEGIN
    WITH touched AS (
      SELECT DISTINCT account,
        CASE WHEN account IN ('unapplied_credit', 'undeposited_funds', 'settled_cash') THEN payment_id
          ELSE charge_id END AS k1,
        CASE account WHEN 'insurer_receivable' THEN coalesce(coverage_id::text, payer_ref)
          WHEN 'unapplied_credit' THEN patient_id::text ELSE NULL END AS k2
      FROM cuspatlas.billing_journal_lines WHERE entry_id = p_entry AND tenant_id = p_tenant),
    totals AS (
      SELECT t.account, sum(l.amount_minor) AS s
      FROM touched t
      JOIN cuspatlas.billing_journal_lines l ON l.tenant_id = p_tenant AND l.account = t.account
        AND (CASE WHEN l.account IN ('unapplied_credit', 'undeposited_funds', 'settled_cash') THEN l.payment_id
               ELSE l.charge_id END) = t.k1
        AND (CASE l.account WHEN 'insurer_receivable' THEN coalesce(l.coverage_id::text, l.payer_ref)
               WHEN 'unapplied_credit' THEN l.patient_id::text ELSE NULL END) IS NOT DISTINCT FROM t.k2
      GROUP BY t.account, t.k1, t.k2)
    SELECT count(*) INTO v FROM totals
    WHERE (account IN ('patient_receivable', 'insurer_receivable', 'undeposited_funds', 'settled_cash') AND s < 0)
       OR (account IN ('production_revenue', 'unapplied_credit') AND s > 0);
    IF v <> 0 THEN
      RAISE EXCEPTION 'journal entry breaks an account sign rule' USING ERRCODE = '23514';
    END IF;
  END
  $$;

-- A reversal must also negate the coverage dimension exactly.
CREATE OR REPLACE FUNCTION cuspatlas.billing_check_entry(p_tenant uuid, p_entry uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
  DECLARE
    e cuspatlas.billing_journal_entries%ROWTYPE;
    o cuspatlas.billing_journal_entries%ROWTYPE;
    n integer;
    s bigint;
    bad integer;
  BEGIN
    SELECT * INTO e FROM cuspatlas.billing_journal_entries WHERE id = p_entry AND tenant_id = p_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'journal line without a visible entry' USING ERRCODE = '23503';
    END IF;
    SELECT count(*), coalesce(sum(amount_minor), 0) INTO n, s
      FROM cuspatlas.billing_journal_lines WHERE entry_id = p_entry AND tenant_id = p_tenant;
    IF n <> e.line_count OR n < 2 THEN
      RAISE EXCEPTION 'journal entry line count does not match its declaration' USING ERRCODE = '23514';
    END IF;
    IF s <> 0 THEN
      RAISE EXCEPTION 'journal entry is unbalanced' USING ERRCODE = '23514';
    END IF;
    IF e.reverses_entry_id IS NOT NULL THEN
      SELECT * INTO o FROM cuspatlas.billing_journal_entries WHERE id = e.reverses_entry_id AND tenant_id = p_tenant;
      IF NOT FOUND OR o.reverses_entry_id IS NOT NULL OR o.kind <> e.kind OR o.currency <> e.currency
          OR o.line_count <> e.line_count OR o.charge_id IS DISTINCT FROM e.charge_id
          OR o.payment_id IS DISTINCT FROM e.payment_id THEN
        RAISE EXCEPTION 'reversal does not match a reversible original' USING ERRCODE = '23514';
      END IF;
      SELECT count(*) INTO bad FROM (
        (SELECT account, -amount_minor AS amount_minor, patient_id, charge_id, payment_id, payer_ref, coverage_id
           FROM cuspatlas.billing_journal_lines WHERE entry_id = o.id AND tenant_id = p_tenant
         EXCEPT ALL
         SELECT account, amount_minor, patient_id, charge_id, payment_id, payer_ref, coverage_id
           FROM cuspatlas.billing_journal_lines WHERE entry_id = e.id AND tenant_id = p_tenant)
        UNION ALL
        (SELECT account, amount_minor, patient_id, charge_id, payment_id, payer_ref, coverage_id
           FROM cuspatlas.billing_journal_lines WHERE entry_id = e.id AND tenant_id = p_tenant
         EXCEPT ALL
         SELECT account, -amount_minor, patient_id, charge_id, payment_id, payer_ref, coverage_id
           FROM cuspatlas.billing_journal_lines WHERE entry_id = o.id AND tenant_id = p_tenant)) d;
      IF bad <> 0 THEN
        RAISE EXCEPTION 'reversal does not exactly negate its original' USING ERRCODE = '23514';
      END IF;
    END IF;
    PERFORM cuspatlas.billing_check_signs(p_tenant, p_entry);
  END
  $$;
