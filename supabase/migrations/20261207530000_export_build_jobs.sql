-- Closeout C: the A15 export build runs as a worker job (synthetic engineering implementation,
-- recommended-pending-approval). `exports.create` records the request (`building`) and returns; a
-- worker leases the request row, builds the package as the requester (fresh live membership), and
-- completes it. `build_attempt` is the lease's fencing token: a lease is taken by incrementing it, and
-- only the holder of the current attempt may complete the request, so a worker whose lease expired can
-- never overwrite (or double-complete) the build of its successor. `build_leased_until` is when an
-- unfinished lease may be taken over. Nothing else about the request changes.
ALTER TABLE cuspatlas.export_requests
  ADD COLUMN build_attempt integer NOT NULL DEFAULT 0 CHECK (build_attempt >= 0),
  ADD COLUMN build_leased_until timestamptz;
CREATE INDEX export_requests_building ON cuspatlas.export_requests (tenant_id, created_at)
  WHERE state = 'building';
GRANT UPDATE (build_attempt, build_leased_until) ON cuspatlas.export_requests TO cuspatlas_app;
