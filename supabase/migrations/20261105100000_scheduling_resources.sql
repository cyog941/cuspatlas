-- S7: scheduling locations, resources, effective-dated availability, time blocks and the occupancy
-- table whose exclusion constraint is the database authority against overlapping use of one resource.
-- Synthetic data only. Tenant and actor come from the transaction-local context; RLS is enabled and
-- forced on every table; the runtime role receives explicit grants and no DELETE anywhere.

-- btree_gist provides the `=` operator class for uuid inside a GiST exclusion constraint. It is a
-- trusted contrib extension (available in the embedded PostgreSQL 17 build and on Supabase), kept
-- out of the application schema.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- Reserved appointment-state vocabulary (scheduling-state-labels.1). A resource label that names a
-- state is the pseudo-operatory workaround (docs/TAB32-STATUS-VOCABULARIES.md) and is refused.
-- Terms are compared after normalization: lower case, a leading ordinal ("8.", "9)") removed,
-- punctuation collapsed to spaces, trailing generic words (appts, appointments, list, column, queue,
-- bucket, status) removed, spaces removed.
CREATE FUNCTION cuspatlas.scheduling_state_terms() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT ARRAY[
    'scheduled', 'unscheduled', 'confirmed', 'confirmed auto', 'auto confirmed', 'checked in', 'check in',
    'curbside', 'curbside check in', 'in chair', 'waiting', 'late', 'no show', 'no shows', 'left without treatment',
    'lwt', 'canceled', 'cancelled', 'cancellation', 'cancellations', 'cancel', 'reschedule', 'rescheduled',
    'treatment complete', 'complete', 'completed', 'billed', 'checked out', 'check out', 'asap', 'broken',
    'pending', 'arrived', 'in progress', 'all', 'deleted', 'void'
  ]::text[] $$;

