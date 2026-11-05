-- M8 restore drill finding (workstream M; synthetic only): the F8 restore of a tenant with migrated
-- opening items failed, because the H2 M-2 bind trigger requires an apply run in the current
-- transaction. The restore load sets the transaction-local flag cuspatlas.restore_load (restore.ts)
-- as a role that bypasses RLS; only that combination skips the bind checks (the rows were checked
-- when written and the restore verifies every table digest). Every other writer is unchanged.
CREATE OR REPLACE FUNCTION cuspatlas.migration_opening_items_bind() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  DECLARE
    s cuspatlas.migration_staged_records%ROWTYPE;
    v text;
    n numeric;
  BEGIN
    -- F8 restore (M8 drill finding): a verified backup reloads historical opening items outside any
    -- apply run. Skipped only inside the restore load (transaction-local flag) AND for a role that
    -- bypasses RLS; the runtime role cannot bypass RLS, so setting the flag changes nothing for it.
    IF current_setting('cuspatlas.restore_load', true) = 'on'
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
      RETURN NEW;
    END IF;
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
