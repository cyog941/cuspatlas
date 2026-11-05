-- Hardening H2 M-10 (workstream M/B seam; synthetic only; recommended-pending-billing-approval):
-- migrated opening credit can be allocated to charges through the B2 allocation command. An
-- `allocation` entry may now draw on `opening_credit` (per opening item of kind unappliedCredit, of the
-- line's own patient and the entry currency) instead of a payment's `unapplied_credit`; such an entry
-- names its charge and no payment and never mixes the two funding sources. The existing sign rule (an
-- item's opening credit never turns positive) bounds it by what the item still holds. Otherwise
-- billing_check_entry is unchanged from 20261126020000.
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
      WHEN 'allocation' THEN ARRAY['unapplied_credit', 'patient_receivable', 'opening_credit']
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
    IF e.kind = 'allocation' AND EXISTS (SELECT 1 FROM cuspatlas.billing_journal_lines
        WHERE entry_id = p_entry AND tenant_id = p_tenant AND account = 'opening_credit') THEN
      SELECT count(*) INTO bad FROM cuspatlas.billing_journal_lines l
        LEFT JOIN cuspatlas.migration_opening_items i ON i.id = l.opening_item_id AND i.tenant_id = l.tenant_id
        WHERE l.entry_id = p_entry AND l.tenant_id = p_tenant AND (l.account = 'unapplied_credit'
          OR (l.account = 'opening_credit' AND (i.id IS NULL OR i.kind <> 'unappliedCredit'
            OR i.patient_id <> l.patient_id OR i.currency <> e.currency OR l.amount_minor <= 0)));
      IF bad <> 0 OR e.payment_id IS NOT NULL OR e.charge_id IS NULL THEN
        RAISE EXCEPTION 'an opening-credit allocation draws only on opening credit items' USING ERRCODE = '23514';
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
