-- Closeout D (synthetic engineering implementation, recommended-pending-approval): durable-first
-- orphan-bytes removal. Before Closeout D the sweep removed bytes inside its own transaction, so a
-- rollback after a removal left no record of it. Now a real sweep commits one removal intent per
-- candidate together with its sweep record, before any byte is touched. Each intent is then finished
-- in its own transaction under the content lock: references re-checked, bytes removed, intent marked.
-- A failure between those steps leaves the committed intent `intended`; the next real sweep (or a
-- same-key retry of the same sweep) finishes it, or marks it `absent` when the bytes are already gone.
-- Rows hold content digests and storage keys only, never patient data. They are append-only except
-- the one completion transition, and are never deleted.
CREATE TABLE cuspatlas.imaging_orphan_removals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  sweep_id uuid NOT NULL,
  digest_sha256 text NOT NULL CHECK (digest_sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL CHECK (octet_length(storage_key) <= 512),
  intended_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  state text NOT NULL DEFAULT 'intended' CHECK (state IN ('intended', 'removed', 'absent', 'kept')),
  kept_reason text CHECK (kept_reason IN ('withinGrace', 'liveObject', 'tombstoneRetained', 'legalHold',
    'exportPackage')),
  completed_sweep_id uuid,
  completed_by uuid REFERENCES cuspatlas.principals (id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, sweep_id) REFERENCES cuspatlas.imaging_orphan_sweeps (tenant_id, id),
  FOREIGN KEY (tenant_id, completed_sweep_id) REFERENCES cuspatlas.imaging_orphan_sweeps (tenant_id, id),
  CHECK (storage_key = 't/' || tenant_id::text || '/sha256/' || substr(digest_sha256, 1, 2) || '/' || digest_sha256),
  CHECK ((state = 'kept') = (kept_reason IS NOT NULL)),
  CHECK ((state = 'intended') = (completed_at IS NULL)),
  CHECK (state = 'intended' OR (completed_by IS NOT NULL AND completed_sweep_id IS NOT NULL))
);
-- One open intent per content key: a later sweep finishes it rather than recording a second one.
CREATE UNIQUE INDEX imaging_orphan_removals_open ON cuspatlas.imaging_orphan_removals (tenant_id, storage_key)
  WHERE state = 'intended';
CREATE INDEX imaging_orphan_removals_sweep ON cuspatlas.imaging_orphan_removals (tenant_id, sweep_id);

CREATE FUNCTION cuspatlas.imaging_orphan_removals_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'orphan removal intents are never deleted' USING ERRCODE = '42501';
    END IF;
    IF OLD.state <> 'intended' OR NEW.state = 'intended'
      OR NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.sweep_id <> OLD.sweep_id
      OR NEW.digest_sha256 <> OLD.digest_sha256 OR NEW.storage_key <> OLD.storage_key
      OR NEW.intended_by <> OLD.intended_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'an orphan removal intent is completed once and is otherwise immutable'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER imaging_orphan_removals_guard BEFORE UPDATE OR DELETE ON cuspatlas.imaging_orphan_removals
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.imaging_orphan_removals_guard();

ALTER TABLE cuspatlas.imaging_orphan_removals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.imaging_orphan_removals FORCE ROW LEVEL SECURITY;
CREATE POLICY imaging_orphan_removals_select ON cuspatlas.imaging_orphan_removals
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY imaging_orphan_removals_insert ON cuspatlas.imaging_orphan_removals
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND intended_by = cuspatlas.current_actor_id()
    AND state = 'intended');
CREATE POLICY imaging_orphan_removals_update ON cuspatlas.imaging_orphan_removals
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id())
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND completed_by = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.imaging_orphan_removals TO cuspatlas_app;
GRANT UPDATE (state, kept_reason, completed_sweep_id, completed_by, completed_at)
  ON cuspatlas.imaging_orphan_removals TO cuspatlas_app;
