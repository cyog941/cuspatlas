-- H3 item 3c (synthetic implementation, pending approval): a sponsor change requires the named human's
-- acceptance. `agents.sponsors.change` now records a pending offer (one pending offer per agent; a newer
-- offer supersedes it); the offered human accepts or declines it; until acceptance the old sponsor stays
-- in force. Offers expire after 7 days (recommended-pending-approval). A guard trigger makes the
-- accepted offer the only way agent_principals.sponsorship_ref can change, whoever writes the row.
-- 20261201000000 and 20261203000000 are applied and stay unchanged; agent_transition is replaced here
-- so its 'sponsor' action can no longer re-sponsor directly.

CREATE TABLE cuspatlas.agent_sponsor_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  agent_ref uuid NOT NULL REFERENCES cuspatlas.agent_principals (principal_id),
  sponsor_ref uuid NOT NULL REFERENCES cuspatlas.principals (id),
  offered_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'declined', 'superseded')),
  decided_at timestamptz,
  sponsorship_ref uuid REFERENCES cuspatlas.agent_sponsorships (id),
  CHECK (expires_at > offered_at),
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  CHECK ((state = 'accepted') = (sponsorship_ref IS NOT NULL)),
  CHECK (sponsor_ref <> agent_ref)
);
CREATE UNIQUE INDEX agent_sponsor_offers_one_pending ON cuspatlas.agent_sponsor_offers (agent_ref)
  WHERE state = 'pending';
ALTER TABLE cuspatlas.agent_sponsor_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_sponsor_offers FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_sponsor_offers_select ON cuspatlas.agent_sponsor_offers
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
GRANT SELECT ON cuspatlas.agent_sponsor_offers TO cuspatlas_app;
COMMENT ON TABLE cuspatlas.agent_sponsor_offers IS
  'H3 3c: pending sponsor change offers; written only by agent_sponsor_offer / agent_sponsor_decide.';

-- A decided offer is never changed again.
CREATE FUNCTION cuspatlas.agent_sponsor_offers_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' OR OLD.state <> 'pending' THEN
      RAISE EXCEPTION 'decided sponsor offers are never changed' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER agent_sponsor_offers_guard BEFORE UPDATE OR DELETE ON cuspatlas.agent_sponsor_offers
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.agent_sponsor_offers_guard();

-- The sponsorship of an agent changes only to the sponsorship of an accepted offer for that agent.
CREATE FUNCTION cuspatlas.agent_principals_sponsorship_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  BEGIN
    IF NEW.sponsorship_ref IS DISTINCT FROM OLD.sponsorship_ref AND NOT EXISTS (
      SELECT 1 FROM cuspatlas.agent_sponsor_offers o
      WHERE o.agent_ref = NEW.principal_id AND o.state = 'accepted' AND o.sponsorship_ref = NEW.sponsorship_ref) THEN
      RAISE EXCEPTION 'a sponsorship changes only through an accepted sponsor offer' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER agent_principals_sponsorship_guard BEFORE UPDATE OF sponsorship_ref ON cuspatlas.agent_principals
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.agent_principals_sponsorship_guard();

