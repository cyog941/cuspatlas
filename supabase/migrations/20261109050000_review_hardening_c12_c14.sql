-- Hardening after the independent review of c-chart 1365bff (synthetic data only). New migration;
-- applied migrations are never edited.
--
-- Scope (as in 20261109020000): every check below binds the runtime role `cuspatlas_app`, the only
-- role the application uses. The guards test `current_user`, which is the runtime role for every
-- application statement because the runtime role never owns a SECURITY DEFINER function it could call
-- into; privileged roles (restore, table owner, superuser) can disable triggers in any case.

-- 1. Observed patient-reference transitions.
--
-- A merge, move or reversal row is only evidence of something the same transaction actually did.
-- Every update of a registered patient reference (and of patients.merged_into) is recorded here by a
-- SECURITY DEFINER trigger, keyed by the top-level transaction id. The runtime role cannot read or
-- write this table; the integrity guards ask `patient_reference_moved_now`, which answers only for the
-- current transaction.
CREATE TABLE cuspatlas.patient_reference_observations (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  xact_id xid8 NOT NULL,
  table_name text NOT NULL,
  column_name text NOT NULL,
  record_id uuid NOT NULL,
  old_patient_id uuid,
  new_patient_id uuid,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_reference_observations_xact
  ON cuspatlas.patient_reference_observations (xact_id, table_name, record_id);
ALTER TABLE cuspatlas.patient_reference_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.patient_reference_observations FORCE ROW LEVEL SECURITY;
-- Tenant-bound like every application table; the runtime role holds no grant on it at all (only the
-- SECURITY DEFINER trigger and check function below touch it, inside the caller's tenant context).
CREATE POLICY patient_reference_observations_tenant ON cuspatlas.patient_reference_observations
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
REVOKE ALL ON cuspatlas.patient_reference_observations FROM PUBLIC;
REVOKE ALL ON cuspatlas.patient_reference_observations FROM cuspatlas_app;

CREATE FUNCTION cuspatlas.observe_patient_reference() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $$
  DECLARE
    col text := TG_ARGV[0];
    o uuid := (to_jsonb(OLD) ->> col)::uuid;
    n uuid := (to_jsonb(NEW) ->> col)::uuid;
  BEGIN
    IF o IS DISTINCT FROM n THEN
      INSERT INTO cuspatlas.patient_reference_observations (tenant_id, xact_id, table_name, column_name, record_id,
        old_patient_id, new_patient_id)
      VALUES (NEW.tenant_id, pg_current_xact_id(), TG_TABLE_NAME, col, NEW.id, o, n);
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.observe_patient_reference() FROM PUBLIC;

CREATE FUNCTION cuspatlas.patient_reference_moved_now(tbl text, col text, rec uuid, o uuid, n uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM cuspatlas.patient_reference_observations x
      WHERE x.xact_id = pg_current_xact_id() AND x.table_name = tbl AND x.column_name = col AND x.record_id = rec
        AND x.old_patient_id IS NOT DISTINCT FROM o AND x.new_patient_id IS NOT DISTINCT FROM n)
  $$;
REVOKE ALL ON FUNCTION cuspatlas.patient_reference_moved_now(text, text, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.patient_reference_moved_now(text, text, uuid, uuid, uuid) TO cuspatlas_app;

CREATE TRIGGER patients_observe_merged_into AFTER UPDATE OF merged_into ON cuspatlas.patients
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('merged_into');
CREATE TRIGGER patient_relationships_observe_subject AFTER UPDATE OF subject_patient_id ON cuspatlas.patient_relationships
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('subject_patient_id');
CREATE TRIGGER patient_relationships_observe_counterparty
  AFTER UPDATE OF counterparty_patient_id ON cuspatlas.patient_relationships
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('counterparty_patient_id');
CREATE TRIGGER appointment_requests_observe_subject AFTER UPDATE OF subject_patient_id ON cuspatlas.appointment_requests
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('subject_patient_id');
CREATE TRIGGER appointments_observe_subject AFTER UPDATE OF subject_patient_id ON cuspatlas.appointments
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('subject_patient_id');
CREATE TRIGGER appointment_series_observe_subject AFTER UPDATE OF subject_patient_id ON cuspatlas.appointment_series
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('subject_patient_id');
CREATE TRIGGER waitlist_entries_observe_subject AFTER UPDATE OF subject_patient_id ON cuspatlas.waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('subject_patient_id');
CREATE TRIGGER clinical_encounters_observe_subject AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_encounters
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('subject_patient_id');
CREATE TRIGGER clinical_history_streams_observe_subject
  AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_history_streams
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('subject_patient_id');
CREATE TRIGGER clinical_charts_observe_subject AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_charts
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('subject_patient_id');
CREATE TRIGGER clinical_perio_streams_observe_subject AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_perio_streams
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('subject_patient_id');
CREATE TRIGGER clinical_treatment_plans_observe_subject
  AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_treatment_plans
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('subject_patient_id');
CREATE TRIGGER clinical_consents_observe_subject AFTER UPDATE OF subject_patient_id ON cuspatlas.clinical_consents
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.observe_patient_reference('subject_patient_id');

-- 1a. A merge row needs the merged identity's merged_into to go from NULL to the survivor in this very
--     transaction, and no other unreversed merge of the same merged patient may exist.
CREATE OR REPLACE FUNCTION cuspatlas.patient_merges_integrity_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user <> 'cuspatlas_app' THEN
      RETURN NULL;
    END IF;
    IF NEW.merged_at <> now()
       OR NOT EXISTS (SELECT 1 FROM cuspatlas.patients p WHERE p.id = NEW.merged_patient_id AND p.tenant_id = NEW.tenant_id
                      AND p.merged_into = NEW.survivor_patient_id)
       OR NOT EXISTS (SELECT 1 FROM cuspatlas.patients p WHERE p.id = NEW.survivor_patient_id AND p.tenant_id = NEW.tenant_id
                      AND p.merged_into IS NULL)
       OR NOT cuspatlas.patient_reference_moved_now('patients', 'merged_into', NEW.merged_patient_id, NULL,
                                                    NEW.survivor_patient_id)
       OR EXISTS (SELECT 1 FROM cuspatlas.patient_merges m WHERE m.tenant_id = NEW.tenant_id
                    AND m.merged_patient_id = NEW.merged_patient_id AND m.id <> NEW.id
                    AND NOT EXISTS (SELECT 1 FROM cuspatlas.patient_merge_reversals r WHERE r.merge_id = m.id))
       OR cuspatlas.patient_identity_digest(NEW.survivor_patient_id) IS DISTINCT FROM NEW.survivor_digest
       OR cuspatlas.patient_identity_digest(NEW.merged_patient_id) IS DISTINCT FROM NEW.merged_digest
       OR NEW.move_count <> (SELECT count(*) FROM cuspatlas.patient_merge_moves mv WHERE mv.merge_id = NEW.id
                             AND mv.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'a merge record must describe the merge performed in its transaction' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END
  $$;

-- 1b. A move names a record whose reference this transaction moved from the merged patient to the
--     survivor (observed), so a survivor's own record can never be listed as moved.
CREATE OR REPLACE FUNCTION cuspatlas.patient_merge_moves_integrity_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    m record;
    tbl text := cuspatlas.merge_class_table(NEW.record_class);
    excl text[] := cuspatlas.merge_class_digest_exclude(NEW.record_class);
    ref uuid;
    digest text;
  BEGIN
    IF current_user <> 'cuspatlas_app' THEN
      RETURN NULL;
    END IF;
    SELECT * INTO m FROM cuspatlas.patient_merges WHERE id = NEW.merge_id AND tenant_id = NEW.tenant_id;
    IF m IS NULL OR m.merged_at <> now() OR NEW.prior_patient_id <> m.merged_patient_id
       OR NEW.new_patient_id <> m.survivor_patient_id OR tbl IS NULL
       OR NOT (NEW.reference_column = ANY (excl))
       OR NOT cuspatlas.patient_reference_moved_now(tbl, NEW.reference_column, NEW.record_ref, m.merged_patient_id,
                                                    m.survivor_patient_id) THEN
      RAISE EXCEPTION 'a merge move must belong to the merge of its transaction' USING ERRCODE = '42501';
    END IF;
    EXECUTE format(
      'SELECT (to_jsonb(r) ->> %L)::uuid, encode(sha256(convert_to((to_jsonb(r) - %L::text[])::text, ''UTF8'')), ''hex'')
       FROM cuspatlas.%I r WHERE r.id = $1 AND r.tenant_id = $2', NEW.reference_column, excl, tbl)
      INTO ref, digest USING NEW.record_ref, NEW.tenant_id;
    IF ref IS DISTINCT FROM NEW.new_patient_id OR digest IS DISTINCT FROM NEW.content_digest_after THEN
      RAISE EXCEPTION 'a merge move must describe the moved record' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END
  $$;

-- 1c. A reversal targets the latest merge of its merged patient and needs merged_into to go from the
--     survivor back to NULL in this very transaction.
CREATE OR REPLACE FUNCTION cuspatlas.patient_merge_reversals_integrity_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    m record;
  BEGIN
    IF current_user <> 'cuspatlas_app' THEN
      RETURN NULL;
    END IF;
    SELECT * INTO m FROM cuspatlas.patient_merges WHERE id = NEW.merge_id AND tenant_id = NEW.tenant_id;
    IF m IS NULL OR NEW.reversed_at <> now()
       OR NOT EXISTS (SELECT 1 FROM cuspatlas.patients p WHERE p.id = m.merged_patient_id AND p.tenant_id = m.tenant_id
                      AND p.merged_into IS NULL)
       OR NOT cuspatlas.patient_reference_moved_now('patients', 'merged_into', m.merged_patient_id,
                                                    m.survivor_patient_id, NULL)
       OR EXISTS (SELECT 1 FROM cuspatlas.patient_merges later WHERE later.tenant_id = m.tenant_id
                    AND later.merged_patient_id = m.merged_patient_id AND later.id <> m.id
                    AND later.merged_at > m.merged_at) THEN
      RAISE EXCEPTION 'a merge reversal must restore the merged identity in its transaction' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END
  $$;

-- 2. Humans only: actor and witness checks for estimates, presentations, acceptances and consents.
--    The runtime role sees only its own principal and membership rows, so membership is answered by a
--    narrow SECURITY DEFINER function for the current tenant only.
CREATE FUNCTION cuspatlas.is_human_member(principal uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM cuspatlas.principals p JOIN cuspatlas.memberships m ON m.principal_id = p.id
      WHERE p.id = principal AND p.kind = 'human' AND m.tenant_id = cuspatlas.current_tenant_id()
        AND m.revoked_at IS NULL)
  $$;
REVOKE ALL ON FUNCTION cuspatlas.is_human_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cuspatlas.is_human_member(uuid) TO cuspatlas_app;

CREATE FUNCTION cuspatlas.human_actor_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    actor uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  BEGIN
    IF current_user = 'cuspatlas_app'
       AND (actor IS DISTINCT FROM cuspatlas.current_actor_id() OR NOT cuspatlas.is_human_member(actor)) THEN
      RAISE EXCEPTION 'this record is authored by the acting human member' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.human_actor_guard() FROM PUBLIC;
CREATE TRIGGER clinical_estimates_human BEFORE INSERT ON cuspatlas.clinical_estimates
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.human_actor_guard('created_by');
CREATE TRIGGER clinical_estimate_presentations_human BEFORE INSERT ON cuspatlas.clinical_estimate_presentations
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.human_actor_guard('presented_by');
CREATE TRIGGER clinical_plan_acceptances_human BEFORE INSERT ON cuspatlas.clinical_plan_acceptances
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.human_actor_guard('accepted_by');
CREATE TRIGGER clinical_consents_human BEFORE INSERT ON cuspatlas.clinical_consents
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.human_actor_guard('recorded_by');
CREATE TRIGGER clinical_consent_withdrawals_human BEFORE INSERT ON cuspatlas.clinical_consent_withdrawals
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.human_actor_guard('recorded_by');

-- 3. Estimates: a complete estimate's gross is the sum of its lines in its one currency (checked at
--    commit, after the lines are written; a line appended later is checked too).
CREATE FUNCTION cuspatlas.clinical_estimate_sum_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    est uuid := CASE WHEN TG_TABLE_NAME = 'clinical_estimates' THEN NEW.id ELSE (to_jsonb(NEW) ->> 'estimate_id')::uuid END;
    e record;
    s record;
  BEGIN
    IF current_user <> 'cuspatlas_app' THEN
      RETURN NULL;
    END IF;
    SELECT complete, currency, gross_minor INTO e FROM cuspatlas.clinical_estimates WHERE id = est;
    SELECT count(*) AS n, coalesce(sum(fee_minor), 0) AS total, count(DISTINCT fee_currency) AS currencies,
           min(fee_currency) AS currency
      INTO s FROM cuspatlas.clinical_estimate_lines WHERE estimate_id = est;
    IF e.complete AND (s.n = 0 OR s.total <> e.gross_minor OR s.currencies <> 1 OR s.currency <> e.currency) THEN
      RAISE EXCEPTION 'a complete estimate''s gross is the sum of its lines' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_estimate_sum_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER clinical_estimates_sum
  AFTER INSERT ON cuspatlas.clinical_estimates DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_estimate_sum_guard();
CREATE CONSTRAINT TRIGGER clinical_estimate_lines_sum
  AFTER INSERT ON cuspatlas.clinical_estimate_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_estimate_sum_guard();

-- 4. Acceptance: only of a presented, complete estimate, recording the plan-version revision the
--    acceptor saw (the domain re-evaluates completeness and coverage freshness at acceptance).
ALTER TABLE cuspatlas.clinical_plan_acceptances ADD COLUMN accepted_revision integer
  CHECK (accepted_revision >= 1);
CREATE FUNCTION cuspatlas.clinical_plan_acceptances_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user <> 'cuspatlas_app' THEN
      RETURN NEW;
    END IF;
    IF NEW.accepted_revision IS NULL
       OR NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_estimate_presentations p WHERE p.estimate_id = NEW.estimate_id
                      AND p.tenant_id = NEW.tenant_id)
       OR NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_estimates e WHERE e.id = NEW.estimate_id
                      AND e.tenant_id = NEW.tenant_id AND e.complete)
       OR NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_versions v WHERE v.id = NEW.plan_version_id
                      AND v.tenant_id = NEW.tenant_id AND v.revision = NEW.accepted_revision) THEN
      RAISE EXCEPTION 'an acceptance binds a presented, complete estimate at the current revision' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_plan_acceptances_guard() FROM PUBLIC;
CREATE TRIGGER clinical_plan_acceptances_guard BEFORE INSERT ON cuspatlas.clinical_plan_acceptances
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_plan_acceptances_guard();

-- 5. Consents: a plan-bound consent is for the plan's own patient; a witness is a human member of the
--    practice; a withdrawal signed by the patient names the consent's patient (source or survivor).
CREATE FUNCTION cuspatlas.clinical_consents_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user <> 'cuspatlas_app' THEN
      RETURN NEW;
    END IF;
    IF (NEW.plan_version_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM cuspatlas.clinical_plan_versions v
          JOIN cuspatlas.clinical_treatment_plans p ON p.id = v.plan_id AND p.tenant_id = v.tenant_id
          WHERE v.id = NEW.plan_version_id AND v.tenant_id = NEW.tenant_id
            AND p.subject_patient_id = NEW.subject_patient_id))
       OR NEW.subject_patient_id IS DISTINCT FROM NEW.origin_patient_id
       OR (NEW.witness_ref IS NOT NULL AND NOT cuspatlas.is_human_member(NEW.witness_ref)) THEN
      RAISE EXCEPTION 'a consent binds its own patient''s plan and a human witness' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_consents_insert_guard() FROM PUBLIC;
