-- Clock audit review, restore drill finding: the F8 restore reloads audit_events with their recorded
-- seq, and the 20261207600000 trigger renumbered them, so the restored table digest differed. The
-- sequence is now kept only inside the restore load (transaction-local cuspatlas.restore_load) AND for a
-- role that bypasses RLS, the same combination as 20261129020000; the runtime role cannot bypass RLS,
-- so setting the flag changes nothing for it and its rows still take the next value. The restore also
-- advances the sequence past every reloaded value, so later rows sort after them.
-- The function is no longer SECURITY DEFINER (current_user must be the inserting role), so the runtime
-- role is granted USAGE on the sequence; nextval can only add gaps, never choose a position.
GRANT USAGE ON SEQUENCE cuspatlas.audit_events_seq TO cuspatlas_app;

CREATE OR REPLACE FUNCTION cuspatlas.audit_events_assign_seq() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
  AS $$
  BEGIN
    IF NEW.seq IS NOT NULL AND current_setting('cuspatlas.restore_load', true) = 'on'
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
      PERFORM setval('cuspatlas.audit_events_seq',
        greatest(NEW.seq, (SELECT last_value FROM cuspatlas.audit_events_seq)));
      RETURN NEW;
    END IF;
    NEW.seq := nextval('cuspatlas.audit_events_seq');
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.audit_events_assign_seq() FROM PUBLIC;
