-- A10 generalized prepare/commit (workstream A batch 2; synthetic only; approval identity rule open
-- under A-D4). A proposal binds one elevated catalog operation, its payload and canonical digest, the
-- affected resource versions, the policy version, the proposer (and an agent proposer's sponsor of
-- record) and an expiry. A human distinct from the proposer and from that sponsor approves; a human
-- commits through the owning command (executed once per proposal, the proposal id as idempotency
-- key). Terminal states (committed, rejected, expired, abandoned) are never revived.

CREATE TABLE cuspatlas.operation_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  operation text NOT NULL CHECK (operation IN ('portal.principals.enroll', 'communications.consents.record',
    'patients.relationships.add', 'billing.plans.authorize')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 16384),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  resource_versions jsonb NOT NULL CHECK (jsonb_typeof(resource_versions) = 'array'),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9.-]{1,64}$'),
  proposer_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  proposer_kind text NOT NULL CHECK (proposer_kind IN ('human', 'service')),
  sponsor_id uuid REFERENCES cuspatlas.principals (id),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'approved', 'committing', 'committed', 'rejected', 'expired', 'abandoned')),
  approver_id uuid REFERENCES cuspatlas.principals (id),
  approved_at timestamptz,
  committer_id uuid REFERENCES cuspatlas.principals (id),
  result_type text,
  result_ref uuid,
  result_version integer,
  disposition_reason text CHECK (disposition_reason ~ '^[a-z_]{1,64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- No self-approval and no approval by the agent proposer's sponsor (self-approval by proxy).
  CHECK (approver_id IS NULL OR (approver_id <> proposer_id AND approver_id IS DISTINCT FROM sponsor_id)),
  CHECK ((state IN ('approved', 'committing', 'committed')) <= (approver_id IS NOT NULL)),
  CHECK ((state = 'committed') = (result_ref IS NOT NULL))
);
CREATE INDEX operation_proposals_tenant ON cuspatlas.operation_proposals (tenant_id, created_at DESC, id);

-- A terminal proposal never changes again.
CREATE FUNCTION cuspatlas.operation_proposals_terminal() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' OR OLD.state IN ('committed', 'rejected', 'expired', 'abandoned') THEN
      RAISE EXCEPTION 'a terminal proposal is never changed' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER operation_proposals_guard BEFORE UPDATE OR DELETE ON cuspatlas.operation_proposals
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.operation_proposals_terminal();

ALTER TABLE cuspatlas.operation_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.operation_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY operation_proposals_select ON cuspatlas.operation_proposals
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY operation_proposals_insert ON cuspatlas.operation_proposals
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND proposer_id = cuspatlas.current_actor_id()
    AND state = 'prepared');
CREATE POLICY operation_proposals_update ON cuspatlas.operation_proposals
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON cuspatlas.operation_proposals TO cuspatlas_app;
