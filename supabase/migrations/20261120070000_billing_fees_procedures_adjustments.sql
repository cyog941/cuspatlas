-- B9 fee schedules, the C14 -> B rendered-procedure consumer, adjustments with approval, and the
-- journal accounts B7 posts remittance into (synthetic data only; ADR 0008, pending billing
-- approval; SYN- placeholder codes only, B-S4 open). New migration; no posted row is updated.

-- 1. Fee schedules: a schedule (tenant-wide or per location, or a payer allowance schedule named by a
-- coverage's fee_schedule_ref) has append-only versions; each version is effective from a date and
-- prices SYN- codes in integer minor units. A later version never reprices a posted charge: the
-- charge records the version it used.
CREATE TABLE cuspatlas.billing_fee_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  schedule_ref text NOT NULL CHECK (schedule_ref ~ '^syn-fee-[a-z0-9-]{1,40}$'),
  purpose text NOT NULL CHECK (purpose IN ('practice', 'allowance')),
  location_id uuid,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, schedule_ref),
  CHECK (purpose = 'practice' OR location_id IS NULL)
);
-- At most one practice schedule per location and one tenant-wide practice schedule.
CREATE UNIQUE INDEX billing_fee_schedules_one_practice
  ON cuspatlas.billing_fee_schedules (tenant_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE purpose = 'practice';

CREATE TABLE cuspatlas.billing_fee_schedule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  schedule_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  effective_from date NOT NULL,
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 500),
  reason_code text CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (schedule_id, tenant_id) REFERENCES cuspatlas.billing_fee_schedules (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, schedule_id, version_no)
);

CREATE TABLE cuspatlas.billing_fee_schedule_items (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  version_id uuid NOT NULL,
  code_ref text NOT NULL CHECK (code_ref ~ '^SYN-[A-Z0-9-]{1,40}$'),
  fee_minor bigint NOT NULL CHECK (fee_minor BETWEEN 0 AND 99999999999),
  FOREIGN KEY (version_id, tenant_id) REFERENCES cuspatlas.billing_fee_schedule_versions (id, tenant_id),
  PRIMARY KEY (tenant_id, version_id, code_ref)
);

-- A version is effective no earlier than the latest version of its schedule (no retroactive
-- insertion in the middle of the history; a same-day correction is a higher version number).
CREATE FUNCTION cuspatlas.billing_fee_version_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM cuspatlas.billing_fee_schedule_versions v
               WHERE v.schedule_id = NEW.schedule_id AND v.tenant_id = NEW.tenant_id
                 AND (v.effective_from > NEW.effective_from OR v.version_no >= NEW.version_no)) THEN
      RAISE EXCEPTION 'a fee schedule version must follow the latest version' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.billing_fee_version_guard() FROM PUBLIC;
CREATE TRIGGER billing_fee_schedule_versions_guard
  BEFORE INSERT ON cuspatlas.billing_fee_schedule_versions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_fee_version_guard();

-- Declared item count, checked at commit (no item can be added to a published version later).
CREATE FUNCTION cuspatlas.billing_fee_version_complete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF (SELECT count(*) FROM cuspatlas.billing_fee_schedule_items i
        WHERE i.version_id = NEW.id AND i.tenant_id = NEW.tenant_id) <> NEW.item_count THEN
      RAISE EXCEPTION 'a fee schedule version must contain exactly its declared items' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END
  $$;
