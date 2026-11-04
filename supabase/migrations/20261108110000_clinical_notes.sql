-- C10: note drafting, signing, amendment, addendum and co-signature (synthetic data only).
-- Semantics are recommended-pending-clinical-approval (ADR 0006: C-D4, C-D5); co-signature
-- (C-S2-Q5) is blocking and recorded as a pending state only. Signed clinical content is immutable:
-- no command updates it, the runtime role holds no UPDATE or DELETE on frozen versions, and the
-- triggers below refuse every rewrite for every role, the table owner included.
--
-- No note table carries a patient reference: a note belongs to an encounter, and a merge relinks
-- only the encounter (S6), so a merge can never change a note row.

-- The note header with its mutable draft. While the note is a draft the content, the pinned template
-- version and the draft authorship may change (optimistic version); signing freezes all of them.
CREATE TABLE cuspatlas.clinical_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  note_type text NOT NULL CHECK (note_type ~ '^[a-z][a-z_]{0,63}$'),
  template_version_id uuid,
  -- Provenance label only (A11 later): nothing in this module generates note text.
  source text NOT NULL DEFAULT 'human' CHECK (source IN ('human', 'ai_draft')),
  ai_model_ref text CHECK (ai_model_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ai_prompt_version_ref text CHECK (ai_prompt_version_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'signed')),
  draft_sections jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(draft_sections) = 'array' AND jsonb_array_length(draft_sections) <= 30),
  draft_code_refs text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(draft_code_refs) <= 50 AND cuspatlas.clinical_syn_codes_valid(draft_code_refs)),
  draft_updated_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  draft_updated_by_role text NOT NULL CHECK (draft_updated_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  draft_updated_by_credential_ref text CHECK (draft_updated_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  draft_updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  -- Number of frozen versions (0 while a draft); the next version is head_sequence + 1.
  head_sequence integer NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_by_role text NOT NULL CHECK (created_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  created_by_credential_ref text CHECK (created_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (encounter_id, tenant_id) REFERENCES cuspatlas.clinical_encounters (id, tenant_id),
  FOREIGN KEY (template_version_id, tenant_id) REFERENCES cuspatlas.clinical_note_template_versions (id, tenant_id),
  UNIQUE (id, tenant_id),
  CHECK ((state = 'draft') = (head_sequence = 0)),
  CHECK ((source = 'ai_draft') = (ai_model_ref IS NOT NULL AND ai_prompt_version_ref IS NOT NULL)),
  CHECK (source = 'ai_draft' OR (ai_model_ref IS NULL AND ai_prompt_version_ref IS NULL))
);
CREATE INDEX clinical_notes_encounter ON cuspatlas.clinical_notes (tenant_id, encounter_id, created_at);

CREATE FUNCTION cuspatlas.clinical_notes_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'clinical notes are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (NEW.id, NEW.tenant_id, NEW.encounter_id, NEW.note_type, NEW.source, NEW.ai_model_ref,
        NEW.ai_prompt_version_ref, NEW.created_by, NEW.created_by_role, NEW.created_by_credential_ref, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.encounter_id, OLD.note_type, OLD.source, OLD.ai_model_ref,
        OLD.ai_prompt_version_ref, OLD.created_by, OLD.created_by_role, OLD.created_by_credential_ref, OLD.created_at) THEN
      RAISE EXCEPTION 'clinical note identity is immutable' USING ERRCODE = '42501';
    END IF;
    IF OLD.state = 'signed' OR NEW.state = 'signed' THEN
      -- Signing freezes the draft as it stands; a signed note never returns to draft.
      IF NEW.state <> 'signed' OR (NEW.template_version_id, NEW.draft_sections, NEW.draft_code_refs,
          NEW.draft_updated_by, NEW.draft_updated_by_role, NEW.draft_updated_by_credential_ref, NEW.draft_updated_at)
         IS DISTINCT FROM (OLD.template_version_id, OLD.draft_sections, OLD.draft_code_refs,
          OLD.draft_updated_by, OLD.draft_updated_by_role, OLD.draft_updated_by_credential_ref, OLD.draft_updated_at) THEN
        RAISE EXCEPTION 'signed clinical note content is immutable' USING ERRCODE = '42501';
      END IF;
      IF NEW.head_sequence <> OLD.head_sequence + 1 AND NOT (OLD.state = 'signed' AND NEW.head_sequence = OLD.head_sequence) THEN
        RAISE EXCEPTION 'note versions are appended one at a time' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.head_sequence <> 0 THEN
      RAISE EXCEPTION 'a draft has no frozen version' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'clinical note version must increase by one' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_notes_guard() FROM PUBLIC;
CREATE TRIGGER clinical_notes_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_notes
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_notes_guard();

-- Frozen versions: the signed original (sequence 1), amendments (a complete replacement statement)
-- and addenda (additional text). Each names the version it references, its author, instant, reason,
-- the template version and history versions it was recorded against, and a content digest.
CREATE TABLE cuspatlas.clinical_note_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  note_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  kind text NOT NULL CHECK (kind IN ('original', 'amendment', 'addendum')),
  references_sequence integer CHECK (references_sequence >= 1),
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  sections jsonb CHECK (jsonb_typeof(sections) = 'array' AND jsonb_array_length(sections) <= 30),
  code_refs text[] CHECK (cardinality(code_refs) <= 50 AND cuspatlas.clinical_syn_codes_valid(code_refs)),
  addendum_text text CHECK (char_length(addendum_text) BETWEEN 1 AND 8000),
  template_version_id uuid,
  template_check jsonb CHECK (jsonb_typeof(template_check) = 'object'),
  history_refs jsonb NOT NULL CHECK (jsonb_typeof(history_refs) = 'array'),
  authored_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  authored_by_role text NOT NULL CHECK (authored_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  authored_by_credential_ref text CHECK (authored_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  authored_at timestamptz NOT NULL,
  cosign_required boolean NOT NULL,
  supervising_resource_id uuid,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  FOREIGN KEY (note_id, tenant_id) REFERENCES cuspatlas.clinical_notes (id, tenant_id),
  FOREIGN KEY (template_version_id, tenant_id) REFERENCES cuspatlas.clinical_note_template_versions (id, tenant_id),
  FOREIGN KEY (supervising_resource_id, tenant_id) REFERENCES cuspatlas.scheduling_resources (id, tenant_id),
  UNIQUE (note_id, sequence),
  UNIQUE (id, tenant_id),
  UNIQUE (id, content_digest),
  CHECK ((kind = 'original') = (sequence = 1)),
  CHECK ((kind = 'original') = (references_sequence IS NULL)),
  CHECK (references_sequence IS NULL OR references_sequence < sequence),
  CHECK ((kind = 'original') = (reason_code IS NULL)),
  CHECK ((kind = 'addendum') = (addendum_text IS NOT NULL)),
  CHECK ((kind = 'addendum') = (sections IS NULL AND code_refs IS NULL)),
  CHECK (kind <> 'addendum' OR template_check IS NULL),
  CHECK (cosign_required = (supervising_resource_id IS NOT NULL))
);

-- A co-signature binds one frozen version by its digest (the foreign key includes the digest) and
-- never changes it. Who must co-sign which note class is C-S2-Q5 (blocking).
CREATE TABLE cuspatlas.clinical_note_cosignatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  note_version_id uuid NOT NULL,
  content_digest text NOT NULL,
  cosigned_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  cosigned_by_role text NOT NULL CHECK (cosigned_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  cosigned_by_credential_ref text CHECK (cosigned_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  cosigned_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (note_version_id, tenant_id) REFERENCES cuspatlas.clinical_note_versions (id, tenant_id),
  FOREIGN KEY (note_version_id, content_digest) REFERENCES cuspatlas.clinical_note_versions (id, content_digest),
  UNIQUE (tenant_id, note_version_id)
);

CREATE TRIGGER clinical_note_versions_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_note_versions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_note_cosignatures_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_note_cosignatures
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.clinical_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_notes FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_note_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_note_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_note_cosignatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_note_cosignatures FORCE ROW LEVEL SECURITY;

CREATE POLICY clinical_notes_select ON cuspatlas.clinical_notes
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_notes_insert ON cuspatlas.clinical_notes
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id()
    AND draft_updated_by = cuspatlas.current_actor_id() AND state = 'draft' AND head_sequence = 0 AND version = 1);
CREATE POLICY clinical_notes_update ON cuspatlas.clinical_notes
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_note_versions_select ON cuspatlas.clinical_note_versions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_note_versions_insert ON cuspatlas.clinical_note_versions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND authored_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_note_cosignatures_select ON cuspatlas.clinical_note_cosignatures
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_note_cosignatures_insert ON cuspatlas.clinical_note_cosignatures
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND cosigned_by = cuspatlas.current_actor_id());

-- Explicit grants: frozen versions and co-signatures are append-only; the header may change only its
-- draft, pin, state, head and bookkeeping (the guard freezes the draft once signed). No DELETE.
GRANT SELECT, INSERT ON cuspatlas.clinical_notes, cuspatlas.clinical_note_versions,
  cuspatlas.clinical_note_cosignatures TO cuspatlas_app;
GRANT UPDATE (template_version_id, state, draft_sections, draft_code_refs, draft_updated_by, draft_updated_by_role,
  draft_updated_by_credential_ref, draft_updated_at, head_sequence, version, updated_at)
  ON cuspatlas.clinical_notes TO cuspatlas_app;
