-- Closeout A2 (M8 runbook gap; synthetic only; nothing is deployed). Downtime windows and the paper
-- records transcribed for them. A window covers the tenant or a set of membership location refs; at most
-- one open window covers any scope (a tenant-wide window overlaps every location). A logged entry is never
-- applied by this log: it stays pending_review until a human reviewer links the owning command that applied
-- it (operation, resource and correlation of a committed audit event of this tenant), rejects it with a
-- reason code or marks it superseded by another entry. Entries are append-only except that one review
-- transition; windows change only by ending. The runtime role has column-level UPDATE on exactly those
-- fields, no DELETE, and guard triggers refuse every other change for every role.
CREATE TABLE cuspatlas.ops_downtime_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  scope_kind text NOT NULL CHECK (scope_kind IN ('tenant', 'locations')),
  location_refs text[] NOT NULL DEFAULT '{}',
  CHECK ((scope_kind = 'tenant') = (cardinality(location_refs) = 0)),
  CHECK (cardinality(location_refs) <= 20),
  CHECK (cardinality(location_refs) = 0
    OR array_to_string(location_refs, ',') ~ '^[a-z0-9-]{1,64}(,[a-z0-9-]{1,64})*$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'ended')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  started_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  ended_by uuid REFERENCES cuspatlas.principals (id),
  CHECK ((state = 'ended') = (ended_at IS NOT NULL)),
  CHECK ((ended_at IS NULL) = (ended_by IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX ops_downtime_windows_one_open_tenant ON cuspatlas.ops_downtime_windows (tenant_id)
  WHERE state = 'open' AND scope_kind = 'tenant';
CREATE INDEX ops_downtime_windows_open ON cuspatlas.ops_downtime_windows (tenant_id, state, started_at);

CREATE TABLE cuspatlas.ops_downtime_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  window_id uuid NOT NULL,
  FOREIGN KEY (tenant_id, window_id) REFERENCES cuspatlas.ops_downtime_windows (tenant_id, id),
  entry_kind text NOT NULL CHECK (entry_kind IN ('appointment_booking', 'attendance', 'payment', 'clinical_note',
    'patient_registration', 'other')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 8192),
  paper_ref text NOT NULL CHECK (paper_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$'),
  captured_at timestamptz NOT NULL,
  logged_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  logged_at timestamptz NOT NULL DEFAULT now(),
  review_state text NOT NULL DEFAULT 'pending_review'
    CHECK (review_state IN ('pending_review', 'applied', 'rejected', 'superseded')),
  reviewed_by uuid REFERENCES cuspatlas.principals (id),
  reviewed_at timestamptz,
  applied_operation text CHECK (applied_operation ~ '^[a-z][A-Za-z]{0,40}(\.[a-z][A-Za-z]{0,40}){0,3}$'),
  applied_resource_ref uuid,
  applied_correlation_id uuid,
  rejection_reason text CHECK (rejection_reason ~ '^[a-z_]{1,64}$'),
  superseded_by uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, superseded_by) REFERENCES cuspatlas.ops_downtime_entries (tenant_id, id),
  CHECK (superseded_by IS NULL OR superseded_by <> id),
  CHECK ((review_state = 'pending_review') = (reviewed_by IS NULL)),
  CHECK ((review_state = 'pending_review') = (reviewed_at IS NULL)),
  CHECK ((review_state = 'applied') = (applied_operation IS NOT NULL)),
  CHECK ((applied_operation IS NULL) = (applied_resource_ref IS NULL)),
  CHECK ((applied_operation IS NULL) = (applied_correlation_id IS NULL)),
  CHECK ((review_state = 'rejected') = (rejection_reason IS NOT NULL)),
  CHECK ((review_state = 'superseded') = (superseded_by IS NOT NULL))
);
CREATE INDEX ops_downtime_entries_worklist ON cuspatlas.ops_downtime_entries (tenant_id, review_state, captured_at);
CREATE INDEX ops_downtime_entries_window ON cuspatlas.ops_downtime_entries (tenant_id, window_id);
-- One committed owning command applies at most one downtime entry.
CREATE UNIQUE INDEX ops_downtime_entries_applied_once ON cuspatlas.ops_downtime_entries
  (tenant_id, applied_operation, applied_resource_ref, applied_correlation_id) WHERE review_state = 'applied';

-- Whether a committed change of the CURRENT tenant matches the reviewer's link: the operation, the resource
-- and the request correlation of one audit event recorded after the entry was logged. The runtime role
-- cannot read audit rows (20261202500000); this definer answers one boolean and rechecks a live human
-- membership with migration.write (the review scope), so it discloses nothing to anyone else.
CREATE FUNCTION cuspatlas.ops_downtime_command_exists(p_operation text, p_resource_ref uuid, p_correlation uuid,
    p_after timestamptz) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT cuspatlas.current_tenant_id() IS NOT NULL AND cuspatlas.admin_caller_has('migration.write')
      AND EXISTS (
        SELECT 1 FROM cuspatlas.audit_events a
        WHERE a.tenant_id = cuspatlas.current_tenant_id() AND a.operation = p_operation
          AND a.resource_ref = p_resource_ref AND a.correlation_id = p_correlation AND a.occurred_at >= p_after)
  $$;
REVOKE ALL ON FUNCTION cuspatlas.ops_downtime_command_exists(text, uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.ops_downtime_command_exists(text, uuid, uuid, timestamptz) TO cuspatlas_app;

-- One open window per scope, serialized per tenant: a tenant-wide window overlaps every location window.
CREATE FUNCTION cuspatlas.ops_downtime_windows_insert_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  BEGIN
    IF NEW.state <> 'open' OR NEW.ended_at IS NOT NULL OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'a downtime window starts open' USING ERRCODE = '42501';
    END IF;
    IF NEW.started_at > now() THEN
      RAISE EXCEPTION 'a downtime window cannot start in the future' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('cuspatlas.ops_downtime:' || NEW.tenant_id::text, 0));
    IF EXISTS (
      SELECT 1 FROM cuspatlas.ops_downtime_windows w
      WHERE w.tenant_id = NEW.tenant_id AND w.state = 'open'
        AND (w.scope_kind = 'tenant' OR NEW.scope_kind = 'tenant' OR w.location_refs && NEW.location_refs)
    ) THEN
      RAISE EXCEPTION 'a downtime window is already open for this scope' USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER ops_downtime_windows_insert BEFORE INSERT ON cuspatlas.ops_downtime_windows
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.ops_downtime_windows_insert_guard();

-- A window only ends (open -> ended, one version step); nothing else about it ever changes.
CREATE FUNCTION cuspatlas.ops_downtime_windows_update_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'downtime windows are never deleted' USING ERRCODE = '42501';
    END IF;
    IF OLD.state <> 'open' OR NEW.state <> 'ended' OR NEW.version <> OLD.version + 1
      OR (NEW.id, NEW.tenant_id, NEW.scope_kind, NEW.location_refs, NEW.reason_code, NEW.started_at, NEW.started_by,
          NEW.recorded_at)
        IS DISTINCT FROM
         (OLD.id, OLD.tenant_id, OLD.scope_kind, OLD.location_refs, OLD.reason_code, OLD.started_at, OLD.started_by,
          OLD.recorded_at)
      OR NEW.ended_at > now() THEN
      RAISE EXCEPTION 'a downtime window only ends, once' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER ops_downtime_windows_update BEFORE UPDATE OR DELETE ON cuspatlas.ops_downtime_windows
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.ops_downtime_windows_update_guard();

-- An entry is logged pending review, against an open window or one ended within the 14-day transcription
-- grace, captured inside the window bounds and not in the future.
CREATE FUNCTION cuspatlas.ops_downtime_entries_insert_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  DECLARE
    w record;
  BEGIN
    IF NEW.review_state <> 'pending_review' OR NEW.version <> 1 OR NEW.reviewed_by IS NOT NULL
      OR NEW.applied_operation IS NOT NULL OR NEW.rejection_reason IS NOT NULL OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION 'a downtime entry is logged pending review' USING ERRCODE = '42501';
    END IF;
    SELECT state, started_at, ended_at INTO w FROM cuspatlas.ops_downtime_windows
      WHERE tenant_id = NEW.tenant_id AND id = NEW.window_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'downtime window not found' USING ERRCODE = '23503';
    END IF;
    IF w.state = 'ended' AND w.ended_at < now() - interval '14 days' THEN
      RAISE EXCEPTION 'the downtime window is closed for logging' USING ERRCODE = '23514';
    END IF;
    IF NEW.captured_at < w.started_at OR NEW.captured_at > coalesce(w.ended_at, now()) OR NEW.captured_at > now() THEN
      RAISE EXCEPTION 'captured outside the downtime window' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER ops_downtime_entries_insert BEFORE INSERT ON cuspatlas.ops_downtime_entries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.ops_downtime_entries_insert_guard();

-- The one review transition: pending_review -> applied | rejected | superseded, one version step, nothing
-- transcribed changes, and an applied link must name a committed command of this tenant.
CREATE FUNCTION cuspatlas.ops_downtime_entries_update_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'downtime entries are never deleted' USING ERRCODE = '42501';
    END IF;
    IF OLD.review_state <> 'pending_review' OR NEW.review_state = 'pending_review'
      OR NEW.version <> OLD.version + 1
      OR (NEW.id, NEW.tenant_id, NEW.window_id, NEW.entry_kind, NEW.summary, NEW.payload, NEW.paper_ref,
          NEW.captured_at, NEW.logged_by, NEW.logged_at)
        IS DISTINCT FROM
         (OLD.id, OLD.tenant_id, OLD.window_id, OLD.entry_kind, OLD.summary, OLD.payload, OLD.paper_ref,
          OLD.captured_at, OLD.logged_by, OLD.logged_at) THEN
      RAISE EXCEPTION 'a downtime entry is reviewed once and never rewritten' USING ERRCODE = '42501';
    END IF;
    IF NEW.review_state = 'applied' AND NOT cuspatlas.ops_downtime_command_exists(NEW.applied_operation,
        NEW.applied_resource_ref, NEW.applied_correlation_id, OLD.logged_at) THEN
      RAISE EXCEPTION 'the linked command is not a committed change of this tenant' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER ops_downtime_entries_update BEFORE UPDATE OR DELETE ON cuspatlas.ops_downtime_entries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.ops_downtime_entries_update_guard();

ALTER TABLE cuspatlas.ops_downtime_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.ops_downtime_windows FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.ops_downtime_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.ops_downtime_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY ops_downtime_windows_select ON cuspatlas.ops_downtime_windows
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY ops_downtime_windows_insert ON cuspatlas.ops_downtime_windows
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND started_by = cuspatlas.current_actor_id());
CREATE POLICY ops_downtime_windows_update ON cuspatlas.ops_downtime_windows
  FOR UPDATE TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND ended_by = cuspatlas.current_actor_id());
CREATE POLICY ops_downtime_entries_select ON cuspatlas.ops_downtime_entries
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY ops_downtime_entries_insert ON cuspatlas.ops_downtime_entries
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND logged_by = cuspatlas.current_actor_id());
CREATE POLICY ops_downtime_entries_update ON cuspatlas.ops_downtime_entries
  FOR UPDATE TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND reviewed_by = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.ops_downtime_windows TO cuspatlas_app;
GRANT UPDATE (state, ended_at, ended_by, version, updated_at) ON cuspatlas.ops_downtime_windows TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.ops_downtime_entries TO cuspatlas_app;
GRANT UPDATE (review_state, reviewed_by, reviewed_at, applied_operation, applied_resource_ref, applied_correlation_id,
  rejection_reason, superseded_by, version) ON cuspatlas.ops_downtime_entries TO cuspatlas_app;
