-- B2: payments, payment attempts, allocations, refunds, transfers and settlement (synthetic data only;
-- ADR 0008, recommended-pending-billing-approval). A payment is a recorded fact posted as received
-- (undeposited funds against the patient's unapplied credit); settlement, allocation, refund and
-- transfer are their own journal entries. No card data, PAN or provider token is stored: the only
-- instrument is a synthetic opaque reference for the synthetic provider (B-S1 blocked-on-discovery).

-- A provider attempt (card_synthetic only). The capture outcome is immutable; an unknown outcome is
-- an open reconciliation item until a lookup resolves it, exactly once.
CREATE TABLE cuspatlas.billing_payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  patient_id uuid NOT NULL,
  guarantor_id uuid,
  method text NOT NULL CHECK (method IN ('card_synthetic')),
  instrument_ref text NOT NULL CHECK (instrument_ref ~ '^syn-card-[a-z0-9-]{1,40}$'),
  -- Stable provider idempotency key derived from the caller's idempotency scope (never the raw key).
  provider_key text NOT NULL CHECK (provider_key ~ '^[0-9a-f]{64}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 99999999999),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  outcome text NOT NULL CHECK (outcome IN ('confirmed', 'declined', 'unknown')),
  provider_receipt text CHECK (provider_receipt ~ '^syn-rcpt-[a-z0-9]{1,64}$'),
  resolution text CHECK (resolution IN ('captured', 'not_captured')),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES cuspatlas.principals (id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (guarantor_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, provider_key),
  CHECK (resolution IS NULL OR outcome = 'unknown'),
  CHECK ((resolution IS NULL) = (resolved_at IS NULL) AND (resolution IS NULL) = (resolved_by IS NULL)),
  CHECK ((outcome = 'confirmed' OR coalesce(resolution, '') = 'captured') = (provider_receipt IS NOT NULL))
);
CREATE INDEX billing_payment_attempts_open ON cuspatlas.billing_payment_attempts (tenant_id, created_at)
  WHERE outcome = 'unknown' AND resolution IS NULL;

CREATE TABLE cuspatlas.billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  patient_id uuid NOT NULL,
  guarantor_id uuid,
  method text NOT NULL CHECK (method IN ('cash', 'check', 'card_synthetic')),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 99999999999),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  external_ref text CHECK (external_ref ~ '^syn-[a-z0-9-]{1,60}$'),
  attempt_id uuid,
  received_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (guarantor_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (attempt_id, tenant_id) REFERENCES cuspatlas.billing_payment_attempts (id, tenant_id),
  UNIQUE (id, tenant_id),
  -- A receipt (check number, cash receipt, provider receipt) is recorded once per method.
  UNIQUE (tenant_id, method, external_ref),
  UNIQUE (tenant_id, attempt_id),
  CHECK ((method = 'card_synthetic') = (attempt_id IS NOT NULL)),
  CHECK (guarantor_id IS NULL OR guarantor_id <> patient_id)
);
CREATE INDEX billing_payments_patient ON cuspatlas.billing_payments (tenant_id, patient_id);

ALTER TABLE cuspatlas.billing_journal_entries
  ADD CONSTRAINT billing_journal_entries_payment
  FOREIGN KEY (payment_id, tenant_id) REFERENCES cuspatlas.billing_payments (id, tenant_id);
ALTER TABLE cuspatlas.billing_journal_lines
  ADD CONSTRAINT billing_journal_lines_payment
  FOREIGN KEY (payment_id, tenant_id) REFERENCES cuspatlas.billing_payments (id, tenant_id);
CREATE INDEX billing_journal_entries_payment ON cuspatlas.billing_journal_entries (tenant_id, payment_id);
CREATE INDEX billing_journal_lines_payment ON cuspatlas.billing_journal_lines (tenant_id, payment_id, account);

-- The cash and unapplied accounts join the receivables. Unapplied credit is held per payment and
-- per holding patient; cash per payment. Receivable lines may name the payment that paid them.
ALTER TABLE cuspatlas.billing_journal_lines DROP CONSTRAINT billing_journal_lines_account;
ALTER TABLE cuspatlas.billing_journal_lines ADD CONSTRAINT billing_journal_lines_account CHECK (account IN (
  'patient_receivable', 'insurer_receivable', 'production_revenue', 'unapplied_credit', 'undeposited_funds',
  'settled_cash'));
ALTER TABLE cuspatlas.billing_journal_lines DROP CONSTRAINT billing_journal_lines_dimensions;
ALTER TABLE cuspatlas.billing_journal_lines ADD CONSTRAINT billing_journal_lines_dimensions CHECK (CASE account
  WHEN 'patient_receivable' THEN charge_id IS NOT NULL AND payer_ref IS NULL
  WHEN 'insurer_receivable' THEN charge_id IS NOT NULL AND payer_ref IS NOT NULL
  WHEN 'production_revenue' THEN charge_id IS NOT NULL AND payer_ref IS NULL AND payment_id IS NULL
  WHEN 'unapplied_credit' THEN payment_id IS NOT NULL AND charge_id IS NULL AND payer_ref IS NULL
  WHEN 'undeposited_funds' THEN payment_id IS NOT NULL AND charge_id IS NULL AND payer_ref IS NULL
  WHEN 'settled_cash' THEN payment_id IS NOT NULL AND charge_id IS NULL AND payer_ref IS NULL
  ELSE false END);

-- Sign rules per dimension (the same table as the domain): receivables and cash never below zero,
-- revenue and unapplied credit never a debit. Unapplied credit is checked per payment and holder.
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
        CASE account WHEN 'insurer_receivable' THEN payer_ref WHEN 'unapplied_credit' THEN patient_id::text
          ELSE NULL END AS k2
      FROM cuspatlas.billing_journal_lines WHERE entry_id = p_entry AND tenant_id = p_tenant),
    totals AS (
      SELECT t.account, sum(l.amount_minor) AS s
      FROM touched t
      JOIN cuspatlas.billing_journal_lines l ON l.tenant_id = p_tenant AND l.account = t.account
        AND (CASE WHEN l.account IN ('unapplied_credit', 'undeposited_funds', 'settled_cash') THEN l.payment_id
               ELSE l.charge_id END) = t.k1
        AND (CASE l.account WHEN 'insurer_receivable' THEN l.payer_ref WHEN 'unapplied_credit' THEN l.patient_id::text
               ELSE NULL END) IS NOT DISTINCT FROM t.k2
      GROUP BY t.account, t.k1, t.k2)
    SELECT count(*) INTO v FROM totals
    WHERE (account IN ('patient_receivable', 'insurer_receivable', 'undeposited_funds', 'settled_cash') AND s < 0)
       OR (account IN ('production_revenue', 'unapplied_credit') AND s > 0);
    IF v <> 0 THEN
      RAISE EXCEPTION 'journal entry breaks an account sign rule' USING ERRCODE = '23514';
    END IF;
  END
  $$;

