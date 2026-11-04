-- Hardening of B3-B5 after the independent review of 74f3232 (synthetic data only; ADR 0008, pending
-- billing approval). New migration; no applied migration is edited and no posted row is updated.

-- M1. A pending provider attempt carries an in-flight lease: the instant by which the request that
-- created it must have its provider answer (provider timeout plus margin). Reconciliation refuses a
-- pending attempt before its deadline. A premature `not_captured` resolution can be corrected exactly
-- once to `captured` (a later lookup or the original request's late answer), keeping the superseded
-- resolution, its instant and its actor; nothing else changes.
ALTER TABLE cuspatlas.billing_payment_attempts
  ADD COLUMN call_deadline timestamptz,
  ADD COLUMN superseded_resolution text CHECK (superseded_resolution = 'not_captured'),
  ADD COLUMN corrected_at timestamptz,
  ADD COLUMN corrected_by uuid,
  ADD CONSTRAINT billing_payment_attempts_correction CHECK (
    (superseded_resolution IS NULL) = (corrected_at IS NULL)
    AND (superseded_resolution IS NULL) = (corrected_by IS NULL)
    AND (superseded_resolution IS NULL OR resolution = 'captured'));

CREATE OR REPLACE FUNCTION cuspatlas.billing_attempt_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    lifecycle text[] := ARRAY['outcome', 'provider_receipt', 'resolution', 'resolved_at', 'resolved_by',
      'superseded_resolution', 'corrected_at', 'corrected_by', 'version', 'updated_at'];
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'payment attempts are never deleted' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'payment attempt version must increase by one' USING ERRCODE = '42501';
    END IF;
    IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
      RAISE EXCEPTION 'payment attempt facts are immutable' USING ERRCODE = '42501';
    END IF;
    IF OLD.outcome = 'pending' THEN
      IF NEW.outcome = 'pending' OR NEW.superseded_resolution IS NOT NULL THEN
        RAISE EXCEPTION 'a pending attempt may only record its outcome' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.outcome IS DISTINCT FROM OLD.outcome THEN
      RAISE EXCEPTION 'an attempt outcome is recorded once' USING ERRCODE = '42501';
    END IF;
    IF OLD.resolution IS NULL THEN
      IF NEW.superseded_resolution IS NOT NULL
         OR OLD.provider_receipt IS NOT NULL AND NEW.provider_receipt IS DISTINCT FROM OLD.provider_receipt THEN
        RAISE EXCEPTION 'a resolved attempt cannot be resolved again' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    -- The one correction: not_captured -> captured, with a receipt, keeping the first resolution.
    IF OLD.resolution = 'not_captured' AND OLD.superseded_resolution IS NULL AND NEW.resolution = 'captured'
       AND NEW.superseded_resolution = 'not_captured' AND OLD.provider_receipt IS NULL
       AND NEW.provider_receipt IS NOT NULL AND NEW.resolved_at = OLD.resolved_at
       AND NEW.resolved_by = OLD.resolved_by THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a resolved attempt cannot be resolved again' USING ERRCODE = '42501';
  END
  $$;

GRANT UPDATE (superseded_resolution, corrected_at, corrected_by) ON cuspatlas.billing_payment_attempts
  TO cuspatlas_app;
DROP POLICY billing_payment_attempts_update ON cuspatlas.billing_payment_attempts;
CREATE POLICY billing_payment_attempts_update ON cuspatlas.billing_payment_attempts
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id()
    AND (resolved_by IS NULL OR resolved_by = cuspatlas.current_actor_id()
      OR corrected_by = cuspatlas.current_actor_id()));

-- S4. The runtime role records an attempt only as pending; an outcome is only ever the transition.
DROP POLICY billing_payment_attempts_insert ON cuspatlas.billing_payment_attempts;
CREATE POLICY billing_payment_attempts_insert ON cuspatlas.billing_payment_attempts
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND outcome = 'pending' AND resolution IS NULL AND provider_receipt IS NULL AND call_deadline IS NOT NULL);

-- S4. A card payment names a captured attempt with its amount, currency and receipt.
CREATE FUNCTION cuspatlas.billing_payment_attempt_match() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.attempt_id IS NULL THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM cuspatlas.billing_payment_attempts a
      WHERE a.id = NEW.attempt_id AND a.tenant_id = NEW.tenant_id
        AND (a.outcome = 'confirmed' OR a.resolution = 'captured')
        AND a.amount_minor = NEW.amount_minor AND a.currency = NEW.currency
        AND a.provider_receipt = NEW.external_ref) THEN
      RAISE EXCEPTION 'a card payment must match its captured attempt' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.billing_payment_attempt_match() FROM PUBLIC;
CREATE TRIGGER billing_payments_attempt_match
  BEFORE INSERT ON cuspatlas.billing_payments
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_payment_attempt_match();

-- S5. A pre-B5 insurer line names a payer only. Its reversal must negate it exactly, so a reversal
-- line may carry a NULL coverage when the line it negates did; every other new insurer line names a
-- coverage and carries that coverage's payer.
ALTER TABLE cuspatlas.billing_journal_lines DROP CONSTRAINT billing_journal_lines_insurer_coverage;
CREATE FUNCTION cuspatlas.billing_insurer_line_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.account <> 'insurer_receivable' THEN
      RETURN NEW;
    END IF;
    IF NEW.coverage_id IS NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM cuspatlas.billing_journal_entries e
        JOIN cuspatlas.billing_journal_lines o ON o.entry_id = e.reverses_entry_id AND o.tenant_id = e.tenant_id
        WHERE e.id = NEW.entry_id AND e.tenant_id = NEW.tenant_id AND o.account = 'insurer_receivable'
          AND o.coverage_id IS NULL AND o.payer_ref = NEW.payer_ref AND o.charge_id = NEW.charge_id) THEN
        RAISE EXCEPTION 'an insurer line must name a coverage' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM cuspatlas.rcm_coverages c
      WHERE c.id = NEW.coverage_id AND c.tenant_id = NEW.tenant_id AND c.payer_ref = NEW.payer_ref) THEN
      RAISE EXCEPTION 'an insurer line carries its coverage''s payer' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.billing_insurer_line_check() FROM PUBLIC;
CREATE TRIGGER billing_journal_lines_insurer_check
  BEFORE INSERT ON cuspatlas.billing_journal_lines
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_insurer_line_check();

-- S6. An authorization reference is single-use across the tenant, not only within one plan.
CREATE UNIQUE INDEX billing_payment_plan_events_one_use_tenant
  ON cuspatlas.billing_payment_plan_events (tenant_id, authorization_ref) WHERE authorization_ref IS NOT NULL;
