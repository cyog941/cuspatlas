-- A23 hardening after independent review (synthetic implementation; every value here stays
-- recommended-pending-approval). Memory PHI screening in the domain is a best-effort heuristic, not
-- enforced default-deny; this migration adds the database parts that do not depend on it:
--   * the phi guard takes a share lock on the tenant policy row, so a concurrent flip to "off" either
--     waits for the write and then removes it, or commits first and the write is refused;
--   * a flip to "off" removes every phi note of the tenant in the same transaction;
--   * the guard no longer fires on read-count bumps (a refused read never fails on the counter);
--   * an independent regex backstop refuses contact and DOB patterns in non-phi notes;
--   * RLS carries the reach rule (agent: own rows; human: current sponsor or agents.manage; the worker
--     service holding outbox.deliver), task policies update only their state columns by owner or
--     manager, and a scheduled task binds a policy of the same agent and tenant;
--   * sponsor offers are readable only by the offeree, the offering manager, the agent's sponsor and
--     agent managers; agent_sponsor_decide locks agent then offer, the same order as agent_sponsor_offer.

-- ---- Reach helpers (definer: they read memberships and sponsorships the caller's RLS hides) ----

-- True when the current actor is a live human member holding agents.manage in the current tenant.
CREATE FUNCTION cuspatlas.agent_actor_manages() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
      WHERE m.principal_id = cuspatlas.current_actor_id() AND m.tenant_id = cuspatlas.current_tenant_id()
        AND m.revoked_at IS NULL AND p.kind = 'human' AND 'agents.manage' = ANY (m.scopes))
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_actor_manages() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.agent_actor_manages() TO cuspatlas_app;

-- Human reach: the agent's current sponsor or an agent manager.
CREATE FUNCTION cuspatlas.agent_human_reach(p_agent uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT EXISTS (
        SELECT 1 FROM cuspatlas.agent_principals a
        JOIN cuspatlas.agent_sponsorships s ON s.id = a.sponsorship_ref
        WHERE a.principal_id = p_agent AND a.tenant_id = cuspatlas.current_tenant_id()
          AND s.sponsor_ref = cuspatlas.current_actor_id())
      OR cuspatlas.agent_actor_manages()
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_human_reach(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.agent_human_reach(uuid) TO cuspatlas_app;

-- Workspace reach: an agent reaches only its own rows; a human its sponsored agents or, as a manager,
-- every agent; a non-agent service principal holding outbox.deliver (the worker) the tenant's tasks.
CREATE FUNCTION cuspatlas.agent_workspace_reach(p_agent uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM cuspatlas.agent_principals WHERE principal_id = cuspatlas.current_actor_id())
        THEN p_agent = cuspatlas.current_actor_id()
      ELSE cuspatlas.agent_human_reach(p_agent) OR EXISTS (
        SELECT 1 FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
        WHERE m.principal_id = cuspatlas.current_actor_id() AND m.tenant_id = cuspatlas.current_tenant_id()
          AND m.revoked_at IS NULL AND p.kind = 'service' AND 'outbox.deliver' = ANY (m.scopes))
    END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_workspace_reach(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.agent_workspace_reach(uuid) TO cuspatlas_app;

-- ---- Scoped memory: phi guard, flip removal, regex backstop ----

CREATE OR REPLACE FUNCTION cuspatlas.agent_memory_phi_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  BEGIN
    IF NEW.classification = 'phi' THEN
      -- Share lock: a concurrent flip waits for this transaction, or this re-reads the flipped row.
      PERFORM 1 FROM cuspatlas.agent_memory_policies p
        WHERE p.tenant_id = NEW.tenant_id AND p.phi_allowed FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'phi_not_permitted' USING ERRCODE = 'P0422';
      END IF;
    END IF;
    RETURN NEW;
  END
  $$;
DROP TRIGGER agent_memory_phi_guard ON cuspatlas.agent_memory_entries;
CREATE TRIGGER agent_memory_phi_guard BEFORE INSERT OR UPDATE OF classification, value
  ON cuspatlas.agent_memory_entries FOR EACH ROW EXECUTE FUNCTION cuspatlas.agent_memory_phi_guard();

CREATE FUNCTION cuspatlas.agent_memory_policy_flip() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  BEGIN
    DELETE FROM cuspatlas.agent_memory_entries WHERE tenant_id = NEW.tenant_id AND classification = 'phi';
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_memory_policy_flip() FROM PUBLIC;
CREATE TRIGGER agent_memory_policy_flip AFTER UPDATE OF phi_allowed ON cuspatlas.agent_memory_policies
  FOR EACH ROW WHEN (OLD.phi_allowed AND NOT NEW.phi_allowed)
  EXECUTE FUNCTION cuspatlas.agent_memory_policy_flip();

-- Independent backstop for non-phi notes: e-mail addresses, phone-like digit runs and DOB phrases.
-- NOT VALID: enforced for every new or changed row; existing synthetic rows are not rechecked.
ALTER TABLE cuspatlas.agent_memory_entries ADD CONSTRAINT agent_memory_entries_value_screen CHECK (
  classification = 'phi' OR (
    value !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
    AND value !~ '\+?[0-9][0-9 ().-]{6,}[0-9]'
    AND value !~* '(^|[^a-z])(dob|d\.o\.b|date of birth|birth ?date|born)([^a-z]|$)')
) NOT VALID;

-- ---- RLS reach rule on agent-owned rows ----

DROP POLICY agent_sessions_rw ON cuspatlas.agent_sessions;
CREATE POLICY agent_sessions_rw ON cuspatlas.agent_sessions FOR ALL TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND cuspatlas.agent_workspace_reach(agent_ref))
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND cuspatlas.agent_workspace_reach(agent_ref));
DROP POLICY agent_memory_entries_rw ON cuspatlas.agent_memory_entries;
CREATE POLICY agent_memory_entries_rw ON cuspatlas.agent_memory_entries FOR ALL TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND cuspatlas.agent_workspace_reach(agent_ref))
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND agent_ref = cuspatlas.current_actor_id());
DROP POLICY agent_scheduled_tasks_rw ON cuspatlas.agent_scheduled_tasks;
CREATE POLICY agent_scheduled_tasks_rw ON cuspatlas.agent_scheduled_tasks FOR ALL TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND cuspatlas.agent_workspace_reach(agent_ref))
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND cuspatlas.agent_workspace_reach(agent_ref));
DROP POLICY agent_task_runs_rw ON cuspatlas.agent_task_runs;
CREATE POLICY agent_task_runs_rw ON cuspatlas.agent_task_runs FOR ALL TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND cuspatlas.agent_workspace_reach(agent_ref))
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND NOT cuspatlas.current_actor_is_agent()
    AND cuspatlas.agent_workspace_reach(agent_ref));

