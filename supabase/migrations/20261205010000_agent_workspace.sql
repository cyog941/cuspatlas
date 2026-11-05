-- A23 / OR-13 agent workspace (synthetic implementation; retention, idle timeout and limits are
-- recommended-pending-approval). Sessions group an agent's admitted MCP calls per consent (the history
-- is agent_tool_calls and agent_audit_events, referenced by session_ref and correlation id, never
-- copied). Scoped memory is per agent and tenant, classified, default-deny for PHI (a per-tenant
-- policy row must allow it, enforced here as well as in the domain), retained 30 days by default.
-- Scheduled tasks bind to a revocable standing policy owned by a human; the worker rechecks the
-- policy at execution and records every run. Agents see only their own workspace rows (RLS).

-- True when the current actor is an agent principal (its rows are limited to its own workspace).
CREATE FUNCTION cuspatlas.current_actor_is_agent() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT EXISTS (SELECT 1 FROM cuspatlas.agent_principals WHERE principal_id = cuspatlas.current_actor_id())
  $$;
REVOKE ALL ON FUNCTION cuspatlas.current_actor_is_agent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.current_actor_is_agent() TO cuspatlas_app;

CREATE TABLE cuspatlas.agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  agent_ref uuid NOT NULL REFERENCES cuspatlas.agent_principals (principal_id),
  consent_ref uuid NOT NULL REFERENCES cuspatlas.agent_consents (id),
  deployment text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_call_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN ('ended_by_agent', 'ended_by_human')),
  ended_by uuid REFERENCES cuspatlas.principals (id),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE INDEX agent_sessions_agent ON cuspatlas.agent_sessions (tenant_id, agent_ref, started_at);
ALTER TABLE cuspatlas.agent_tool_calls ADD COLUMN session_ref uuid REFERENCES cuspatlas.agent_sessions (id);
CREATE INDEX agent_tool_calls_session ON cuspatlas.agent_tool_calls (session_ref, occurred_at);

CREATE TABLE cuspatlas.agent_memory_policies (
  tenant_id uuid PRIMARY KEY REFERENCES cuspatlas.tenants (id),
  phi_allowed boolean NOT NULL,
  set_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  set_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1)
);

CREATE TABLE cuspatlas.agent_memory_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  agent_ref uuid NOT NULL REFERENCES cuspatlas.agent_principals (principal_id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9._-]{0,63}$'),
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 2000),
  classification text NOT NULL CHECK (classification IN ('operational', 'reference', 'phi')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  read_count integer NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (expires_at > updated_at AND expires_at <= updated_at + interval '30 days'),
  UNIQUE (agent_ref, key)
);
CREATE INDEX agent_memory_entries_expiry ON cuspatlas.agent_memory_entries (expires_at);

-- PHI default deny, independent of the domain: a phi entry needs the tenant policy to allow it.
CREATE FUNCTION cuspatlas.agent_memory_phi_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  BEGIN
    IF NEW.classification = 'phi' AND NOT EXISTS (
      SELECT 1 FROM cuspatlas.agent_memory_policies p WHERE p.tenant_id = NEW.tenant_id AND p.phi_allowed) THEN
      RAISE EXCEPTION 'phi_not_permitted' USING ERRCODE = 'P0422';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_memory_phi_guard() FROM PUBLIC;
CREATE TRIGGER agent_memory_phi_guard BEFORE INSERT OR UPDATE ON cuspatlas.agent_memory_entries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.agent_memory_phi_guard();

CREATE TABLE cuspatlas.agent_task_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  agent_ref uuid NOT NULL REFERENCES cuspatlas.agent_principals (principal_id),
  owner_ref uuid NOT NULL REFERENCES cuspatlas.principals (id),
  deployment text NOT NULL,
  operations text[] NOT NULL CHECK (cardinality(operations) BETWEEN 1 AND 16),
  min_interval_seconds integer NOT NULL CHECK (min_interval_seconds BETWEEN 60 AND 86400),
  max_runs_per_day integer NOT NULL CHECK (max_runs_per_day BETWEEN 1 AND 1440),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES cuspatlas.principals (id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days'),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (owner_ref <> agent_ref)
);

CREATE TABLE cuspatlas.agent_scheduled_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  agent_ref uuid NOT NULL REFERENCES cuspatlas.agent_principals (principal_id),
  policy_ref uuid NOT NULL REFERENCES cuspatlas.agent_task_policies (id),
  operation text NOT NULL CHECK (operation ~ '^[a-z][A-Za-z]{0,40}(\.[a-z][A-Za-z]{0,40}){0,3}$'),
  arguments jsonb NOT NULL CHECK (jsonb_typeof(arguments) = 'object' AND octet_length(arguments::text) <= 4000),
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 60 AND 2592000),
  next_run_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'cancelled', 'stopped')),
  stop_reason text CHECK (stop_reason ~ '^[a-z_]{1,64}$'),
  last_run_at timestamptz,
  last_outcome text CHECK (last_outcome ~ '^[a-z_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK ((state = 'stopped') = (stop_reason IS NOT NULL))
);
CREATE INDEX agent_scheduled_tasks_due ON cuspatlas.agent_scheduled_tasks (tenant_id, next_run_at)
  WHERE state = 'active';

