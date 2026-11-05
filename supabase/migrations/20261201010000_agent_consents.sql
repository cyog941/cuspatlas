-- A9 MCP consent and budgets (workstream A batch 2; synthetic only; remote transport blocked on A-S1;
-- ceilings recommended-pending-approval under A-D3). A consent names one agent, one MCP deployment
-- (its resource identifier), the operations the agent may call there, a budget and an expiry, and the
-- human who granted it. Budget usage is one counter row per consent and period; every agent tool call
-- (allowed or refused after admission) is appended to agent_tool_calls.

CREATE TABLE cuspatlas.agent_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  agent_ref uuid NOT NULL REFERENCES cuspatlas.agent_principals (principal_id),
  deployment text NOT NULL CHECK (deployment ~ '^[A-Za-z0-9:._/-]{1,200}$'),
  operations text[] NOT NULL CHECK (cardinality(operations) BETWEEN 1 AND 400),
  period_seconds integer NOT NULL CHECK (period_seconds BETWEEN 60 AND 86400),
  calls_per_period integer NOT NULL CHECK (calls_per_period BETWEEN 1 AND 100000),
  records_per_period integer NOT NULL CHECK (records_per_period BETWEEN 0 AND 1000000),
  phi_fields_per_period integer NOT NULL CHECK (phi_fields_per_period BETWEEN 0 AND 10000000),
  records_per_call integer NOT NULL CHECK (records_per_call BETWEEN 0 AND 1000),
  phi_fields_per_call integer NOT NULL CHECK (phi_fields_per_call BETWEEN 0 AND 100000),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  granted_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_by uuid REFERENCES cuspatlas.principals (id),
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (granted_by <> agent_ref)
);
CREATE INDEX agent_consents_agent ON cuspatlas.agent_consents (tenant_id, agent_ref, deployment, state);

CREATE TABLE cuspatlas.agent_budget_usage (
  consent_ref uuid PRIMARY KEY REFERENCES cuspatlas.agent_consents (id),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  period_started_at timestamptz NOT NULL,
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  records integer NOT NULL DEFAULT 0 CHECK (records >= 0),
  phi_fields integer NOT NULL DEFAULT 0 CHECK (phi_fields >= 0)
);

CREATE TABLE cuspatlas.agent_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  agent_ref uuid NOT NULL REFERENCES cuspatlas.agent_principals (principal_id),
  consent_ref uuid REFERENCES cuspatlas.agent_consents (id),
  deployment text NOT NULL,
  operation text NOT NULL CHECK (operation ~ '^[a-z][A-Za-z]{0,40}(\.[a-z][A-Za-z]{0,40}){0,3}$'),
  outcome text NOT NULL CHECK (outcome ~ '^[a-z_]{1,64}$'),
  records integer NOT NULL DEFAULT 0 CHECK (records >= 0),
  phi_fields integer NOT NULL DEFAULT 0 CHECK (phi_fields >= 0),
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_tool_calls_agent ON cuspatlas.agent_tool_calls (tenant_id, agent_ref, occurred_at);
CREATE TRIGGER agent_tool_calls_guard BEFORE UPDATE OR DELETE ON cuspatlas.agent_tool_calls
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.agent_records_append_only();

ALTER TABLE cuspatlas.agent_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_budget_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_budget_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_tool_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_consents_select ON cuspatlas.agent_consents
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
-- Granted by the calling human (the domain authorizes agents.manage, human only, first).
CREATE POLICY agent_consents_insert ON cuspatlas.agent_consents
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND granted_by = cuspatlas.current_actor_id());
CREATE POLICY agent_consents_update ON cuspatlas.agent_consents
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND revoked_by = cuspatlas.current_actor_id());
-- Usage counters are written in the agent's own call (current actor = the consented agent).
CREATE POLICY agent_budget_usage_select ON cuspatlas.agent_budget_usage
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY agent_budget_usage_write ON cuspatlas.agent_budget_usage
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND EXISTS (
    SELECT 1 FROM cuspatlas.agent_consents c
    WHERE c.id = consent_ref AND c.agent_ref = cuspatlas.current_actor_id()));
CREATE POLICY agent_budget_usage_update ON cuspatlas.agent_budget_usage
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND EXISTS (
    SELECT 1 FROM cuspatlas.agent_consents c
    WHERE c.id = consent_ref AND c.agent_ref = cuspatlas.current_actor_id()))
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY agent_tool_calls_select ON cuspatlas.agent_tool_calls
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY agent_tool_calls_insert ON cuspatlas.agent_tool_calls
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND agent_ref = cuspatlas.current_actor_id());
GRANT SELECT, INSERT, UPDATE ON cuspatlas.agent_consents TO cuspatlas_app;
GRANT SELECT, INSERT, UPDATE ON cuspatlas.agent_budget_usage TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.agent_tool_calls TO cuspatlas_app;
