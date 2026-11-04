-- Hardening after the independent review of c-chart 3b242d4 (synthetic data only). New migration;
-- applied migrations are never edited. Scope as in 20261109050000: the checks bind the runtime role
-- `cuspatlas_app`; privileged roles can disable triggers in any case.

-- 1. A clinical patient reference moves only with the merge or the reversal recorded in this very
--    transaction. Forward (merged -> survivor): a merge of that pair created in this transaction (its
--    merged_into NULL -> survivor observed now) that lists the record as moved and is not reversed.
--    Reversal (survivor -> merged): the reversal of that merge created in this transaction (its
--    merged_into survivor -> NULL observed now), a listed move of this record in that merge, and that
--    merge is the record's current lineage (no later merge moved this record). A reversal of an older
--    merge can never license a relink in an unrelated transaction.
CREATE OR REPLACE FUNCTION cuspatlas.clinical_subject_relink_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.subject_patient_id IS NOT DISTINCT FROM OLD.subject_patient_id THEN
      RETURN NULL;
    END IF;
    IF EXISTS (
      SELECT 1 FROM cuspatlas.patient_merges m
      JOIN cuspatlas.patient_merge_moves mv ON mv.merge_id = m.id AND mv.tenant_id = m.tenant_id
      WHERE m.tenant_id = NEW.tenant_id AND mv.record_ref = NEW.id AND mv.reference_column = 'subject_patient_id'
        AND cuspatlas.merge_class_table(mv.record_class) = TG_TABLE_NAME
        AND m.merged_patient_id = OLD.subject_patient_id AND m.survivor_patient_id = NEW.subject_patient_id
        AND m.merged_at = now()
        AND cuspatlas.patient_reference_moved_now('patients', 'merged_into', m.merged_patient_id, NULL,
                                                  m.survivor_patient_id)
        AND NOT EXISTS (SELECT 1 FROM cuspatlas.patient_merge_reversals r WHERE r.merge_id = m.id)
    ) THEN
      RETURN NULL;
    END IF;
    IF EXISTS (
      SELECT 1 FROM cuspatlas.patient_merges m
      JOIN cuspatlas.patient_merge_moves mv ON mv.merge_id = m.id AND mv.tenant_id = m.tenant_id
      JOIN cuspatlas.patient_merge_reversals r ON r.merge_id = m.id AND r.tenant_id = m.tenant_id
      WHERE m.tenant_id = NEW.tenant_id AND mv.record_ref = NEW.id AND mv.reference_column = 'subject_patient_id'
        AND cuspatlas.merge_class_table(mv.record_class) = TG_TABLE_NAME
        AND m.survivor_patient_id = OLD.subject_patient_id AND m.merged_patient_id = NEW.subject_patient_id
        AND r.reversed_at = now()
        AND cuspatlas.patient_reference_moved_now('patients', 'merged_into', m.merged_patient_id,
                                                  m.survivor_patient_id, NULL)
        AND cuspatlas.patient_reference_moved_now(TG_TABLE_NAME, 'subject_patient_id', NEW.id,
                                                  OLD.subject_patient_id, NEW.subject_patient_id)
        AND NOT EXISTS (
          SELECT 1 FROM cuspatlas.patient_merge_moves later_mv
          JOIN cuspatlas.patient_merges later ON later.id = later_mv.merge_id AND later.tenant_id = later_mv.tenant_id
          WHERE later_mv.tenant_id = NEW.tenant_id AND later_mv.record_ref = NEW.id
            AND later_mv.reference_column = 'subject_patient_id'
            AND cuspatlas.merge_class_table(later_mv.record_class) = TG_TABLE_NAME
            AND later.id <> m.id AND later.merged_at > m.merged_at)
    ) THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'a clinical patient reference moves only with the merge or reversal of its transaction'
      USING ERRCODE = '42501';
  END
  $$;

