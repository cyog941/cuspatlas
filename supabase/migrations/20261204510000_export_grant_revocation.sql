-- A15 hardening (A batch 4): a delivery grant can be revoked before it expires. Revocation is a
-- one-way fact (who and when); a revoked grant never downloads. Nothing is deleted.
ALTER TABLE cuspatlas.export_grants
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid REFERENCES cuspatlas.principals (id),
  ADD CONSTRAINT export_grants_revocation_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL));

CREATE FUNCTION cuspatlas.export_grants_revocation_final() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- The runtime role may update only the revocation columns (column grants); a revocation is final.
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
    RAISE EXCEPTION 'an export grant revocation is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION cuspatlas.export_grants_revocation_final() FROM PUBLIC;
CREATE TRIGGER export_grants_revocation_final BEFORE UPDATE ON cuspatlas.export_grants
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.export_grants_revocation_final();

CREATE POLICY export_grants_revoke ON cuspatlas.export_grants FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND revoked_by = cuspatlas.current_actor_id());
GRANT UPDATE (revoked_at, revoked_by) ON cuspatlas.export_grants TO cuspatlas_app;
