-- Closeout E (synthetic engineering implementation, recommended-pending-approval): every orphan-bytes
-- sweep record (the scheduled dry-run report included) now states how many removal intents were open in
-- the tenant when it was recorded and how old the oldest of them was (whole seconds, database clock), so
-- an operator reading a dry-run report sees intents an interrupted real sweep left behind. A dry run only
-- reports them; finishing them stays a human real sweep. Records written before this change hold 0/NULL
-- (not measured then).
ALTER TABLE cuspatlas.imaging_orphan_sweeps
  ADD COLUMN open_intent_count integer NOT NULL DEFAULT 0 CHECK (open_intent_count >= 0),
  ADD COLUMN oldest_open_intent_age_seconds integer CHECK (oldest_open_intent_age_seconds >= 0),
  ADD CHECK ((open_intent_count = 0) = (oldest_open_intent_age_seconds IS NULL));
