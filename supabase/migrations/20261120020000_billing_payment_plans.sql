-- B3: payment plans, terms versions, authorization and auto-pay facts, and installment attempts
-- (synthetic data only; ADR 0008, recommended-pending-billing-approval; card and auto-pay execution
-- blocked-on-discovery, B-S1). Every plan fact is append-only. No balance, overdue, state or status
-- column exists: the plan view derives them from the terms, the facts, the attempts and the journal.
-- No card data is stored: the instrument is a synthetic opaque reference and a card expiry month.

-- The plan aggregate: identity, parties and time zone. Only the version (the serialization point of
-- plan commands) moves.
CREATE TABLE cuspatlas.billing_payment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  patient_id uuid NOT NULL,
  -- Null: the patient guarantees its own plan. Otherwise the S5 guarantor at creation.
  guarantor_id uuid,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- IANA zone in which installment due dates and card expiry are evaluated.
  time_zone text NOT NULL CHECK (time_zone ~ '^[A-Z][A-Za-z_+-]*(/[A-Za-z0-9_+-]+){1,2}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (guarantor_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (id, tenant_id),
  CHECK (guarantor_id IS NULL OR guarantor_id <> patient_id)
);
CREATE INDEX billing_payment_plans_patient ON cuspatlas.billing_payment_plans (tenant_id, patient_id);

-- One row per terms version. An amendment is a new version; the schedule of a version splits
-- (contract total - collected basis) evenly over its installments (ADR 0008 M-4).
CREATE TABLE cuspatlas.billing_payment_plan_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  terms_version integer NOT NULL CHECK (terms_version >= 1),
  contract_total_minor bigint NOT NULL CHECK (contract_total_minor BETWEEN 1 AND 99999999999),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  installment_count smallint NOT NULL CHECK (installment_count BETWEEN 1 AND 120),
  first_due_on date NOT NULL,
  -- Money collected under earlier terms when this version was agreed.
  collected_basis_minor bigint NOT NULL CHECK (collected_basis_minor >= 0),
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (plan_id, tenant_id) REFERENCES cuspatlas.billing_payment_plans (id, tenant_id),
  UNIQUE (tenant_id, plan_id, terms_version),
  CHECK (collected_basis_minor < contract_total_minor),
  CHECK ((terms_version = 1) = (reason_code IS NULL))
);

-- Authorization, auto-pay and closure facts. An authorization record is used once per plan, so a
-- card update always needs a new one. A plan is closed (voided or defaulted) at most once.
CREATE TABLE cuspatlas.billing_payment_plan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  terms_version integer NOT NULL CHECK (terms_version >= 1),
  kind text NOT NULL CHECK (kind IN ('authorized', 'autopay_enrolled', 'autopay_paused', 'autopay_resumed',
    'voided', 'defaulted')),
  authorization_ref text CHECK (authorization_ref ~ '^syn-auth-[a-z0-9-]{1,60}$'),
  evidence_ref text CHECK (evidence_ref ~ '^syn-evidence-[a-z0-9-]{1,60}$'),
  instrument_ref text CHECK (instrument_ref ~ '^syn-card-[a-z0-9-]{1,40}$'),
  card_expiry text CHECK (card_expiry ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (plan_id, tenant_id) REFERENCES cuspatlas.billing_payment_plans (id, tenant_id),
  FOREIGN KEY (tenant_id, plan_id, terms_version)
    REFERENCES cuspatlas.billing_payment_plan_terms (tenant_id, plan_id, terms_version),
  CHECK (CASE kind
    WHEN 'authorized' THEN authorization_ref IS NOT NULL AND evidence_ref IS NOT NULL AND instrument_ref IS NULL
    WHEN 'autopay_enrolled' THEN authorization_ref IS NOT NULL AND instrument_ref IS NOT NULL AND card_expiry IS NOT NULL
    WHEN 'voided' THEN reason_code IS NOT NULL AND authorization_ref IS NULL
    WHEN 'defaulted' THEN reason_code IS NOT NULL AND authorization_ref IS NULL
    ELSE authorization_ref IS NULL AND instrument_ref IS NULL END)
);
CREATE UNIQUE INDEX billing_payment_plan_events_one_use
  ON cuspatlas.billing_payment_plan_events (tenant_id, plan_id, authorization_ref) WHERE authorization_ref IS NOT NULL;
