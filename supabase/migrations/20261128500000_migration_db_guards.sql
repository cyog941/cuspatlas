-- Hardening H2 M-2 (workstream M; synthetic only; recommended-pending-approval): database-level
-- protection against the runtime role for the three facts that gate a cutover. Every guard is
-- SECURITY INVOKER and reads only rows the runtime role already sees in its own tenant.
--
-- (a) An opening item is written only inside an apply run (a run row of the same transaction, package
--     and actor) and only for a staged record of the same package whose validated payload value, sign,
--     currency, source id and applied patient the item repeats exactly.
-- (b) migration_packages.cutover_state moves only through the domain state machine: a change-sequence
--     bump (by exactly one) always resets to `reconciling`; `reconciling -> readyForCutover` needs the
--     latest report bound to the current change sequence with no blocking exception and approvals of
--     both reviewer roles by two distinct signers bound to that report's digest; nothing else changes
--     the state.
-- (c) A sign-off repeats the digest of the latest report of its package (bound to the current change
--     sequence), and its signer is a human principal with a live membership holding migration.signoff.
CREATE TABLE cuspatlas.migration_apply_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  package_id uuid NOT NULL,
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[0-9a-f]{64}$'),
  xact_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  started_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  started_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (package_id, tenant_id) REFERENCES cuspatlas.migration_packages (id, tenant_id)
);
CREATE INDEX migration_apply_runs_package ON cuspatlas.migration_apply_runs (tenant_id, package_id);
CREATE TRIGGER migration_apply_runs_guard BEFORE UPDATE OR DELETE ON cuspatlas.migration_apply_runs
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_applied_records_guard();
ALTER TABLE cuspatlas.migration_apply_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.migration_apply_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_apply_runs_select ON cuspatlas.migration_apply_runs
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY migration_apply_runs_insert ON cuspatlas.migration_apply_runs
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND started_by = cuspatlas.current_actor_id()
    AND xact_id = pg_current_xact_id());
GRANT SELECT, INSERT ON cuspatlas.migration_apply_runs TO cuspatlas_app;

-- (a)
CREATE FUNCTION cuspatlas.migration_opening_items_bind() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  DECLARE
    s cuspatlas.migration_staged_records%ROWTYPE;
    v text;
    n numeric;
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM cuspatlas.migration_apply_runs r WHERE r.tenant_id = NEW.tenant_id
        AND r.package_id = NEW.package_id AND r.xact_id = pg_current_xact_id() AND r.started_by = NEW.created_by) THEN
      RAISE EXCEPTION 'an opening item is written only by an apply run in progress' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO s FROM cuspatlas.migration_staged_records
      WHERE id = NEW.staged_record_id AND tenant_id = NEW.tenant_id AND package_id = NEW.package_id;
    IF NOT FOUND OR NOT s.mapped OR s.issue_code IS NOT NULL OR s.source_id IS DISTINCT FROM NEW.source_ref
        OR (s.payload ->> 'currency') IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'an opening item repeats a staged record of its own package' USING ERRCODE = '42501';
    END IF;
    v := CASE s.entity WHEN 'ledger_balances' THEN s.payload ->> 'balance_minor'
      WHEN 'unapplied_credits' THEN s.payload ->> 'amount_minor'
      WHEN 'open_claims' THEN s.payload ->> 'outstanding_minor' END;
    IF v IS NULL OR v !~ '^-?[0-9]{1,15}$' THEN
      RAISE EXCEPTION 'an opening item needs a validated staged amount' USING ERRCODE = '42501';
    END IF;
    n := v::numeric;
    IF abs(n) <> NEW.amount_minor OR NOT (
        (NEW.kind = 'balance' AND s.entity = 'ledger_balances' AND n > 0)
        OR (NEW.kind = 'unappliedCredit' AND s.entity = 'unapplied_credits' AND n > 0)
        OR (NEW.kind = 'unappliedCredit' AND s.entity = 'ledger_balances' AND n < 0 AND EXISTS (
          SELECT 1 FROM cuspatlas.migration_review_items i WHERE i.tenant_id = NEW.tenant_id
            AND i.package_id = NEW.package_id AND i.decision = 'acceptProposal'
            AND NEW.staged_record_id = ANY (i.staged_record_ids)))
        OR (NEW.kind = 'openClaim' AND s.entity = 'open_claims' AND n <> 0)) THEN
      RAISE EXCEPTION 'an opening item amount and kind equal its staged value' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cuspatlas.migration_applied_records a
        JOIN cuspatlas.migration_staged_records p ON p.id = a.staged_record_id AND p.tenant_id = a.tenant_id
        WHERE a.tenant_id = NEW.tenant_id AND a.package_id = NEW.package_id
          AND a.action IN ('createPatient', 'linkPatient') AND p.entity = 'patients'
          AND p.source_id = (s.payload ->> 'patient_id') AND a.patient_id = NEW.patient_id) THEN
      RAISE EXCEPTION 'an opening item belongs to the patient its source row was applied to' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER migration_opening_items_bind BEFORE INSERT ON cuspatlas.migration_opening_items
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_opening_items_bind();

