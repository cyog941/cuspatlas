-- E8: telephony configuration and call references (synthetic data only). The telephony provider is
-- blocked-on-discovery (E-S2): there is no provider SDK and no network; call events come from a fake
-- adapter through a service integration principal. Numbers are fictional 555-01xx numbers only.
--
-- Configuration is versioned and append-only, so a historical call resolves to the routing rule in
-- force when it happened. Recording is off and cannot be turned on (no recording storage exists and
-- no recording consent model is approved). A call event stores metadata only: the caller number as a
-- digest plus its last four digits, never a recording and never the full number. A call is linked to a
-- patient only by a person's confirmation (an append-only link fact); a caller-number match only ever
-- yields a candidate list. Recommended-pending-approval throughout.

CREATE TABLE cuspatlas.telephony_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  version integer NOT NULL CHECK (version >= 1),
  numbers text[] NOT NULL
    CHECK (array_to_string(numbers, ',') ~ '^\+1-[0-9]{3}-555-01[0-9]{2}(,\+1-[0-9]{3}-555-01[0-9]{2})*$'),
  time_zone text NOT NULL CHECK (time_zone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$'),
  hours jsonb NOT NULL CHECK (jsonb_typeof(hours) = 'array'),
  routing jsonb NOT NULL CHECK (jsonb_typeof(routing) = 'object'),
  recording_state text NOT NULL DEFAULT 'off' CHECK (recording_state = 'off'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, version),
  UNIQUE (id, tenant_id)
);
CREATE TRIGGER telephony_configs_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.telephony_configs
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

CREATE TABLE cuspatlas.call_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  provider_call_ref text NOT NULL CHECK (provider_call_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  caller_digest text NOT NULL CHECK (caller_digest ~ '^[0-9a-f]{64}$'),
  caller_last4 text NOT NULL CHECK (caller_last4 ~ '^[0-9]{4}$'),
  dialed_number text NOT NULL CHECK (dialed_number ~ '^\+1-[0-9]{3}-555-01[0-9]{2}$'),
  occurred_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('answered', 'missed', 'voicemail')),
  config_id uuid NOT NULL,
  handling text NOT NULL CHECK (handling IN ('open', 'closed')),
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (config_id, tenant_id) REFERENCES cuspatlas.telephony_configs (id, tenant_id),
  UNIQUE (tenant_id, provider_call_ref),
  UNIQUE (id, tenant_id)
);
CREATE TRIGGER call_events_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.call_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

-- A person's confirmation that a call was with a patient (or the removal of that link). The latest
-- fact per call is the current link.
CREATE TABLE cuspatlas.call_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  call_id uuid NOT NULL,
  patient_id uuid,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  linked_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (call_id, tenant_id) REFERENCES cuspatlas.call_events (id, tenant_id),
  FOREIGN KEY (patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id)
);
CREATE INDEX call_links_call ON cuspatlas.call_links (tenant_id, call_id, seq);
CREATE TRIGGER call_links_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.call_links
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.telephony_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.telephony_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.call_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.call_events FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.call_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.call_links FORCE ROW LEVEL SECURITY;
CREATE POLICY telephony_configs_select ON cuspatlas.telephony_configs
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY telephony_configs_insert ON cuspatlas.telephony_configs
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY call_events_select ON cuspatlas.call_events
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY call_events_insert ON cuspatlas.call_events
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND recorded_by = cuspatlas.current_actor_id());
CREATE POLICY call_links_select ON cuspatlas.call_links
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY call_links_insert ON cuspatlas.call_links
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND linked_by = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.telephony_configs, cuspatlas.call_events, cuspatlas.call_links TO cuspatlas_app;
