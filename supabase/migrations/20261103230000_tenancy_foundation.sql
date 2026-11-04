-- F Task 2: synthetic tenancy foundation. Non-clinical by construction.
-- Applied by the privileged migration role only. The application connects as cuspatlas_app,
-- which owns nothing, has no BYPASSRLS, and receives explicit table-level grants below.
-- Does not depend on Supabase-only roles or the auth schema (frozen contract decisions).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'cuspatlas_app') THEN
    CREATE ROLE cuspatlas_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;
-- Enforce the attributes even if the role pre-existed with different ones.
ALTER ROLE cuspatlas_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;

CREATE SCHEMA cuspatlas;
REVOKE ALL ON SCHEMA cuspatlas FROM PUBLIC;
GRANT USAGE ON SCHEMA cuspatlas TO cuspatlas_app;

-- Context accessors. A missing or empty setting yields NULL, so every comparison denies.
CREATE FUNCTION cuspatlas.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(pg_catalog.current_setting('cuspatlas.tenant_id', true), '')::uuid $$;

CREATE FUNCTION cuspatlas.current_actor_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(pg_catalog.current_setting('cuspatlas.actor_id', true), '')::uuid $$;

-- Set only by the identity lookup after token signature verification, never by a caller value.
-- It lets a principal read its own membership rows before a tenant context exists.
CREATE FUNCTION cuspatlas.current_auth_principal_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(pg_catalog.current_setting('cuspatlas.auth_principal_id', true), '')::uuid $$;

REVOKE ALL ON FUNCTION cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(),
  cuspatlas.current_auth_principal_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(),
  cuspatlas.current_auth_principal_id() TO cuspatlas_app;

CREATE TABLE cuspatlas.tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cuspatlas.principals (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('human', 'service')),
  handle text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cuspatlas.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  principal_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  scopes text[] NOT NULL,
  -- NULL means every location in the tenant; otherwise the allowed location references.
  location_refs text[],
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (tenant_id, principal_id)
);

CREATE TABLE cuspatlas.synthetic_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  location_ref text CHECK (location_ref ~ '^[a-z0-9-]{1,64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX synthetic_tasks_tenant_id_id ON cuspatlas.synthetic_tasks (tenant_id, id);

-- Minimal durable security-attempt sink (Task 4 hardens it). Insert-only for the runtime role.
-- No foreign keys: unauthenticated attempts carry NULL tenant/actor and are never fabricated.
CREATE TABLE cuspatlas.security_attempt_events (
  attempt_ref uuid PRIMARY KEY,
  correlation_id uuid NOT NULL,
  tenant_id uuid,
  actor_id uuid,
  operation text NOT NULL CHECK (operation ~ '^[a-z][A-Za-z]{0,40}(\.[a-z][A-Za-z]{0,40}){0,3}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX security_attempt_events_correlation ON cuspatlas.security_attempt_events (correlation_id);

-- Row level security: enabled and forced everywhere, default deny, runtime role policies only.
ALTER TABLE cuspatlas.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.principals FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.synthetic_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.synthetic_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.security_attempt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.security_attempt_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_current ON cuspatlas.tenants
  FOR SELECT TO cuspatlas_app
  USING (id = cuspatlas.current_tenant_id());

CREATE POLICY memberships_current_tenant_or_self ON cuspatlas.memberships
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id() OR principal_id = cuspatlas.current_auth_principal_id());

CREATE POLICY principals_self_or_tenant_member ON cuspatlas.principals
  FOR SELECT TO cuspatlas_app
  USING (
    id = cuspatlas.current_auth_principal_id()
    OR EXISTS (
      SELECT 1 FROM cuspatlas.memberships m
      WHERE m.principal_id = principals.id AND m.tenant_id = cuspatlas.current_tenant_id()
    )
  );

CREATE POLICY synthetic_tasks_select ON cuspatlas.synthetic_tasks
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY synthetic_tasks_insert ON cuspatlas.synthetic_tasks
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());

CREATE POLICY synthetic_tasks_update ON cuspatlas.synthetic_tasks
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY security_attempt_events_insert ON cuspatlas.security_attempt_events
  FOR INSERT TO cuspatlas_app
  WITH CHECK (true);

-- Explicit grants. No DELETE anywhere; no UPDATE of tenant_id; attempts are insert-only.
GRANT SELECT ON cuspatlas.tenants, cuspatlas.principals, cuspatlas.memberships TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.synthetic_tasks TO cuspatlas_app;
GRANT UPDATE (label, version, updated_at) ON cuspatlas.synthetic_tasks TO cuspatlas_app;
GRANT INSERT ON cuspatlas.security_attempt_events TO cuspatlas_app;