-- Task policies: only the state/revocation columns change, only by the owner or an agent manager.
DROP POLICY agent_task_policies_update ON cuspatlas.agent_task_policies;
CREATE POLICY agent_task_policies_update ON cuspatlas.agent_task_policies FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND NOT cuspatlas.current_actor_is_agent()
    AND (owner_ref = cuspatlas.current_actor_id() OR cuspatlas.agent_actor_manages()))
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
REVOKE UPDATE ON cuspatlas.agent_task_policies FROM cuspatlas_app;
GRANT UPDATE (state, revoked_at, revoked_by, version) ON cuspatlas.agent_task_policies TO cuspatlas_app;

-- A scheduled task binds a policy of the same agent and tenant.
ALTER TABLE cuspatlas.agent_task_policies
  ADD CONSTRAINT agent_task_policies_id_agent_tenant UNIQUE (id, agent_ref, tenant_id);
ALTER TABLE cuspatlas.agent_scheduled_tasks ADD CONSTRAINT agent_scheduled_tasks_policy_same_agent
  FOREIGN KEY (policy_ref, agent_ref, tenant_id)
  REFERENCES cuspatlas.agent_task_policies (id, agent_ref, tenant_id);

-- ---- Worker rechecks at claim time ----

-- The policy owner is still a live human member and the agent's current sponsor or an agent manager.
CREATE FUNCTION cuspatlas.agent_task_owner_live(p_owner uuid, p_agent uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
      WHERE m.principal_id = p_owner AND m.tenant_id = cuspatlas.current_tenant_id()
        AND m.revoked_at IS NULL AND p.kind = 'human'
        AND ('agents.manage' = ANY (m.scopes) OR EXISTS (
          SELECT 1 FROM cuspatlas.agent_principals a JOIN cuspatlas.agent_sponsorships s ON s.id = a.sponsorship_ref
          WHERE a.principal_id = p_agent AND s.sponsor_ref = p_owner)))
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_task_owner_live(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.agent_task_owner_live(uuid, uuid) TO cuspatlas_app;

-- False when the agent has no consent in force (state active) on the deployment: revoked consents stop
-- the task; an expired one is refused by the MCP gate and recorded as a run outcome.
CREATE FUNCTION cuspatlas.agent_task_consent_live(p_agent uuid, p_deployment text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM cuspatlas.agent_consents c
      WHERE c.agent_ref = p_agent AND c.tenant_id = cuspatlas.current_tenant_id()
        AND c.deployment = p_deployment AND c.state = 'active')
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_task_consent_live(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.agent_task_consent_live(uuid, text) TO cuspatlas_app;

-- ---- Sponsor offers: visibility and lock order ----

DROP POLICY agent_sponsor_offers_select ON cuspatlas.agent_sponsor_offers;
CREATE POLICY agent_sponsor_offers_select ON cuspatlas.agent_sponsor_offers FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() AND NOT cuspatlas.current_actor_is_agent()
    AND (sponsor_ref = cuspatlas.current_actor_id() OR offered_by = cuspatlas.current_actor_id()
      OR cuspatlas.agent_human_reach(agent_ref)));

-- Same contract as 20261205000000; locks the agent before the offer (agent_sponsor_offer's order).
CREATE OR REPLACE FUNCTION cuspatlas.agent_sponsor_decide(p_offer uuid, p_accept boolean) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  DECLARE
    o cuspatlas.agent_sponsor_offers%ROWTYPE;
    a cuspatlas.agent_principals%ROWTYPE;
    v_agent uuid;
    v_sponsorship uuid;
  BEGIN
    SELECT agent_ref INTO v_agent FROM cuspatlas.agent_sponsor_offers
    WHERE id = p_offer AND tenant_id = cuspatlas.current_tenant_id()
      AND sponsor_ref = cuspatlas.current_actor_id();
    IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found' USING ERRCODE = 'P0404'; END IF;
    SELECT * INTO a FROM cuspatlas.agent_principals WHERE principal_id = v_agent FOR UPDATE;
    SELECT * INTO o FROM cuspatlas.agent_sponsor_offers WHERE id = p_offer FOR UPDATE;
    IF o.state <> 'pending' THEN RAISE EXCEPTION 'offer_decided' USING ERRCODE = 'P0409', DETAIL = 'offer_decided'; END IF;
    IF o.expires_at <= now() THEN RAISE EXCEPTION 'offer_expired' USING ERRCODE = 'P0409', DETAIL = 'offer_expired'; END IF;
    IF NOT p_accept THEN
      UPDATE cuspatlas.agent_sponsor_offers SET state = 'declined', decided_at = now() WHERE id = p_offer;
      RETURN a.version;
    END IF;
    IF a.state = 'revoked' THEN RAISE EXCEPTION 'agent_revoked' USING ERRCODE = 'P0409', DETAIL = 'agent_revoked'; END IF;
    IF NOT cuspatlas.agent_sponsor_qualifies(o.agent_ref, o.sponsor_ref) THEN
      RAISE EXCEPTION 'sponsor_invalid' USING ERRCODE = 'P0422';
    END IF;
    v_sponsorship := gen_random_uuid();
    INSERT INTO cuspatlas.agent_sponsorships (id, tenant_id, agent_ref, sponsor_ref, recorded_by)
      VALUES (v_sponsorship, o.tenant_id, o.agent_ref, o.sponsor_ref, cuspatlas.current_actor_id());
    UPDATE cuspatlas.agent_sponsor_offers SET state = 'accepted', decided_at = now(), sponsorship_ref = v_sponsorship
    WHERE id = p_offer;
    UPDATE cuspatlas.agent_principals SET sponsorship_ref = v_sponsorship, version = version + 1
    WHERE principal_id = o.agent_ref;
    INSERT INTO cuspatlas.agent_lifecycle_events (tenant_id, agent_ref, event, actor_ref, agent_version)
      VALUES (o.tenant_id, o.agent_ref, 'sponsorChanged', cuspatlas.current_actor_id(), a.version + 1);
    RETURN a.version + 1;
  END
  $$;