CREATE TRIGGER billing_payments_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.billing_payments
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_aggregate_guard();

-- An attempt's facts and capture outcome are immutable; only a single resolution of an unknown
-- outcome (and the version) may be recorded.
CREATE FUNCTION cuspatlas.billing_attempt_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'payment attempts are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (to_jsonb(NEW) - 'resolution' - 'resolved_at' - 'resolved_by' - 'provider_receipt' - 'version' - 'updated_at')
        IS DISTINCT FROM
       (to_jsonb(OLD) - 'resolution' - 'resolved_at' - 'resolved_by' - 'provider_receipt' - 'version' - 'updated_at') THEN
      RAISE EXCEPTION 'payment attempt facts are immutable' USING ERRCODE = '42501';
    END IF;
    IF OLD.resolution IS NOT NULL OR OLD.provider_receipt IS DISTINCT FROM NEW.provider_receipt
        AND OLD.provider_receipt IS NOT NULL THEN
      RAISE EXCEPTION 'a resolved attempt cannot be resolved again' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'payment attempt version must increase by one' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.billing_attempt_guard() FROM PUBLIC;
CREATE TRIGGER billing_payment_attempts_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.billing_payment_attempts
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_attempt_guard();

ALTER TABLE cuspatlas.billing_payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_payment_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.billing_payments FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_payment_attempts_select ON cuspatlas.billing_payment_attempts
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY billing_payment_attempts_insert ON cuspatlas.billing_payment_attempts
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND resolution IS NULL);
CREATE POLICY billing_payment_attempts_update ON cuspatlas.billing_payment_attempts
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND resolved_by = cuspatlas.current_actor_id());
CREATE POLICY billing_payments_select ON cuspatlas.billing_payments
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY billing_payments_insert ON cuspatlas.billing_payments
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY billing_payments_update ON cuspatlas.billing_payments
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.billing_payment_attempts TO cuspatlas_app;
GRANT UPDATE (resolution, resolved_at, resolved_by, provider_receipt, version, updated_at)
  ON cuspatlas.billing_payment_attempts TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.billing_payments TO cuspatlas_app;
GRANT UPDATE (version, updated_at) ON cuspatlas.billing_payments TO cuspatlas_app;