CREATE UNIQUE INDEX billing_payment_plan_events_one_close
  ON cuspatlas.billing_payment_plan_events (tenant_id, plan_id) WHERE kind IN ('voided', 'defaulted');
CREATE INDEX billing_payment_plan_events_plan ON cuspatlas.billing_payment_plan_events (tenant_id, plan_id, created_at);

-- One row per installment attempt. A blocked attempt (expired card) never reached the provider; any
-- other attempt names the B2 provider attempt whose outcome (and single reconciliation) it reports.
CREATE TABLE cuspatlas.billing_payment_plan_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  terms_version integer NOT NULL,
  period_no smallint NOT NULL CHECK (period_no BETWEEN 1 AND 120),
  attempt_no smallint NOT NULL CHECK (attempt_no BETWEEN 1 AND 100),
  outcome text NOT NULL CHECK (outcome IN ('confirmed', 'declined', 'unknown', 'blocked')),
  block_reason text CHECK (block_reason IN ('card_expired')),
  payment_attempt_id uuid,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 99999999999),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (plan_id, tenant_id) REFERENCES cuspatlas.billing_payment_plans (id, tenant_id),
  FOREIGN KEY (tenant_id, plan_id, terms_version)
    REFERENCES cuspatlas.billing_payment_plan_terms (tenant_id, plan_id, terms_version),
  FOREIGN KEY (payment_attempt_id, tenant_id) REFERENCES cuspatlas.billing_payment_attempts (id, tenant_id),
  -- Two concurrent scheduler runs for one installment cannot both record an attempt.
  UNIQUE (tenant_id, plan_id, terms_version, period_no, attempt_no),
  UNIQUE (tenant_id, payment_attempt_id),
  CHECK ((outcome = 'blocked') = (payment_attempt_id IS NULL)),
  CHECK ((outcome = 'blocked') = (block_reason IS NOT NULL))
);
CREATE INDEX billing_payment_plan_attempts_plan ON cuspatlas.billing_payment_plan_attempts (tenant_id, plan_id);

CREATE TRIGGER billing_payment_plans_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.billing_payment_plans
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_aggregate_guard();
CREATE TRIGGER billing_payment_plan_terms_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.billing_payment_plan_terms
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER billing_payment_plan_events_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.billing_payment_plan_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER billing_payment_plan_attempts_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.billing_payment_plan_attempts
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.billing_payment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_payment_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_payment_plan_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_payment_plan_terms FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_payment_plan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_payment_plan_events FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_payment_plan_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_payment_plan_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_payment_plans_select ON cuspatlas.billing_payment_plans
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY billing_payment_plans_insert ON cuspatlas.billing_payment_plans
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY billing_payment_plans_update ON cuspatlas.billing_payment_plans
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY billing_payment_plan_terms_select ON cuspatlas.billing_payment_plan_terms
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY billing_payment_plan_terms_insert ON cuspatlas.billing_payment_plan_terms
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY billing_payment_plan_events_select ON cuspatlas.billing_payment_plan_events
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY billing_payment_plan_events_insert ON cuspatlas.billing_payment_plan_events
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY billing_payment_plan_attempts_select ON cuspatlas.billing_payment_plan_attempts
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY billing_payment_plan_attempts_insert ON cuspatlas.billing_payment_plan_attempts
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());

GRANT SELECT, INSERT ON cuspatlas.billing_payment_plans TO cuspatlas_app;
GRANT UPDATE (version, updated_at) ON cuspatlas.billing_payment_plans TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.billing_payment_plan_terms TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.billing_payment_plan_events TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.billing_payment_plan_attempts TO cuspatlas_app;