CREATE FUNCTION cuspatlas.billing_fee_item_complete() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF (SELECT count(*) FROM cuspatlas.billing_fee_schedule_items i
        WHERE i.version_id = NEW.version_id AND i.tenant_id = NEW.tenant_id)
       <> (SELECT v.item_count FROM cuspatlas.billing_fee_schedule_versions v
           WHERE v.id = NEW.version_id AND v.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'a fee schedule version must contain exactly its declared items' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.billing_fee_version_complete(), cuspatlas.billing_fee_item_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER billing_fee_schedule_versions_complete
  AFTER INSERT ON cuspatlas.billing_fee_schedule_versions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_fee_version_complete();
CREATE CONSTRAINT TRIGGER billing_fee_schedule_items_complete
  AFTER INSERT ON cuspatlas.billing_fee_schedule_items DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_fee_item_complete();

-- 2. Charges from C14 rendered procedures. A clinical charge names the procedure (UUID), its SYN-
-- code (up to 40 characters with hyphens), the encounter location and the fee schedule version that
-- priced it. The manual synthetic seam stays for non-clinical synthetic charges only.
ALTER TABLE cuspatlas.billing_charges DROP CONSTRAINT billing_charges_source_check;
ALTER TABLE cuspatlas.billing_charges DROP CONSTRAINT billing_charges_procedure_ref_check;
ALTER TABLE cuspatlas.billing_charges DROP CONSTRAINT billing_charges_procedure_code_check;
ALTER TABLE cuspatlas.billing_charges
  ADD COLUMN fee_schedule_version_id uuid,
  ADD COLUMN location_id uuid,
  ADD CONSTRAINT billing_charges_source_check CHECK (source IN ('synthetic_procedure_seam', 'clinical_procedure')),
  ADD CONSTRAINT billing_charges_procedure_code_check CHECK (procedure_code ~ '^SYN-[A-Z0-9-]{1,40}$'),
  ADD CONSTRAINT billing_charges_procedure_ref_check CHECK (CASE source
    WHEN 'synthetic_procedure_seam' THEN procedure_ref ~ '^syn-proc-[a-z0-9-]{1,60}$'
      AND fee_schedule_version_id IS NULL
    WHEN 'clinical_procedure' THEN
      procedure_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND procedure_code IS NOT NULL AND fee_schedule_version_id IS NOT NULL AND location_id IS NOT NULL
    ELSE false END),
  ADD CONSTRAINT billing_charges_fee_version FOREIGN KEY (fee_schedule_version_id, tenant_id)
    REFERENCES cuspatlas.billing_fee_schedule_versions (id, tenant_id),
  ADD CONSTRAINT billing_charges_location FOREIGN KEY (location_id, tenant_id)
    REFERENCES cuspatlas.scheduling_locations (id, tenant_id);

-- One consumption per procedure event version (the C14 -> B idempotency key): inserted first, so a
-- concurrent duplicate waits on the unique key and then finds the committed consumption.
CREATE TABLE cuspatlas.billing_procedure_events (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  procedure_id uuid NOT NULL,
  event_version integer NOT NULL CHECK (event_version >= 1),
  event_type text NOT NULL CHECK (event_type IN ('procedure.rendered.v1', 'procedure.reversed.v1')),
  charge_id uuid NOT NULL,
  consumed_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, procedure_id, event_version)
);

-- 3. Adjustments (contractual, courtesy, write-off) are journal entries with a configured reason. A
-- courtesy adjustment or write-off is a request first and is posted only by a different human's
-- approval (no silent write-off); a contractual adjustment from a remittance posts directly (B-D2).
CREATE TABLE cuspatlas.billing_adjustment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  charge_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('courtesy', 'writeOff')),
  responsibility text NOT NULL CHECK (responsibility IN ('patient', 'insurer')),
  coverage_id uuid,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 99999999999),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  requested_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (charge_id, tenant_id) REFERENCES cuspatlas.billing_charges (id, tenant_id),
  FOREIGN KEY (coverage_id, tenant_id) REFERENCES cuspatlas.rcm_coverages (id, tenant_id),
  UNIQUE (id, tenant_id),
  CHECK ((responsibility = 'insurer') = (coverage_id IS NOT NULL))
);
CREATE TABLE cuspatlas.billing_adjustment_decisions (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  request_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  entry_id uuid,
  reason_code text CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  decided_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (request_id, tenant_id) REFERENCES cuspatlas.billing_adjustment_requests (id, tenant_id),
  PRIMARY KEY (tenant_id, request_id),
  CHECK ((decision = 'approved') = (entry_id IS NOT NULL))
);
-- The approver is never the requester (checked by the database too).
CREATE FUNCTION cuspatlas.billing_adjustment_decision_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM cuspatlas.billing_adjustment_requests r
               WHERE r.id = NEW.request_id AND r.tenant_id = NEW.tenant_id AND r.requested_by = NEW.decided_by) THEN
      RAISE EXCEPTION 'an adjustment is decided by someone other than its requester' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.billing_adjustment_decision_guard() FROM PUBLIC;
CREATE TRIGGER billing_adjustment_decisions_guard
  BEFORE INSERT ON cuspatlas.billing_adjustment_decisions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_adjustment_decision_guard();

