-- A8 agent principals (workstream A batch 2; synthetic only; lifecycle limits open under A-D9).
-- An agent is a service principal with an agent record: one named human sponsor, a stated purpose, a
-- recorded scope set (never a human-only scope, never more than the sponsor holds), an expiry, a
-- rotatable credential reference and a terminal revocation. Sponsorship is append-only: a sponsor
-- change is a new sponsorship row, so earlier actions keep resolving to the sponsor of record.
-- Every audit row whose actor is an agent is copied by a SECURITY DEFINER trigger into the separate
-- agent-audit stream with the sponsorship in force at that moment. The runtime role never writes the
-- principal, membership or agent tables directly: lifecycle changes go through the checked functions
-- below, called by the domain after `authorize` (human, agents.manage).

CREATE TABLE cuspatlas.agent_principals (
  principal_id uuid PRIMARY KEY REFERENCES cuspatlas.principals (id),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 200),
  scope_set text[] NOT NULL CHECK (cardinality(scope_set) BETWEEN 1 AND 64),
  state text NOT NULL CHECK (state IN ('active', 'suspended', 'revoked')),
  expires_at timestamptz NOT NULL,
  credential_ref text NOT NULL CHECK (credential_ref ~ '^agc-[0-9a-f]{32}$'),
  sponsorship_ref uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES cuspatlas.principals (id),
  revocation_reason text CHECK (revocation_reason ~ '^[a-z_]{1,64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX agent_principals_tenant ON cuspatlas.agent_principals (tenant_id, created_at, principal_id);

CREATE TABLE cuspatlas.agent_sponsorships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  agent_ref uuid NOT NULL REFERENCES cuspatlas.agent_principals (principal_id),
  sponsor_ref uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_sponsorships_agent ON cuspatlas.agent_sponsorships (agent_ref, effective_at);
-- No foreign key from agent_principals.sponsorship_ref back to agent_sponsorships: the pair would be a
-- foreign-key cycle (the restore orders tables by their keys). The checked functions below always
-- write the agent row and its sponsorship together, and every read joins them.

CREATE TABLE cuspatlas.agent_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  agent_ref uuid NOT NULL REFERENCES cuspatlas.agent_principals (principal_id),
  event text NOT NULL CHECK (event IN ('created', 'suspended', 'resumed', 'revoked', 'rotated', 'sponsorChanged')),
  actor_ref uuid NOT NULL REFERENCES cuspatlas.principals (id),
  agent_version integer NOT NULL CHECK (agent_version >= 1),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The separate agent-audit stream: one row per audit event whose actor is an agent.
CREATE TABLE cuspatlas.agent_audit_events (
  event_ref uuid PRIMARY KEY REFERENCES cuspatlas.audit_events (event_ref),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  agent_ref uuid NOT NULL REFERENCES cuspatlas.agent_principals (principal_id),
  sponsor_ref uuid NOT NULL REFERENCES cuspatlas.principals (id),
  sponsorship_ref uuid NOT NULL REFERENCES cuspatlas.agent_sponsorships (id),
  operation text NOT NULL,
  resource_type text NOT NULL,
  resource_ref uuid NOT NULL,
  resource_version integer NOT NULL,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  CHECK (agent_ref <> sponsor_ref)
);
CREATE INDEX agent_audit_events_agent ON cuspatlas.agent_audit_events (tenant_id, agent_ref, occurred_at, event_ref);

CREATE FUNCTION cuspatlas.agent_records_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION 'agent sponsorships, lifecycle events and agent audit rows are never changed'
      USING ERRCODE = '42501';
  END
  $$;
CREATE TRIGGER agent_sponsorships_guard BEFORE UPDATE OR DELETE ON cuspatlas.agent_sponsorships
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.agent_records_append_only();
CREATE TRIGGER agent_lifecycle_events_guard BEFORE UPDATE OR DELETE ON cuspatlas.agent_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.agent_records_append_only();
CREATE TRIGGER agent_audit_events_guard BEFORE UPDATE OR DELETE ON cuspatlas.agent_audit_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.agent_records_append_only();

ALTER TABLE cuspatlas.agent_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_principals FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_sponsorships ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_sponsorships FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_lifecycle_events FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_principals_select ON cuspatlas.agent_principals
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY agent_sponsorships_select ON cuspatlas.agent_sponsorships
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY agent_lifecycle_events_select ON cuspatlas.agent_lifecycle_events
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY agent_audit_events_select ON cuspatlas.agent_audit_events
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
GRANT SELECT ON cuspatlas.agent_principals, cuspatlas.agent_sponsorships, cuspatlas.agent_lifecycle_events,
  cuspatlas.agent_audit_events TO cuspatlas_app;

-- Live authority of one principal in one tenant, read by the membership source (which sets only
-- cuspatlas.auth_principal_id). Answers only for that principal. NULL row = not an agent.
CREATE FUNCTION cuspatlas.agent_authority(p_principal uuid, p_tenant uuid)
  RETURNS TABLE (agent_ref uuid, state text, live boolean, scope_set text[], sponsor_ref uuid,
    sponsorship_ref uuid, credential_ref text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT a.principal_id, a.state,
      a.state <> 'revoked' AND a.expires_at > now() AND EXISTS (
        SELECT 1 FROM cuspatlas.memberships sm JOIN cuspatlas.principals sp ON sp.id = sm.principal_id
        WHERE sm.principal_id = s.sponsor_ref AND sm.tenant_id = a.tenant_id AND sm.revoked_at IS NULL
          AND sp.kind = 'human'),
      a.scope_set, s.sponsor_ref, s.id, a.credential_ref
    FROM cuspatlas.agent_principals a JOIN cuspatlas.agent_sponsorships s ON s.id = a.sponsorship_ref
    WHERE a.principal_id = p_principal AND a.tenant_id = p_tenant
      AND (p_principal = cuspatlas.current_auth_principal_id() OR p_principal = cuspatlas.current_actor_id())
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_authority(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.agent_authority(uuid, uuid) TO cuspatlas_app;

-- The caller (current actor in the current tenant) must be a live human member holding agents.manage.
CREATE FUNCTION cuspatlas.agent_assert_manager() RETURNS text[]
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  DECLARE
    v_scopes text[];
  BEGIN
    SELECT m.scopes INTO v_scopes FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
    WHERE m.principal_id = cuspatlas.current_actor_id() AND m.tenant_id = cuspatlas.current_tenant_id()
      AND m.revoked_at IS NULL AND p.kind = 'human';
    IF v_scopes IS NULL OR NOT ('agents.manage' = ANY (v_scopes)) THEN
      RAISE EXCEPTION 'agent management requires a live human manager' USING ERRCODE = '42501';
    END IF;
    RETURN v_scopes;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_assert_manager() FROM PUBLIC;

CREATE FUNCTION cuspatlas.agent_create(p_purpose text, p_scopes text[], p_expires timestamptz,
  p_credential text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  DECLARE
    v_manager text[] := cuspatlas.agent_assert_manager();
    v_id uuid := gen_random_uuid();
    v_sponsorship uuid := gen_random_uuid();
    v_locations text[];
  BEGIN
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
REVOKE ALL ON FUNCTION cuspatlas.agent_create(text, text[], timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.agent_create(text, text[], timestamptz, text) TO cuspatlas_app;

-- suspend | resume | revoke | rotate | sponsor. P0404 hidden/missing, P0409 stale or not allowed in
-- this state (detail names the reason), P0422 invalid sponsor. Returns the new version.
CREATE FUNCTION cuspatlas.agent_transition(p_agent uuid, p_action text, p_expected integer,
  p_credential text, p_sponsor uuid, p_reason text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  DECLARE
    v_manager text[] := cuspatlas.agent_assert_manager();
    a cuspatlas.agent_principals%ROWTYPE;
    v_sponsorship uuid;
    v_event text;
  BEGIN
    SELECT * INTO a FROM cuspatlas.agent_principals
    WHERE principal_id = p_agent AND tenant_id = cuspatlas.current_tenant_id() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'agent_not_found' USING ERRCODE = 'P0404'; END IF;
    IF a.version <> p_expected THEN
      RAISE EXCEPTION 'stale' USING ERRCODE = 'P0409', DETAIL = a.version::text;
    END IF;
    IF a.state = 'revoked' THEN RAISE EXCEPTION 'agent_revoked' USING ERRCODE = 'P0409', DETAIL = 'agent_revoked'; END IF;
    IF p_action = 'suspend' THEN
      IF a.state <> 'active' THEN RAISE EXCEPTION 'not_active' USING ERRCODE = 'P0409', DETAIL = 'agent_not_active'; END IF;
      UPDATE cuspatlas.agent_principals SET state = 'suspended', version = version + 1 WHERE principal_id = p_agent;
      v_event := 'suspended';
    ELSIF p_action = 'resume' THEN
      IF a.state <> 'suspended' THEN RAISE EXCEPTION 'not_suspended' USING ERRCODE = 'P0409', DETAIL = 'agent_not_suspended'; END IF;
      UPDATE cuspatlas.agent_principals SET state = 'active', version = version + 1 WHERE principal_id = p_agent;
      v_event := 'resumed';
    ELSIF p_action = 'revoke' THEN
      UPDATE cuspatlas.agent_principals SET state = 'revoked', revoked_at = now(),
        revoked_by = cuspatlas.current_actor_id(), revocation_reason = p_reason, version = version + 1
      WHERE principal_id = p_agent;
      UPDATE cuspatlas.memberships SET revoked_at = now()
      WHERE principal_id = p_agent AND tenant_id = cuspatlas.current_tenant_id() AND revoked_at IS NULL;
      v_event := 'revoked';
    ELSIF p_action = 'rotate' THEN
      UPDATE cuspatlas.agent_principals SET credential_ref = p_credential, version = version + 1
      WHERE principal_id = p_agent;
      v_event := 'rotated';
    ELSIF p_action = 'sponsor' THEN
      IF p_sponsor IS NULL OR p_sponsor = p_agent OR NOT EXISTS (
        SELECT 1 FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
        WHERE m.principal_id = p_sponsor AND m.tenant_id = cuspatlas.current_tenant_id()
          AND m.revoked_at IS NULL AND p.kind = 'human' AND a.scope_set <@ m.scopes) THEN
        RAISE EXCEPTION 'sponsor_invalid' USING ERRCODE = 'P0422';
      END IF;
      v_sponsorship := gen_random_uuid();
      INSERT INTO cuspatlas.agent_sponsorships (id, tenant_id, agent_ref, sponsor_ref, recorded_by)
        VALUES (v_sponsorship, cuspatlas.current_tenant_id(), p_agent, p_sponsor, cuspatlas.current_actor_id());
      UPDATE cuspatlas.agent_principals SET sponsorship_ref = v_sponsorship, version = version + 1
      WHERE principal_id = p_agent;
      v_event := 'sponsorChanged';
    ELSE
      RAISE EXCEPTION 'unknown action' USING ERRCODE = '22023';
    END IF;
    INSERT INTO cuspatlas.agent_lifecycle_events (tenant_id, agent_ref, event, actor_ref, agent_version)
      VALUES (cuspatlas.current_tenant_id(), p_agent, v_event, cuspatlas.current_actor_id(), a.version + 1);
    RETURN a.version + 1;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_transition(uuid, text, integer, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.agent_transition(uuid, text, integer, text, uuid, text) TO cuspatlas_app;

-- Copies every audit row whose actor is an agent into the agent-audit stream (sponsor of record).
CREATE FUNCTION cuspatlas.agent_audit_copy() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  BEGIN
    INSERT INTO cuspatlas.agent_audit_events (event_ref, tenant_id, agent_ref, sponsor_ref, sponsorship_ref,
        operation, resource_type, resource_ref, resource_version, correlation_id, occurred_at)
      SELECT NEW.event_ref, NEW.tenant_id, a.principal_id, s.sponsor_ref, s.id, NEW.operation,
        NEW.resource_type, NEW.resource_ref, NEW.resource_version, NEW.correlation_id, NEW.occurred_at
      FROM cuspatlas.agent_principals a JOIN cuspatlas.agent_sponsorships s ON s.id = a.sponsorship_ref
      WHERE a.principal_id = NEW.actor_id AND a.tenant_id = NEW.tenant_id;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_audit_copy() FROM PUBLIC;
CREATE TRIGGER audit_events_agent_copy AFTER INSERT ON cuspatlas.audit_events
  FOR EACH ROW WHEN (NEW.principal = 'service') EXECUTE FUNCTION cuspatlas.agent_audit_copy();
