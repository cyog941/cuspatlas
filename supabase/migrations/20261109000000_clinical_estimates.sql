-- C12: treatment alternatives, estimates and versioned acceptance (synthetic data only).
-- C-D7 recommended-pending-approval: an estimate is never a coverage guarantee; with unknown
-- coverage it shows a labelled unknown, otherwise a bounded range; never a guaranteed patient
-- responsibility. Amounts are the shared Money shape stored as an explicit currency and integer
-- minor units, from staff-entered per-item fee placeholders (no fee schedule data: B9 later).
-- Coverage and discount assumptions are references with provenance and freshness only (B5 owns
-- eligibility, not built). Estimates, lines, assumptions, presentations and acceptances are
-- append-only; a change is a new estimate version.

-- Lines name an item of the estimated plan version (composite key).
ALTER TABLE cuspatlas.clinical_plan_items ADD CONSTRAINT clinical_plan_items_id_version_tenant
  UNIQUE (id, plan_version_id, tenant_id);

-- Alternatives: plans for one clinical problem share a group. Creating an alternative never changes
-- a sibling plan.
CREATE TABLE cuspatlas.clinical_plan_alternatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  group_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (plan_id, tenant_id) REFERENCES cuspatlas.clinical_treatment_plans (id, tenant_id),
  UNIQUE (tenant_id, plan_id)
);
CREATE INDEX clinical_plan_alternatives_group ON cuspatlas.clinical_plan_alternatives (tenant_id, group_id);

CREATE TABLE cuspatlas.clinical_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  plan_version_id uuid NOT NULL,
  number integer NOT NULL CHECK (number >= 1),
  supersedes_estimate_id uuid,
  fee_schedule_version_ref text CHECK (fee_schedule_version_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  gross_minor bigint CHECK (gross_minor >= 0),
  complete boolean NOT NULL,
  coverage_status text NOT NULL CHECK (coverage_status IN ('entered', 'unknown', 'stale')),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (plan_version_id, tenant_id) REFERENCES cuspatlas.clinical_plan_versions (id, tenant_id),
  FOREIGN KEY (supersedes_estimate_id, plan_version_id, tenant_id)
    REFERENCES cuspatlas.clinical_estimates (id, plan_version_id, tenant_id),
  UNIQUE (plan_version_id, number),
  UNIQUE (tenant_id, supersedes_estimate_id),
  UNIQUE (id, tenant_id),
  UNIQUE (id, plan_version_id, tenant_id),
  CHECK ((supersedes_estimate_id IS NULL) = (number = 1)),
  -- An incomplete estimate carries no amount at all.
  CHECK (complete = (gross_minor IS NOT NULL)),
  CHECK ((gross_minor IS NULL) = (currency IS NULL))
);

-- An estimate version is appended after the current one, never beside it.
CREATE FUNCTION cuspatlas.clinical_estimates_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    head record;
  BEGIN
    SELECT e.id, e.number INTO head FROM cuspatlas.clinical_estimates e
     WHERE e.plan_version_id = NEW.plan_version_id AND e.tenant_id = NEW.tenant_id ORDER BY e.number DESC LIMIT 1;
    IF (head IS NULL AND NEW.number <> 1)
       OR (head IS NOT NULL AND (NEW.number <> head.number + 1 OR NEW.supersedes_estimate_id IS DISTINCT FROM head.id)) THEN
      RAISE EXCEPTION 'an estimate version supersedes the current one' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM cuspatlas.clinical_plan_versions s WHERE s.supersedes_version_id = NEW.plan_version_id
               AND s.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'a superseded plan version takes no new estimate' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_estimates_insert_guard() FROM PUBLIC;
CREATE TRIGGER clinical_estimates_insert
  BEFORE INSERT ON cuspatlas.clinical_estimates
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_estimates_insert_guard();

CREATE TABLE cuspatlas.clinical_estimate_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  estimate_id uuid NOT NULL,
  plan_version_id uuid NOT NULL,
  item_id uuid NOT NULL,
  fee_schedule_ref text NOT NULL CHECK (fee_schedule_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  fee_currency text NOT NULL CHECK (fee_currency ~ '^[A-Z]{3}$'),
  fee_minor bigint NOT NULL CHECK (fee_minor BETWEEN 0 AND 10000000000),
  FOREIGN KEY (estimate_id, plan_version_id, tenant_id)
    REFERENCES cuspatlas.clinical_estimates (id, plan_version_id, tenant_id),
  FOREIGN KEY (item_id, plan_version_id, tenant_id)
    REFERENCES cuspatlas.clinical_plan_items (id, plan_version_id, tenant_id),
  UNIQUE (estimate_id, item_id)
);

CREATE TABLE cuspatlas.clinical_estimate_assumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  estimate_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 20),
  kind text NOT NULL CHECK (kind IN ('coverage', 'discount')),
  source_ref text NOT NULL CHECK (source_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  source_as_of timestamptz NOT NULL,
  FOREIGN KEY (estimate_id, tenant_id) REFERENCES cuspatlas.clinical_estimates (id, tenant_id),
  UNIQUE (estimate_id, ordinal)
);

