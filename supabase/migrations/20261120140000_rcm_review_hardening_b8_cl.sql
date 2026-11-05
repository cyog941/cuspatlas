-- Review hardening of B8, the closed-loop workflow and B10 (synthetic data; fake clearinghouse only).
-- 1. A durable timer may bring the workflow back to a pending automated action (bounded retry).
-- 2. Automation refusals are counted per head version of the claim, so a step's uniqueness includes the
--    claim version it refused (a corrected claim version is a new budget, its history stays distinct).
ALTER TABLE cuspatlas.rcm_claim_workflow_timers DROP CONSTRAINT rcm_claim_workflow_timers_kind_check;
ALTER TABLE cuspatlas.rcm_claim_workflow_timers ADD CONSTRAINT rcm_claim_workflow_timers_kind_check
  CHECK (kind IN ('payer_follow_up', 'exception_escalation', 'automation_retry'));

DO $$
DECLARE
  c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
  WHERE conrelid = 'cuspatlas.rcm_claim_workflow_steps'::regclass AND contype = 'u' AND cardinality(conkey) = 6;
  IF c IS NULL THEN
    RAISE EXCEPTION 'the workflow step uniqueness constraint was not found';
  END IF;
  EXECUTE format('ALTER TABLE cuspatlas.rcm_claim_workflow_steps DROP CONSTRAINT %I', c);
END
$$;
CREATE UNIQUE INDEX rcm_claim_workflow_steps_once ON cuspatlas.rcm_claim_workflow_steps
  (tenant_id, workflow_id, step, subject_ref, outcome, attempt, (coalesce(input_versions ->> 'claimVersion', '')));