-- 1a. The listed moves cover every observed move: a reference moved from the merged patient to the
--     survivor in a merge's transaction (or back in its reversal's transaction) is a move row of that
--     merge. The SECURITY DEFINER function returns only the current transaction's observations for one
--     patient pair in the current tenant; the guard (runtime role, RLS-bound) compares them with the
--     merge's move rows.
CREATE FUNCTION cuspatlas.patient_reference_moves_now(o uuid, n uuid)
  RETURNS TABLE (table_name text, column_name text, record_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT x.table_name, x.column_name, x.record_id FROM cuspatlas.patient_reference_observations x
    WHERE x.xact_id = pg_current_xact_id() AND x.tenant_id = cuspatlas.current_tenant_id()
      AND x.table_name <> 'patients' AND x.old_patient_id = o AND x.new_patient_id = n
  $$;
REVOKE ALL ON FUNCTION cuspatlas.patient_reference_moves_now(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.patient_reference_moves_now(uuid, uuid) TO cuspatlas_app;

CREATE FUNCTION cuspatlas.patient_merge_moves_cover_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    m record;
    forward boolean := TG_TABLE_NAME = 'patient_merges';
  BEGIN
    IF current_user <> 'cuspatlas_app' THEN
      RETURN NULL;
    END IF;
    SELECT * INTO m FROM cuspatlas.patient_merges
     WHERE id = CASE WHEN forward THEN NEW.id ELSE (to_jsonb(NEW) ->> 'merge_id')::uuid END
       AND tenant_id = NEW.tenant_id;
    IF m IS NULL OR EXISTS (
         SELECT 1 FROM cuspatlas.patient_reference_moves_now(
             CASE WHEN forward THEN m.merged_patient_id ELSE m.survivor_patient_id END,
             CASE WHEN forward THEN m.survivor_patient_id ELSE m.merged_patient_id END) x
         WHERE NOT EXISTS (
           SELECT 1 FROM cuspatlas.patient_merge_moves mv
           WHERE mv.merge_id = m.id AND mv.tenant_id = m.tenant_id AND mv.record_ref = x.record_id
             AND mv.reference_column = x.column_name AND cuspatlas.merge_class_table(mv.record_class) = x.table_name)) THEN
      RAISE EXCEPTION 'every reference moved by a merge or its reversal is listed as a move of that merge'
        USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.patient_merge_moves_cover_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER patient_merges_moves_cover
  AFTER INSERT ON cuspatlas.patient_merges DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.patient_merge_moves_cover_guard();
CREATE CONSTRAINT TRIGGER patient_merge_reversals_moves_cover
  AFTER INSERT ON cuspatlas.patient_merge_reversals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.patient_merge_moves_cover_guard();

-- 2. Lab case rows are authored by the acting human member (attachments had no actor check; the
--    case and its transitions get the same explicit check as every other clinical record).
CREATE TRIGGER clinical_lab_cases_human BEFORE INSERT ON cuspatlas.clinical_lab_cases
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.human_actor_guard('created_by');
CREATE TRIGGER clinical_lab_case_transitions_human BEFORE INSERT ON cuspatlas.clinical_lab_case_transitions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.human_actor_guard('actor_id');
CREATE TRIGGER clinical_lab_case_attachments_human BEFORE INSERT ON cuspatlas.clinical_lab_case_attachments
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.human_actor_guard('added_by');

-- 3. Retention of patient_reference_observations. The guards read only the current transaction's
--    rows (`patient_reference_moved_now`, `patient_merge_unlisted_moves`), so rows of finished
--    (committed or aborted) transactions are never consulted again and may be pruned. The maintenance
--    function belongs to the migration owner; the runtime role has no grant. A row whose transaction
--    status is no longer known (older than the commit log) is finished.
CREATE POLICY patient_reference_observations_prune ON cuspatlas.patient_reference_observations
  FOR DELETE TO CURRENT_USER USING (true);
CREATE FUNCTION cuspatlas.prune_patient_reference_observations() RETURNS bigint
  LANGUAGE sql SET search_path = pg_catalog
  AS $$
    WITH gone AS (
      DELETE FROM cuspatlas.patient_reference_observations x
      WHERE x.xact_id <> pg_current_xact_id()
        AND coalesce(pg_xact_status(x.xact_id), 'committed') <> 'in progress'
      RETURNING 1)
    SELECT count(*) FROM gone
  $$;
REVOKE ALL ON FUNCTION cuspatlas.prune_patient_reference_observations() FROM PUBLIC;

-- 4. Verification query set for the privileged C18 import (which loads with triggers off): the
--    invariants the deferred and insert guards enforce for application writes, answered for one tenant.
--    Owner only; the runtime role has no grant. Returns one row per violated invariant. Consent
--    template and evidence digests are references to artifacts stored outside C (no content to
--    recompute); their format and reference/digest pairing are CHECK constraints, which stay active
--    under session_replication_role = replica. Note version digests are recomputed by the domain.
CREATE FUNCTION cuspatlas.clinical_import_violations(tenant uuid) RETURNS TABLE (check_name text, ref uuid)
  LANGUAGE sql STABLE SET search_path = pg_catalog
  AS $$
    -- A complete estimate's gross is the sum of its lines in its one currency.
    SELECT 'estimate_sum', e.id FROM cuspatlas.clinical_estimates e
    WHERE e.tenant_id = tenant AND e.complete AND NOT EXISTS (
      SELECT 1 FROM (SELECT count(*) AS n, coalesce(sum(l.fee_minor), 0) AS total,
                            count(DISTINCT l.fee_currency) AS currencies, min(l.fee_currency) AS currency
                     FROM cuspatlas.clinical_estimate_lines l WHERE l.estimate_id = e.id AND l.tenant_id = e.tenant_id) s
      WHERE s.n > 0 AND s.total = e.gross_minor AND s.currencies = 1 AND s.currency = e.currency)
    UNION ALL
    -- An acceptance binds a presented, complete, not superseded estimate of its version at a revision
    -- the version reached.
    SELECT 'acceptance', a.id FROM cuspatlas.clinical_plan_acceptances a
    WHERE a.tenant_id = tenant AND (
      a.accepted_revision IS NULL
      OR NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_estimate_presentations p WHERE p.estimate_id = a.estimate_id
                     AND p.tenant_id = a.tenant_id)
      OR NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_estimates e WHERE e.id = a.estimate_id
                     AND e.tenant_id = a.tenant_id AND e.complete)
      OR NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_versions v WHERE v.id = a.plan_version_id
                     AND v.tenant_id = a.tenant_id AND v.revision >= a.accepted_revision)
      OR EXISTS (SELECT 1 FROM cuspatlas.clinical_estimates s WHERE s.supersedes_estimate_id = a.estimate_id
                 AND s.tenant_id = a.tenant_id AND s.created_at <= a.accepted_at))
    UNION ALL
    -- A co-signature binds the digest of the version it co-signs.
    SELECT 'cosignature_digest', c.id FROM cuspatlas.clinical_note_cosignatures c
    JOIN cuspatlas.clinical_note_versions v ON v.id = c.note_version_id
    WHERE c.tenant_id = tenant AND (v.tenant_id <> c.tenant_id OR v.content_digest <> c.content_digest)
    UNION ALL
    -- A lab case state is its latest transition; a referral state is its latest event.
    SELECT 'lab_case_state', l.id FROM cuspatlas.clinical_lab_cases l
    WHERE l.tenant_id = tenant AND l.state IS DISTINCT FROM (
      SELECT t.to_state FROM cuspatlas.clinical_lab_case_transitions t WHERE t.case_id = l.id
        AND t.tenant_id = l.tenant_id ORDER BY t.sequence DESC LIMIT 1)
    UNION ALL
    SELECT 'referral_state', r.id FROM cuspatlas.clinical_referrals r
    WHERE r.tenant_id = tenant AND r.state IS DISTINCT FROM (
      SELECT e.to_state FROM cuspatlas.clinical_referral_events e WHERE e.referral_id = r.id
        AND e.tenant_id = r.tenant_id ORDER BY e.sequence DESC LIMIT 1)
    UNION ALL
    -- A note header counts exactly its frozen versions.
    SELECT 'note_head', n.id FROM cuspatlas.clinical_notes n
    WHERE n.tenant_id = tenant AND n.head_sequence <> (
      SELECT count(*) FROM cuspatlas.clinical_note_versions v WHERE v.note_id = n.id AND v.tenant_id = n.tenant_id)
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_import_violations(uuid) FROM PUBLIC;