-- Presentation: once, only for the current complete estimate, with the coverage status re-evaluated
-- at the instant of presentation (stale is shown, never silently reused).
CREATE TABLE cuspatlas.clinical_estimate_presentations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  estimate_id uuid NOT NULL,
  coverage_status text NOT NULL CHECK (coverage_status IN ('entered', 'unknown', 'stale')),
  presented_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  presented_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (estimate_id, tenant_id) REFERENCES cuspatlas.clinical_estimates (id, tenant_id),
  UNIQUE (tenant_id, estimate_id)
);

-- Acceptance binds one plan version to one estimate version of that plan version. Full scope only
-- (phase-level acceptance is refused, never recorded as full). C13 binds consent as a later fact.
CREATE TABLE cuspatlas.clinical_plan_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  plan_version_id uuid NOT NULL,
  estimate_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('full')),
  accepted_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  accepted_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  FOREIGN KEY (estimate_id, plan_version_id, tenant_id)
    REFERENCES cuspatlas.clinical_estimates (id, plan_version_id, tenant_id),
  UNIQUE (tenant_id, plan_version_id),
  UNIQUE (id, tenant_id),
  UNIQUE (id, plan_version_id, tenant_id)
);

CREATE FUNCTION cuspatlas.clinical_estimate_current_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM cuspatlas.clinical_estimates s WHERE s.supersedes_estimate_id = NEW.estimate_id
               AND s.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'a superseded estimate cannot be presented or accepted' USING ERRCODE = '42501';
    END IF;
    IF TG_TABLE_NAME = 'clinical_estimate_presentations' AND NOT EXISTS (
         SELECT 1 FROM cuspatlas.clinical_estimates e WHERE e.id = NEW.estimate_id AND e.tenant_id = NEW.tenant_id
           AND e.complete) THEN
      RAISE EXCEPTION 'an incomplete estimate cannot be presented as a quote' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_estimate_current_guard() FROM PUBLIC;
CREATE TRIGGER clinical_estimate_presentations_current
  BEFORE INSERT ON cuspatlas.clinical_estimate_presentations
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_estimate_current_guard();
CREATE TRIGGER clinical_plan_acceptances_current
  BEFORE INSERT ON cuspatlas.clinical_plan_acceptances
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_estimate_current_guard();

-- A plan version's acceptance reference is a real C12 acceptance of that very version. Checked at
-- commit by a constraint trigger rather than a foreign key, because a key would close a cycle
-- (versions -> acceptances -> estimates -> versions) that the ordered restore (F) cannot load.
CREATE FUNCTION cuspatlas.clinical_plan_versions_acceptance_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.acceptance_ref IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM cuspatlas.clinical_plan_acceptances a
         WHERE a.id = NEW.acceptance_ref AND a.plan_version_id = NEW.id AND a.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'a plan version acceptance must be a recorded acceptance of that version'
        USING ERRCODE = '23503';
    END IF;
    RETURN NULL;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.clinical_plan_versions_acceptance_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER clinical_plan_versions_acceptance
  AFTER INSERT OR UPDATE OF acceptance_ref ON cuspatlas.clinical_plan_versions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.clinical_plan_versions_acceptance_guard();

CREATE TRIGGER clinical_plan_alternatives_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_plan_alternatives
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_estimates_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_estimates
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_estimate_lines_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_estimate_lines
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_estimate_assumptions_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_estimate_assumptions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_estimate_presentations_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_estimate_presentations
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();
CREATE TRIGGER clinical_plan_acceptances_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.clinical_plan_acceptances
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.clinical_plan_alternatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_plan_alternatives FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_estimates FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_estimate_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_estimate_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_estimate_assumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_estimate_assumptions FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_estimate_presentations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_estimate_presentations FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_plan_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.clinical_plan_acceptances FORCE ROW LEVEL SECURITY;

CREATE POLICY clinical_plan_alternatives_select ON cuspatlas.clinical_plan_alternatives
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_plan_alternatives_insert ON cuspatlas.clinical_plan_alternatives
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_estimates_select ON cuspatlas.clinical_estimates
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_estimates_insert ON cuspatlas.clinical_estimates
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_estimate_lines_select ON cuspatlas.clinical_estimate_lines
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_estimate_lines_insert ON cuspatlas.clinical_estimate_lines
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_estimate_assumptions_select ON cuspatlas.clinical_estimate_assumptions
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_estimate_assumptions_insert ON cuspatlas.clinical_estimate_assumptions
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_estimate_presentations_select ON cuspatlas.clinical_estimate_presentations
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_estimate_presentations_insert ON cuspatlas.clinical_estimate_presentations
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND presented_by = cuspatlas.current_actor_id());
CREATE POLICY clinical_plan_acceptances_select ON cuspatlas.clinical_plan_acceptances
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY clinical_plan_acceptances_insert ON cuspatlas.clinical_plan_acceptances
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND accepted_by = cuspatlas.current_actor_id());

-- Explicit grants: SELECT and INSERT only (append-only). No UPDATE, DELETE or TRUNCATE.
GRANT SELECT, INSERT ON cuspatlas.clinical_plan_alternatives, cuspatlas.clinical_estimates,
  cuspatlas.clinical_estimate_lines, cuspatlas.clinical_estimate_assumptions,
  cuspatlas.clinical_estimate_presentations, cuspatlas.clinical_plan_acceptances TO cuspatlas_app;
