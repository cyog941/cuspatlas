-- F Task 7a: server-owned action proposals, approvals and protected provenance. Synthetic only:
-- the only operations a proposal can carry are syntheticTasks.create and syntheticTasks.relabel.
-- A proposal binds tenant, operation, the stored payload and its canonical SHA-256 digest, the target
-- resource version (relabel), the policy version, the proposer (principal and kind) and an expiry.
-- The runtime role may INSERT and SELECT its own tenant's proposals and UPDATE only the state,
-- approval and commit-result columns; binding columns are not updatable by grant, and a trigger
-- enforces the state machine and that an approval is set once, by the acting principal, over the
-- bound digest and policy version. Provenance (who prepared/approved/committed/closed it, when, under
-- which policy and digest) is a separate append-only table, not part of ordinary logs, and never
-- holds payload text. No DELETE anywhere.

CREATE TABLE cuspatlas.action_proposals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  operation text NOT NULL CHECK (operation IN ('syntheticTasks.create', 'syntheticTasks.relabel')),
  -- Protected proposal content (caller text). Visible only through the read policy in the domain.
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 2048),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  resource_type text CHECK (resource_type = 'syntheticTask'),
  resource_ref uuid,
  resource_version integer CHECK (resource_version >= 1),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9.-]{1,64}$'),
  proposer_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  proposer_kind text NOT NULL CHECK (proposer_kind IN ('human', 'service')),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'approved', 'committed', 'expired', 'rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 3),
  approver_id uuid REFERENCES cuspatlas.principals (id),
  approver_kind text CHECK (approver_kind = 'human'),
  approved_at timestamptz,
  approval_policy_version text CHECK (approval_policy_version ~ '^[a-z0-9.-]{1,64}$'),
  approval_digest text CHECK (approval_digest ~ '^[0-9a-f]{64}$'),
  execution text CHECK (execution IN ('manual', 'deferred')),
  committed_by uuid REFERENCES cuspatlas.principals (id),
  committed_at timestamptz,
  result_ref uuid,
  result_version integer CHECK (result_version >= 1),
  disposition_reason text CHECK (disposition_reason IN ('payload_mismatch', 'expired', 'stale_version',
    'policy_changed', 'approval_invalid', 'approver_unauthorized', 'proposer_unauthorized')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CHECK ((operation = 'syntheticTasks.relabel') = (resource_ref IS NOT NULL)),
  CHECK ((resource_ref IS NULL) = (resource_version IS NULL)),
  CHECK ((resource_ref IS NULL) = (resource_type IS NULL)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 day'),
  -- The approval record is all-or-nothing.
  CHECK (num_nulls(approver_id, approver_kind, approved_at, approval_policy_version, approval_digest, execution)
    IN (0, 6)),
  CHECK (state NOT IN ('approved', 'committed') OR approver_id IS NOT NULL),
  CHECK (num_nulls(committed_by, committed_at, result_ref, result_version) IN (0, 4)),
  CHECK ((state = 'committed') = (committed_by IS NOT NULL)),
  CHECK ((state IN ('expired', 'rejected')) = (disposition_reason IS NOT NULL)),
  -- Frozen rule: a service principal never approves its own proposal.
  CHECK (NOT (proposer_kind = 'service' AND approver_id = proposer_id))
);
CREATE INDEX action_proposals_tenant_state ON cuspatlas.action_proposals (tenant_id, state);

-- State machine and approval binding, independent of the application. Superusers (and the owner,
-- through session_replication_role or by disabling the trigger) can still bypass it; that is the
-- privileged-tamper case the domain rechecks at commit (digest and policy version of the approval).
CREATE FUNCTION cuspatlas.action_proposals_guard() RETURNS trigger
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
  END IF;
  IF NEW.state = 'committed' AND NEW.committed_by IS DISTINCT FROM cuspatlas.current_actor_id() THEN
    RAISE EXCEPTION 'commit must be recorded by the acting principal' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION cuspatlas.action_proposals_guard() FROM PUBLIC;
CREATE TRIGGER action_proposals_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.action_proposals
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.action_proposals_guard();

ALTER TABLE cuspatlas.action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.action_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY action_proposals_select ON cuspatlas.action_proposals
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id());
-- The proposer is the acting principal, its kind is its real kind, and a proposal starts unapproved.
CREATE POLICY action_proposals_insert ON cuspatlas.action_proposals
  FOR INSERT TO cuspatlas_app
  WITH CHECK (
    tenant_id = cuspatlas.current_tenant_id()
    AND proposer_id = cuspatlas.current_actor_id()
    AND EXISTS (SELECT 1 FROM cuspatlas.principals p WHERE p.id = proposer_id AND p.kind = proposer_kind)
    AND state = 'prepared' AND version = 1 AND approver_id IS NULL AND committed_by IS NULL
  );
