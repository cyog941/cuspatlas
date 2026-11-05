import type { Money } from './money';

/**
 * B10 versioned billing export (workstream B scope; M1 owns the full export contract, manifest and
 * completeness validation). Every billing and rcm table of the tenant, one array of rows per table,
 * references preserved, no tenant field, and every `*_minor` amount as Money (`{currency, minor}`).
 * Synthetic data only.
 */
export const BILLING_EXPORT_FORMAT = 'cuspatlas-billing-export/1';
export const BILLING_EXPORT_TABLES = [
  'billing_settings',
  'billing_fee_schedules',
  'billing_fee_schedule_versions',
  'billing_fee_schedule_items',
  'billing_charges',
  'billing_payment_attempts',
  'billing_payments',
  // H2 M-9: the migration opening chain the opening journal lines reference (opening items, their
  // staged records, packages without the source tables, profiles); never the migration workspace.
  'migration_source_profiles',
  'migration_packages',
  'migration_staged_records',
  'migration_opening_items',
  'billing_journal_entries',
  'billing_journal_lines',
  'billing_payment_plans',
  'billing_payment_plan_terms',
  'billing_payment_plan_events',
  'billing_payment_plan_attempts',
  'billing_statements',
  'billing_procedure_events',
  'rcm_coverages',
  'rcm_coverage_versions',
  'rcm_eligibility_records',
  'billing_adjustment_requests',
  'billing_adjustment_decisions',
  'rcm_submission_policies',
  'rcm_submission_policy_revocations',
  'rcm_workflow_policies',
  'rcm_claims',
  'rcm_claim_versions',
  'rcm_claim_lines',
  'rcm_claim_attachments',
  'rcm_claim_attachment_packages',
  'rcm_claim_attachment_package_items',
  'rcm_claim_validations',
  'rcm_claim_submissions',
  'rcm_claim_events',
  'rcm_claim_procedure_holds',
  'rcm_appeals',
  'rcm_appeal_reviews',
  'rcm_appeal_send_resolutions',
  'rcm_secondary_claims',
  'rcm_remittances',
  'rcm_remittance_lines',
  'rcm_remittance_settlements',
  'rcm_remittance_reversals',
  'rcm_remittance_line_resolutions',
  'rcm_remittance_resolution_decisions',
  'rcm_remittance_resolution_postings',
  'rcm_claim_workflows',
  'rcm_claim_workflow_steps',
  'rcm_claim_workflow_exceptions',
  'rcm_claim_workflow_exception_events',
  'rcm_claim_workflow_timers',
  'rcm_claim_workflow_timer_firings',
  'rcm_claim_workflow_closures',
] as const;
export type BillingExportTable = (typeof BILLING_EXPORT_TABLES)[number];
export type BillingExportRow = Readonly<Record<string, unknown>>;
export interface BillingExport {
  readonly format: typeof BILLING_EXPORT_FORMAT;
  readonly exportedAt: string;
  /** The tenant billing currency (the currency of every Money amount of a row without its own). */
  readonly currency: string;
  readonly tables: Readonly<Record<string, readonly BillingExportRow[]>>;
}
/** An exported amount column (`*_minor`) carries Money, never a bare number. */
export const isMoneyColumn = (column: string) => column.endsWith('_minor');
export type ExportedMoney = Money;
