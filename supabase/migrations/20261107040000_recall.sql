-- S16: recall policy and due computation (ADR 0009 S-D7, recommended-pending-approval). Synthetic
-- data only. Policies are versioned rows per tenant and category (append-only); a computation names the
-- version it used. The implementable basis is an attended visit (S11 attendance); the completed-procedure
-- basis waits for C14 and is refused. The due list is computed on read and writes nothing; a recall
-- contact task is a separate audited command, and whether the patient may be contacted is E6's.

CREATE TABLE cuspatlas.recall_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  category text NOT NULL CHECK (category ~ '^[a-z][a-z0-9-]{0,39}$'),
  version integer NOT NULL CHECK (version >= 1),
  interval_months integer NOT NULL CHECK (interval_months BETWEEN 1 AND 60),
  basis text NOT NULL CHECK (basis IN ('attended_visit')),
  appointment_type_codes text[] NOT NULL DEFAULT '{}',
  exclude_booked boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, category, version),
  UNIQUE (id, tenant_id)
);

CREATE TABLE cuspatlas.recall_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_patient_id uuid NOT NULL,
  location_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  category text NOT NULL,
  policy_version integer NOT NULL,
  due_date date NOT NULL,
  last_event_appointment_id uuid,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  resolution_reason text CHECK (resolution_reason ~ '^[a-z_]{1,64}$'),
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_patient_id, tenant_id) REFERENCES cuspatlas.patients (id, tenant_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES cuspatlas.scheduling_locations (id, tenant_id),
  FOREIGN KEY (policy_id, tenant_id) REFERENCES cuspatlas.recall_policies (id, tenant_id),
  CHECK ((state = 'resolved') = (resolution_reason IS NOT NULL AND resolved_at IS NOT NULL))
);
-- One open task per patient and policy version (duplicate creation returns the recorded task).
CREATE UNIQUE INDEX recall_tasks_one_open ON cuspatlas.recall_tasks (tenant_id, subject_patient_id, policy_id)
  WHERE state = 'open';

CREATE TRIGGER recall_policies_append_only
  BEFORE UPDATE OR DELETE ON cuspatlas.recall_policies
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.append_only();

ALTER TABLE cuspatlas.recall_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.recall_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.recall_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.recall_tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY recall_policies_select ON cuspatlas.recall_policies
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY recall_policies_insert ON cuspatlas.recall_policies
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY recall_tasks_select ON cuspatlas.recall_tasks
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY recall_tasks_insert ON cuspatlas.recall_tasks
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND created_by = cuspatlas.current_actor_id());
CREATE POLICY recall_tasks_update ON cuspatlas.recall_tasks
  FOR UPDATE TO cuspatlas_app
  USING (tenant_id = cuspatlas.current_tenant_id()) WITH CHECK (tenant_id = cuspatlas.current_tenant_id());

GRANT SELECT, INSERT ON cuspatlas.recall_policies TO cuspatlas_app;
GRANT SELECT, INSERT ON cuspatlas.recall_tasks TO cuspatlas_app;
GRANT UPDATE (subject_patient_id, state, resolution_reason, resolved_at, version, updated_at)
  ON cuspatlas.recall_tasks TO cuspatlas_app;