CREATE TRIGGER clinical_consents_insert BEFORE INSERT ON cuspatlas.clinical_consents
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_consents_insert_guard();

CREATE FUNCTION cuspatlas.clinical_consent_withdrawals_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user = 'cuspatlas_app' AND NEW.signer_kind = 'patient' AND NOT EXISTS (
         SELECT 1 FROM cuspatlas.clinical_consents c WHERE c.id = NEW.consent_id AND c.tenant_id = NEW.tenant_id
           AND NEW.signer_patient_id IN (c.origin_patient_id, c.subject_patient_id)) THEN
      RAISE EXCEPTION 'a withdrawal signed by the patient names the consent''s patient' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_consent_withdrawals_insert_guard() FROM PUBLIC;
CREATE TRIGGER clinical_consent_withdrawals_insert BEFORE INSERT ON cuspatlas.clinical_consent_withdrawals
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_consent_withdrawals_insert_guard();

-- 6. Rendered procedures: a procedure linked to a plan item (planned or a replacement) matches the
--    item's code, tooth and surfaces, not only its code.
CREATE OR REPLACE FUNCTION cuspatlas.clinical_rendered_procedures_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    target record;
    enc record;
  BEGIN
    SELECT e.subject_patient_id, e.state INTO enc FROM cuspatlas.clinical_encounters e
     WHERE e.id = NEW.encounter_id AND e.tenant_id = NEW.tenant_id;
    IF NOT EXISTS (SELECT 1 FROM cuspatlas.scheduling_resources r WHERE r.id = NEW.rendering_provider_id
                   AND r.tenant_id = NEW.tenant_id AND r.kind = 'provider') THEN
      RAISE EXCEPTION 'a rendering provider is a provider resource' USING ERRCODE = '42501';
    END IF;
    IF NEW.kind = 'reversal' THEN
      SELECT * INTO target FROM cuspatlas.clinical_rendered_procedures p
       WHERE p.id = NEW.reverses_procedure_id AND p.tenant_id = NEW.tenant_id;
      IF target.kind <> 'rendered'
         OR (NEW.encounter_id, NEW.origin_patient_id, NEW.code_ref, NEW.tooth_canonical_ref, NEW.surfaces, NEW.plan_item_id,
             NEW.rendering_provider_id, NEW.date_of_service, NEW.sequence)
            IS DISTINCT FROM (target.encounter_id, target.origin_patient_id, target.code_ref, target.tooth_canonical_ref,
             target.surfaces, target.plan_item_id, target.rendering_provider_id, target.date_of_service, target.sequence) THEN
        RAISE EXCEPTION 'a reversal mirrors the rendered procedure it reverses' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.replaces_procedure_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_rendered_procedures p
                     JOIN cuspatlas.clinical_rendered_procedures r ON r.reverses_procedure_id = p.id AND r.tenant_id = p.tenant_id
                     WHERE p.id = NEW.replaces_procedure_id AND p.tenant_id = NEW.tenant_id
                       AND p.encounter_id = NEW.encounter_id) THEN
        RAISE EXCEPTION 'a replacement names a reversed procedure of the same encounter' USING ERRCODE = '42501';
      END IF;
    ELSIF enc.state IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'a procedure is rendered in an open encounter' USING ERRCODE = '42501';
    END IF;
    IF NEW.origin_patient_id IS DISTINCT FROM enc.subject_patient_id THEN
      RAISE EXCEPTION 'a rendered procedure names its encounter patient' USING ERRCODE = '42501';
    END IF;
    IF NEW.plan_item_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM cuspatlas.clinical_plan_items i
         JOIN cuspatlas.clinical_plan_versions v ON v.id = i.plan_version_id AND v.tenant_id = i.tenant_id
         JOIN cuspatlas.clinical_treatment_plans pl ON pl.id = v.plan_id AND pl.tenant_id = v.tenant_id
         WHERE i.id = NEW.plan_item_id AND i.tenant_id = NEW.tenant_id AND pl.subject_patient_id = enc.subject_patient_id
           AND i.procedure_code_ref = NEW.code_ref
           AND i.tooth_canonical_ref IS NOT DISTINCT FROM NEW.tooth_canonical_ref
           AND (SELECT array_agg(x ORDER BY x) FROM unnest(i.surfaces) x)
               IS NOT DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(NEW.surfaces) x)) THEN
      RAISE EXCEPTION 'a planned procedure renders an item of the encounter patient as planned' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;

