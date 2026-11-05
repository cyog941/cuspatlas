-- A12 evaluation runs (workstream A batch 2; synthetic cases and model only; acceptance thresholds and
-- reviewer authority open under A-S3). Each run records the model, prompt version and case set version
-- it judged, the repetitions, the verdict, the metrics, the failing cases and per-case results. Runs are
-- append-only: a later run never rewrites an earlier one, and the gate of record is the latest run of
-- the current model, prompt version and case set. A result is never clinical validation.

CREATE TABLE cuspatlas.ai_evaluation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES cuspatlas.tenants (id),
  use_case text NOT NULL CHECK (use_case ~ '^[a-z][A-Za-z]{1,63}$'),
  model_ref text NOT NULL CHECK (model_ref ~ '^[A-Za-z0-9._:-]{1,64}$'),
  prompt_version_ref text NOT NULL CHECK (prompt_version_ref ~ '^[a-z0-9.-]{1,64}$'),
  case_set_version text NOT NULL CHECK (case_set_version ~ '^[a-z0-9.-]{1,64}$'),
  repetitions integer NOT NULL CHECK (repetitions BETWEEN 1 AND 10),
  verdict text NOT NULL CHECK (verdict IN ('pass', 'fail', 'inconclusive')),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  failed_cases text[] NOT NULL,
  case_results jsonb NOT NULL CHECK (jsonb_typeof(case_results) = 'array'),
  ran_by uuid NOT NULL REFERENCES cuspatlas.principals (id),
  ran_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ai_evaluation_runs_identity
  ON cuspatlas.ai_evaluation_runs (tenant_id, use_case, model_ref, prompt_version_ref, case_set_version, ran_at DESC);
CREATE TRIGGER ai_evaluation_runs_guard BEFORE UPDATE OR DELETE ON cuspatlas.ai_evaluation_runs
  FOR EACH ROW EXECUTE FUNCTION cuspatlas.agent_records_append_only();

ALTER TABLE cuspatlas.ai_evaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuspatlas.ai_evaluation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_evaluation_runs_select ON cuspatlas.ai_evaluation_runs
  FOR SELECT TO cuspatlas_app USING (tenant_id = cuspatlas.current_tenant_id());
CREATE POLICY ai_evaluation_runs_insert ON cuspatlas.ai_evaluation_runs
  FOR INSERT TO cuspatlas_app
  WITH CHECK (tenant_id = cuspatlas.current_tenant_id() AND ran_by = cuspatlas.current_actor_id());
GRANT SELECT, INSERT ON cuspatlas.ai_evaluation_runs TO cuspatlas_app;
