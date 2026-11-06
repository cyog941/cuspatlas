-- E4/E5 hardening (independent review): `attempt` is the lease fencing token, so it must never go
-- backwards. Grants already restrict which columns the runtime role may update; this trigger makes
-- the fence monotonic for every role that cannot disable triggers (the runtime role included).
CREATE FUNCTION cuspatlas.outbox_events_attempt_monotonic() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.attempt < OLD.attempt THEN
    RAISE EXCEPTION 'outbox attempt is monotonic' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION cuspatlas.outbox_events_attempt_monotonic() FROM PUBLIC;
CREATE TRIGGER outbox_events_attempt_monotonic
  BEFORE UPDATE OF attempt ON cuspatlas.outbox_events
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.outbox_events_attempt_monotonic();
