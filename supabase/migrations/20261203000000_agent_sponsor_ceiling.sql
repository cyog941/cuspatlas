-- H3 (A8 hardening). Synthetic development only.
-- 1. DB-side agent scope ceiling: the scopes an agent may ever hold (AGENT_SCOPE_CEILING: every
--    service-admitting scope minus the A-D2 non-delegable set). An allowlist, so a new human-only scope
--    is refused until a migration adds it here (tests/integration/api-agent-identity.test.ts asserts the
--    table equals the generated ceiling). agent_create refuses anything outside it, whatever the caller
--    sends.
-- 2. Sponsor downgrade propagates: agent_authority returns the agent's scope set INTERSECTED with the
--    sponsor's live scopes, so a scope the sponsor loses leaves the agent at its next call.
CREATE TABLE cuspatlas.agent_scope_ceiling (
  scope text PRIMARY KEY CHECK (scope ~ '^[a-zA-Z]+(\.[a-zA-Z]+)+$')
);
INSERT INTO cuspatlas.agent_scope_ceiling (scope) VALUES
  ('actions.prepare'),
  ('actions.read'),
  ('admin.configure'),
  ('agents.read'),
  ('ai.draft'),
  ('ai.read'),
  ('billing.write'),
  ('clinical.read'),
  ('communications.deliver'),
  ('communications.read'),
  ('communications.receipts'),
  ('communications.write'),
  ('coverage.read'),
  ('coverage.write'),
  ('imaging.read'),
  ('imaging.write'),
  ('ledger.read'),
  ('messaging.read'),
  ('migration.read'),
  ('migration.write'),
  ('openClaims.read'),
  ('outbox.deliver'),
  ('patients.read'),
  ('patients.write'),
  ('paymentDistribution.read'),
  ('portal.manage'),
  ('receivables.read'),
  ('scheduling.read'),
  ('scheduling.write'),
  ('syntheticTasks.read'),
  ('syntheticTasks.write'),
  ('telephony.events'),
  ('undistributedFunds.read')
;
CREATE FUNCTION cuspatlas.agent_scope_ceiling_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION 'the agent scope ceiling changes only by migration' USING ERRCODE = '42501';
  END
  $$;
CREATE TRIGGER agent_scope_ceiling_guard BEFORE UPDATE OR DELETE ON cuspatlas.agent_scope_ceiling
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.agent_scope_ceiling_guard();
GRANT SELECT ON cuspatlas.agent_scope_ceiling TO cuspatlas_app;

CREATE OR REPLACE FUNCTION cuspatlas.agent_authority(p_principal uuid, p_tenant uuid)
  RETURNS TABLE (agent_ref uuid, state text, live boolean, scope_set text[], sponsor_ref uuid,
    sponsorship_ref uuid, credential_ref text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT a.principal_id, a.state,
      a.state <> 'revoked' AND a.expires_at > now() AND sm.principal_id IS NOT NULL,
      -- Effective scope set: recorded scopes the sponsor still holds right now (none without a live sponsor).
      ARRAY(SELECT x FROM unnest(a.scope_set) AS x WHERE x = ANY (COALESCE(sm.scopes, '{}'::text[]))),
      s.sponsor_ref, s.id, a.credential_ref
    FROM cuspatlas.agent_principals a
    JOIN cuspatlas.agent_sponsorships s ON s.id = a.sponsorship_ref
    LEFT JOIN LATERAL (
      SELECT m.principal_id, m.scopes FROM cuspatlas.memberships m JOIN cuspatlas.principals sp ON sp.id = m.principal_id
      WHERE m.principal_id = s.sponsor_ref AND m.tenant_id = a.tenant_id AND m.revoked_at IS NULL AND sp.kind = 'human'
    ) sm ON true
    WHERE a.principal_id = p_principal AND a.tenant_id = p_tenant
      AND (p_principal = cuspatlas.current_auth_principal_id() OR p_principal = cuspatlas.current_actor_id())
  $$;

CREATE OR REPLACE FUNCTION cuspatlas.agent_create(p_purpose text, p_scopes text[], p_expires timestamptz,
  p_credential text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  DECLARE
    v_manager text[] := cuspatlas.agent_assert_manager();
    v_id uuid := gen_random_uuid();
    v_sponsorship uuid := gen_random_uuid();
    v_locations text[];
  BEGIN
    IF EXISTS (SELECT 1 FROM unnest(p_scopes) AS x
               WHERE NOT EXISTS (SELECT 1 FROM cuspatlas.agent_scope_ceiling c WHERE c.scope = x)) THEN
      RAISE EXCEPTION 'human_only_scope' USING ERRCODE = 'P0422';
    END IF;
    IF NOT (p_scopes <@ v_manager) THEN
      RAISE EXCEPTION 'sponsor_scope_exceeded' USING ERRCODE = 'P0422';
    END IF;
    SELECT m.location_refs INTO v_locations FROM cuspatlas.memberships m
    WHERE m.principal_id = cuspatlas.current_actor_id() AND m.tenant_id = cuspatlas.current_tenant_id();
    INSERT INTO cuspatlas.principals (id, kind, handle)
      VALUES (v_id, 'service', 'agent-' || substr(replace(v_id::text, '-', ''), 1, 24));
    INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes, location_refs)
      VALUES (cuspatlas.current_tenant_id(), v_id, p_scopes, v_locations);
    INSERT INTO cuspatlas.agent_principals (principal_id, tenant_id, purpose, scope_set, state, expires_at,
        credential_ref, sponsorship_ref, created_by)
      VALUES (v_id, cuspatlas.current_tenant_id(), p_purpose, p_scopes, 'active', p_expires, p_credential,
        v_sponsorship, cuspatlas.current_actor_id());
    INSERT INTO cuspatlas.agent_sponsorships (id, tenant_id, agent_ref, sponsor_ref, recorded_by)
      VALUES (v_sponsorship, cuspatlas.current_tenant_id(), v_id, cuspatlas.current_actor_id(),
        cuspatlas.current_actor_id());
    INSERT INTO cuspatlas.agent_lifecycle_events (tenant_id, agent_ref, event, actor_ref, agent_version)
      VALUES (cuspatlas.current_tenant_id(), v_id, 'created', cuspatlas.current_actor_id(), 1);
    RETURN v_id;
  END
  $$;