CREATE FUNCTION cuspatlas.scheduling_label_words(label text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT btrim(regexp_replace(
    regexp_replace(lower(coalesce(label, '')), '^\s*[0-9]+\s*[.):-]?\s*', ''),
    '[^a-z0-9]+', ' ', 'g')) $$;

-- The term a label equals (constraint), or NULL.
CREATE FUNCTION cuspatlas.scheduling_reserved_label(label text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT t FROM unnest(cuspatlas.scheduling_state_terms()) AS t
    WHERE label IS NOT NULL
      AND replace(t, ' ', '') = replace(regexp_replace(cuspatlas.scheduling_label_words(label),
        '( (appts?|appointments?|list|column|queue|bucket|status))+$', ''), ' ', '')
    ORDER BY t LIMIT 1 $$;

-- The first term a label contains as whole words (data-quality "resembles" check), or NULL.
CREATE FUNCTION cuspatlas.scheduling_resembles_state_label(label text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT t FROM unnest(cuspatlas.scheduling_state_terms()) AS t
    WHERE label IS NOT NULL
      AND (position(' ' || t || ' ' IN ' ' || cuspatlas.scheduling_label_words(label) || ' ') > 0
        OR position(' ' || replace(t, ' ', '') || ' ' IN ' ' || cuspatlas.scheduling_label_words(label) || ' ') > 0)
    ORDER BY length(t) DESC, t LIMIT 1 $$;

REVOKE ALL ON FUNCTION cuspatlas.scheduling_state_terms(), cuspatlas.scheduling_label_words(text),
  cuspatlas.scheduling_reserved_label(text), cuspatlas.scheduling_resembles_state_label(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.scheduling_state_terms(), cuspatlas.scheduling_label_words(text),
  cuspatlas.scheduling_reserved_label(text), cuspatlas.scheduling_resembles_state_label(text) TO cuspatlas_app;

CREATE TABLE cuspatlas.scheduling_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  -- Same reference space as memberships.location_refs, so location policy applies directly.
  location_ref text NOT NULL CHECK (location_ref ~ '^[a-z0-9-]{1,64}$'),
  display_label text NOT NULL CHECK (char_length(display_label) BETWEEN 1 AND 80),
  -- IANA zone name; the domain additionally requires the server's zone database to know it.
  time_zone text NOT NULL CHECK (char_length(time_zone) <= 64
    AND time_zone ~ '^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2})$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, location_ref),
  UNIQUE (id, tenant_id)
);

CREATE TABLE cuspatlas.scheduling_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  -- Declared kind; never inferred from a label. No kind represents an appointment state.
  kind text NOT NULL CHECK (kind IN ('provider', 'operatory', 'equipment', 'staff')),
  -- Mutable display text: never identity, never ordering.
  display_label text CHECK (display_label IS NULL OR char_length(display_label) BETWEEN 1 AND 80),
  display_order integer NOT NULL DEFAULT 0 CHECK (display_order BETWEEN 0 AND 9999),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  deactivated_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_resources_status_instant CHECK ((status = 'inactive') = (deactivated_at IS NOT NULL)),
  CONSTRAINT scheduling_resources_no_state_label CHECK (cuspatlas.scheduling_reserved_label(display_label) IS NULL),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (id, location_id, tenant_id)
);
CREATE INDEX scheduling_resources_location ON cuspatlas.scheduling_resources (tenant_id, location_id, kind);

-- Effective-dated, append-only weekly hours. A version applies from effective_from until the next
-- version's effective_from; it is never rewritten. The zone is the location's zone when recorded.
CREATE TABLE cuspatlas.scheduling_availability_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  effective_from date NOT NULL,
  time_zone text NOT NULL CHECK (char_length(time_zone) <= 64
    AND time_zone ~ '^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2})$'),
  weekly jsonb NOT NULL CHECK (jsonb_typeof(weekly) = 'array' AND jsonb_array_length(weekly) <= 28),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (resource_id, tenant_id) REFERENCES cuspatlas.scheduling_resources (id, tenant_id),
  UNIQUE (tenant_id, resource_id, effective_from)
);

-- A window of unavailable time with a reason and no patient. resource_count = 0 is a location-wide
-- block (for example a holiday); otherwise one occupancy row exists per blocked resource.
CREATE TABLE cuspatlas.scheduling_time_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  time_zone text NOT NULL CHECK (char_length(time_zone) <= 64
    AND time_zone ~ '^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2})$'),
  reason_code text NOT NULL
    CHECK (reason_code IN ('meeting', 'maintenance', 'training', 'holiday', 'lunch', 'personal', 'other')),
  resource_count integer NOT NULL CHECK (resource_count BETWEEN 0 AND 20),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at AND ends_at - starts_at <= interval '14 days'),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  UNIQUE (id, tenant_id)
);
CREATE INDEX scheduling_time_blocks_location ON cuspatlas.scheduling_time_blocks (tenant_id, location_id, starts_at);

-- Occupancy of one resource over a half-open instant range. Time blocks write rows now; S10 adds
-- holds and appointments as further source kinds through the same table, so one exclusion constraint
-- decides every overlap. Released rows (S10) stop occupying.
CREATE TABLE cuspatlas.scheduling_occupancy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  location_id uuid NOT NULL,
  during tstzrange NOT NULL CHECK (NOT isempty(during) AND lower_inc(during) AND NOT upper_inc(during)
    AND NOT lower_inf(during) AND NOT upper_inf(during)),
  source_kind text NOT NULL CHECK (source_kind IN ('time_block', 'hold', 'appointment')),
  source_id uuid NOT NULL,
  released_at timestamptz,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (resource_id, location_id, tenant_id)
    REFERENCES cuspatlas.scheduling_resources (id, location_id, tenant_id),
  UNIQUE (tenant_id, source_kind, source_id, resource_id),
  CONSTRAINT scheduling_occupancy_no_overlap
    EXCLUDE USING gist (tenant_id WITH =, resource_id WITH =, during WITH &&) WHERE (released_at IS NULL)
);
CREATE INDEX scheduling_occupancy_source ON cuspatlas.scheduling_occupancy (tenant_id, source_kind, source_id);