-- 7. Plan item lineage: an item derived from another is a carry-forward from the version its own
--    version supersedes (same plan, same patient), never an item of another plan.
CREATE FUNCTION cuspatlas.clinical_plan_items_lineage_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.derived_from_item_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM cuspatlas.clinical_plan_items src
         JOIN cuspatlas.clinical_plan_versions nv ON nv.id = NEW.plan_version_id AND nv.tenant_id = NEW.tenant_id
         WHERE src.id = NEW.derived_from_item_id AND src.tenant_id = NEW.tenant_id
           AND nv.supersedes_version_id = src.plan_version_id) THEN
      RAISE EXCEPTION 'a derived item comes from the version its own version supersedes' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_plan_items_lineage_guard() FROM PUBLIC;
CREATE TRIGGER clinical_plan_items_lineage BEFORE INSERT ON cuspatlas.clinical_plan_items
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_plan_items_lineage_guard();

-- 8. Item completion. `completed` is reached only through a rendered, non-reversed procedure: by the
--    `rendered` cause (a procedure of this item) or by a carry-forward that names the non-reversed
--    procedure behind its source item's completion. A reversed completion names the reversal of the
--    procedure that completed the item. Existing history is kept (NOT VALID); new rows are checked.
ALTER TABLE cuspatlas.clinical_plan_item_events DROP CONSTRAINT clinical_plan_item_events_procedure_cause;
ALTER TABLE cuspatlas.clinical_plan_item_events ADD CONSTRAINT clinical_plan_item_events_procedure_cause
  CHECK (CASE
    WHEN cause IN ('rendered', 'render_reversed') THEN rendered_procedure_id IS NOT NULL
    WHEN cause = 'carried_forward' THEN (to_state = 'completed') = (rendered_procedure_id IS NOT NULL)
    ELSE rendered_procedure_id IS NULL
  END) NOT VALID;

