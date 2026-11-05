-- Closeout A5 (synthetic only; nothing is deployed). Orphan-bytes sweeps of the imaging object store.
-- Content is addressed per tenant (t/<tenant>/sha256/..), so a sweep only ever lists and removes the
-- caller tenant's prefix; a file is a candidate only when no imaging object row (any state, tombstones
-- included), no legal hold and no export package of that tenant references it, it is older than the grace
-- period and its content lock is free. Each run (dry run or real) leaves one append-only record with the
-- actor, the counts, the candidate digests and the removed digests (content digests only, never patient
-- data). A same-key replay of the command reads the digest lists back from this record.
CREATE TABLE cuspatlas.imaging_orphan_sweeps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  actor_id uuid NOT NULL REFERENCES cuspatlas.principals (id),
  dry_run boolean NOT NULL,
  grace_hours integer NOT NULL CHECK (grace_hours BETWEEN 1 AND 720),
  scanned_count integer NOT NULL CHECK (scanned_count >= 0),
  orphan_count integer NOT NULL CHECK (orphan_count >= 0),
  kept_within_grace integer NOT NULL CHECK (kept_within_grace >= 0),
  kept_live_object integer NOT NULL CHECK (kept_live_object >= 0),
  kept_tombstone_retained integer NOT NULL CHECK (kept_tombstone_retained >= 0),
  kept_legal_hold integer NOT NULL CHECK (kept_legal_hold >= 0),
  kept_export_package integer NOT NULL CHECK (kept_export_package >= 0),
  kept_content_locked integer NOT NULL CHECK (kept_content_locked >= 0),
  orphan_digests text[] NOT NULL DEFAULT '{}',
  removed_digests text[] NOT NULL DEFAULT '{}',
  CHECK (cardinality(orphan_digests) <= 500 AND cardinality(orphan_digests) <= orphan_count),
  CHECK (array_to_string(orphan_digests, ',') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'),
  CHECK (removed_digests <@ orphan_digests),
  CHECK (cardinality(removed_digests) <= 500),
  CHECK (array_to_string(removed_digests, ',') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'),
  CHECK (NOT dry_run OR cardinality(removed_digests) = 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX imaging_orphan_sweeps_recent ON cuspatlas.imaging_orphan_sweeps (tenant_id, created_at);

CREATE FUNCTION cuspatlas.imaging_orphan_sweeps_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  BEGIN
    RAISE EXCEPTION 'orphan sweep records are append-only' USING ERRCODE = '42501';
  END
  $$;
CREATE TRIGGER imaging_orphan_sweeps_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_orphan_sweeps
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_orphan_sweeps_guard();

ALTER TABLE cuspatlas.imaging_orphan_sweeps ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_orphan_sweeps FORCE ROW LEVEL SECURITY;
CREATE POLICY imaging_orphan_sweeps_select ON cuspatlas.imaging_orphan_sweeps
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_orphan_sweeps_insert ON cuspatlas.imaging_orphan_sweeps
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND actor_id = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.imaging_orphan_sweeps TO cuspatlas_app;

-- Non-blocking form of imaging_lock_content (same key): true when this transaction now holds the content
-- lock, false when another transaction (an ingest of the same bytes, or a byte removal) holds it. Domain
-- statements cannot call pg_* functions; this wrapper takes only a uuid and a checked digest.
CREATE FUNCTION cuspatlas.imaging_try_lock_content(p_tenant uuid, p_digest text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  IF p_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'content lock needs a sha-256 digest' USING ERRCODE = '22023';
  END IF;
  RETURN pg_try_advisory_xact_lock(hashtextextended('imaging-content:' || p_tenant::text || ':' || p_digest, 0));
END;
$$;
REVOKE ALL ON FUNCTION cuspatlas.imaging_try_lock_content(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.imaging_try_lock_content(uuid, text) TO cuspatlas_app;
