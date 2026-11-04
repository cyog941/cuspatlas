-- Review hardening of S4-S9 (batch 2, synthetic data only).
--
-- 1. A revocation is frozen whole: once revoked_at is set, neither the instant, the reason nor the
--    revoking actor can change (revoked_by was not covered before).
-- 2. Match keys become tenant-bound HMACs under a server pepper (domain change, no schema change).
--    The pepper is not available to SQL, so existing rows are re-keyed on their next write; only
--    synthetic rows exist, and the duplicate review compares keys produced by the same pepper.
CREATE OR REPLACE FUNCTION cuspatlas.patient_relationships_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'patient relationships are never deleted' USING ERRCODE = '42501';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
        OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason
        OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
      RAISE EXCEPTION 'a revocation cannot be undone or rewritten' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'relationship version must increase by one' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.patient_relationships_guard() FROM PUBLIC;