CREATE OR REPLACE FUNCTION cuspatlas.clinical_plan_item_events_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    last record;
    src record;
    item record;
  BEGIN
    SELECT e.sequence, e.to_state, e.rendered_procedure_id INTO last FROM cuspatlas.clinical_plan_item_events e
     WHERE e.item_id = NEW.item_id AND e.tenant_id = NEW.tenant_id ORDER BY e.sequence DESC LIMIT 1;
    SELECT i.id, i.detail_id, i.derived_from_item_id, p.subject_patient_id INTO item
      FROM cuspatlas.clinical_plan_items i
      JOIN cuspatlas.clinical_plan_versions v ON v.id = i.plan_version_id AND v.tenant_id = i.tenant_id
      JOIN cuspatlas.clinical_treatment_plans p ON p.id = v.plan_id AND p.tenant_id = v.tenant_id
     WHERE i.id = NEW.item_id AND i.tenant_id = NEW.tenant_id;
    IF NEW.cause IN ('created', 'carried_forward') THEN
      IF last IS NOT NULL OR NEW.sequence <> 1 OR NEW.from_state IS NOT NULL
         OR (NEW.cause = 'created' AND NEW.to_state <> 'proposed') THEN
        RAISE EXCEPTION 'an item starts with exactly one initial state' USING ERRCODE = '42501';
      END IF;
      IF NEW.cause = 'carried_forward' THEN
        SELECT e.to_state, e.reason_code, e.appointment_id, e.rendered_procedure_id INTO src
          FROM cuspatlas.clinical_plan_item_events e
         WHERE e.item_id = item.derived_from_item_id AND e.tenant_id = NEW.tenant_id ORDER BY e.sequence DESC LIMIT 1;
        IF item.derived_from_item_id IS NULL OR src IS NULL
           OR (src.to_state, src.reason_code) IS DISTINCT FROM (NEW.to_state, NEW.reason_code)
           OR (NEW.to_state = 'scheduled' AND src.appointment_id IS DISTINCT FROM NEW.appointment_id) THEN
          RAISE EXCEPTION 'a carried-forward item carries its source item state' USING ERRCODE = '42501';
        END IF;
        IF NEW.to_state = 'completed' AND NOT EXISTS (
             SELECT 1 FROM cuspatlas.clinical_rendered_procedures p
             WHERE p.id = NEW.rendered_procedure_id AND p.tenant_id = NEW.tenant_id AND p.kind = 'rendered'
               AND (p.plan_item_id = item.derived_from_item_id OR p.id = src.rendered_procedure_id)
               AND NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_rendered_procedures r
                               WHERE r.reverses_procedure_id = p.id AND r.tenant_id = p.tenant_id)) THEN
          RAISE EXCEPTION 'a carried-forward completion names the non-reversed procedure behind it' USING ERRCODE = '42501';
        END IF;
      ELSIF NEW.to_state = 'completed' THEN
        RAISE EXCEPTION 'completion is recorded by a rendered procedure (C14)' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF last IS NULL OR NEW.sequence <> last.sequence + 1 OR NEW.from_state IS DISTINCT FROM last.to_state THEN
      RAISE EXCEPTION 'item transitions are appended in order from the current state' USING ERRCODE = '42501';
    END IF;
    IF NEW.cause = 'rendered' THEN
      IF NEW.to_state <> 'completed' OR NEW.from_state NOT IN ('accepted', 'scheduled') OR NOT EXISTS (
           SELECT 1 FROM cuspatlas.clinical_rendered_procedures p WHERE p.id = NEW.rendered_procedure_id
             AND p.tenant_id = NEW.tenant_id AND p.kind = 'rendered' AND p.plan_item_id = NEW.item_id
             AND NOT EXISTS (SELECT 1 FROM cuspatlas.clinical_rendered_procedures r
                             WHERE r.reverses_procedure_id = p.id AND r.tenant_id = p.tenant_id)) THEN
        RAISE EXCEPTION 'completion names a non-reversed rendered procedure of this item' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.cause = 'render_reversed' THEN
      IF NEW.from_state <> 'completed' OR NEW.to_state <> 'accepted' OR NOT EXISTS (
           SELECT 1 FROM cuspatlas.clinical_rendered_procedures r
           WHERE r.id = NEW.rendered_procedure_id AND r.tenant_id = NEW.tenant_id AND r.kind = 'reversal'
             AND r.reverses_procedure_id = last.rendered_procedure_id) THEN
        RAISE EXCEPTION 'a reversed completion names the reversal of the procedure that completed the item'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NEW.to_state = 'completed' THEN
        RAISE EXCEPTION 'completion is recorded by a rendered procedure (C14)' USING ERRCODE = '42501';
      END IF;
      IF (NEW.from_state, NEW.to_state) NOT IN (
           ('proposed', 'accepted'), ('proposed', 'declined'), ('proposed', 'discontinued'),
           ('accepted', 'scheduled'), ('accepted', 'declined'), ('accepted', 'discontinued'),
           ('scheduled', 'accepted'), ('scheduled', 'declined'), ('scheduled', 'discontinued'),
           ('declined', 'proposed')) THEN
        RAISE EXCEPTION 'item transition is not in the allowed set' USING ERRCODE = '42501';
      END IF;
      IF (NEW.from_state, NEW.to_state) IN (('scheduled', 'accepted'), ('declined', 'proposed')) AND NEW.reason_code IS NULL THEN
        RAISE EXCEPTION 'this item transition needs a reason' USING ERRCODE = '42501';
      END IF;
      IF (NEW.cause = 'detail_declined' AND NEW.to_state <> 'declined')
         OR (NEW.cause = 'detail_discontinued' AND NEW.to_state <> 'discontinued') THEN
        RAISE EXCEPTION 'a detail consequence matches the detail state' USING ERRCODE = '42501';
      END IF;
      IF NEW.cause = 'direct' AND EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_detail_events d
                                          WHERE d.detail_id = item.detail_id AND d.tenant_id = NEW.tenant_id) THEN
        RAISE EXCEPTION 'an item of a declined or discontinued detail takes no direct transition' USING ERRCODE = '42501';
      END IF;
      IF NEW.to_state = 'scheduled' AND NOT EXISTS (
           SELECT 1 FROM cuspatlas.appointments a WHERE a.id = NEW.appointment_id AND a.tenant_id = NEW.tenant_id
             AND a.subject_patient_id = item.subject_patient_id) THEN
        RAISE EXCEPTION 'a scheduled item names an appointment of the plan patient' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_items i
               JOIN cuspatlas.clinical_plan_versions s ON s.supersedes_version_id = i.plan_version_id
                 AND s.tenant_id = i.tenant_id
               WHERE i.id = NEW.item_id AND i.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'items of a superseded plan version are frozen' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
