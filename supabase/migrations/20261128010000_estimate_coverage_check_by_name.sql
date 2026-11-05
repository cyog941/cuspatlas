-- Hardening H1 (R-NIT): 20261125040000 found the unnamed C12 coverage_status CHECKs with a LIKE over
-- their definitions (which could silently pick the wrong constraint) and replaced them with named ones.
-- That migration is applied and never edited; this one verifies the outcome by name: exactly one CHECK
-- references coverage_status on each table, and it is the named `<table>_coverage_status` constraint
-- with the four statuses. Synthetic data only; any drift stops the migration.
DO $$
DECLARE
  t text;
  n integer;
BEGIN
  FOREACH t IN ARRAY ARRAY['clinical_estimates', 'clinical_estimate_presentations'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint con
      WHERE con.conrelid = format('cuspatlas.%I', t)::regclass AND con.contype = 'c'
        AND con.conname = t || '_coverage_status'
    ) THEN
      RAISE EXCEPTION 'expected the named check %_coverage_status', t;
    END IF;
    SELECT count(*) INTO n FROM pg_constraint con
    WHERE con.conrelid = format('cuspatlas.%I', t)::regclass AND con.contype = 'c'
      AND con.conkey @> ARRAY[(SELECT a.attnum FROM pg_attribute a
                               WHERE a.attrelid = con.conrelid AND a.attname = 'coverage_status')];
    IF n <> 1 THEN
      RAISE EXCEPTION 'expected exactly one coverage_status check on %, found %', t, n;
    END IF;
  END LOOP;
END
$$;