-- 4. Journal accounts for adjustments and remittance. `adjustment_expense` (per charge) is the
-- contra-revenue side of an adjustment or write-off. `insurer_clearing` (per remittance) is money a
-- payer reported as paid but not yet received: an ERA is never cash. `insurer_cash` (per
-- remittance) is the EFT/check settlement, a separate fact.
ALTER TABLE cuspatlas.billing_journal_lines ADD COLUMN remittance_id uuid;
ALTER TABLE cuspatlas.billing_journal_entries ADD COLUMN remittance_id uuid;
ALTER TABLE cuspatlas.billing_journal_entries DROP CONSTRAINT billing_journal_entries_kind;
ALTER TABLE cuspatlas.billing_journal_entries ADD CONSTRAINT billing_journal_entries_kind CHECK (kind IN ('charge',
  'patientPayment', 'insurerPayment', 'adjustment', 'refund', 'writeOff', 'transfer', 'openingBalance', 'allocation',
  'settlement', 'responsibilityTransfer', 'insurerSettlement'));
ALTER TABLE cuspatlas.billing_journal_lines DROP CONSTRAINT billing_journal_lines_account;
ALTER TABLE cuspatlas.billing_journal_lines ADD CONSTRAINT billing_journal_lines_account CHECK (account IN (
  'patient_receivable', 'insurer_receivable', 'production_revenue', 'unapplied_credit', 'undeposited_funds',
  'settled_cash', 'adjustment_expense', 'insurer_clearing', 'insurer_cash'));
ALTER TABLE cuspatlas.billing_journal_lines DROP CONSTRAINT billing_journal_lines_dimensions;
ALTER TABLE cuspatlas.billing_journal_lines ADD CONSTRAINT billing_journal_lines_dimensions CHECK (CASE account
  WHEN 'patient_receivable' THEN charge_id IS NOT NULL AND payer_ref IS NULL AND coverage_id IS NULL
    AND remittance_id IS NULL
  WHEN 'insurer_receivable' THEN charge_id IS NOT NULL AND payer_ref IS NOT NULL AND remittance_id IS NULL
  WHEN 'production_revenue' THEN charge_id IS NOT NULL AND payer_ref IS NULL AND payment_id IS NULL
    AND coverage_id IS NULL AND remittance_id IS NULL
  WHEN 'unapplied_credit' THEN payment_id IS NOT NULL AND charge_id IS NULL AND payer_ref IS NULL
    AND coverage_id IS NULL AND remittance_id IS NULL
  WHEN 'undeposited_funds' THEN payment_id IS NOT NULL AND charge_id IS NULL AND payer_ref IS NULL
    AND coverage_id IS NULL AND remittance_id IS NULL
  WHEN 'settled_cash' THEN payment_id IS NOT NULL AND charge_id IS NULL AND payer_ref IS NULL AND coverage_id IS NULL
    AND remittance_id IS NULL
  WHEN 'adjustment_expense' THEN charge_id IS NOT NULL AND payer_ref IS NULL AND payment_id IS NULL
    AND coverage_id IS NULL AND remittance_id IS NULL
  WHEN 'insurer_clearing' THEN remittance_id IS NOT NULL AND charge_id IS NULL AND payment_id IS NULL
    AND payer_ref IS NOT NULL AND coverage_id IS NULL
  WHEN 'insurer_cash' THEN remittance_id IS NOT NULL AND charge_id IS NULL AND payment_id IS NULL
    AND payer_ref IS NOT NULL AND coverage_id IS NULL
  ELSE false END);

