-- M5: opening balances, unapplied credit and open items (workstream M; synthetic only;
-- recommended-pending-billing-approval; the practice's opening figures need financial sign-off).
--
-- Past financial events are never re-posted (M-D2). An opening figure is an explicit opening fact
-- (`migration_opening_items`, one per source row, with provenance and as-of precision) and, for a
-- patient balance or an unapplied credit, one B1 journal entry of the new `openingBalance` kind. The
-- kind may touch only three new accounts keyed on the opening item, so an opening balance can never
-- be posted as a charge (no production revenue, no charge receivable) nor allocated as a payment.
-- Open claims are opening references (work items), never a claim in a submittable state.
CREATE TABLE cuspatlas.migration_opening_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  package_id uuid NOT NULL,
  staged_record_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('balance', 'unappliedCredit', 'openClaim')),
  patient_id uuid NOT NULL,
  guarantor_source_id text CHECK (guarantor_source_id ~ '^[A-Za-z0-9._:/-]{1,64}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 99999999999),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  as_of date,
  as_of_precision text NOT NULL CHECK (as_of_precision IN ('day', 'approximate')),
  age_basis date,
  claim_state text CHECK (claim_state ~ '^[a-z_]{1,32}$'),
  source_ref text NOT NULL CHECK (source_ref ~ '^[A-Za-z0-9._:/-]{1,64}$'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (package_id, tenant_id) REFERENCES cuspatlas.migration_packages (id, tenant_id),
  FOREIGN KEY (staged_record_id, tenant_id) REFERENCES cuspatlas.migration_staged_records (id, tenant_id),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (staged_record_id),
  CHECK ((as_of_precision = 'day') = (as_of IS NOT NULL)),
  CHECK ((kind = 'openClaim') = (claim_state IS NOT NULL))
);
-- One opening balance per patient, currency and as-of date (duplicate_opening).
CREATE UNIQUE INDEX migration_opening_items_one_balance
  ON cuspatlas.migration_opening_items (tenant_id, patient_id, currency, coalesce(as_of, '1900-01-01'::date))
  WHERE kind = 'balance';
CREATE INDEX migration_opening_items_package ON cuspatlas.migration_opening_items (tenant_id, package_id);

CREATE FUNCTION cuspatlas.migration_opening_items_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION 'opening items are never changed; a correction is a new superseding record' USING ERRCODE = '42501';
  END
  $$;
CREATE TRIGGER migration_opening_items_guard BEFORE UPDATE OR DELETE ON cuspatlas.migration_opening_items
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_opening_items_guard();

ALTER TABLE cuspatlas.migration_opening_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_opening_items FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_opening_items_select ON cuspatlas.migration_opening_items
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_opening_items_insert ON cuspatlas.migration_opening_items
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.migration_opening_items TO cuspatlas_app;

-- Journal: the opening item dimension and three opening accounts.
ALTER TABLE cuspatlas.billing_journal_lines ADD COLUMN opening_item_id uuid,
  ADD CONSTRAINT billing_journal_lines_opening_item_fkey
    FOREIGN KEY (opening_item_id, tenant_id) REFERENCES cuspatlas.migration_opening_items (id, tenant_id);
ALTER TABLE cuspatlas.billing_journal_lines DROP CONSTRAINT billing_journal_lines_account;
ALTER TABLE cuspatlas.billing_journal_lines ADD CONSTRAINT billing_journal_lines_account CHECK (account IN (
  'patient_receivable', 'insurer_receivable', 'production_revenue', 'unapplied_credit', 'undeposited_funds',
  'settled_cash', 'adjustment_expense', 'insurer_clearing', 'insurer_cash', 'opening_receivable', 'opening_credit',
  'opening_equity'));
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
  WHEN 'opening_receivable' THEN opening_item_id IS NOT NULL AND charge_id IS NULL AND payment_id IS NULL
    AND payer_ref IS NULL AND coverage_id IS NULL AND remittance_id IS NULL
  WHEN 'opening_credit' THEN opening_item_id IS NOT NULL AND charge_id IS NULL AND payment_id IS NULL
    AND payer_ref IS NULL AND coverage_id IS NULL AND remittance_id IS NULL
  WHEN 'opening_equity' THEN opening_item_id IS NOT NULL AND charge_id IS NULL AND payment_id IS NULL
    AND payer_ref IS NULL AND coverage_id IS NULL AND remittance_id IS NULL
  ELSE false END AND (opening_item_id IS NULL OR account IN ('opening_receivable', 'opening_credit', 'opening_equity')));
