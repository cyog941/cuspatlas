-- C15: encounter image links by opaque imageRef only (synthetic data only; C-D8 recommended option:
-- imaging owns bytes, storage, digest and patient association per I1 and I3). A link names an
-- encounter and an I3 imageRef, with the association reference I3 reported when the link was made
-- (evidence for a later review flag, never a copy of image metadata). No bytes, digest, modality,
-- capture instant or match status exist here. A link is ended (unlinked or relinked) with a reason and
-- stays in history; it is never deleted. Links reference the encounter, never the patient, so a merge
-- (which moves the encounter's patient) never touches them.

CREATE TABLE cuspatlas.clinical_encounter_image_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  encounter_id uuid NOT NULL,
  image_ref text NOT NULL CHECK (image_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  association_ref text NOT NULL CHECK (association_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  reason_code text CHECK (reason_code ~ '^[a-z_]{1,64}$'),
  relinked_from_id uuid,
  linked_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  linked_by_role text NOT NULL CHECK (linked_by_role IN ('dentist', 'hygienist', 'assistant', 'other_clinical')),
  linked_by_credential_ref text CHECK (linked_by_credential_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  linked_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'ended')),
  end_kind text CHECK (end_kind IN ('unlinked', 'relinked')),
  end_reason_code text CHECK (end_reason_code ~ '^[a-z_]{1,64}$'),
  relinked_to_id uuid,
  ended_by uuid REFERENCES cuspatlas.principals (id),
  ended_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (encounter_id, tenant_id) REFERENCES cuspatlas.clinical_encounters (id, tenant_id),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (relinked_from_id, tenant_id) REFERENCES cuspatlas.clinical_encounter_image_links (id, tenant_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (relinked_to_id, tenant_id) REFERENCES cuspatlas.clinical_encounter_image_links (id, tenant_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((state = 'ended') = (end_kind IS NOT NULL AND end_reason_code IS NOT NULL AND ended_by IS NOT NULL
                               AND ended_at IS NOT NULL)),
  CHECK ((end_kind IS NOT DISTINCT FROM 'relinked') = (relinked_to_id IS NOT NULL)),
  CHECK (relinked_from_id IS NULL OR reason_code IS NOT NULL)
);
CREATE INDEX clinical_encounter_image_links_encounter ON cuspatlas.clinical_encounter_image_links (tenant_id, encounter_id);
-- One active link per image: an image linked elsewhere needs the explicit relink.
CREATE UNIQUE INDEX clinical_encounter_image_links_one_active
  ON cuspatlas.clinical_encounter_image_links (tenant_id, image_ref) WHERE state = 'active';

-- Only the end of a link changes, once, by the acting member; content and identity never change.
CREATE FUNCTION cuspatlas.clinical_encounter_image_links_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'image links are never deleted' USING ERRCODE = '42501';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['state', 'end_kind', 'end_reason_code', 'relinked_to_id', 'ended_by', 'ended_at',
                               'version', 'updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'end_kind', 'end_reason_code', 'relinked_to_id', 'ended_by',
                               'ended_at', 'version', 'updated_at'])
       OR OLD.state <> 'active' OR NEW.state <> 'ended' OR NEW.version <> OLD.version + 1
       OR (current_user = 'cuspatlas_app' AND NEW.ended_by IS DISTINCT FROM cuspatlas.current_actor_id()) THEN
      RAISE EXCEPTION 'an image link only ends, once, by the acting member' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_encounter_image_links_guard() FROM PUBLIC;
CREATE TRIGGER clinical_encounter_image_links_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_encounter_image_links
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_encounter_image_links_guard();
CREATE TRIGGER clinical_encounter_image_links_author
  BEFORE INSERT ON cuspatlas.clinical_encounter_image_links
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_author_snapshot_guard(
    'linked_by', 'linked_by_role', 'linked_by_credential_ref');

ALTER TABLE cuspatlas.clinical_encounter_image_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_encounter_image_links FORCE ROW LEVEL SECURITY;
CREATE POLICY clinical_encounter_image_links_select ON cuspatlas.clinical_encounter_image_links
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_encounter_image_links_insert ON cuspatlas.clinical_encounter_image_links
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND linked_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_encounter_image_links_update ON cuspatlas.clinical_encounter_image_links
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
GRANT SELECT, INSERT ON cuspatlas.clinical_encounter_image_links TO cuspatlas_app;
GRANT UPDATE (state, end_kind, end_reason_code, relinked_to_id, ended_by, ended_at, version, updated_at)
  ON cuspatlas.clinical_encounter_image_links TO cuspatlas_app;
