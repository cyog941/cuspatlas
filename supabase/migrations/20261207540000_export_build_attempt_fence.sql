-- Closeout C review fixes (synthetic engineering implementation, recommended-pending-approval): the
-- export build lease's fencing token (`build_attempt`) never moves backwards. A worker takes a lease by
-- incrementing it and only the holder of the current attempt may renew the lease or complete the
-- request, so a decrease would let a stale attempt complete a successor's build. Refused for every
-- role, the database owner included; nothing else about the request changes.
CREATE FUNCTION cuspatlas.export_requests_attempt_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.build_attempt < OLD.build_attempt THEN
    RAISE EXCEPTION 'export build attempt never decreases' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER export_requests_attempt_fence BEFORE UPDATE OF build_attempt ON cuspatlas.export_requests
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.export_requests_attempt_fence();