CREATE TABLE cuspatlas.agent_task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  task_ref uuid NOT NULL REFERENCES cuspatlas.agent_scheduled_tasks (id),
  agent_ref uuid NOT NULL REFERENCES cuspatlas.agent_principals (principal_id),
  correlation_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text CHECK (outcome ~ '^[a-z_]{1,64}$'),
  CHECK ((finished_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX agent_task_runs_task ON cuspatlas.agent_task_runs (task_ref, started_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_sessions', 'agent_memory_policies', 'agent_memory_entries',
    'agent_task_policies', 'agent_scheduled_tasks', 'agent_task_runs'] LOOP
    EXECUTE format('ALTER TABLE cuspatlas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE cuspatlas.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- Agent-owned rows: tenant-bound, and an agent sees and writes only its own.
CREATE POLICY agent_sessions_rw ON cuspatlas.agent_sessions FOR ALL TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()
    AND (agent_ref = cuspatlas.current_actor_id() OR NOT cuspatlas.current_actor_is_agent()))
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id()
    AND (agent_ref = cuspatlas.current_actor_id() OR NOT cuspatlas.current_actor_is_agent()));
CREATE POLICY agent_memory_entries_rw ON cuspatlas.agent_memory_entries FOR ALL TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()
    AND (agent_ref = cuspatlas.current_actor_id() OR NOT cuspatlas.current_actor_is_agent()))
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND agent_ref = cuspatlas.current_actor_id());
CREATE POLICY agent_scheduled_tasks_rw ON cuspatlas.agent_scheduled_tasks FOR ALL TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()
    AND (agent_ref = cuspatlas.current_actor_id() OR NOT cuspatlas.current_actor_is_agent()))
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id()
    AND (agent_ref = cuspatlas.current_actor_id() OR NOT cuspatlas.current_actor_is_agent()));
CREATE POLICY agent_task_runs_rw ON cuspatlas.agent_task_runs FOR ALL TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()
    AND (agent_ref = cuspatlas.current_actor_id() OR NOT cuspatlas.current_actor_is_agent()))
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND NOT cuspatlas.current_actor_is_agent());
-- Human-owned rows: an agent reads only the policies naming it and never writes one.
CREATE POLICY agent_task_policies_select ON cuspatlas.agent_task_policies FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()
    AND (agent_ref = cuspatlas.current_actor_id() OR NOT cuspatlas.current_actor_is_agent()));
CREATE POLICY agent_task_policies_insert ON cuspatlas.agent_task_policies FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND owner_ref = cuspatlas.current_actor_id()
    AND NOT cuspatlas.current_actor_is_agent());
CREATE POLICY agent_task_policies_update ON cuspatlas.agent_task_policies FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND NOT cuspatlas.current_actor_is_agent())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY agent_memory_policies_select ON cuspatlas.agent_memory_policies FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY agent_memory_policies_write ON cuspatlas.agent_memory_policies FOR ALL TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND NOT cuspatlas.current_actor_is_agent())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND set_by = cuspatlas.current_actor_id()
    AND NOT cuspatlas.current_actor_is_agent());
GRANT SELECT, INSERT, UPDATE ON cuspatlas.agent_sessions, cuspatlas.agent_task_policies,
  cuspatlas.agent_scheduled_tasks, cuspatlas.agent_task_runs, cuspatlas.agent_memory_policies TO cuspatlas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cuspatlas.agent_memory_entries TO cuspatlas_app;

-- Expired memory purge for the worker maintenance connection (returns rows removed).
CREATE FUNCTION cuspatlas.agent_memory_purge_expired() RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    WITH d AS (DELETE FROM cuspatlas.agent_memory_entries WHERE expires_at <= now() RETURNING 1)
    SELECT count(*)::integer FROM d
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_memory_purge_expired() FROM PUBLIC;

-- A23 adds agentWorkspace.read and agentWorkspace.write, scopes service principals may hold. The
-- database ceiling must equal the generated AGENT_SCOPE_CEILING (asserted in api-agent-identity.test.ts).
CREATE OR REPLACE FUNCTION cuspatlas.agent_scope_ceiling() RETURNS text[]
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
  AS $$
    SELECT ARRAY[
      'actions.prepare',
      'actions.read',
      'admin.configure',
      'agentWorkspace.read',
      'agentWorkspace.write',
      'agents.read',
      'ai.draft',
      'ai.read',
      'analytics.read',
      'billing.write',
      'clinical.read',
      'communications.deliver',
      'communications.read',
      'communications.receipts',
      'communications.write',
      'coverage.read',
      'coverage.write',
      'imaging.read',
      'imaging.write',
      'ledger.read',
      'messaging.read',
      'migration.read',
      'migration.write',
      'openClaims.read',
      'outbox.deliver',
      'patients.read',
      'patients.write',
      'paymentDistribution.read',
      'portal.manage',
      'receivables.read',
      'scheduling.read',
      'scheduling.write',
      'syntheticTasks.read',
      'syntheticTasks.write',
      'telephony.events',
      'undistributedFunds.read'
    ]::text[]
  $$;
