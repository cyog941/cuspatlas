-- A11 draft-only AI pipeline (workstream A batch 2; synthetic only; provider egress blocked on A-S2,
-- A-D5/A-D6 pending). A draft records the use case, the (synthetic) model and prompt version, the
-- source references with the versions it was built from, review flags and its text. It is never a
-- clinical, financial or communication fact: a human accepts it through the owning command (the
-- accepted note or message is linked), rejects it, or it goes stale when a source changes.
-- AI use cases are off per tenant until an administrator enables them; '*' is the tenant-wide switch.

CREATE TABLE cuspatlas.ai_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  use_case text NOT NULL CHECK (use_case ~ '^[a-z][A-Za-z]{1,63}$'),
  state text NOT NULL CHECK (state IN ('offered', 'flagged', 'accepted', 'rejected', 'stale')),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 20000),
  model_ref text NOT NULL CHECK (model_ref ~ '^[A-Za-z0-9._:-]{1,64}$'),
  prompt_version_ref text NOT NULL CHECK (prompt_version_ref ~ '^[a-z0-9.-]{1,64}$'),
  source_refs jsonb NOT NULL CHECK (jsonb_typeof(source_refs) = 'array'),
  flags text[] NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES cuspatlas.principals (id),
  decided_at timestamptz,
  rejection_reason text CHECK (rejection_reason ~ '^[a-z_]{1,64}$'),
  accepted_kind text,
  accepted_ref uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- The model never decides: a decided draft names a human decider other than an agent creator's
  -- self-acceptance (the domain refuses agents; the policy admits humans only).
  CHECK ((state IN ('accepted', 'rejected')) <= (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK ((accepted_ref IS NOT NULL) <= (state = 'accepted'))
);
CREATE INDEX ai_drafts_tenant ON cuspatlas.ai_drafts (tenant_id, created_at DESC, id);

CREATE FUNCTION cuspatlas.ai_drafts_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' OR OLD.state IN ('accepted', 'rejected') THEN
      RAISE EXCEPTION 'a decided AI draft is never changed' USING ERRCODE = '42501';
    END IF;
    IF NEW.text <> OLD.text OR NEW.model_ref <> OLD.model_ref OR NEW.prompt_version_ref <> OLD.prompt_version_ref
      OR NEW.source_refs <> OLD.source_refs OR NEW.created_by <> OLD.created_by THEN
      RAISE EXCEPTION 'AI draft provenance is immutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER ai_drafts_guard BEFORE UPDATE OR DELETE ON cuspatlas.ai_drafts
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.ai_drafts_guard();

CREATE TABLE cuspatlas.ai_use_case_settings (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  use_case text NOT NULL CHECK (use_case = '*' OR use_case ~ '^[a-z][A-Za-z]{1,63}$'),
  enabled boolean NOT NULL,
  updated_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, use_case)
);

ALTER TABLE cuspatlas.ai_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.ai_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.ai_use_case_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.ai_use_case_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_drafts_select ON cuspatlas.ai_drafts
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY ai_drafts_insert ON cuspatlas.ai_drafts
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND state IN ('offered', 'flagged'));
CREATE POLICY ai_drafts_update ON cuspatlas.ai_drafts
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY ai_use_case_settings_select ON cuspatlas.ai_use_case_settings
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY ai_use_case_settings_write ON cuspatlas.ai_use_case_settings
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND updated_by = cuspatlas.current_actor_id());
CREATE POLICY ai_use_case_settings_update ON cuspatlas.ai_use_case_settings
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND updated_by = cuspatlas.current_actor_id());
GRANT SELECT, INSERT, UPDATE ON cuspatlas.ai_drafts TO cuspatlas_app;
GRANT SELECT, INSERT, UPDATE ON cuspatlas.ai_use_case_settings TO cuspatlas_app;
