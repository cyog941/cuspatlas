-- Closed-loop claims workflow (CL-01..CL-12) over the existing B/C/I contracts (synthetic data only; fake
-- clearinghouse only; ADR 0008 pending billing approval). A workflow instance per claim lineage links the
-- owning domains' facts BY REFERENCE (claim versions, validations, attachment packages, submissions,
-- partner events, appeals, remittance lines and resolutions, settlements, journal entries, statements);
-- it never copies or collapses their state machines and never posts money itself. Each observed step
-- records its input versions, authority, outcome, attempt and next expected event; exceptions are owned,
-- deduplicated per underlying issue and escalate a bounded number of times through durable timers
-- delivered by the outbox worker. Closure is its own fact with the resolution breakdown.

-- CL-04 attachment package placeholder: a manifest bound to one claim version, its object references
-- (I owns bytes; syn-img-/syn-obj- references only) and their digests, rechecked before dispatch.
CREATE TABLE cuspatlas.rcm_claim_attachment_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  claim_id uuid NOT NULL,
  version_id uuid NOT NULL,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 50),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id, tenant_id) REFERENCES cuspatlas.rcm_claims (id, tenant_id),
  FOREIGN KEY (version_id, tenant_id) REFERENCES cuspatlas.rcm_claim_versions (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, version_id)
);
CREATE TABLE cuspatlas.rcm_claim_attachment_package_items (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  package_id uuid NOT NULL,
  object_ref text NOT NULL CHECK (object_ref ~ '^syn-(img|obj)-[a-z0-9-]{1,60}$'),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (package_id, tenant_id) REFERENCES cuspatlas.rcm_claim_attachment_packages (id, tenant_id),
  PRIMARY KEY (tenant_id, package_id, object_ref)
);

CREATE TABLE cuspatlas.rcm_claim_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  claim_id uuid NOT NULL,
  workflow_policy_id uuid,
  submission_policy_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id, tenant_id) REFERENCES cuspatlas.rcm_claims (id, tenant_id),
  FOREIGN KEY (workflow_policy_id, tenant_id) REFERENCES cuspatlas.rcm_workflow_policies (id, tenant_id),
  FOREIGN KEY (submission_policy_id, tenant_id) REFERENCES cuspatlas.rcm_submission_policies (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, claim_id)
);
CREATE TRIGGER rcm_claim_workflows_guard
  BEFORE UPDATE OR DELETE ON cuspatlas.rcm_claim_workflows
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.billing_aggregate_guard();

CREATE TABLE cuspatlas.rcm_claim_workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  workflow_id uuid NOT NULL,
  step text NOT NULL CHECK (step ~ '^[a-z][a-z_]{0,40}$'),
  subject_kind text NOT NULL CHECK (subject_kind ~ '^[a-z][A-Za-z]{0,40}$'),
  subject_ref text NOT NULL CHECK (subject_ref ~ '^[0-9a-f-]{36}(:[0-9]{1,3})?$'),
  outcome text NOT NULL CHECK (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 10),
  input_versions jsonb NOT NULL CHECK (jsonb_typeof(input_versions) = 'object'),
  authority jsonb NOT NULL CHECK (jsonb_typeof(authority) = 'object'),
  next_expected text CHECK (next_expected ~ '^[a-z][a-z_]{0,40}$'),
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workflow_id, tenant_id) REFERENCES cuspatlas.rcm_claim_workflows (id, tenant_id),
  UNIQUE (tenant_id, workflow_id, step, subject_ref, outcome, attempt)
);

CREATE TABLE cuspatlas.rcm_claim_workflow_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  workflow_id uuid NOT NULL,
  issue_key text NOT NULL CHECK (issue_key ~ '^[a-z][a-z_]{0,40}:[0-9a-f:-]{1,80}$'),
  occurrence integer NOT NULL CHECK (occurrence >= 1),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  owner text NOT NULL CHECK (owner IN ('billing', 'front_office', 'clinical', 'billing_manager')),
  owed_by text NOT NULL CHECK (owed_by IN ('practice', 'patient', 'payer', 'platform')),
  source_ref text CHECK (source_ref ~ '^[0-9a-f-]{36}(:[0-9]{1,3})?$'),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  due_at timestamptz NOT NULL,
  opened_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  FOREIGN KEY (workflow_id, tenant_id) REFERENCES cuspatlas.rcm_claim_workflows (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, workflow_id, issue_key, occurrence)
);
CREATE TABLE cuspatlas.rcm_claim_workflow_exception_events (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  exception_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('escalated', 'resolved')),
  level integer NOT NULL CHECK (level BETWEEN 0 AND 10),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  recorded_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (exception_id, tenant_id) REFERENCES cuspatlas.rcm_claim_workflow_exceptions (id, tenant_id),
  PRIMARY KEY (tenant_id, exception_id, kind, level),
  CHECK (kind = 'escalated' OR level = 0)
);