-- The busy-interval seam read by availability search (S9) and by booking rechecks (S10). It runs
-- with the caller's privileges (security_invoker), so RLS of the underlying tables applies.
-- resource_id NULL = location-wide time block.
CREATE VIEW cuspatlas.scheduling_busy WITH (security_invoker = true) AS
  SELECT o.tenant_id, o.location_id, o.resource_id, o.during, o.source_kind, o.source_id
  FROM cuspatlas.scheduling_occupancy o WHERE o.released_at IS NULL
  UNION ALL
  SELECT b.tenant_id, b.location_id, NULL::uuid, tstzrange(b.starts_at, b.ends_at, '[)'), 'time_block', b.id
  FROM cuspatlas.scheduling_time_blocks b WHERE b.resource_count = 0;

-- A deactivated resource stays deactivated; location and identity never move.
CREATE FUNCTION cuspatlas.scheduling_resources_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'inactive' AND NEW.status <> 'inactive' THEN
    RAISE EXCEPTION 'resource reactivation is not a permitted transition' USING ERRCODE = '42501';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'resource version must increase by one' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER scheduling_resources_guard BEFORE UPDATE ON cuspatlas.scheduling_resources
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.scheduling_resources_guard();

CREATE FUNCTION cuspatlas.scheduling_locations_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'location version must increase by one' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER scheduling_locations_guard BEFORE UPDATE ON cuspatlas.scheduling_locations
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.scheduling_locations_guard();

REVOKE ALL ON FUNCTION cuspatlas.scheduling_resources_guard(), cuspatlas.scheduling_locations_guard() FROM PUBLIC;

ALTER TABLE cuspatlas.scheduling_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_locations FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_resources FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_availability_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_availability_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_time_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_time_blocks FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_occupancy ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.scheduling_occupancy FORCE ROW LEVEL SECURITY;

CREATE POLICY scheduling_locations_select ON cuspatlas.scheduling_locations
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY scheduling_locations_insert ON cuspatlas.scheduling_locations
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY scheduling_locations_update ON cuspatlas.scheduling_locations
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY scheduling_resources_select ON cuspatlas.scheduling_resources
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY scheduling_resources_insert ON cuspatlas.scheduling_resources
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY scheduling_resources_update ON cuspatlas.scheduling_resources
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY scheduling_availability_versions_select ON cuspatlas.scheduling_availability_versions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY scheduling_availability_versions_insert ON cuspatlas.scheduling_availability_versions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());

CREATE POLICY scheduling_time_blocks_select ON cuspatlas.scheduling_time_blocks
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY scheduling_time_blocks_insert ON cuspatlas.scheduling_time_blocks
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());

CREATE POLICY scheduling_occupancy_select ON cuspatlas.scheduling_occupancy
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY scheduling_occupancy_insert ON cuspatlas.scheduling_occupancy
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());

-- Explicit grants. No DELETE or TRUNCATE; availability versions, time blocks and occupancy are
-- insert-only for now (S10 adds the occupancy release column grant together with its command).
GRANT SELECT, INSERT ON cuspatlas.scheduling_locations, cuspatlas.scheduling_resources,
  cuspatlas.scheduling_availability_versions, cuspatlas.scheduling_time_blocks,
  cuspatlas.scheduling_occupancy TO cuspatlas_app;
GRANT UPDATE (time_zone, version, updated_at) ON cuspatlas.scheduling_locations TO cuspatlas_app;
GRANT UPDATE (status, deactivated_at, version, updated_at) ON cuspatlas.scheduling_resources TO cuspatlas_app;
GRANT SELECT ON cuspatlas.scheduling_busy TO cuspatlas_app;