GRANT INSERT (opening_item_id) ON cuspatlas.billing_journal_lines TO cuspatlas_app;

-- billing_check_signs: opening receivable never negative and opening credit never positive per item.
CREATE OR REPLACE FUNCTION cuspatlas.billing_check_signs(p_tenant uuid, p_entry uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
  DECLARE
    v integer;
  BEGIN
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
          WHEN account IN ('opening_receivable', 'opening_credit', 'opening_equity') THEN opening_item_id
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
               WHEN l.account IN ('opening_receivable', 'opening_credit', 'opening_equity') THEN l.opening_item_id
               ELSE l.charge_id END) = t.k1
        AND (CASE l.account WHEN 'insurer_receivable' THEN coalesce(l.coverage_id::text, l.payer_ref)
               WHEN 'unapplied_credit' THEN l.patient_id::text ELSE NULL END) IS NOT DISTINCT FROM t.k2
      GROUP BY t.account, t.k1, t.k2)
    SELECT count(*) INTO v FROM totals
    WHERE (account IN ('patient_receivable', 'insurer_receivable', 'undeposited_funds', 'settled_cash',
             'adjustment_expense', 'insurer_clearing', 'insurer_cash', 'opening_receivable') AND s < 0)
       OR (account IN ('production_revenue', 'unapplied_credit', 'opening_credit') AND s > 0);
    IF v <> 0 THEN
      RAISE EXCEPTION 'journal entry breaks an account sign rule' USING ERRCODE = '23514';
    END IF;
  END
  $$;

-- billing_check_entry: unchanged from 20261120070000 except the `openingBalance` kind, which until now
-- failed closed (no accounts allowed). It may touch only the opening accounts; every line names an
-- opening item of the entry's own patient whose amount and kind the line matches exactly, and an
-- opening entry is posted once per item and never reversed (a correction is a superseding record).
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
      WHEN 'openingBalance' THEN ARRAY['opening_receivable', 'opening_credit', 'opening_equity']
      ELSE ARRAY[]::text[] END;
    SELECT count(*) INTO bad FROM cuspatlas.billing_journal_lines
      WHERE entry_id = p_entry AND tenant_id = p_tenant AND NOT (account = ANY (allowed));
    IF bad <> 0 THEN
      RAISE EXCEPTION 'journal entry kind does not permit these accounts' USING ERRCODE = '23514';
    END IF;
    IF e.kind = 'openingBalance' THEN
      IF e.reverses_entry_id IS NOT NULL OR e.charge_id IS NOT NULL OR e.payment_id IS NOT NULL THEN
        RAISE EXCEPTION 'an opening entry is never a reversal, a charge or a payment' USING ERRCODE = '23514';
      END IF;
      SELECT count(*) INTO bad FROM cuspatlas.billing_journal_lines l
        LEFT JOIN cuspatlas.migration_opening_items i ON i.id = l.opening_item_id AND i.tenant_id = l.tenant_id
        WHERE l.entry_id = p_entry AND l.tenant_id = p_tenant AND (i.id IS NULL OR i.patient_id <> l.patient_id
          OR i.currency <> e.currency OR abs(l.amount_minor) <> i.amount_minor
          OR (l.account = 'opening_receivable' AND (i.kind <> 'balance' OR l.amount_minor < 0))
          OR (l.account = 'opening_credit' AND (i.kind <> 'unappliedCredit' OR l.amount_minor > 0))
          OR i.kind = 'openClaim');
      IF bad <> 0 OR (SELECT count(DISTINCT opening_item_id) FROM cuspatlas.billing_journal_lines
          WHERE entry_id = p_entry AND tenant_id = p_tenant) <> 1 OR (SELECT count(*) FROM cuspatlas.billing_journal_lines
          WHERE entry_id = p_entry AND tenant_id = p_tenant) <> 2 THEN
        RAISE EXCEPTION 'an opening entry posts exactly its one opening item' USING ERRCODE = '23514';
      END IF;
      IF (SELECT count(DISTINCT l.entry_id) FROM cuspatlas.billing_journal_lines l
          WHERE l.tenant_id = p_tenant AND l.opening_item_id = (SELECT opening_item_id FROM cuspatlas.billing_journal_lines
            WHERE entry_id = p_entry AND tenant_id = p_tenant LIMIT 1)) <> 1 THEN
        RAISE EXCEPTION 'an opening item is posted once' USING ERRCODE = '23514';
      END IF;
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
