-- Clock audit review: a monotonic tie-breaker for committed-change audit order. Audit rows are stamped
-- with clock_timestamp() (statement wall time, monotonic within a transaction), and `seq`, assigned by
-- the database on insert from one sequence, orders any rows whose instants still tie, instead of a
-- random event reference. Append-only like the row: the existing guards refuse every UPDATE and DELETE,
-- and a BEFORE INSERT trigger overwrites any caller-supplied value, so the runtime role cannot choose a
-- position. The runtime role still cannot read audit_events (20261202500000); `seq` is never exposed.

CREATE SEQUENCE cuspatlas.audit_events_seq AS bigint;
REVOKE ALL ON SEQUENCE cuspatlas.audit_events_seq FROM PUBLIC;

-- Existing rows are numbered by the table rewrite (no row trigger fires), then new rows by the trigger.
ALTER TABLE cuspatlas.audit_events ADD COLUMN seq bigint DEFAULT nextval('cuspatlas.audit_events_seq');
ALTER TABLE cuspatlas.audit_events ALTER COLUMN seq DROP DEFAULT;
ALTER TABLE cuspatlas.audit_events ALTER COLUMN seq SET NOT NULL;
ALTER TABLE cuspatlas.audit_events ADD CONSTRAINT audit_events_seq_key UNIQUE (seq);

CREATE FUNCTION cuspatlas.audit_events_assign_seq() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  BEGIN
    NEW.seq := nextval('cuspatlas.audit_events_seq');
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.audit_events_assign_seq() FROM PUBLIC;
CREATE TRIGGER audit_events_assign_seq BEFORE INSERT ON cuspatlas.audit_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.audit_events_assign_seq();

-- The agent-audit stream carries the same sequence (copied by the definer trigger) for its readers.
ALTER TABLE cuspatlas.agent_audit_events ADD COLUMN seq bigint;
-- One-time backfill from the source rows: the append-only guard is lifted only inside this migration.
ALTER TABLE cuspatlas.agent_audit_events DISABLE TRIGGER agent_audit_events_guard;
UPDATE cuspatlas.agent_audit_events g SET seq = a.seq FROM cuspatlas.audit_events a WHERE a.event_ref = g.event_ref;
ALTER TABLE cuspatlas.agent_audit_events ENABLE TRIGGER agent_audit_events_guard;
ALTER TABLE cuspatlas.agent_audit_events ALTER COLUMN seq SET NOT NULL;
ALTER TABLE cuspatlas.agent_audit_events ADD CONSTRAINT agent_audit_events_seq_key UNIQUE (seq);
DROP INDEX cuspatlas.agent_audit_events_agent;
CREATE INDEX agent_audit_events_agent ON cuspatlas.agent_audit_events (tenant_id, agent_ref, occurred_at, seq);

CREATE OR REPLACE FUNCTION cuspatlas.agent_audit_copy() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  BEGIN
    INSERT INTO cuspatlas.agent_audit_events (event_ref, tenant_id, agent_ref, sponsor_ref, sponsorship_ref,
        operation, resource_type, resource_ref, resource_version, correlation_id, occurred_at, seq)
      SELECT NEW.event_ref, NEW.tenant_id, a.principal_id, s.sponsor_ref, s.id, NEW.operation,
        NEW.resource_type, NEW.resource_ref, NEW.resource_version, NEW.correlation_id, NEW.occurred_at, NEW.seq
      FROM cuspatlas.agent_principals a JOIN cuspatlas.agent_sponsorships s ON s.id = a.sponsorship_ref
      WHERE a.principal_id = NEW.actor_id AND a.tenant_id = NEW.tenant_id;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_audit_copy() FROM PUBLIC;

-- The admin audit search: committed changes tie-break on seq (other sources have none and fall back to
-- their event reference). Same signature and checks as 20261202010000.
CREATE OR REPLACE FUNCTION cuspatlas.admin_audit_search(p_sources text[], p_actor uuid, p_principal text,
    p_operation text, p_from timestamptz, p_to timestamptz, p_limit integer)
  RETURNS TABLE (source text, event_ref uuid, occurred_at timestamptz, actor_id uuid, principal text, operation text,
    resource_type text, resource_ref uuid, reason_code text, result_count integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  BEGIN
    IF cuspatlas.current_tenant_id() IS NULL OR NOT cuspatlas.admin_caller_has('audit.read') THEN
      RAISE EXCEPTION 'audit search not permitted' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT x.source, x.event_ref, x.occurred_at, x.actor_id, x.principal, x.operation, x.resource_type,
      x.resource_ref, x.reason_code, x.result_count
    FROM (
      SELECT 'committed_change'::text, a.event_ref, a.occurred_at, a.actor_id, a.principal, a.operation, a.resource_type,
        a.resource_ref, NULL::text, NULL::integer, a.seq
      FROM cuspatlas.audit_events a
      WHERE 'committed_change' = ANY (p_sources) AND a.tenant_id = cuspatlas.current_tenant_id()
        AND (p_actor IS NULL OR a.actor_id = p_actor) AND (p_principal IS NULL OR a.principal = p_principal)
        AND (p_operation IS NULL OR a.operation = p_operation)
        AND (p_from IS NULL OR a.occurred_at >= p_from) AND (p_to IS NULL OR a.occurred_at < p_to)
      UNION ALL
      SELECT 'security_attempt'::text, s.attempt_ref, s.occurred_at, s.actor_id, NULL::text, s.operation, NULL::text,
        NULL::uuid, s.reason_code, NULL::integer, NULL::bigint
      FROM cuspatlas.security_attempt_events s
      WHERE 'security_attempt' = ANY (p_sources) AND s.tenant_id = cuspatlas.current_tenant_id()
        AND (p_actor IS NULL OR s.actor_id = p_actor) AND p_principal IS NULL
        AND (p_operation IS NULL OR s.operation = p_operation)
        AND (p_from IS NULL OR s.occurred_at >= p_from) AND (p_to IS NULL OR s.occurred_at < p_to)
      UNION ALL
      SELECT 'sensitive_read'::text, r.event_ref, r.occurred_at, r.actor_id, r.principal, r.operation, r.resource_type,
        NULL::uuid, NULL::text, r.result_count, NULL::bigint
      FROM cuspatlas.sensitive_read_events r
      WHERE 'sensitive_read' = ANY (p_sources) AND r.tenant_id = cuspatlas.current_tenant_id()
        AND (p_actor IS NULL OR r.actor_id = p_actor) AND (p_principal IS NULL OR r.principal = p_principal)
        AND (p_operation IS NULL OR r.operation = p_operation)
        AND (p_from IS NULL OR r.occurred_at >= p_from) AND (p_to IS NULL OR r.occurred_at < p_to)
    ) x (source, event_ref, occurred_at, actor_id, principal, operation, resource_type, resource_ref, reason_code,
         result_count, seq)
    ORDER BY x.occurred_at DESC, x.seq DESC NULLS LAST, x.event_ref DESC
    LIMIT least(greatest(p_limit, 1), 201);
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.admin_audit_search(text[], uuid, text, text, timestamptz, timestamptz, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.admin_audit_search(text[], uuid, text, text, timestamptz, timestamptz, integer)
  TO cuspatlas_app;
