-- S4: patient identity core. Synthetic data only (see AGENTS.md); decisions per ADR 0003, which is
-- recommended-pending-approval. Tenant-wide identity (S-D8). Applied by the privileged migration role.
-- The runtime role cuspatlas_app gets explicit grants only; RLS is enabled and forced everywhere.
-- Contact values live only in cuspatlas.patients: audit, outbox, attempts, idempotency rows and the
-- sensitive-read log carry references, versions and field names, never values.

-- Field groups are objects with a boolean "known"; an unknown group carries a reason. Empty strings
-- anywhere in a group are refused, so "unknown" can never be stored as "" that reads as "none".
CREATE FUNCTION cuspatlas.patient_group_valid(g jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT jsonb_typeof(g) = 'object'
      AND jsonb_typeof(g -> 'known') = 'boolean'
      AND (
        (g ->> 'known')::boolean
        OR (g ->> 'reason' IN ('not_provided', 'declined', 'not_applicable', 'unavailable')
            AND (SELECT count(*) FROM jsonb_object_keys(g)) = 2)
      )
      AND NOT jsonb_path_exists(g, 'strict $.** ? (@.type() == "string" && @ == "")')
  $$;

-- Field names only (outbox/sensitive-read classification): never values.
CREATE FUNCTION cuspatlas.field_names_valid(names text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT coalesce(bool_and(n ~ '^[a-z][A-Za-z]{0,63}$'), true) AND coalesce(cardinality(names), 0) <= 16
    FROM unnest(names) AS n
  $$;

-- Generic append-only guard for the history and log tables below (every role that cannot disable
-- triggers, the runtime role included; not a defence against the owner or a superuser).
CREATE FUNCTION cuspatlas.append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'table is append-only' USING ERRCODE = '42501'; END $$;

REVOKE ALL ON FUNCTION cuspatlas.patient_group_valid(jsonb), cuspatlas.field_names_valid(text[]),
  cuspatlas.append_only() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.patient_group_valid(jsonb), cuspatlas.field_names_valid(text[])
  TO cuspatlas_app;

CREATE TABLE cuspatlas.patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  legal_name jsonb NOT NULL CHECK (cuspatlas.patient_group_valid(legal_name)),
  preferred_name jsonb NOT NULL CHECK (cuspatlas.patient_group_valid(preferred_name)),
  pronouns jsonb NOT NULL CHECK (cuspatlas.patient_group_valid(pronouns)),
  language jsonb NOT NULL CHECK (cuspatlas.patient_group_valid(language)),
  contact jsonb NOT NULL CHECK (cuspatlas.patient_group_valid(contact)),
  address jsonb NOT NULL CHECK (cuspatlas.patient_group_valid(address)),
  -- Birth date with explicit precision. A month or year precision date is stored as its first day.
  birth_date date,
  birth_date_precision text NOT NULL CHECK (birth_date_precision IN ('day', 'month', 'year', 'unknown')),
  birth_date_unknown_reason text
    CHECK (birth_date_unknown_reason IN ('not_provided', 'declined', 'not_applicable', 'unavailable')),
  time_zone text CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]{0,30}(/[A-Za-z0-9_+-]{1,30}){0,2}$'),
  identifiers jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(identifiers) = 'array' AND jsonb_array_length(identifiers) <= 10),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  home_location_ref text CHECK (home_location_ref ~ '^[a-z0-9-]{1,64}$'),
  -- Normalized search columns (NULL when the name is unknown) and SHA-256 match keys of normalized
  -- name, birth date, phone, email, address and identifiers (never plaintext copies).
  search_family text CHECK (search_family <> ''),
  search_given text CHECK (search_given <> ''),
  match_keys text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(match_keys) <= 32),
  contactable boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'inactive', 'deceased')),
  status_effective_at timestamptz NOT NULL,
  merged_into uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CHECK ((birth_date_precision = 'unknown') = (birth_date IS NULL)),
  CHECK ((birth_date_precision = 'unknown') = (birth_date_unknown_reason IS NOT NULL)),
  CHECK (merged_into IS NULL OR merged_into <> id),
  -- A merged patient points at a survivor of the same tenant.
  FOREIGN KEY (merged_into, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id)
);
CREATE INDEX patients_tenant_id_id ON cuspatlas.patients (tenant_id, id);
CREATE INDEX patients_search_family ON cuspatlas.patients (tenant_id, search_family text_pattern_ops);
CREATE INDEX patients_search_given ON cuspatlas.patients (tenant_id, search_given text_pattern_ops);
CREATE INDEX patients_birth_date ON cuspatlas.patients (tenant_id, birth_date);
CREATE INDEX patients_match_keys ON cuspatlas.patients USING gin (match_keys);

-- Effective-dated status facts. A status change appends a row; nothing is deleted or rewritten.
CREATE TABLE cuspatlas.patient_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  patient_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'inactive', 'deceased')),
  effective_at timestamptz NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  patient_version integer NOT NULL CHECK (patient_version >= 1),
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  UNIQUE (patient_id, patient_version)
);
CREATE TRIGGER patient_status_history_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.patient_status_history
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- Sensitive-read log (S4): who read or searched which patients. References and field names only.
-- Inserted in the same transaction as the read, so a read that cannot be logged fails closed.
CREATE TABLE cuspatlas.sensitive_read_events (
  event_ref uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  principal text NOT NULL CHECK (principal IN ('human', 'service')),
  operation text NOT NULL CHECK (operation ~ '^[a-z][A-Za-z]{0,40}(\.[a-z][A-Za-z]{0,40}){0,3}$'),
  resource_type text NOT NULL CHECK (resource_type ~ '^[a-z][A-Za-z]{0,63}$'),
  resource_refs uuid[] NOT NULL CHECK (cardinality(resource_refs) <= 100),
  result_count integer NOT NULL CHECK (result_count >= 0 AND result_count <= 100),
  query_fields text[] NOT NULL CHECK (cuspatlas.field_names_valid(query_fields)),
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sensitive_read_events_correlation ON cuspatlas.sensitive_read_events (correlation_id);
CREATE TRIGGER sensitive_read_events_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.sensitive_read_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.patients FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.patient_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.patient_status_history FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.sensitive_read_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.sensitive_read_events FORCE ROW LEVEL SECURITY;

CREATE POLICY patients_select ON cuspatlas.patients
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY patients_insert ON cuspatlas.patients
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY patients_update ON cuspatlas.patients
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

CREATE POLICY patient_status_history_select ON cuspatlas.patient_status_history
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY patient_status_history_insert ON cuspatlas.patient_status_history
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());

CREATE POLICY sensitive_read_events_select ON cuspatlas.sensitive_read_events
  FOR SELECT TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY sensitive_read_events_insert ON cuspatlas.sensitive_read_events
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());

-- Explicit grants. No DELETE or TRUNCATE anywhere; identity, tenant and creator are not updatable.
GRANT SELECT, INSERT ON cuspatlas.patients TO cuspatlas_app;
GRANT UPDATE (legal_name, preferred_name, pronouns, language, contact, address, birth_date,
  birth_date_precision, birth_date_unknown_reason, time_zone, identifiers, provenance, home_location_ref,
  search_family, search_given, match_keys, contactable, status, status_effective_at, merged_into, version,
  updated_at) ON cuspatlas.patients TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.patient_status_history TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.sensitive_read_events TO cuspatlas_app;
