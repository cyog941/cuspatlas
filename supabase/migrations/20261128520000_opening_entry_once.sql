-- Hardening H2 M-6 (workstream M; synthetic only; recommended-pending-billing-approval): an opening item
-- is posted once at the database, not only by the deferred entry check (which two concurrent
-- transactions can both pass before either commits). Every opening entry carries exactly one
-- `opening_equity` line for its item, and only an opening entry touches `opening_equity` (an allocation
-- of opening credit touches the credit side, never equity), so one equity line per item is one opening
-- entry per item. The equity side is also constrained: it offsets a balance (negative) or a credit
-- (positive) and never an open claim, so an entry of two equity lines cannot stand in for a posting.
CREATE UNIQUE INDEX billing_journal_lines_opening_equity_once
  ON cuspatlas.billing_journal_lines (tenant_id, opening_item_id) WHERE account = 'opening_equity';

CREATE FUNCTION cuspatlas.billing_opening_equity_side() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  DECLARE
    k text;
  BEGIN
    SELECT i.kind INTO k FROM cuspatlas.migration_opening_items i
      WHERE i.id = NEW.opening_item_id AND i.tenant_id = NEW.tenant_id;
    IF k IS NULL OR k = 'openClaim' OR (k = 'balance' AND NEW.amount_minor >= 0)
        OR (k = 'unappliedCredit' AND NEW.amount_minor <= 0) THEN
      RAISE EXCEPTION 'opening equity offsets its own opening item' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER billing_journal_lines_opening_equity_side BEFORE INSERT ON cuspatlas.billing_journal_lines
  FOR EACH ROW WHEN (NEW.account = 'opening_equity') EXECUTE FUNCTION cuspatlas.billing_opening_equity_side();
