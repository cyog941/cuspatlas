-- Integration seam C12 -> B9/B5 (codex/backend-integration; synthetic data only; recommended-pending-
-- clinical-approval like C12, B5 and B9). New migration; applied migrations are never edited.
--
-- 1. Coverage status gains `inactive`: B5 verified the patient's primary coverage inactive on the
--    service date, so no insurer portion is applied (range basis coverage_inactive). The original
--    coverage_status CHECKs are unnamed, so they are found by definition and replaced by named ones.
-- 2. Each estimate line records the B9 fee schedule version its server-resolved fee came from
--    (nullable: lines written before this seam carried a caller-entered fee and no version).
DO $$
DECLARE
  t text;
  c text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clinical_estimates', 'clinical_estimate_presentations'] LOOP
    SELECT con.conname INTO c FROM pg_constraint con
    WHERE con.conrelid = format('cuspatlas.%I', t)::regclass AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%coverage_status%';
    IF c IS NULL THEN
      RAISE EXCEPTION 'expected the C12 coverage_status check on %', t;
    END IF;
    EXECUTE format('ALTER TABLE cuspatlas.%I DROP CONSTRAINT %I', t, c);
    EXECUTE format(
      'ALTER TABLE cuspatlas.%I ADD CONSTRAINT %I CHECK (coverage_status IN (''entered'', ''unknown'', ''stale'', ''inactive''))',
      t, t || '_coverage_status');
  END LOOP;
END
$$;

ALTER TABLE cuspatlas.clinical_estimate_lines
  ADD COLUMN fee_schedule_version_ref text CHECK (fee_schedule_version_ref ~ '^[A-Za-z0-9._:-]{1,128}$');
