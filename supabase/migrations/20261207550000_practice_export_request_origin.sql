-- Closeout D (synthetic engineering implementation, recommended-pending-approval): the direct M1
-- practice export (`practice.export.create`) no longer builds inline. It records an export request
-- like `exports.create` does, and the leased worker job (`exports.build`) builds it. `origin` names the
-- operation that recorded the request, so the build re-checks the requester against that operation
-- (`practice.export.create` needs admin.configure, `exports.create` needs exports.create) and the M1
-- read (`practice.export.read`) shows only the requests M1 recorded. It is set at insert and never
-- changes (the runtime role has no UPDATE on it); an M1 request is always practice scope.
ALTER TABLE cuspatlas.export_requests
  ADD COLUMN origin text NOT NULL DEFAULT 'exports.create'
    CHECK (origin IN ('exports.create', 'practice.export.create')),
  ADD CONSTRAINT export_requests_origin_scope CHECK (origin = 'exports.create' OR scope = 'practice');
