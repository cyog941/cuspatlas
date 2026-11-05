-- Closeout D review fixes (synthetic engineering implementation, recommended-pending-approval): two real
-- orphan-bytes sweeps can overlap. A sweep reads the open removal intents before it takes each content lock,
-- so a concurrent sweep may commit an intent for the same key in between. The sweep now re-reads the open
-- intents under the lock (and inserts with ON CONFLICT DO NOTHING on imaging_orphan_removals_open), leaves
-- such a key to the other sweep's intent and records how many it left. Existing records were 0.
ALTER TABLE cuspatlas.imaging_orphan_sweeps
  ADD COLUMN kept_already_intended integer NOT NULL DEFAULT 0 CHECK (kept_already_intended >= 0);