CREATE TABLE cuspatlas.rcm_claim_workflow_timers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  workflow_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('payer_follow_up', 'exception_escalation')),
  subject_ref text NOT NULL CHECK (subject_ref ~ '^[0-9a-f-]{36}$'),
  level integer NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 10),
  due_at timestamptz NOT NULL,
  workflow_policy_id uuid,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workflow_id, tenant_id) REFERENCES cuspatlas.rcm_claim_workflows (id, tenant_id),
  FOREIGN KEY (workflow_policy_id, tenant_id) REFERENCES cuspatlas.rcm_workflow_policies (id, tenant_id),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, workflow_id, kind, subject_ref, level)
);
CREATE TABLE cuspatlas.rcm_claim_workflow_timer_firings (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  timer_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
  fired_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  fired_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (timer_id, tenant_id) REFERENCES cuspatlas.rcm_claim_workflow_timers (id, tenant_id),
  PRIMARY KEY (tenant_id, timer_id)
);

CREATE TABLE cuspatlas.rcm_claim_workflow_closures (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  workflow_id uuid NOT NULL,
  breakdown jsonb NOT NULL CHECK (jsonb_typeof(breakdown) = 'array'),
  breakdown_digest text NOT NULL CHECK (breakdown_digest ~ '^[0-9a-f]{64}$'),
  closed_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  closed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workflow_id, tenant_id) REFERENCES cuspatlas.rcm_claim_workflows (id, tenant_id),
  PRIMARY KEY (tenant_id, workflow_id)
);

DO $$
DECLARE
  t text;
  actor text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rcm_claim_attachment_packages', 'rcm_claim_attachment_package_items', 'rcm_claim_workflows',
    'rcm_claim_workflow_steps', 'rcm_claim_workflow_exceptions', 'rcm_claim_workflow_exception_events',
    'rcm_claim_workflow_timers', 'rcm_claim_workflow_timer_firings', 'rcm_claim_workflow_closures'] LOOP
    actor := CASE t
      WHEN 'rcm_claim_attachment_packages' THEN 'created_by'
      WHEN 'rcm_claim_workflows' THEN 'created_by'
      WHEN 'rcm_claim_workflow_steps' THEN 'recorded_by'
      WHEN 'rcm_claim_workflow_exceptions' THEN 'opened_by'
      WHEN 'rcm_claim_workflow_exception_events' THEN 'recorded_by'
      WHEN 'rcm_claim_workflow_timers' THEN 'created_by'
      WHEN 'rcm_claim_workflow_timer_firings' THEN 'fired_by'
      WHEN 'rcm_claim_workflow_closures' THEN 'closed_by'
      ELSE NULL END;
    EXECUTE format('ALTER TABLE cuspatlas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE cuspatlas.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON cuspatlas.%I FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id())', t || '_select', t);
    IF actor IS NULL THEN
      EXECUTE format('CREATE POLICY %I ON cuspatlas.%I FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id())', t || '_insert', t);
    ELSE
      EXECUTE format('CREATE POLICY %I ON cuspatlas.%I FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND %I = cuspatlas.current_actor_id())', t || '_insert', t, actor);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT ON cuspatlas.%I TO cuspatlas_app', t);
    IF t <> 'rcm_claim_workflows' THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON cuspatlas.%I FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only()', t || '_append_only', t);
    END IF;
  END LOOP;
END
$$;
CREATE POLICY rcm_claim_workflows_update ON cuspatlas.rcm_claim_workflows FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
GRANT UPDATE (version, updated_at) ON cuspatlas.rcm_claim_workflows TO cuspatlas_app;