-- The offered sponsor must be a live human member of the tenant holding every scope of the agent.
CREATE FUNCTION cuspatlas.agent_sponsor_qualifies(p_agent uuid, p_sponsor uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT p_sponsor IS NOT NULL AND p_sponsor <> p_agent AND EXISTS (
      SELECT 1 FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
      JOIN cuspatlas.agent_principals a ON a.principal_id = p_agent AND a.tenant_id = m.tenant_id
      WHERE m.principal_id = p_sponsor AND m.tenant_id = cuspatlas.current_tenant_id()
        AND m.revoked_at IS NULL AND p.kind = 'human' AND a.scope_set <@ m.scopes)
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_sponsor_qualifies(uuid, uuid) FROM PUBLIC;

-- Records an offer (manager only). P0404 hidden/missing, P0409 stale/revoked, P0422 invalid sponsor.
-- Returns the offer id; the agent version does not change.
CREATE FUNCTION cuspatlas.agent_sponsor_offer(p_agent uuid, p_expected integer, p_sponsor uuid)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  DECLARE
    v_manager text[] := cuspatlas.agent_assert_manager();
    a cuspatlas.agent_principals%ROWTYPE;
    v_id uuid;
  BEGIN
    SELECT * INTO a FROM cuspatlas.agent_principals
    WHERE principal_id = p_agent AND tenant_id = cuspatlas.current_tenant_id() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'agent_not_found' USING ERRCODE = 'P0404'; END IF;
    IF a.version <> p_expected THEN
      RAISE EXCEPTION 'stale' USING ERRCODE = 'P0409', DETAIL = a.version::text;
    END IF;
    IF a.state = 'revoked' THEN RAISE EXCEPTION 'agent_revoked' USING ERRCODE = 'P0409', DETAIL = 'agent_revoked'; END IF;
    IF NOT cuspatlas.agent_sponsor_qualifies(p_agent, p_sponsor) THEN
      RAISE EXCEPTION 'sponsor_invalid' USING ERRCODE = 'P0422';
    END IF;
    UPDATE cuspatlas.agent_sponsor_offers SET state = 'superseded', decided_at = now()
    WHERE agent_ref = p_agent AND state = 'pending';
    INSERT INTO cuspatlas.agent_sponsor_offers (tenant_id, agent_ref, sponsor_ref, offered_by, expires_at)
      VALUES (cuspatlas.current_tenant_id(), p_agent, p_sponsor, cuspatlas.current_actor_id(),
        now() + interval '7 days')
      RETURNING id INTO v_id;
    RETURN v_id;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_sponsor_offer(uuid, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.agent_sponsor_offer(uuid, integer, uuid) TO cuspatlas_app;

-- The offered human accepts or declines. Only that human sees the offer (P0404 otherwise); a decided
-- offer is P0409 offer_decided, an expired one P0409 offer_expired; at acceptance the human must still
-- qualify (P0422) and the agent must not be revoked. Returns the agent version after the decision.
CREATE FUNCTION cuspatlas.agent_sponsor_decide(p_offer uuid, p_accept boolean) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  DECLARE
    o cuspatlas.agent_sponsor_offers%ROWTYPE;
    a cuspatlas.agent_principals%ROWTYPE;
    v_sponsorship uuid;
  BEGIN
    SELECT * INTO o FROM cuspatlas.agent_sponsor_offers
    WHERE id = p_offer AND tenant_id = cuspatlas.current_tenant_id()
      AND sponsor_ref = cuspatlas.current_actor_id() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found' USING ERRCODE = 'P0404'; END IF;
    SELECT * INTO a FROM cuspatlas.agent_principals WHERE principal_id = o.agent_ref FOR UPDATE;
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
REVOKE ALL ON FUNCTION cuspatlas.agent_sponsor_decide(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.agent_sponsor_decide(uuid, boolean) TO cuspatlas_app;

-- agent_transition keeps suspend | resume | revoke | rotate; 'sponsor' is refused (offers only).
CREATE OR REPLACE FUNCTION cuspatlas.agent_transition(p_agent uuid, p_action text, p_expected integer,
  p_credential text, p_sponsor uuid, p_reason text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  DECLARE
    v_manager text[] := cuspatlas.agent_assert_manager();
    a cuspatlas.agent_principals%ROWTYPE;
    v_event text;
  BEGIN
    IF p_action NOT IN ('suspend', 'resume', 'revoke', 'rotate') THEN
      RAISE EXCEPTION 'unknown action' USING ERRCODE = '22023';
    END IF;
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
    ELSE
      UPDATE cuspatlas.agent_principals SET credential_ref = p_credential, version = version + 1
      WHERE principal_id = p_agent;
      v_event := 'rotated';
    END IF;
    INSERT INTO cuspatlas.agent_lifecycle_events (tenant_id, agent_ref, event, actor_ref, agent_version)
      VALUES (cuspatlas.current_tenant_id(), p_agent, v_event, cuspatlas.current_actor_id(), a.version + 1);
    RETURN a.version + 1;
  END
  $$;
