-- Closeout D review fixes (synthetic engineering implementation, recommended-pending-approval): agent memory
-- becomes a genuine positive allowlist. Closeout D5 classified a non-phi value by grammar only, so a
-- name-shaped code ("maria.garcia"), a name-shaped operation, a free-text key ("jane.doe.prefers...") or an
-- MRN-sized counter could still be written. Now:
--   * keys are namespaced: <registered prefix>.<suffix>, the suffix a registered code, a catalog operation or
--     a UUID reference (every classification, phi included, since keys are listed without values);
--   * a `code` value is a registered code (the state vocabularies plus a small declared set);
--   * an `operation` value is a catalog operation id;
--   * a `counter` is at most 4 digits (-9999..9999);
--   * an `instant` is not earlier than the tenant's creation, so a birth date before it cannot be stored.
-- The registry is seeded by the migrator (packages/db/src/migrate.ts) from @cuspatlas/contracts
-- (memoryRegistryRows) after every migration run; nothing else writes it. Residual risk, stated in the
-- contracts module and the hand-off: a short counter can coincide with a short identifier, a reference or
-- instant can carry deliberately encoded bits, and an instant after the tenant's creation can be a newborn's
-- birth date. NOT VALID / new-row triggers as before: existing synthetic rows are not rechecked.
CREATE TABLE cuspatlas.agent_memory_registry (
  kind text NOT NULL CHECK (kind IN ('key_prefix', 'code', 'operation')),
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 64 AND value ~ '^[a-z][A-Za-z0-9._:-]*$'),
  PRIMARY KEY (kind, value)
);
ALTER TABLE cuspatlas.agent_memory_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.agent_memory_registry FORCE ROW LEVEL SECURITY;
-- Public reference data (no tenant, no patient data): readable by everyone, written only by the migrator.
CREATE POLICY agent_memory_registry_read ON cuspatlas.agent_memory_registry FOR SELECT USING (true);
GRANT SELECT ON cuspatlas.agent_memory_registry TO cuspatlas_app;

-- Keys: the namespace grammar (registered prefix and suffix are checked by the trigger below).
ALTER TABLE cuspatlas.agent_memory_entries DROP CONSTRAINT agent_memory_entries_key_check;
ALTER TABLE cuspatlas.agent_memory_entries ADD CONSTRAINT agent_memory_entries_key_namespaced CHECK (
  char_length(key) <= 64 AND key ~ '^[a-z]{1,16}\.[A-Za-z0-9._:-]{1,63}$'
) NOT VALID;

-- Values: the D5 grammar again, with the counter bounded to at most 4 digits. Code and operation keep the
-- grammar here; membership in the registry is checked by the trigger below.
ALTER TABLE cuspatlas.agent_memory_entries DROP CONSTRAINT agent_memory_entries_value_structured;
ALTER TABLE cuspatlas.agent_memory_entries ADD CONSTRAINT agent_memory_entries_value_structured CHECK (
  classification = 'phi' OR CASE value_kind
    WHEN 'code' THEN char_length(value) <= 64 AND value ~ '^[a-z][a-z0-9]*([._:-][a-z0-9]+){0,7}$'
    WHEN 'counter' THEN value ~ '^-?[0-9]{1,4}$'
    WHEN 'flag' THEN value IN ('true', 'false')
    WHEN 'instant' THEN value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
    WHEN 'duration' THEN value ~ '^P([0-9]{1,4}D)?(T([0-9]{1,4}H)?([0-9]{1,4}M)?([0-9]{1,4}S)?)?$'
      AND value !~ '^PT?$' AND value !~ 'T$'
    WHEN 'operation' THEN value ~ '^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*){1,5}$'
    WHEN 'reference' THEN value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ELSE false
  END
) NOT VALID;

-- Registry membership and the instant floor, after the CHECK constraints (an AFTER row trigger), so a
-- grammar refusal still reports its own constraint first. Fires on insert and on a change of the checked
-- columns only (a read-count bump does not recheck a row).
CREATE FUNCTION cuspatlas.agent_memory_registry_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  DECLARE
    v_prefix text := split_part(NEW.key, '.', 1);
    v_suffix text := substr(NEW.key, char_length(split_part(NEW.key, '.', 1)) + 2);
    v_at timestamptz;
    v_floor timestamptz;
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM cuspatlas.agent_memory_registry r WHERE r.kind = 'key_prefix' AND r.value = v_prefix)
      OR NOT (v_suffix ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR EXISTS (SELECT 1 FROM cuspatlas.agent_memory_registry r
          WHERE r.kind IN ('code', 'operation') AND r.value = v_suffix)) THEN
      RAISE EXCEPTION 'agent_memory_entries_key_registered' USING ERRCODE = '23514',
        CONSTRAINT = 'agent_memory_entries_key_registered';
    END IF;
    IF NEW.classification = 'phi' THEN
      RETURN NULL;
    END IF;
    IF NEW.value_kind IN ('code', 'operation') AND NOT EXISTS (
      SELECT 1 FROM cuspatlas.agent_memory_registry r WHERE r.kind = NEW.value_kind AND r.value = NEW.value) THEN
      RAISE EXCEPTION 'agent_memory_entries_value_registered' USING ERRCODE = '23514',
        CONSTRAINT = 'agent_memory_entries_value_registered';
    END IF;
    IF NEW.value_kind = 'instant' THEN
      BEGIN
        v_at := NEW.value::timestamptz;
      EXCEPTION WHEN OTHERS THEN
        v_at := NULL;
      END;
      SELECT t.created_at INTO v_floor FROM cuspatlas.tenants t WHERE t.id = NEW.tenant_id;
      IF v_at IS NULL OR v_floor IS NULL OR v_at < v_floor THEN
        RAISE EXCEPTION 'agent_memory_entries_instant_floor' USING ERRCODE = '23514',
          CONSTRAINT = 'agent_memory_entries_instant_floor';
      END IF;
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.agent_memory_registry_guard() FROM PUBLIC;
CREATE TRIGGER agent_memory_registry_guard
  AFTER INSERT OR UPDATE OF key, value, value_kind, classification ON cuspatlas.agent_memory_entries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.agent_memory_registry_guard();
