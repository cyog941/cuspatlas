-- Independent review of E4-E9, second pass (synthetic data only; every rule recommended-pending-approval).
--
-- 1. Keyed digests. Contact verification digests and caller digests were plain SHA-256 of a normalized
--    value. They are now HMAC-SHA-256 under the S4 match-key pepper (digest scheme 2, computed in the
--    application; the database never sees the pepper). Rows written before this migration are scheme 1:
--    they are kept (append-only) but never match, so a synthetic contact needs to be re-verified and a
--    historical call shows no candidates. Production has no scheme 1 rows.
--    call_events also keeps the S4 phone match keys of the caller (tenant-bound HMACs, the same kind
--    patients.match_keys holds) so candidate lookup uses the existing GIN index instead of hashing
--    every patient on every read.
ALTER TABLE cuspatlas.contact_verifications ADD COLUMN digest_scheme smallint NOT NULL DEFAULT 1
  CHECK (digest_scheme IN (1, 2));
ALTER TABLE cuspatlas.call_events ADD COLUMN digest_scheme smallint NOT NULL DEFAULT 1
  CHECK (digest_scheme IN (1, 2));
ALTER TABLE cuspatlas.call_events ADD COLUMN caller_match_keys text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(caller_match_keys) <= 2);
CREATE INDEX contact_verifications_digest ON cuspatlas.contact_verifications (tenant_id, patient_id, channel, contact_digest)
  WHERE digest_scheme = 2;

-- 2. Export logging. A sensitive-read entry keeps its capped reference list (100) and now also the total
--    number of records the read returned, so one entry per exported table records an honest count.
ALTER TABLE cuspatlas.sensitive_read_events ADD COLUMN total_count integer CHECK (total_count >= 0);

-- 3. Database-level agreement the application already relies on (nits of the same review).
--    a. A closed thread is never reopened (no reopen command exists).
--    b. The author or opener of a portal-side row is a portal principal and of a staff-side row a human:
--       thread_messages.author_kind, message_threads.opened_via and intake_submissions.submitted_via
--       must agree with the kind of the principal that wrote the row.
--    c. The communication consent purpose vocabulary excludes `treatment` (treatment consent is C13's
--       and is never an E fact); no row can carry it.
--    d. A review item's patient is the patient of its submission.
CREATE OR REPLACE FUNCTION cuspatlas.message_threads_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'message threads are never deleted' USING ERRCODE = '42501';
    END IF;
    IF NEW.version <> OLD.version + 1 OR NEW.patient_id <> OLD.patient_id OR NEW.location_id <> OLD.location_id
        OR NEW.opened_by <> OLD.opened_by OR NEW.opened_via <> OLD.opened_via OR NEW.created_at <> OLD.created_at
        OR NEW.via_relationship_id IS DISTINCT FROM OLD.via_relationship_id
        OR (OLD.state = 'closed' AND NEW.state <> 'closed') THEN
      RAISE EXCEPTION 'message thread change refused' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;

CREATE FUNCTION cuspatlas.actor_kind_matches() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    via text;
    actor uuid;
    actor_kind text;
    expected text;
  BEGIN
    IF TG_TABLE_NAME = 'thread_messages' THEN
      via := NEW.author_kind;
      actor := NEW.author_id;
    ELSIF TG_TABLE_NAME = 'message_threads' THEN
      via := NEW.opened_via;
      actor := NEW.opened_by;
    ELSE
      via := NEW.submitted_via;
      actor := NEW.submitted_by;
    END IF;
    SELECT p.kind INTO actor_kind FROM cuspatlas.principals p WHERE p.id = actor;
    IF via = 'portal' THEN expected := 'portal'; ELSE expected := 'human'; END IF;
    IF actor_kind IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'the writing principal does not match the side of the record' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END $$;
REVOKE ALL ON FUNCTION cuspatlas.actor_kind_matches() FROM PUBLIC;
CREATE TRIGGER thread_messages_actor_kind BEFORE INSERT ON cuspatlas.thread_messages
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.actor_kind_matches();
CREATE TRIGGER message_threads_actor_kind BEFORE INSERT ON cuspatlas.message_threads
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.actor_kind_matches();
CREATE TRIGGER intake_submissions_actor_kind BEFORE INSERT ON cuspatlas.intake_submissions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.actor_kind_matches();

ALTER TABLE cuspatlas.communication_consents DROP CONSTRAINT communication_consents_purpose_check;
ALTER TABLE cuspatlas.communication_consents ADD CONSTRAINT communication_consents_purpose_check
  CHECK (purpose IN ('reminders', 'recall', 'messaging', 'all'));

ALTER TABLE cuspatlas.intake_submissions ADD CONSTRAINT intake_submissions_id_patient_key
  UNIQUE (id, patient_id, tenant_id);
ALTER TABLE cuspatlas.intake_review_items ADD CONSTRAINT intake_review_items_submission_patient_fkey
  FOREIGN KEY (submission_id, patient_id, tenant_id) REFERENCES cuspatlas.intake_submissions (id, patient_id, tenant_id);
