-- A batch 3 hardening (synthetic only): a revocation can never leave the tenant without a live human
-- access.manage holder, also under concurrency. Self-revocation was already refused, but two managers
-- revoking each other at once could both pass the caller check before either commit. The function now
-- locks every live access.manage membership of the tenant first (in principal order, so concurrent
-- revocations serialize), rechecks the caller after the lock (a caller revoked meanwhile is refused), and
-- refuses with 'last_access_manager' when the target is a holder and no other live human holder remains.
CREATE OR REPLACE FUNCTION cuspatlas.admin_revoke_membership(p_principal uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  DECLARE
    r timestamptz;
    target_holds boolean;
    others integer;
  BEGIN
    IF cuspatlas.current_tenant_id() IS NULL THEN
      RAISE EXCEPTION 'revocation not permitted' USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM cuspatlas.memberships m
      WHERE m.tenant_id = cuspatlas.current_tenant_id() AND m.revoked_at IS NULL AND 'access.manage' = ANY (m.scopes)
      ORDER BY m.principal_id FOR UPDATE;
    IF NOT cuspatlas.admin_caller_has('access.manage') THEN
      RAISE EXCEPTION 'revocation not permitted' USING ERRCODE = '42501';
    END IF;
    IF p_principal = cuspatlas.current_actor_id() THEN
      RETURN 'self';
    END IF;
    SELECT m.revoked_at, 'access.manage' = ANY (m.scopes) INTO r, target_holds FROM cuspatlas.memberships m
      WHERE m.tenant_id = cuspatlas.current_tenant_id() AND m.principal_id = p_principal FOR UPDATE;
    IF NOT FOUND THEN
      RETURN 'not_found';
    END IF;
    IF r IS NOT NULL THEN
      RETURN 'already_revoked';
    END IF;
    IF target_holds THEN
      SELECT count(*) INTO others FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
        WHERE m.tenant_id = cuspatlas.current_tenant_id() AND m.principal_id <> p_principal AND m.revoked_at IS NULL
          AND p.kind = 'human' AND 'access.manage' = ANY (m.scopes);
      IF others < 1 THEN
        RETURN 'last_access_manager';
      END IF;
    END IF;
    UPDATE cuspatlas.memberships SET revoked_at = now()
      WHERE tenant_id = cuspatlas.current_tenant_id() AND principal_id = p_principal;
    RETURN 'revoked';
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.admin_revoke_membership(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.admin_revoke_membership(uuid) TO cuspatlas_app;
