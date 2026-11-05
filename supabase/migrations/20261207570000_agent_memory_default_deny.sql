-- Closeout D (synthetic engineering implementation, recommended-pending-approval): agent memory is
-- default-deny. Before Closeout D a non-phi note was free text screened by a best-effort heuristic.
-- Now a non-phi note must declare a structured kind and its value must match that kind's grammar.
-- That is a positive allowlist classification: codes, counters, flags, UTC instants, durations, catalog
-- operation names and opaque references. Free text (`text`) is possible only classified `phi`, which
-- still needs the tenant's explicit PHI policy (agent_memory_phi_guard). The domain applies the same
-- allowlist and keeps the heuristic as an extra refusal layer. This constraint enforces the allowlist
-- independently, whoever writes. NOT VALID: enforced for every new or changed row, existing synthetic
-- rows are not rechecked. The name sorts after agent_memory_entries_value_screen, so that backstop
-- still reports its own refusals first.
ALTER TABLE cuspatlas.agent_memory_entries
  ADD COLUMN value_kind text CHECK (value_kind IN ('code', 'counter', 'flag', 'instant', 'duration', 'operation',
    'reference', 'text'));
ALTER TABLE cuspatlas.agent_memory_entries ADD CONSTRAINT agent_memory_entries_value_structured CHECK (
  classification = 'phi' OR CASE value_kind
    WHEN 'code' THEN char_length(value) <= 64 AND value ~ '^[a-z][a-z0-9]*([._:-][a-z0-9]+){0,7}$'
    -- At most 7 digits: 8 or more read as a phone-like run to the contact backstop.
    WHEN 'counter' THEN value ~ '^-?[0-9]{1,7}$'
    WHEN 'flag' THEN value IN ('true', 'false')
    WHEN 'instant' THEN value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
    WHEN 'duration' THEN value ~ '^P([0-9]{1,4}D)?(T([0-9]{1,4}H)?([0-9]{1,4}M)?([0-9]{1,4}S)?)?$'
      AND value !~ '^PT?$' AND value !~ 'T$'
    WHEN 'operation' THEN value ~ '^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*){1,5}$'
    WHEN 'reference' THEN value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ELSE false
  END
) NOT VALID;

-- A strict UTC instant or UUID reference (the grammars above) can read as a phone-like digit run to the
-- contact backstop, which is re-created to exempt only those two kinds from the phone pattern; e-mail and DOB
-- phrases are still refused for every non-phi note. NOT VALID as before.
ALTER TABLE cuspatlas.agent_memory_entries DROP CONSTRAINT agent_memory_entries_value_screen;
ALTER TABLE cuspatlas.agent_memory_entries ADD CONSTRAINT agent_memory_entries_value_screen CHECK (
  classification = 'phi' OR (
    value !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
    AND (coalesce(value_kind IN ('instant', 'reference'), false) OR value !~ '\+?[0-9][0-9 ().-]{6,}[0-9]')
    AND value !~* '(^|[^a-z])(dob|d\.o\.b|date of birth|birth ?date|born)([^a-z]|$)')
) NOT VALID;
