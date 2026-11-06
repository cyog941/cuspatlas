-- Task 7a hardening (independent review of 6540a56), defense in depth: the action_proposals guard
-- trigger additionally refuses an approval whose approver is not a human principal. The domain
-- already enforces this (approve needs a human with syntheticTasks.approve, and approver_kind has a
-- CHECK = 'human'), but approver_kind is written by the caller; this checks the principal row itself.
-- Same body as 20261104040000_action_proposals.sql plus that check; the trigger is unchanged.
CREATE OR REPLACE FUNCTION cuspatlas.action_proposals_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'action_proposals rows are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.state IN ('committed', 'expired', 'rejected') THEN
    RAISE EXCEPTION 'proposal is closed' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.operation, NEW.payload, NEW.payload_digest, NEW.resource_type,
      NEW.resource_ref, NEW.resource_version, NEW.policy_version, NEW.proposer_id, NEW.proposer_kind,
      NEW.correlation_id, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.operation, OLD.payload, OLD.payload_digest, OLD.resource_type,
      OLD.resource_ref, OLD.resource_version, OLD.policy_version, OLD.proposer_id, OLD.proposer_kind,
      OLD.correlation_id, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'proposal binding is immutable' USING ERRCODE = '42501';
  END IF;
  IF NOT ((OLD.state = 'prepared' AND NEW.state IN ('approved', 'expired', 'rejected'))
       OR (OLD.state = 'approved' AND NEW.state IN ('committed', 'expired', 'rejected'))) THEN
    RAISE EXCEPTION 'proposal state transition refused' USING ERRCODE = '42501';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'proposal version must advance by one' USING ERRCODE = '42501';
  END IF;
  IF (NEW.approver_id, NEW.approver_kind, NEW.approved_at, NEW.approval_policy_version,
      NEW.approval_digest, NEW.execution)
     IS DISTINCT FROM
     (OLD.approver_id, OLD.approver_kind, OLD.approved_at, OLD.approval_policy_version,
      OLD.approval_digest, OLD.execution) THEN
    IF NOT (OLD.state = 'prepared' AND NEW.state = 'approved' AND OLD.approver_id IS NULL
        AND NEW.approver_id = cuspatlas.current_actor_id()
        AND NEW.approval_digest = OLD.payload_digest
        AND NEW.approval_policy_version = OLD.policy_version) THEN
      RAISE EXCEPTION 'approval must be recorded once, by the acting principal, over the bound digest'
        USING ERRCODE = '42501';
    END IF;
    -- Hardening (review of 6540a56): the approver row must be a human principal, whatever
    -- approver_kind claims. The approver is the acting principal, so its own principal row is visible.
    IF NOT EXISTS (SELECT 1 FROM cuspatlas.principals pr WHERE pr.id = NEW.approver_id AND pr.kind = 'human') THEN
      RAISE EXCEPTION 'approver must be a human principal' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.state = 'committed' AND NEW.committed_by IS DISTINCT FROM cuspatlas.current_actor_id() THEN
    RAISE EXCEPTION 'commit must be recorded by the acting principal' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION cuspatlas.action_proposals_guard() FROM PUBLIC;