-- (b)
CREATE FUNCTION cuspatlas.migration_packages_cutover_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  DECLARE
    r cuspatlas.migration_reports%ROWTYPE;
  BEGIN
    IF NEW.change_seq <> OLD.change_seq THEN
      IF NEW.change_seq <> OLD.change_seq + 1 OR NEW.cutover_state <> 'reconciling' THEN
        RAISE EXCEPTION 'a change bumps the sequence by one and resets cutover readiness' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.cutover_state = OLD.cutover_state THEN
      RETURN NEW;
    END IF;
    IF OLD.cutover_state = 'reconciling' AND NEW.cutover_state = 'readyForCutover' THEN
      SELECT * INTO r FROM cuspatlas.migration_reports
        WHERE package_id = NEW.id AND tenant_id = NEW.tenant_id ORDER BY version DESC LIMIT 1;
      IF FOUND AND r.change_seq = NEW.change_seq
          AND jsonb_array_length(coalesce(r.body -> 'blockingExceptions', '[]'::jsonb)) = 0
          AND NOT EXISTS (SELECT 1 FROM cuspatlas.migration_signoffs s
            WHERE s.report_id = r.id AND s.tenant_id = NEW.tenant_id AND s.decision = 'rejected')
          AND (SELECT count(DISTINCT s.role) = 2 AND count(DISTINCT s.signed_by) = 2
            FROM cuspatlas.migration_signoffs s WHERE s.report_id = r.id AND s.tenant_id = NEW.tenant_id
              AND s.report_digest = r.digest AND s.decision = 'approved') THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'cutover readiness changes only through the guarded transition' USING ERRCODE = '42501';
  END
  $$;
CREATE TRIGGER migration_packages_cutover_guard BEFORE UPDATE ON cuspatlas.migration_packages
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_packages_cutover_guard();

-- (c)
CREATE FUNCTION cuspatlas.migration_signoffs_bind() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  DECLARE
    r cuspatlas.migration_reports%ROWTYPE;
  BEGIN
    SELECT * INTO r FROM cuspatlas.migration_reports
      WHERE package_id = NEW.package_id AND tenant_id = NEW.tenant_id ORDER BY version DESC LIMIT 1;
    IF NOT FOUND OR r.id <> NEW.report_id OR r.digest <> NEW.report_digest OR r.change_seq <> (
        SELECT p.change_seq FROM cuspatlas.migration_packages p
        WHERE p.id = NEW.package_id AND p.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'a sign-off binds the current report version and digest' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cuspatlas.principals pr
        JOIN cuspatlas.memberships m ON m.principal_id = pr.id AND m.tenant_id = NEW.tenant_id
        WHERE pr.id = NEW.signed_by AND pr.kind = 'human' AND m.revoked_at IS NULL
          AND 'migration.signoff' = ANY (m.scopes)) THEN
      RAISE EXCEPTION 'a sign-off is made by a human reviewer with a live membership' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER migration_signoffs_bind BEFORE INSERT ON cuspatlas.migration_signoffs
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.migration_signoffs_bind();