CREATE POLICY action_proposals_update ON cuspatlas.action_proposals
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.action_proposals TO cuspatlas_app;
GRANT UPDATE (state, version, approver_id, approver_kind, approved_at, approval_policy_version,
  approval_digest, execution, committed_by, committed_at, result_ref, result_version, disposition_reason,
  updated_at) ON cuspatlas.action_proposals TO cuspatlas_app;

-- Protected provenance: one row per lifecycle step. References, digests and codes only.
CREATE TABLE cuspatlas.action_proposal_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  step text NOT NULL CHECK (step IN ('prepared', 'approved', 'committed', 'expired', 'rejected')),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'service')),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9.-]{1,64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  reason text CHECK (reason IN ('payload_mismatch', 'expired', 'stale_version', 'policy_changed',
    'approval_invalid', 'approver_unauthorized', 'proposer_unauthorized')),
  result_ref uuid,
  result_version integer CHECK (result_version >= 1),
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, step),
  CHECK ((step IN ('expired', 'rejected')) = (reason IS NOT NULL)),
  CHECK ((step = 'committed') = (result_ref IS NOT NULL)),
  FOREIGN KEY (proposal_id, tenant_id) REFERENCES cuspatlas.action_proposals (id, tenant_id)
);

CREATE FUNCTION cuspatlas.action_proposal_provenance_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'action_proposal_provenance is append-only' USING ERRCODE = '42501'; END $$;
REVOKE ALL ON FUNCTION cuspatlas.action_proposal_provenance_append_only() FROM PUBLIC;
CREATE TRIGGER action_proposal_provenance_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.action_proposal_provenance
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.action_proposal_provenance_append_only();

ALTER TABLE cuspatlas.action_proposal_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.action_proposal_provenance FORCE ROW LEVEL SECURITY;

CREATE POLICY action_proposal_provenance_select ON cuspatlas.action_proposal_provenance
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY action_proposal_provenance_insert ON cuspatlas.action_proposal_provenance
  FOR INSERT TO cuspatlas_app
  WITH CHECK (
    tenant_id = cuspatlas.current_tenant_id()
    AND actor_id = cuspatlas.current_actor_id()
    AND EXISTS (SELECT 1 FROM cuspatlas.principals p WHERE p.id = actor_id AND p.kind = actor_kind)
  );

GRANT SELECT, INSERT ON cuspatlas.action_proposal_provenance TO cuspatlas_app;

-- Deferred execution of an approved proposal is an outbox event the worker executes internally; a
-- refusal at execution time dead-letters it with its own reason.
ALTER TABLE cuspatlas.outbox_events DROP CONSTRAINT outbox_events_dead_letter_reason_check;
ALTER TABLE cuspatlas.outbox_events
  ADD CONSTRAINT outbox_events_dead_letter_reason_check CHECK (dead_letter_reason IN (
    'membership_revoked', 'authorization_denied', 'max_attempts_exhausted', 'provider_rejected',
    'reconciliation_exhausted', 'proposal_refused'));
