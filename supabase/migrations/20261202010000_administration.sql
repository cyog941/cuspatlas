-- A17 administration surface (synthetic only): audit search, access review and membership revocation.
-- The runtime role still cannot read audit rows, attempts, sensitive reads or other members'
-- memberships. Three SECURITY DEFINER functions do, each bound to the CURRENT tenant and each
-- rechecking that the CURRENT actor holds a live human membership with the privileged scope (defence in
-- depth beneath the application policy). The added policies admit only a role other than the runtime
-- role (the functions' owner), only rows of the current tenant, and grant nothing by themselves (no
-- other role holds SELECT or UPDATE on these tables). Search is read only: no function updates, deletes
-- or restores an audit row (the append-only triggers stay in force).
CREATE POLICY admin_definer_read ON cuspatlas.audit_events FOR SELECT
  USING (current_user <> 'cuspatlas_app' AND tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY admin_definer_read ON cuspatlas.security_attempt_events FOR SELECT
  USING (current_user <> 'cuspatlas_app' AND tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY admin_definer_read ON cuspatlas.sensitive_read_events FOR SELECT
  USING (current_user <> 'cuspatlas_app' AND tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY admin_definer_read ON cuspatlas.memberships FOR SELECT
  USING (current_user <> 'cuspatlas_app' AND tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY admin_definer_revoke ON cuspatlas.memberships FOR UPDATE
  USING (current_user <> 'cuspatlas_app' AND tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (current_user <> 'cuspatlas_app' AND tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY admin_definer_read ON cuspatlas.principals FOR SELECT
  USING (current_user <> 'cuspatlas_app');

CREATE FUNCTION cuspatlas.admin_caller_has(p_scope text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
      WHERE m.tenant_id = cuspatlas.current_tenant_id() AND m.principal_id = cuspatlas.current_actor_id()
        AND m.revoked_at IS NULL AND p.kind = 'human' AND p_scope = ANY (m.scopes))
  $$;
REVOKE ALL ON FUNCTION cuspatlas.admin_caller_has(text) FROM PUBLIC;

CREATE FUNCTION cuspatlas.admin_audit_search(p_sources text[], p_actor uuid, p_principal text, p_operation text,
    p_from timestamptz, p_to timestamptz, p_limit integer)
  RETURNS TABLE (source text, event_ref uuid, occurred_at timestamptz, actor_id uuid, principal text, operation text,
    resource_type text, resource_ref uuid, reason_code text, result_count integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  BEGIN
    IF cuspatlas.current_tenant_id() IS NULL OR NOT cuspatlas.admin_caller_has('audit.read') THEN
      RAISE EXCEPTION 'audit search not permitted' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT x.* FROM (
      SELECT 'committed_change'::text, a.event_ref, a.occurred_at, a.actor_id, a.principal, a.operation, a.resource_type,
        a.resource_ref, NULL::text, NULL::integer
      FROM cuspatlas.audit_events a
      WHERE 'committed_change' = ANY (p_sources) AND a.tenant_id = cuspatlas.current_tenant_id()
        AND (p_actor IS NULL OR a.actor_id = p_actor) AND (p_principal IS NULL OR a.principal = p_principal)
        AND (p_operation IS NULL OR a.operation = p_operation)
        AND (p_from IS NULL OR a.occurred_at >= p_from) AND (p_to IS NULL OR a.occurred_at < p_to)
      UNION ALL
      SELECT 'security_attempt'::text, s.attempt_ref, s.occurred_at, s.actor_id, NULL::text, s.operation, NULL::text,
        NULL::uuid, s.reason_code, NULL::integer
      FROM cuspatlas.security_attempt_events s
      WHERE 'security_attempt' = ANY (p_sources) AND s.tenant_id = cuspatlas.current_tenant_id()
        AND (p_actor IS NULL OR s.actor_id = p_actor) AND p_principal IS NULL
        AND (p_operation IS NULL OR s.operation = p_operation)
        AND (p_from IS NULL OR s.occurred_at >= p_from) AND (p_to IS NULL OR s.occurred_at < p_to)
      UNION ALL
      SELECT 'sensitive_read'::text, r.event_ref, r.occurred_at, r.actor_id, r.principal, r.operation, r.resource_type,
        NULL::uuid, NULL::text, r.result_count
      FROM cuspatlas.sensitive_read_events r
      WHERE 'sensitive_read' = ANY (p_sources) AND r.tenant_id = cuspatlas.current_tenant_id()
        AND (p_actor IS NULL OR r.actor_id = p_actor) AND (p_principal IS NULL OR r.principal = p_principal)
        AND (p_operation IS NULL OR r.operation = p_operation)
        AND (p_from IS NULL OR r.occurred_at >= p_from) AND (p_to IS NULL OR r.occurred_at < p_to)
    ) x (source, event_ref, occurred_at, actor_id, principal, operation, resource_type, resource_ref, reason_code,
         result_count)
    ORDER BY x.occurred_at DESC, x.event_ref DESC
    LIMIT least(greatest(p_limit, 1), 201);
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.admin_audit_search(text[], uuid, text, text, timestamptz, timestamptz, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.admin_audit_search(text[], uuid, text, text, timestamptz, timestamptz, integer)
  TO cuspatlas_app;

CREATE FUNCTION cuspatlas.admin_access_review()
  RETURNS TABLE (principal_id uuid, kind text, handle text, scopes text[], location_refs text[], granted_at timestamptz,
    revoked_at timestamptz, last_activity_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  BEGIN
    IF cuspatlas.current_tenant_id() IS NULL OR NOT cuspatlas.admin_caller_has('access.manage') THEN
      RAISE EXCEPTION 'access review not permitted' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT m.principal_id, p.kind, p.handle, m.scopes, m.location_refs, m.granted_at, m.revoked_at,
      greatest(
        (SELECT max(a.occurred_at) FROM cuspatlas.audit_events a
         WHERE a.tenant_id = m.tenant_id AND a.actor_id = m.principal_id),
        (SELECT max(r.occurred_at) FROM cuspatlas.sensitive_read_events r
         WHERE r.tenant_id = m.tenant_id AND r.actor_id = m.principal_id))
    FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
    WHERE m.tenant_id = cuspatlas.current_tenant_id()
    ORDER BY p.kind, p.handle, m.principal_id
    LIMIT 1000;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.admin_access_review() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.admin_access_review() TO cuspatlas_app;

-- Revokes one staff membership (human or service principal) of the current tenant. Outcome codes:
-- revoked, already_revoked, not_found (no membership in this tenant), self (the caller's own).
CREATE FUNCTION cuspatlas.admin_revoke_membership(p_principal uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  DECLARE
    r timestamptz;
  BEGIN
    IF cuspatlas.current_tenant_id() IS NULL OR NOT cuspatlas.admin_caller_has('access.manage') THEN
      RAISE EXCEPTION 'revocation not permitted' USING ERRCODE = '42501';
    END IF;
    IF p_principal = cuspatlas.current_actor_id() THEN
      RETURN 'self';
    END IF;
    SELECT m.revoked_at INTO r FROM cuspatlas.memberships m
      WHERE m.tenant_id = cuspatlas.current_tenant_id() AND m.principal_id = p_principal FOR UPDATE;
    IF NOT FOUND THEN
      RETURN 'not_found';
    END IF;
    IF r IS NOT NULL THEN
      RETURN 'already_revoked';
    END IF;
    UPDATE cuspatlas.memberships SET revoked_at = now()
      WHERE tenant_id = cuspatlas.current_tenant_id() AND principal_id = p_principal;
    RETURN 'revoked';
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.admin_revoke_membership(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.admin_revoke_membership(uuid) TO cuspatlas_app;
