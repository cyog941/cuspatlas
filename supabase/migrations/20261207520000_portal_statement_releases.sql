-- Closeout C: B4 statements releasable to the portal (synthetic engineering implementation,
-- recommended-pending-billing-approval). A statement release reuses the E2 portal release fact: the
-- same human-only, audited, revoke-once, never-deleted row, with item kind `billing_statement`. A
-- statement is released only to the portal of the guarantor it was generated for; the database
-- refuses a release that names another patient or another tenant's statement.
ALTER TABLE cuspatlas.portal_document_releases DROP CONSTRAINT portal_document_releases_item_kind_check;
ALTER TABLE cuspatlas.portal_document_releases
  ADD CONSTRAINT portal_document_releases_item_kind_check CHECK (item_kind IN ('imaging_object', 'billing_statement'));

CREATE FUNCTION cuspatlas.portal_statement_release_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.item_kind = 'billing_statement' AND NOT EXISTS (
    SELECT 1 FROM cuspatlas.billing_statements s
    WHERE s.id = NEW.item_id AND s.tenant_id = NEW.tenant_id AND s.guarantor_id = NEW.patient_id
  ) THEN
    RAISE EXCEPTION 'statement release must name the statement guarantor' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portal_statement_release_guard BEFORE INSERT ON cuspatlas.portal_document_releases
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.portal_statement_release_guard();
