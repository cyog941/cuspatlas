-- Hardening H2 M-7 (workstream M; synthetic only; recommended-pending-financial-approval): excluded
-- money is never silently accepted. The report lists each excluded balance or credit as a blocking
-- `excluded_balance` exception; the financial reviewer acknowledges each one by its staged reference in
-- an approval, recorded on the (append-only, digest-bound) sign-off row. Cutover readiness accepts an
-- `excluded_balance` exception only when the approved financial sign-off of the same report digest
-- acknowledges it; every other blocking exception still refuses the transition.
ALTER TABLE cuspatlas.migration_signoffs ADD COLUMN acknowledged_exclusions uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT migration_signoffs_acknowledgement CHECK (cardinality(acknowledged_exclusions) = 0
    OR (role = 'financialReviewer' AND decision = 'approved'));

CREATE OR REPLACE FUNCTION cuspatlas.migration_packages_cutover_guard() RETURNS trigger
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
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(r.body -> 'blockingExceptions', '[]'::jsonb)) b
            WHERE b ->> 'code' <> 'excluded_balance' OR NOT EXISTS (
              SELECT 1 FROM cuspatlas.migration_signoffs s
              WHERE s.report_id = r.id AND s.tenant_id = NEW.tenant_id AND s.report_digest = r.digest
                AND s.role = 'financialReviewer' AND s.decision = 'approved'
                AND (b ->> 'subjectRef') = ANY (SELECT 'staged:' || x::text FROM unnest(s.acknowledged_exclusions) x)))
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
