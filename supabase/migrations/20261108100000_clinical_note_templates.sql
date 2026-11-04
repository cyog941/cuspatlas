-- C9: progress-note templates with per-template enforcement and procedure-code association
-- (synthetic data only). Semantics are recommended-pending-clinical-approval (ADR 0006, C-D4):
-- enforcement blocks signing, not drafting. Required sections are synthetic placeholders (C-S2-Q1
-- blocking) and code associations are provisional SYN- references (C-D2), never a licensed code set.

-- True when every element is a provisional synthetic code reference (no licensed terminology).
CREATE FUNCTION cuspatlas.clinical_syn_codes_valid(codes text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT
  AS $$ SELECT coalesce(bool_and(c ~ '^SYN-[A-Z0-9-]{1,40}$'), true) FROM unnest(codes) AS c $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_syn_codes_valid(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.clinical_syn_codes_valid(text[]) TO cuspatlas_app;

-- Template identity: a note type and label (fixed at definition), an active/retired state and the
-- head of its version sequence. Content lives only in the append-only versions below.
CREATE TABLE cuspatlas.clinical_note_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  note_type text NOT NULL CHECK (note_type ~ '^[a-z][a-z_]{0,63}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retired')),
  head_sequence integer NOT NULL DEFAULT 1 CHECK (head_sequence >= 1),
  retired_reason_code text CHECK (retired_reason_code ~ '^[a-z_]{1,64}$'),
  retired_by uuid REFERENCES cuspatlas.principals (id),
  retired_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CHECK ((state = 'retired') = (retired_at IS NOT NULL)),
  CHECK ((state = 'retired') = (retired_by IS NOT NULL)),
  CHECK ((state = 'retired') = (retired_reason_code IS NOT NULL))
);
-- Never two ambiguous active templates: one active template per type and (case-insensitive) label.
CREATE UNIQUE INDEX clinical_note_templates_active_label
  ON cuspatlas.clinical_note_templates (tenant_id, note_type, lower(label)) WHERE state = 'active';

CREATE FUNCTION cuspatlas.clinical_note_templates_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'note templates are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (NEW.id, NEW.tenant_id, NEW.note_type, NEW.label, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.note_type, OLD.label, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'note template identity is immutable' USING ERRCODE = '42501';
    END IF;
    IF OLD.state = 'retired' AND (NEW.state, NEW.retired_reason_code, NEW.retired_by, NEW.retired_at)
       IS DISTINCT FROM (OLD.state, OLD.retired_reason_code, OLD.retired_by, OLD.retired_at) THEN
      RAISE EXCEPTION 'a retired note template stays retired' USING ERRCODE = '42501';
    END IF;
    IF OLD.state = 'retired' AND NEW.head_sequence <> OLD.head_sequence THEN
      RAISE EXCEPTION 'a retired note template takes no new version' USING ERRCODE = '42501';
    END IF;
    IF NEW.head_sequence NOT IN (OLD.head_sequence, OLD.head_sequence + 1) THEN
      RAISE EXCEPTION 'note template versions are appended one at a time' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'note template version must increase by one' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_note_templates_guard() FROM PUBLIC;
CREATE TRIGGER clinical_note_templates_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_note_templates
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_note_templates_guard();

-- One immutable template version: enforcement flag, sections (key, label, required) and associated
-- synthetic procedure-code references. A signed note pins one of these rows; it is never edited.
CREATE TABLE cuspatlas.clinical_note_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  enforced boolean NOT NULL,
  sections jsonb NOT NULL CHECK (jsonb_typeof(sections) = 'array' AND jsonb_array_length(sections) BETWEEN 1 AND 30),
  procedure_code_refs text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(procedure_code_refs) <= 50 AND cuspatlas.clinical_syn_codes_valid(procedure_code_refs)),
  defined_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  defined_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (template_id, tenant_id) REFERENCES cuspatlas.clinical_note_templates (id, tenant_id),
  UNIQUE (template_id, sequence),
  UNIQUE (id, tenant_id)
);
CREATE INDEX clinical_note_template_versions_template
  ON cuspatlas.clinical_note_template_versions (tenant_id, template_id, sequence);

CREATE TRIGGER clinical_note_template_versions_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_note_template_versions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.clinical_note_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_note_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_note_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_note_template_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY clinical_note_templates_select ON cuspatlas.clinical_note_templates
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_note_templates_insert ON cuspatlas.clinical_note_templates
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND state = 'active' AND head_sequence = 1 AND version = 1);
CREATE POLICY clinical_note_templates_update ON cuspatlas.clinical_note_templates
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_note_template_versions_select ON cuspatlas.clinical_note_template_versions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_note_template_versions_insert ON cuspatlas.clinical_note_template_versions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND defined_by = cuspatlas.current_actor_id());

-- Explicit grants: versions are append-only; a template row may change only its state, retirement,
-- version head and bookkeeping (the guard trigger restricts how). No DELETE or TRUNCATE.
GRANT SELECT, INSERT ON cuspatlas.clinical_note_templates, cuspatlas.clinical_note_template_versions
  TO cuspatlas_app;
GRANT UPDATE (state, head_sequence, retired_reason_code, retired_by, retired_at, version, updated_at)
  ON cuspatlas.clinical_note_templates TO cuspatlas_app;
