-- S16 completed-procedure recall basis, now that C14 exists (synthetic data only). Recall policy and the
-- due computation stay S-owned; the qualifying event is read through the C14 seam (the latest active,
-- non-reversed rendered procedure with one of the policy's provisional SYN- codes). recall_policies
-- stays append-only: the new columns are set at insert.
ALTER TABLE cuspatlas.recall_policies DROP CONSTRAINT recall_policies_basis_check;
ALTER TABLE cuspatlas.recall_policies ADD CONSTRAINT recall_policies_basis_check
  CHECK (basis IN ('attended_visit', 'completed_procedure'));
ALTER TABLE cuspatlas.recall_policies ADD COLUMN procedure_code_refs text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(procedure_code_refs) <= 20 AND cuspatlas.clinical_syn_codes_valid(procedure_code_refs));
ALTER TABLE cuspatlas.recall_policies ADD CONSTRAINT recall_policies_procedure_codes
  CHECK ((basis = 'completed_procedure') = (cardinality(procedure_code_refs) >= 1));

-- A task created under the procedure basis names the procedure it was computed from.
ALTER TABLE cuspatlas.recall_tasks ADD COLUMN last_event_procedure_id uuid;
ALTER TABLE cuspatlas.recall_tasks ADD CONSTRAINT recall_tasks_last_event_procedure
  FOREIGN KEY (last_event_procedure_id, tenant_id) REFERENCES cuspatlas.clinical_rendered_procedures (id, tenant_id);
ALTER TABLE cuspatlas.recall_tasks ADD CONSTRAINT recall_tasks_one_last_event
  CHECK (last_event_appointment_id IS NULL OR last_event_procedure_id IS NULL);
