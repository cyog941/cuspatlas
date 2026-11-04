-- B7 follow-up: resolution of remittance review lines, and versioned claims-workflow policy data
-- (synthetic data only; fake clearinghouse only; ADR 0008 pending billing approval). A review line is
-- never edited: its resolution is a separate fact (match to a claim line, post with an approved residual
-- adjustment, route to appeal, or write off under a workflow policy with another human's approval), and
-- every posting it makes is a balanced journal entry tagged with the remittance and linked here.

-- Versioned workflow policy data (CL-08 deadlines, bounded escalation and the write-off limit), per
-- payer or tenant default. A new version never changes an earlier one.
CREATE TABLE cuspatlas.rcm_workflow_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  payer_ref text CHECK (payer_ref ~ '^syn-payer-[a-z0-9-]{1,40}$'),
  version_no integer NOT NULL CHECK (version_no >= 1),
  acknowledgement_due_minutes integer NOT NULL CHECK (acknowledgement_due_minutes BETWEEN 0 AND 525600),
  follow_up_minutes integer NOT NULL CHECK (follow_up_minutes BETWEEN 0 AND 525600),
  exception_due_minutes integer NOT NULL CHECK (exception_due_minutes BETWEEN 0 AND 525600),
  max_escalations integer NOT NULL CHECK (max_escalations BETWEEN 0 AND 10),
  write_off_limit_minor bigint NOT NULL CHECK (write_off_limit_minor BETWEEN 0 AND 99999999999),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX rcm_workflow_policies_version
  ON cuspatlas.rcm_workflow_policies (tenant_id, coalesce(payer_ref, ''), version_no);

CREATE TABLE cuspatlas.rcm_remittance_line_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  remittance_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 500),
  action text NOT NULL CHECK (action IN ('match_claim_line', 'post_with_adjustment', 'route_to_appeal', 'write_off')),
  claim_id uuid NOT NULL,
  claim_line_no integer NOT NULL CHECK (claim_line_no >= 1),
  charge_id uuid NOT NULL,
  coverage_id uuid NOT NULL,
  residual_minor bigint NOT NULL CHECK (residual_minor >= 0),
  workflow_policy_id uuid,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  needs_approval boolean NOT NULL,
  requested_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (remittance_id, tenant_id) REFERENCES cuspatlas.rcm_remittances (id, tenant_id),
  FOREIGN KEY (tenant_id, remittance_id, line_no) REFERENCES cuspatlas.rcm_remittance_lines (tenant_id, remittance_id, line_no),
  FOREIGN KEY (claim_id, tenant_id) REFERENCES cuspatlas.rcm_claims (id, tenant_id),
  FOREIGN KEY (charge_id, tenant_id) REFERENCES cuspatlas.billing_charges (id, tenant_id),
  FOREIGN KEY (coverage_id, tenant_id) REFERENCES cuspatlas.rcm_coverages (id, tenant_id),
  FOREIGN KEY (workflow_policy_id, tenant_id) REFERENCES cuspatlas.rcm_workflow_policies (id, tenant_id),
  UNIQUE (id, tenant_id),
  CHECK (needs_approval = (action IN ('post_with_adjustment', 'write_off'))),
  CHECK ((action = 'write_off') = (workflow_policy_id IS NOT NULL))
);
CREATE TABLE cuspatlas.rcm_remittance_resolution_decisions (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  resolution_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason_code text CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  decided_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (resolution_id, tenant_id) REFERENCES cuspatlas.rcm_remittance_line_resolutions (id, tenant_id),
  PRIMARY KEY (tenant_id, resolution_id)
);
CREATE FUNCTION cuspatlas.rcm_resolution_decision_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM cuspatlas.rcm_remittance_line_resolutions r
               WHERE r.id = NEW.resolution_id AND r.tenant_id = NEW.tenant_id
                 AND (r.requested_by = NEW.decided_by OR NOT r.needs_approval)) THEN
      RAISE EXCEPTION 'a resolution needing approval is decided by someone other than its requester'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION cuspatlas.rcm_resolution_decision_guard() FROM PUBLIC;
CREATE TRIGGER rcm_remittance_resolution_decisions_guard
  BEFORE INSERT ON cuspatlas.rcm_remittance_resolution_decisions
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.rcm_resolution_decision_guard();
-- Every journal entry a resolution posted (linked facts; the entries carry the remittance too).
CREATE TABLE cuspatlas.rcm_remittance_resolution_postings (
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  resolution_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  FOREIGN KEY (resolution_id, tenant_id) REFERENCES cuspatlas.rcm_remittance_line_resolutions (id, tenant_id),
  FOREIGN KEY (entry_id, tenant_id) REFERENCES cuspatlas.billing_journal_entries (id, tenant_id),
  PRIMARY KEY (tenant_id, resolution_id, entry_id)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rcm_workflow_policies', 'rcm_remittance_line_resolutions',
    'rcm_remittance_resolution_decisions', 'rcm_remittance_resolution_postings'] LOOP
    EXECUTE format('ALTER TABLE cuspatlas.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE cuspatlas.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON cuspatlas.%I FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id())', t || '_select', t);
    EXECUTE format('GRANT SELECT, INSERT ON cuspatlas.%I TO cuspatlas_app', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON cuspatlas.%I FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only()', t || '_append_only', t);
  END LOOP;
END
$$;
-- Actor columns are bound to the transaction actor (no forged requester, decider or author).
CREATE POLICY rcm_workflow_policies_insert ON cuspatlas.rcm_workflow_policies FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY rcm_remittance_line_resolutions_insert ON cuspatlas.rcm_remittance_line_resolutions FOR INSERT
  TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND requested_by = cuspatlas.current_actor_id());
CREATE POLICY rcm_remittance_resolution_decisions_insert ON cuspatlas.rcm_remittance_resolution_decisions
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND decided_by = cuspatlas.current_actor_id());
CREATE POLICY rcm_remittance_resolution_postings_insert ON cuspatlas.rcm_remittance_resolution_postings
  FOR INSERT TO cuspatlas_app WITH CHECK (tenant_id = cuspatlas.current_tenant_id());
