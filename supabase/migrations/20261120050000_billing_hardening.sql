-- Hardening of B1/B2 after independent review (synthetic data only; ADR 0008, pending billing
-- approval). No posted row is updated by this migration.

-- 1. A provider attempt is recorded as `pending` and committed before the provider is called. The
-- outcome moves exactly once from pending to the provider's answer (or to unknown with a resolution
-- when reconciliation finds a lost finalize); every other fact stays immutable.
ALTER TABLE cuspatlas.billing_payment_attempts DROP CONSTRAINT billing_payment_attempts_outcome_check;
ALTER TABLE cuspatlas.billing_payment_attempts ADD CONSTRAINT billing_payment_attempts_outcome_check
  CHECK (outcome IN ('pending', 'confirmed', 'declined', 'unknown'));
DROP INDEX cuspatlas.billing_payment_attempts_open;
CREATE INDEX billing_payment_attempts_open ON cuspatlas.billing_payment_attempts (tenant_id, created_at)
  WHERE outcome IN ('pending', 'unknown') AND resolution IS NULL;

CREATE OR REPLACE FUNCTION cuspatlas.billing_attempt_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'payment attempts are never deleted' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'payment attempt version must increase by one' USING ERRCODE = '42501';
    END IF;
    IF OLD.outcome = 'pending' THEN
      IF NEW.outcome = 'pending' OR (to_jsonb(NEW) - 'outcome' - 'provider_receipt' - 'resolution' - 'resolved_at'
          - 'resolved_by' - 'version' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'outcome' - 'provider_receipt'
          - 'resolution' - 'resolved_at' - 'resolved_by' - 'version' - 'updated_at') THEN
        RAISE EXCEPTION 'a pending attempt may only record its outcome' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
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
    RETURN NEW;
  END
  $$;

GRANT UPDATE (outcome) ON cuspatlas.billing_payment_attempts TO cuspatlas_app;
DROP POLICY billing_payment_attempts_update ON cuspatlas.billing_payment_attempts;
CREATE POLICY billing_payment_attempts_update ON cuspatlas.billing_payment_attempts
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id()
    AND (resolved_by IS NULL OR resolved_by = cuspatlas.current_actor_id()));

-- A plan attempt sent to the provider reports the B2 attempt's outcome instead of copying it.
ALTER TABLE cuspatlas.billing_payment_plan_attempts DROP CONSTRAINT billing_payment_plan_attempts_outcome_check;
ALTER TABLE cuspatlas.billing_payment_plan_attempts ADD CONSTRAINT billing_payment_plan_attempts_outcome_check
  CHECK (outcome IN ('submitted', 'confirmed', 'declined', 'unknown', 'blocked'));

-- 3. At most one received entry per payment (reversals aside).
CREATE UNIQUE INDEX billing_journal_one_receipt ON cuspatlas.billing_journal_entries (tenant_id, payment_id)
  WHERE kind = 'patientPayment' AND reverses_entry_id IS NULL;

-- Posting instants are the statement clock, not the transaction start, so entries of one long
-- transaction and the post-merge probe order correctly.
ALTER TABLE cuspatlas.billing_journal_entries ALTER COLUMN posted_at SET DEFAULT clock_timestamp();

-- 2. The commit-time sign rule locks (NO KEY UPDATE: line inserts hold KEY SHARE through their foreign
-- keys) the payments, then the charges, the entry touches (the domain's
-- lock order) before summing, so two raw transactions cannot both pass on stale sums.
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

-- 3. Structural backstops at commit: the accounts each entry kind may touch, the tenant currency,
-- and a received entry that matches its payment (a card payment needs a captured attempt of the same
-- amount). Unapplied holders across a merge set stay a domain rule (a transfer legitimately moves
-- funds to another patient, and the merge set is resolved at read time).
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
      ELSE ARRAY[]::text[] END;
    SELECT count(*) INTO bad FROM cuspatlas.billing_journal_lines
      WHERE entry_id = p_entry AND tenant_id = p_tenant AND NOT (account = ANY (allowed));
    IF bad <> 0 THEN
      RAISE EXCEPTION 'journal entry kind does not permit these accounts' USING ERRCODE = '23514';
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
