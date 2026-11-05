-- Integration seam B CL-04 -> I3 (codex/backend-integration; synthetic data only). New migration;
-- applied migrations are never edited.
--
-- Claim attachments and attachment package items may name an I3 imageRef (a uuid I3 mints) as well
-- as the synthetic syn-img-/syn-obj- references the fake object source accepts. The digest stays
-- I3's; B checks it against I3 in the package and submit transactions for the claim's patient.
DO $$
DECLARE
  t text;
  c text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rcm_claim_attachments', 'rcm_claim_attachment_package_items'] LOOP
    SELECT con.conname INTO c FROM pg_constraint con
    WHERE con.conrelid = format('cuspatlas.%I', t)::regclass AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%object_ref%';
    IF c IS NULL THEN
      RAISE EXCEPTION 'expected the CL-04 object_ref check on %', t;
    END IF;
    EXECUTE format('ALTER TABLE cuspatlas.%I DROP CONSTRAINT %I', t, c);
    EXECUTE format(
      'ALTER TABLE cuspatlas.%I ADD CONSTRAINT %I CHECK (object_ref ~ ''^(syn-(img|obj)-[a-z0-9-]{1,60}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'')',
      t, t || '_object_ref');
  END LOOP;
END
$$;
