-- F revision cycle 1 (independent review of E1/E2). Synthetic, non-clinical.
-- 1. Security attempts may be attributed to a tenant only when the sink has set the matching
--    transaction-local cuspatlas.attempt_tenant_id; unauthenticated attempts keep a NULL tenant.
-- 2. Members see only their own membership and principal rows inside a tenant (no scope listing).

CREATE FUNCTION cuspatlas.current_attempt_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(pg_catalog.current_setting('cuspatlas.attempt_tenant_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION cuspatlas.current_attempt_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.current_attempt_tenant_id() TO cuspatlas_app;

DROP POLICY security_attempt_events_insert ON cuspatlas.security_attempt_events;
CREATE POLICY security_attempt_events_insert ON cuspatlas.security_attempt_events
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id IS NULL OR tenant_id = cuspatlas.current_attempt_tenant_id());

DROP POLICY memberships_current_tenant_or_self ON cuspatlas.memberships;
CREATE POLICY memberships_own ON cuspatlas.memberships
  FOR SELECT TO cuspatlas_app
  USING (
    (tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id())
    OR principal_id = cuspatlas.current_auth_principal_id()
  );

DROP POLICY principals_self_or_tenant_member ON cuspatlas.principals;
CREATE POLICY principals_self ON cuspatlas.principals
  FOR SELECT TO cuspatlas_app
  USING (id = cuspatlas.current_auth_principal_id() OR id = cuspatlas.current_actor_id());
