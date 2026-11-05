-- E2 portal documents (closeout B; synthetic engineering implementation, recommended-pending-approval).
-- A portal release is a separate, human-only, audited and revocable fact: a clinician explicitly
-- releases one image (I3-associated to the patient) to that patient's portal. The portal documents
-- view lists live releases only; downloads go through I1 short-lived read grants bound to the portal
-- principal. A release is never deleted: revocation records who and when, once.
CREATE TABLE cuspatlas.portal_document_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  patient_id uuid NOT NULL,
  item_kind text NOT NULL CHECK (item_kind IN ('imaging_object')),
  item_id uuid NOT NULL,
  released_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  released_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES cuspatlas.principals (id),
  revoked_at timestamptz,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX portal_document_releases_live ON cuspatlas.portal_document_releases (tenant_id, item_kind, item_id)
  WHERE revoked_at IS NULL;
CREATE INDEX portal_document_releases_patient ON cuspatlas.portal_document_releases (tenant_id, patient_id);

CREATE TRIGGER portal_document_releases_human BEFORE INSERT ON cuspatlas.portal_document_releases
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.human_actor_guard('released_by');

CREATE FUNCTION cuspatlas.portal_document_releases_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'portal releases are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR (NEW.id, NEW.tenant_id, NEW.patient_id, NEW.item_kind, NEW.item_id, NEW.released_by, NEW.released_at)
        IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.patient_id, OLD.item_kind, OLD.item_id, OLD.released_by, OLD.released_at)
     OR (current_user = 'cuspatlas_app' AND (NEW.revoked_by IS DISTINCT FROM cuspatlas.current_actor_id()
         OR NOT cuspatlas.is_human_member(NEW.revoked_by))) THEN
    RAISE EXCEPTION 'portal release change not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portal_document_releases_guard BEFORE UPDATE OR DELETE ON cuspatlas.portal_document_releases
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.portal_document_releases_guard();

ALTER TABLE cuspatlas.portal_document_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.portal_document_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_document_releases_select ON cuspatlas.portal_document_releases
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY portal_document_releases_insert ON cuspatlas.portal_document_releases
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND released_by = cuspatlas.current_actor_id());
CREATE POLICY portal_document_releases_update ON cuspatlas.portal_document_releases
  FOR UPDATE TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
GRANT SELECT, INSERT ON cuspatlas.portal_document_releases TO cuspatlas_app;
GRANT UPDATE (revoked_at, revoked_by) ON cuspatlas.portal_document_releases TO cuspatlas_app;
