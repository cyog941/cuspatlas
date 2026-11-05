-- Independent review of I1-I8 (synthetic data only). Holds cannot be lost to a concurrent deletion, a
-- hold on a derived object protects its original, byte removal and ingest of the same bytes serialize on
-- the content, unscoped uploads never deduplicate into an associated object, and an association
-- decision's patient moves only along a recorded merge or unmerge.

-- Transaction-scoped advisory locks keyed by tenant and subject (an object or a patient) or by tenant
-- and content digest. Domain statements cannot call pg_* functions (statement guard); these wrappers
-- are the only lock entry points and take no caller text beyond uuids and a checked digest.
CREATE FUNCTION cuspatlas.imaging_lock_subjects(p_tenant uuid, p_subjects uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  s uuid;
BEGIN
  -- Sorted and distinct: two lockers of overlapping sets always queue instead of deadlocking.
  FOR s IN SELECT DISTINCT x FROM unnest(p_subjects) AS x WHERE x IS NOT NULL ORDER BY x LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('imaging-subject:' || p_tenant::text || ':' || s::text, 0));
  END LOOP;
END;
$$;

CREATE FUNCTION cuspatlas.imaging_lock_content(p_tenant uuid, p_digest text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'content lock needs a sha-256 digest' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('imaging-content:' || p_tenant::text || ':' || p_digest, 0));
END;
$$;

-- Every hold subject that governs an object: the object, its source original (a derived object follows
-- its source), the derived children of the object, every patient the original was ever associated with,
-- and identities merged into those patients.
CREATE FUNCTION cuspatlas.imaging_hold_subjects(p_object uuid) RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  WITH o AS (
    SELECT id, coalesce(source_object_id, id) AS owner FROM cuspatlas.imaging_objects WHERE id = p_object
  ), pats AS (
    SELECT d.subject_patient_id AS pid FROM cuspatlas.imaging_match_decisions d WHERE d.object_id IN (SELECT owner FROM o)
  )
  SELECT coalesce(array_agg(DISTINCT x), '{}') FROM (
    SELECT id AS x FROM o
    UNION SELECT owner FROM o
    UNION SELECT c.id FROM cuspatlas.imaging_objects c WHERE c.source_object_id = p_object
    UNION SELECT pid FROM pats
    UNION SELECT p.id FROM cuspatlas.patients p WHERE p.merged_into IN (SELECT pid FROM pats)
  ) s;
$$;

-- Active holds over those subjects (object and patient identifiers are distinct uuids), oldest first.
CREATE FUNCTION cuspatlas.imaging_object_holds(p_object uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  SELECT h.id FROM cuspatlas.imaging_legal_holds h
  WHERE h.released_at IS NULL AND h.subject_ref = ANY (cuspatlas.imaging_hold_subjects(p_object))
  ORDER BY h.placed_at, h.id;
$$;

-- Placing a hold takes the subject lock first (any inserter, not only the domain), so a deletion that
-- locks the same subjects waits for the placing transaction and then sees the hold.
CREATE FUNCTION cuspatlas.imaging_legal_holds_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cuspatlas.imaging_lock_subjects(NEW.tenant_id, ARRAY[NEW.subject_ref]);
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_legal_holds_lock BEFORE INSERT ON cuspatlas.imaging_legal_holds
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_legal_holds_lock();

-- The deleted transition re-checks holds after taking every governing subject lock.
CREATE FUNCTION cuspatlas.imaging_objects_hold_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'deleted' AND OLD.state <> 'deleted' THEN
    PERFORM cuspatlas.imaging_lock_subjects(NEW.tenant_id, cuspatlas.imaging_hold_subjects(NEW.id));
    IF EXISTS (SELECT 1 FROM cuspatlas.imaging_object_holds(NEW.id)) THEN
      RAISE EXCEPTION 'an active legal hold covers this object' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imaging_objects_hold_check BEFORE UPDATE ON cuspatlas.imaging_objects
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_objects_hold_check();

-- Dedupe: DB uniqueness only for a named patient. Unscoped uploads deduplicate only into an unscoped
-- object that was never associated (domain rule, serialized by the content lock).
DROP INDEX cuspatlas.imaging_objects_dedupe;
CREATE UNIQUE INDEX imaging_objects_dedupe ON cuspatlas.imaging_objects (tenant_id, digest_sha256, dedupe_patient_id)
  WHERE kind = 'original' AND state = 'available' AND dedupe_patient_id IS NOT NULL;

-- A decision's patient may change only as part of a recorded merge (old patient merged into the new one
-- in this transaction) or a recorded unmerge (the reverse move with a reversal written in this
-- transaction). Checked at commit, after the merge rows exist.
CREATE FUNCTION cuspatlas.imaging_match_decisions_relink_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.subject_patient_id IS NOT DISTINCT FROM OLD.subject_patient_id THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
       SELECT 1 FROM cuspatlas.patients p
       JOIN cuspatlas.patient_merges m ON m.merged_patient_id = p.id AND m.survivor_patient_id = NEW.subject_patient_id
       JOIN cuspatlas.patient_merge_moves mv ON mv.merge_id = m.id AND mv.record_ref = NEW.id
         AND mv.prior_patient_id = OLD.subject_patient_id AND mv.new_patient_id = NEW.subject_patient_id
       WHERE p.id = OLD.subject_patient_id AND p.merged_into = NEW.subject_patient_id AND m.merged_at = now()
         AND NOT EXISTS (SELECT 1 FROM cuspatlas.patient_merge_reversals r WHERE r.merge_id = m.id))
     OR EXISTS (
       SELECT 1 FROM cuspatlas.patients p
       JOIN cuspatlas.patient_merges m ON m.merged_patient_id = p.id AND m.survivor_patient_id = OLD.subject_patient_id
       JOIN cuspatlas.patient_merge_reversals r ON r.merge_id = m.id AND r.reversed_at = now()
       JOIN cuspatlas.patient_merge_moves mv ON mv.merge_id = m.id AND mv.record_ref = NEW.id
         AND mv.prior_patient_id = NEW.subject_patient_id AND mv.new_patient_id = OLD.subject_patient_id
       WHERE p.id = NEW.subject_patient_id AND p.merged_into IS NULL) THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'association patient changes only along a recorded merge' USING ERRCODE = '42501';
END;
$$;
CREATE CONSTRAINT TRIGGER imaging_match_decisions_relink_check
  AFTER UPDATE ON cuspatlas.imaging_match_decisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_match_decisions_relink_check();

REVOKE ALL ON FUNCTION cuspatlas.imaging_lock_subjects(uuid, uuid[]), cuspatlas.imaging_lock_content(uuid, text),
  cuspatlas.imaging_hold_subjects(uuid), cuspatlas.imaging_object_holds(uuid),
  cuspatlas.imaging_legal_holds_lock(), cuspatlas.imaging_objects_hold_check(),
  cuspatlas.imaging_match_decisions_relink_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.imaging_lock_subjects(uuid, uuid[]), cuspatlas.imaging_lock_content(uuid, text),
  cuspatlas.imaging_hold_subjects(uuid), cuspatlas.imaging_object_holds(uuid) TO cuspatlas_app;