-- Sign rules: receivables, cash, clearing and adjustment expense never below zero per dimension;
-- revenue and unapplied credit never above zero.
CREATE OR REPLACE FUNCTION cuspatlas.billing_check_signs(p_tenant uuid, p_entry uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
  DECLARE
    v integer;
  BEGIN
    -- Race safety (unchanged from 20261120050000): lock every aggregate the entry touches first.
    PERFORM 1 FROM cuspatlas.billing_payments
      WHERE tenant_id = p_tenant AND id IN (SELECT payment_id FROM cuspatlas.billing_journal_lines
        WHERE entry_id = p_entry AND tenant_id = p_tenant AND payment_id IS NOT NULL)
      ORDER BY id FOR NO KEY UPDATE;
    PERFORM 1 FROM cuspatlas.billing_charges
      WHERE tenant_id = p_tenant AND id IN (SELECT charge_id FROM cuspatlas.billing_journal_lines
        WHERE entry_id = p_entry AND tenant_id = p_tenant AND charge_id IS NOT NULL)
      ORDER BY id FOR NO KEY UPDATE;
    WITH touched AS (
      SELECT DISTINCT account,
        CASE WHEN account IN ('unapplied_credit', 'undeposited_funds', 'settled_cash') THEN payment_id
          WHEN account IN ('insurer_clearing', 'insurer_cash') THEN remittance_id
          ELSE charge_id END AS k1,
        CASE account WHEN 'insurer_receivable' THEN coalesce(coverage_id::text, payer_ref)
          WHEN 'unapplied_credit' THEN patient_id::text ELSE NULL END AS k2
      FROM cuspatlas.billing_journal_lines WHERE entry_id = p_entry AND tenant_id = p_tenant),
    totals AS (
      SELECT t.account, sum(l.amount_minor) AS s
      FROM touched t
      JOIN cuspatlas.billing_journal_lines l ON l.tenant_id = p_tenant AND l.account = t.account
        AND (CASE WHEN l.account IN ('unapplied_credit', 'undeposited_funds', 'settled_cash') THEN l.payment_id
               WHEN l.account IN ('insurer_clearing', 'insurer_cash') THEN l.remittance_id
               ELSE l.charge_id END) = t.k1
        AND (CASE l.account WHEN 'insurer_receivable' THEN coalesce(l.coverage_id::text, l.payer_ref)
               WHEN 'unapplied_credit' THEN l.patient_id::text ELSE NULL END) IS NOT DISTINCT FROM t.k2
      GROUP BY t.account, t.k1, t.k2)
    SELECT count(*) INTO v FROM totals
    WHERE (account IN ('patient_receivable', 'insurer_receivable', 'undeposited_funds', 'settled_cash',
             'adjustment_expense', 'insurer_clearing', 'insurer_cash') AND s < 0)
       OR (account IN ('production_revenue', 'unapplied_credit') AND s > 0);
    IF v <> 0 THEN
      RAISE EXCEPTION 'journal entry breaks an account sign rule' USING ERRCODE = '23514';
    END IF;
  END
  $$;

-- Entry kinds and their accounts (review nit: B7/B9 kinds), and exact reversal including the
-- remittance dimension. Everything else is unchanged from 20261120050000.
CREATE OR REPLACE FUNCTION cuspatlas.billing_check_entry(p_tenant uuid, p_entry uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
  DECLARE
    e cuspatlas.billing_journal_entries%ROWTYPE;
    o cuspatlas.billing_journal_entries%ROWTYPE;
    pay cuspatlas.billing_payments%ROWTYPE;
    n integer;
    s bigint;
    bad integer;
    allowed text[];
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
    IF e.currency <> coalesce((SELECT currency FROM cuspatlas.billing_settings WHERE tenant_id = p_tenant), 'USD') THEN
      RAISE EXCEPTION 'journal entry is not in the tenant currency' USING ERRCODE = '23514';
    END IF;
    allowed := CASE e.kind
      WHEN 'charge' THEN ARRAY['patient_receivable', 'production_revenue']
      WHEN 'patientPayment' THEN ARRAY['undeposited_funds', 'unapplied_credit']
      WHEN 'allocation' THEN ARRAY['unapplied_credit', 'patient_receivable']
      WHEN 'settlement' THEN ARRAY['settled_cash', 'undeposited_funds']
      WHEN 'refund' THEN ARRAY['unapplied_credit', 'undeposited_funds', 'settled_cash']
      WHEN 'transfer' THEN ARRAY['unapplied_credit']
      WHEN 'responsibilityTransfer' THEN ARRAY['insurer_receivable', 'patient_receivable']
      WHEN 'adjustment' THEN ARRAY['adjustment_expense', 'patient_receivable', 'insurer_receivable']
      WHEN 'writeOff' THEN ARRAY['adjustment_expense', 'patient_receivable', 'insurer_receivable']
      WHEN 'insurerPayment' THEN ARRAY['insurer_clearing', 'insurer_receivable']
      WHEN 'insurerSettlement' THEN ARRAY['insurer_cash', 'insurer_clearing']
      ELSE ARRAY[]::text[] END;
    SELECT count(*) INTO bad FROM cuspatlas.billing_journal_lines
      WHERE entry_id = p_entry AND tenant_id = p_tenant AND NOT (account = ANY (allowed));
    IF bad <> 0 THEN
      RAISE EXCEPTION 'journal entry kind does not permit these accounts' USING ERRCODE = '23514';
    END IF;
    IF e.kind IN ('insurerPayment', 'insurerSettlement') AND e.remittance_id IS NULL THEN
      RAISE EXCEPTION 'a remittance entry names its remittance' USING ERRCODE = '23514';
    END IF;
    IF e.kind = 'patientPayment' AND e.reverses_entry_id IS NULL THEN
      SELECT * INTO pay FROM cuspatlas.billing_payments WHERE id = e.payment_id AND tenant_id = p_tenant;
      IF NOT FOUND OR (SELECT coalesce(sum(amount_minor), 0) FROM cuspatlas.billing_journal_lines
          WHERE entry_id = p_entry AND tenant_id = p_tenant AND account = 'undeposited_funds') <> pay.amount_minor THEN
        RAISE EXCEPTION 'a received entry must match its payment' USING ERRCODE = '23514';
      END IF;
      IF pay.method = 'card_synthetic' AND NOT EXISTS (
          SELECT 1 FROM cuspatlas.billing_payment_attempts a
          WHERE a.id = pay.attempt_id AND a.tenant_id = p_tenant AND a.amount_minor = pay.amount_minor
            AND a.currency = pay.currency AND (a.outcome = 'confirmed' OR a.resolution = 'captured')) THEN
        RAISE EXCEPTION 'a card payment needs a captured attempt of the same amount' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF e.reverses_entry_id IS NOT NULL THEN
      SELECT * INTO o FROM cuspatlas.billing_journal_entries WHERE id = e.reverses_entry_id AND tenant_id = p_tenant;
      IF NOT FOUND OR o.reverses_entry_id IS NOT NULL OR o.kind <> e.kind OR o.currency <> e.currency
          OR o.line_count <> e.line_count OR o.charge_id IS DISTINCT FROM e.charge_id
          OR o.payment_id IS DISTINCT FROM e.payment_id OR o.remittance_id IS DISTINCT FROM e.remittance_id THEN
        RAISE EXCEPTION 'reversal does not match a reversible original' USING ERRCODE = '23514';
      END IF;
      SELECT count(*) INTO bad FROM (
        (SELECT account, -amount_minor AS amount_minor, patient_id, charge_id, payment_id, payer_ref, coverage_id,
           remittance_id
           FROM cuspatlas.billing_journal_lines WHERE entry_id = o.id AND tenant_id = p_tenant
         EXCEPT ALL
         SELECT account, amount_minor, patient_id, charge_id, payment_id, payer_ref, coverage_id, remittance_id
           FROM cuspatlas.billing_journal_lines WHERE entry_id = e.id AND tenant_id = p_tenant)
        UNION ALL
        (SELECT account, amount_minor, patient_id, charge_id, payment_id, payer_ref, coverage_id, remittance_id
           FROM cuspatlas.billing_journal_lines WHERE entry_id = e.id AND tenant_id = p_tenant
         EXCEPT ALL
         SELECT account, -amount_minor, patient_id, charge_id, payment_id, payer_ref, coverage_id, remittance_id
           FROM cuspatlas.billing_journal_lines WHERE entry_id = o.id AND tenant_id = p_tenant)) d;
      IF bad <> 0 THEN
        RAISE EXCEPTION 'reversal does not exactly negate its original' USING ERRCODE = '23514';
      END IF;
    END IF;
    PERFORM cuspatlas.billing_check_signs(p_tenant, p_entry);
  END
  $$;

-- 5. Grants and row-level security (runtime role: SELECT and INSERT only; all append-only).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_fee_schedules', 'billing_fee_schedule_versions', 'billing_fee_schedule_items',
    'billing_procedure_events', 'billing_adjustment_requests', 'billing_adjustment_decisions'] LOOP
    EXECUTE format('ALTER TABLE cuspatlas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE cuspatlas.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON cuspatlas.%I FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id())', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON cuspatlas.%I FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id())', t || '_insert', t);
    EXECUTE format('GRANT SELECT, INSERT ON cuspatlas.%I TO cuspatlas_app', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON cuspatlas.%I FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only()', t || '_append_only', t);
  END LOOP;
END
$$;
