import { createHash, randomUUID } from 'node:crypto';
import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  isRefusalError,
  listEnvelope,
  type ObjectStorePort,
  type TenantTransaction,
  validateExportCreate,
  validateExportDownload,
  validateExportGrant,
  validateExportGrantRevoke,
  validateExportListQuery,
  validateExportQuery,
} from '@cuspatlas/contracts';
import { canonicalJson } from '../commands/digest';
import type { ReplayCodec, StoredResult } from '../commands/execute-once';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { signGrantToken, verifyGrantToken } from '../imaging/tokens';
import {
  type ComposedDocument,
  documentDigest,
  GRANT_SECONDS,
  type PackageBytes,
  type PackageBytesRequest,
  PRACTICE_EXPORT_DOCUMENTS,
  type PracticeExporters,
  readVerifiedPackage,
} from '../migration/practice-export';
import {
  type AutomationBase,
  assertRef,
  checkEnvelope,
  conflict,
  failed,
  notFound,
  unavailable,
  validate,
} from './base';

/**
 * A15 export surface. One API over three scopes, all granted by the ordinary `exports.create` scope
 * (no licence, plan or feature key exists on this path):
 * - `practice`: the M1 practice export (cuspatlas-practice-export/1), composed by reference;
 * - `patient`: the right-of-access export of one patient across S, I, C, E and B;
 * - `domain`: one module's export document.
 * Patient and domain packages use `cuspatlas-export/1` (docs/export-format.md) and the M1 digest and
 * document registry; each module export is called as the caller, so it re-authorizes for itself.
 */
export const EXPORT_FORMAT = 'cuspatlas-export/1' as const;
export const EXPORT_DOMAINS = ['scheduling', 'imaging', 'clinical', 'engagement', 'billing'] as const;
export type ExportDomain = (typeof EXPORT_DOMAINS)[number];
const M1_PURPOSES = new Set(['practiceExit', 'verification', 'archiveCopy']);

export interface ExportPracticePort {
  create(
    ctx: ActorContext,
    e: CommandEnvelope<unknown>,
  ): Promise<
    CommandResult<{
      exportRef: string;
      format: string;
      manifestDigest: string;
      packageDigest: string;
      byteLength: number;
      documentCount: number;
    }>
  >;
  grant(ctx: ActorContext, e: CommandEnvelope<unknown>): Promise<{ data: { token: string } }>;
  download(ctx: ActorContext, e: CommandEnvelope<unknown>): Promise<{ data: unknown }>;
  /** A8: the M1 package bytes through the same M1 grant and download policy. */
  downloadBytes?(
    ctx: ActorContext,
    e: CommandEnvelope<unknown>,
    request?: PackageBytesRequest,
  ): Promise<{ data: PackageBytes }>;
}

export interface ExportDeps {
  readonly exporters: PracticeExporters;
  readonly practice?: ExportPracticePort;
  readonly objectStore?: ObjectStorePort;
  readonly tokenSecret?: Uint8Array | null;
  /** Largest package a build stores (bytes); larger builds fail as export_too_large. */
  readonly maxPackageBytes?: number;
  /** Largest package returned inline by download (bytes); larger ones are refused, never truncated. */
  readonly maxInlineBytes?: number;
  /** A request still building after this many seconds is failed as build_interrupted (crash recovery). */
  readonly buildDeadlineSeconds?: number;
}

type Doc = ComposedDocument;
type Row = Record<string, unknown>;
export interface ScopedManifest {
  readonly format: typeof EXPORT_FORMAT;
  readonly exportRef: string;
  readonly exportedAt: string;
  readonly scope: { kind: 'patient'; subjectRef: string } | { kind: 'domain'; domain: ExportDomain };
  readonly documents: { format: string; digestSha256: string; tables: Record<string, number> }[];
  readonly blobs: { digestSha256: string; byteLength: number }[];
  readonly licenceGate: 'none';
  readonly completeness: { readonly basis: string };
}
export interface ScopedPackage {
  readonly manifest: ScopedManifest;
  readonly documents: readonly Doc[];
}

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

/** Patient-link columns (`patient_id`, `subject_patient_id`, `survivor_patient_id`, ...) with a value. */
const patientLinks = (r: Row): unknown[] =>
  Object.entries(r)
    .filter(([k, v]) => /(^|_)patient_id$/.test(k) && v !== null && v !== undefined)
    .map(([, v]) => v);

/**
 * How a row of a module export table belongs to one patient (owner-declared; A batch 4 hardening):
 * `patient` names the column holding the patient; `parent` names a column referencing an already
 * included row of another table; `referencedBy` includes a row an included row of `table` references
 * through `column`. A table with several entries is included through any of them. Tables absent from
 * this map (reference data, configuration, payer-level or multi-patient records such as remittances,
 * the migration workspace and call events) never contribute rows to a patient export. Derived from
 * the foreign keys of the export tables and reviewed by hand: owning columns are the subject side
 * (`subject_patient_id`, a merge survivor, the reassignment target, a statement guarantor).
 */
export type PatientLink =
  | { readonly patient: string }
  | { readonly parent: string; readonly column: string }
  | { readonly referencedBy: string; readonly column: string };
const p = (patient: string): PatientLink => ({ patient });
const via = (parent: string, column: string): PatientLink => ({ parent, column });
export const PATIENT_EXPORT_LINKAGE: Readonly<Record<string, readonly PatientLink[]>> = {
  // Scheduling and patients.
  patient_status_history: [p('patient_id')],
  patient_relationships: [p('subject_patient_id')],
  patient_merges: [p('survivor_patient_id')],
  patient_merge_moves: [via('patient_merges', 'merge_id')],
  patient_merge_reversals: [via('patient_merges', 'merge_id')],
  appointment_requests: [p('subject_patient_id')],
  appointment_request_transitions: [via('appointment_requests', 'request_id')],
  appointments: [p('subject_patient_id')],
  appointment_lifecycle_events: [via('appointments', 'appointment_id')],
  appointment_overrides: [via('appointments', 'appointment_id')],
  appointment_attendance_transitions: [via('appointments', 'appointment_id')],
  visit_context_items: [via('appointments', 'appointment_id')],
  appointment_series: [p('subject_patient_id')],
  appointment_series_occurrences: [via('appointment_series', 'series_id')],
  appointment_series_exceptions: [via('appointment_series', 'series_id')],
  notification_intents: [via('suppression_decisions', 'suppression_decision_ref')],
  waitlist_entries: [p('subject_patient_id')],
  cancellation_recoveries: [via('appointments', 'appointment_id')],
  waitlist_offers: [via('waitlist_entries', 'entry_id')],
  recall_tasks: [p('subject_patient_id')],
  scheduling_staging_entries: [
    via('appointments', 'appointment_id'),
    via('appointment_requests', 'request_id'),
  ],
  scheduling_provider_requests: [via('appointments', 'appointment_id')],
  appointment_patient_reassignments: [p('new_patient_id')],
  // Imaging: an object belongs to the patient through its image reference or its dedupe patient.
  imaging_match_decisions: [p('subject_patient_id')],
  imaging_image_refs: [via('imaging_match_decisions', 'minted_decision_id')],
  imaging_objects: [p('dedupe_patient_id'), { referencedBy: 'imaging_image_refs', column: 'object_id' }],
  imaging_object_provenance: [via('imaging_objects', 'object_id')],
  imaging_mount_slots: [via('imaging_objects', 'object_id')],
  imaging_annotations: [via('imaging_objects', 'object_id')],
  imaging_derivations: [via('imaging_objects', 'source_object_id')],
  imaging_deletion_requests: [via('imaging_objects', 'object_id')],
  // Clinical record.
  clinical_encounters: [p('subject_patient_id')],
  clinical_encounter_assignments: [via('clinical_encounters', 'encounter_id')],
  clinical_history_streams: [p('subject_patient_id')],
  clinical_history_versions: [via('clinical_history_streams', 'stream_id')],
  clinical_history_items: [via('clinical_history_streams', 'stream_id')],
  clinical_history_changes: [via('clinical_history_items', 'item_id')],
  clinical_history_verifications: [via('clinical_history_changes', 'change_id')],
  clinical_history_reviews: [via('clinical_encounters', 'encounter_id')],
  clinical_charts: [p('subject_patient_id')],
  clinical_chart_entries: [via('clinical_charts', 'chart_id')],
  clinical_perio_streams: [p('subject_patient_id')],
  clinical_perio_exams: [via('clinical_perio_streams', 'stream_id')],
  clinical_perio_measurements: [via('clinical_perio_exams', 'exam_id')],
  clinical_perio_derivations: [via('clinical_perio_exams', 'exam_id')],
  clinical_perio_derived_values: [via('clinical_perio_derivations', 'derivation_id')],
  clinical_treatment_plans: [p('subject_patient_id')],
  clinical_plan_versions: [via('clinical_treatment_plans', 'plan_id')],
  clinical_plan_details: [via('clinical_plan_versions', 'plan_version_id')],
  clinical_plan_items: [via('clinical_plan_details', 'detail_id')],
  clinical_plan_detail_events: [via('clinical_plan_details', 'detail_id')],
  clinical_plan_alternatives: [via('clinical_treatment_plans', 'plan_id')],
  clinical_estimates: [via('clinical_plan_versions', 'plan_version_id')],
  clinical_estimate_lines: [via('clinical_estimates', 'estimate_id')],
  clinical_estimate_assumptions: [via('clinical_estimates', 'estimate_id')],
  clinical_estimate_presentations: [via('clinical_estimates', 'estimate_id')],
  clinical_plan_acceptances: [via('clinical_estimates', 'estimate_id')],
  clinical_consents: [p('subject_patient_id')],
  clinical_consent_withdrawals: [via('clinical_consents', 'consent_id')],
  clinical_notes: [via('clinical_encounters', 'encounter_id')],
  clinical_note_versions: [via('clinical_notes', 'note_id')],
  clinical_note_cosignatures: [via('clinical_note_versions', 'note_version_id')],
  clinical_rendered_procedures: [p('origin_patient_id')],
  clinical_plan_item_events: [via('clinical_plan_items', 'item_id')],
  clinical_encounter_image_links: [via('clinical_encounters', 'encounter_id')],
  clinical_lab_cases: [p('subject_patient_id')],
  clinical_lab_case_transitions: [via('clinical_lab_cases', 'case_id')],
  clinical_lab_case_attachments: [via('clinical_lab_cases', 'case_id')],
  clinical_referrals: [p('subject_patient_id')],
  clinical_referral_selections: [via('clinical_referrals', 'referral_id')],
  clinical_referral_shares: [via('clinical_referrals', 'referral_id')],
  clinical_referral_events: [via('clinical_referrals', 'referral_id')],
  clinical_referral_responses: [via('clinical_referrals', 'referral_id')],
  // Engagement: a thread belongs to its patient; its messages only through it.
  portal_principals: [p('person_patient_id')],
  communication_consents: [p('patient_id')],
  contact_verifications: [p('patient_id')],
  suppression_decisions: [p('subject_patient_id')],
  recall_enrollments: [p('patient_id')],
  message_threads: [p('patient_id')],
  thread_messages: [via('message_threads', 'thread_id')],
  outbound_messages: [p('patient_id')],
  delivery_attempts: [via('outbound_messages', 'message_id')],
  message_receipts: [via('outbound_messages', 'message_id')],
  intake_submissions: [p('patient_id')],
  intake_submission_consents: [via('intake_submissions', 'submission_id')],
  intake_review_items: [p('patient_id')],
  call_links: [p('patient_id')],
  // Billing and revenue cycle.
  billing_charges: [p('patient_id')],
  billing_payment_attempts: [p('patient_id')],
  billing_payments: [p('patient_id')],
  migration_opening_items: [p('patient_id')],
  billing_journal_entries: [via('billing_charges', 'charge_id'), via('billing_payments', 'payment_id')],
  billing_journal_lines: [p('patient_id')],
  billing_payment_plans: [p('patient_id')],
  billing_payment_plan_terms: [via('billing_payment_plans', 'plan_id')],
  billing_payment_plan_events: [via('billing_payment_plans', 'plan_id')],
  billing_payment_plan_attempts: [via('billing_payment_plans', 'plan_id')],
  billing_statements: [p('guarantor_id')],
  rcm_coverages: [p('patient_id')],
  rcm_coverage_versions: [via('rcm_coverages', 'coverage_id')],
  rcm_eligibility_records: [via('rcm_coverages', 'coverage_id')],
  billing_adjustment_requests: [via('billing_charges', 'charge_id')],
  billing_adjustment_decisions: [via('billing_adjustment_requests', 'request_id')],
  rcm_claims: [p('patient_id')],
  rcm_claim_versions: [via('rcm_claims', 'claim_id')],
  rcm_claim_lines: [via('rcm_claim_versions', 'version_id')],
  rcm_claim_attachments: [via('rcm_claim_versions', 'version_id')],
  rcm_claim_attachment_packages: [via('rcm_claims', 'claim_id')],
  rcm_claim_attachment_package_items: [via('rcm_claim_attachment_packages', 'package_id')],
  rcm_claim_validations: [via('rcm_claim_versions', 'version_id')],
  rcm_claim_submissions: [via('rcm_claims', 'claim_id')],
  rcm_claim_events: [via('rcm_claims', 'claim_id')],
  rcm_claim_procedure_holds: [via('rcm_claims', 'claim_id')],
  rcm_appeals: [via('rcm_claims', 'claim_id')],
  rcm_appeal_reviews: [via('rcm_appeals', 'appeal_id')],
  rcm_appeal_send_resolutions: [via('rcm_appeals', 'appeal_id')],
  rcm_secondary_claims: [via('rcm_claims', 'claim_id')],
  rcm_remittance_line_resolutions: [via('rcm_claims', 'claim_id')],
  rcm_remittance_resolution_decisions: [via('rcm_remittance_line_resolutions', 'resolution_id')],
  rcm_remittance_resolution_postings: [via('rcm_remittance_line_resolutions', 'resolution_id')],
  rcm_claim_workflows: [via('rcm_claims', 'claim_id')],
  rcm_claim_workflow_steps: [via('rcm_claim_workflows', 'workflow_id')],
  rcm_claim_workflow_exceptions: [via('rcm_claim_workflows', 'workflow_id')],
  rcm_claim_workflow_exception_events: [via('rcm_claim_workflow_exceptions', 'exception_id')],
  rcm_claim_workflow_timers: [via('rcm_claim_workflows', 'workflow_id')],
  rcm_claim_workflow_timer_firings: [via('rcm_claim_workflow_timers', 'timer_id')],
  rcm_claim_workflow_closures: [via('rcm_claim_workflows', 'workflow_id')],
};

/**
 * Patient filter over the composed module documents, driven only by PATIENT_EXPORT_LINKAGE: the
 * `patients` row of the subject, then rows linked to it (directly or through an included parent) to
 * a fixpoint. A row of another patient, a row of an unlisted table, or a row that merely mentions an
 * included identifier in some other column never enters.
 */
export function filterPatientDocuments(docs: readonly Doc[], patientRef: string): Doc[] {
  const included = new Map<string, Set<string>>([['patients', new Set([patientRef])]]);
  const ids = (t: string) => included.get(t) ?? new Set<string>();
  const taken = docs.map((d) => Object.fromEntries(Object.keys(d.tables).map((t) => [t, new Set<number>()])));
  const rowsOf = (t: string): Row[] =>
    docs.flatMap((d, di) =>
      ((d.tables[t] as Row[] | undefined) ?? []).filter((_, i) => taken[di]?.[t]?.has(i)),
    );
  const linked = (t: string, r: Row): boolean => {
    if (t === 'patients') return r.id === patientRef;
    return (PATIENT_EXPORT_LINKAGE[t] ?? []).some((l) =>
      'patient' in l
        ? r[l.patient] === patientRef
        : 'parent' in l
          ? typeof r[l.column] === 'string' && ids(l.parent).has(r[l.column] as string)
          : typeof r.id === 'string' && rowsOf(l.referencedBy).some((x) => x[l.column] === r.id),
    );
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [di, d] of docs.entries())
      for (const [t, rows] of Object.entries(d.tables)) {
        if (t !== 'patients' && !(t in PATIENT_EXPORT_LINKAGE)) continue;
        const set = taken[di]?.[t] as Set<number>;
        for (const [i, r] of (rows as Row[]).entries()) {
          if (set.has(i) || !linked(t, r)) continue;
          set.add(i);
          if (typeof r.id === 'string') included.set(t, ids(t).add(r.id));
          changed = true;
        }
      }
  }
  return docs.map((d, di) => {
    const tables = Object.fromEntries(
      Object.entries(d.tables).map(([t, rows]) => [
        t,
        (rows as Row[]).filter((_, i) => taken[di]?.[t]?.has(i)),
      ]),
    );
    const out: Doc = { format: d.format, exportedAt: d.exportedAt, tables } as Doc;
    if (d.blobs) {
      const digests = new Set(
        Object.values(tables).flatMap((rows) =>
          (rows as Row[]).map((r) => r.digest_sha256).filter((x): x is string => typeof x === 'string'),
        ),
      );
      return { ...out, blobs: d.blobs.filter((b) => digests.has(b.digestSha256)) };
    }
    return out;
  });
}

export function buildScopedManifest(
  exportRef: string,
  exportedAt: string,
  scope: ScopedManifest['scope'],
  docs: readonly Doc[],
): ScopedManifest {
  return {
    format: EXPORT_FORMAT,
    exportRef,
    exportedAt,
    scope,
    documents: docs.map((d) => ({
      format: d.format,
      digestSha256: documentDigest(d),
      tables: Object.fromEntries(Object.entries(d.tables).map(([t, rows]) => [t, rows.length])),
    })),
    blobs: docs.flatMap((d) =>
      (d.blobs ?? []).map((b) => ({ digestSha256: b.digestSha256, byteLength: b.byteLength })),
    ),
    licenceGate: 'none',
    completeness: {
      basis:
        scope.kind === 'patient'
          ? 'every table of every module format; rows linked to the patient; reference data excluded'
          : 'every table of the module format',
    },
  };
}

export type ScopedExportRefusal =
  | 'unknown_version'
  | 'empty_manifest'
  | 'missing_entity'
  | 'count_mismatch'
  | 'digest_mismatch'
  | 'tenant_mismatch'
  | 'foreign_patient'
  | 'unlinked_table';
export type ScopedExportValidation =
  | { accepted: true; warnings: string[] }
  | { accepted: false; reason: ScopedExportRefusal; entity: string };
const refuse = (reason: ScopedExportRefusal, entity: string): ScopedExportValidation => ({
  accepted: false,
  reason,
  entity,
});

/**
 * Completeness validator of `cuspatlas-export/1` (reuses the M1 document registry and digest): the
 * version is known; the documents are exactly those of the scope, in the platform import order; every
 * table of each format is present with the manifest's row count and no extra table; each document
 * digest matches; no tenant identifier appears; a patient package holds rows of its subject only.
 * Anything else is refused, naming the failing entity; nothing shorter is ever accepted.
 */
export function validateScopedExport(
  input: { readonly manifest: object; readonly documents: readonly object[] },
  opts: { subjectRef?: string; tenantId?: string } = {},
): ScopedExportValidation {
  const pkg = input as unknown as ScopedPackage;
  const m = pkg.manifest;
  if (m?.format !== EXPORT_FORMAT) return refuse('unknown_version', 'manifest');
  if (!Array.isArray(m.documents) || m.documents.length === 0 || !Array.isArray(pkg.documents))
    return refuse('empty_manifest', 'manifest');
  const want =
    m.scope?.kind === 'patient'
      ? PRACTICE_EXPORT_DOCUMENTS
      : PRACTICE_EXPORT_DOCUMENTS.filter(
          (_, i) => EXPORT_DOMAINS[i] === (m.scope as { domain?: string })?.domain,
        );
  if (want.length === 0) return refuse('unknown_version', 'scope');
  for (const [i, w] of want.entries()) {
    const summary = m.documents[i];
    const doc = pkg.documents[i];
    if (summary?.format !== w.format || doc?.format !== w.format) return refuse('missing_entity', w.format);
    for (const t of w.tables) {
      if (!Array.isArray(doc.tables?.[t]) || summary.tables?.[t] === undefined)
        return refuse('missing_entity', `${w.format}:${t}`);
      if (summary.tables[t] !== doc.tables[t]?.length) return refuse('count_mismatch', `${w.format}:${t}`);
    }
    for (const t of new Set([...Object.keys(doc.tables), ...Object.keys(summary.tables)]))
      if (!w.tables.includes(t)) return refuse('count_mismatch', `${w.format}:${t}`);
  }
  if (m.documents.length !== want.length || pkg.documents.length !== want.length)
    return refuse('count_mismatch', 'documents');
  for (const doc of pkg.documents)
    for (const rows of Object.values(doc.tables))
      if ((rows as Row[]).some((r) => 'tenant_id' in r)) return refuse('tenant_mismatch', doc.format);
  if (opts.tenantId !== undefined && JSON.stringify(pkg).includes(opts.tenantId))
    return refuse('tenant_mismatch', 'package');
  if (m.scope.kind === 'patient') {
    const subject = opts.subjectRef ?? m.scope.subjectRef;
    if (subject !== m.scope.subjectRef) return refuse('foreign_patient', 'scope');
    for (const doc of pkg.documents)
      for (const [t, rows] of Object.entries(doc.tables))
        if (t !== 'patients' && !(t in PATIENT_EXPORT_LINKAGE) && (rows as Row[]).length > 0)
          return refuse('unlinked_table', `${doc.format}:${t}`);
    for (const doc of pkg.documents)
      for (const [t, rows] of Object.entries(doc.tables))
        for (const r of rows as Row[])
          if (
            (t === 'patients' && r.id !== subject) ||
            (t !== 'patients' && patientLinks(r).length > 0 && !patientLinks(r).includes(subject))
          )
            return refuse('foreign_patient', `${doc.format}:${t}`);
  }
  for (const [i, doc] of pkg.documents.entries())
    if (documentDigest(doc) !== m.documents[i]?.digestSha256) return refuse('digest_mismatch', doc.format);
  const blobs = pkg.documents.flatMap((d) => d.blobs ?? []);
  if (
    canonicalJson(blobs.map((b) => ({ digestSha256: b.digestSha256, byteLength: b.byteLength }))) !==
    canonicalJson(m.blobs)
  )
    return refuse('digest_mismatch', 'blobs');
  return { accepted: true, warnings: [] };
}

interface RequestRow extends Record<string, unknown> {
  id: string;
  scope: 'practice' | 'patient' | 'domain';
  subject_id: string | null;
  domain: string | null;
  format_version: string;
  purpose: string;
  state: 'building' | 'ready' | 'failed';
  artifact_format: string | null;
  practice_export_id: string | null;
  manifest: Record<string, unknown> | null;
  manifest_digest: string | null;
  package_digest: string | null;
  byte_length: string | number | null;
  document_count: number | null;
  storage_key: string | null;
  diagnostic: string | null;
  version: number;
  created_at: Date;
  completed_at: Date | null;
  created_by: string;
}
const present = (r: RequestRow) => ({
  exportRef: r.id,
  scope: r.scope,
  subjectRef: r.subject_id,
  domain: r.domain,
  formatVersion: r.format_version,
  purpose: r.purpose,
  state: r.state,
  artifactFormat: r.artifact_format,
  manifestDigest: r.manifest_digest,
  packageDigest: r.package_digest,
  byteLength: r.byte_length === null ? null : Number(r.byte_length),
  documentCount: r.document_count,
  diagnostic: r.diagnostic,
  licenceGate: 'none' as const,
  version: r.version,
  createdAt: new Date(r.created_at).toISOString(),
  completedAt: r.completed_at === null ? null : new Date(r.completed_at).toISOString(),
});
export type ExportRequestView = ReturnType<typeof present>;

// biome-ignore lint/suspicious/noExplicitAny: codecs are heterogeneous per operation.
export const AUTOMATION_EXPORT_CODECS: Readonly<Record<string, ReplayCodec<any>>> = {
  'exports.create': {
    persist: (d: ExportRequestView): StoredResult => ({ kind: 'success', ...d }),
    restore(stored) {
      if (stored.kind !== 'success') throw new Error('Stored result is malformed');
      const { kind: _k, ...rest } = stored;
      return rest as unknown as ExportRequestView;
    },
  } satisfies ReplayCodec<ExportRequestView>,
};

export function createExportOperations(base: AutomationBase, ex: ExportDeps | undefined) {
  const { deps, execute } = base;
  const need = () => {
    if (!ex?.objectStore || !ex.tokenSecret) throw unavailable();
    return { exporters: ex.exporters, objectStore: ex.objectStore, tokenSecret: ex.tokenSecret };
  };
  const loadRequest = async (tx: TenantTransaction, ref: string, lock = false): Promise<RequestRow> => {
    assertRef(ref);
    const { rows } = await tx.query<RequestRow>(
      `SELECT * FROM cuspatlas.export_requests WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [ref],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  };
  const maxPackageBytes = ex?.maxPackageBytes ?? 256 * 1024 * 1024;
  const maxInlineBytes = ex?.maxInlineBytes ?? 64 * 1024 * 1024;
  const buildDeadlineSeconds = ex?.buildDeadlineSeconds ?? 900;

  /** Crash recovery: a request still building past the deadline is failed, never left stuck. */
  const failStaleBuilds = async (tx: TenantTransaction, op: string) => {
    const { rows } = await tx.query<{ id: string; version: number }>(
      `UPDATE cuspatlas.export_requests SET state = 'failed', diagnostic = 'build_interrupted',
         version = version + 1, completed_at = now()
       WHERE state = 'building' AND created_at < now() - make_interval(secs => $1) RETURNING id, version`,
      [buildDeadlineSeconds],
    );
    for (const r of rows)
      await recordCommand(
        tx,
        { operation: op, resourceType: 'exportRequest', resourceRef: r.id, resourceVersion: r.version },
        { changedFields: ['state'] },
      );
  };

  /** True when the caller holds the elevated export-administrator scope (never assumed; checked). */
  const isExportAdmin = async (ctx: ActorContext) => {
    try {
      await deps.authorize(ctx, 'exports.administer', { tenantId: ctx.tenantId, id: 'exports' });
      return true;
    } catch (err) {
      if (isRefusalError(err)) return false;
      throw err;
    }
  };

  /**
   * An export is the requester's: anyone else (even with `exports.create`) sees it as missing, unless
   * they hold `exports.admin`, and that access is itself recorded as a sensitive read.
   */
  const assertRequesterOrAdmin = async (
    ctx: ActorContext,
    tx: TenantTransaction,
    row: RequestRow,
    op: string,
  ) => {
    if (row.created_by === ctx.actorId) return;
    if (!(await isExportAdmin(ctx))) throw notFound();
    await recordSensitiveRead(tx, {
      operation: op,
      resourceType: 'exportAdminAccess',
      resourceRefs: row.subject_id ? [row.id, row.subject_id] : [row.id],
      queryFields: [],
    });
  };

  /**
   * The module read authorization the build ran under, re-run for whoever grants or downloads a
   * patient or domain export now (narrowed access blocks delivery). M1 re-authorizes practice exports.
   */
  const MODULE_EXPORT_ACTIONS = [
    'scheduling.export',
    'imaging.export',
    'clinical.export',
    'communications.export',
    'billing.export',
  ] as const;
  const reauthorizeModules = async (ctx: ActorContext, row: RequestRow) => {
    if (row.scope === 'practice') return;
    const actions =
      row.scope === 'patient'
        ? MODULE_EXPORT_ACTIONS
        : [MODULE_EXPORT_ACTIONS[EXPORT_DOMAINS.indexOf(row.domain as ExportDomain)]];
    for (const action of actions) if (action) await base.tenantWide(ctx, action, 'exports');
  };
  const envOf = (
    operation: string,
    payload: unknown,
    key: string = randomUUID(),
  ): CommandEnvelope<unknown> => ({
    operation,
    idempotencyKey: key,
    payload,
  });

  /** Builds the artifact as the caller; returns the completion columns or a fixed diagnostic. */
  const build = async (ctx: ActorContext, row: RequestRow) => {
    const { exporters, objectStore } = need();
    if (row.scope === 'practice') {
      if (!ex?.practice) throw unavailable();
      const r = await ex.practice.create(
        ctx,
        envOf('practice.export.create', { purpose: row.purpose }, `exports-${row.id}`),
      );
      return {
        artifactFormat: r.data.format,
        practiceExportId: r.data.exportRef,
        manifest: null,
        manifestDigest: r.data.manifestDigest,
        packageDigest: r.data.packageDigest,
        byteLength: r.data.byteLength,
        documentCount: r.data.documentCount,
        storageKey: null,
      };
    }
    const order = [
      exporters.scheduling,
      exporters.imaging,
      exporters.clinical,
      exporters.engagement,
      exporters.billing,
    ];
    let docs: Doc[];
    if (row.scope === 'domain') {
      const f = order[EXPORT_DOMAINS.indexOf(row.domain as ExportDomain)];
      if (!f) throw failed('unknown_domain');
      docs = [await f(ctx)];
    } else {
      const all: Doc[] = [];
      // One patient-scoped read per module naming the export and its subject (not a tenant-wide read).
      const audit = { subjectRefs: [row.id, row.subject_id as string] };
      for (const f of order) all.push(await f(ctx, audit));
      docs = filterPatientDocuments(all, row.subject_id as string);
    }
    const scope: ScopedManifest['scope'] =
      row.scope === 'patient'
        ? { kind: 'patient', subjectRef: row.subject_id as string }
        : { kind: 'domain', domain: row.domain as ExportDomain };
    const manifest = buildScopedManifest(row.id, new Date().toISOString(), scope, docs);
    const pkg: ScopedPackage = { manifest, documents: docs };
    const check = validateScopedExport(pkg, {
      tenantId: ctx.tenantId,
      ...(row.scope === 'patient' ? { subjectRef: row.subject_id as string } : {}),
    });
    if (!check.accepted) return { diagnostic: check.reason };
    const bytes = Buffer.from(JSON.stringify(pkg), 'utf8');
    if (bytes.byteLength > maxPackageBytes) return { diagnostic: 'export_too_large' };
    const staged = await objectStore.stage(ctx.tenantId, bytes);
    const { storageKey } = await objectStore.promote(ctx.tenantId, staged.stagingKey, staged.digestSha256);
    return {
      artifactFormat: EXPORT_FORMAT,
      practiceExportId: null,
      manifest,
      manifestDigest: sha256(canonicalJson(manifest)),
      packageDigest: staged.digestSha256,
      byteLength: bytes.byteLength,
      documentCount: docs.length,
      storageKey,
    };
  };

  /**
   * The delivery checks shared by the JSON and byte representations of `exports.download` (run inside
   * its guard): tenant-wide authorization, envelope, a live unrevoked grant bound to this caller and
   * export, module re-authorization, requester or administrator, ready state, then the sensitive-read
   * audit (a ranged read carries the `range` marker; content is never logged).
   */
  const authorizeDelivery = async (
    ctx: ActorContext,
    envelope: CommandEnvelope<unknown>,
    ranged: boolean,
    inline: boolean,
  ): Promise<RequestRow> => {
    const op = 'exports.download';
    await base.tenantWide(ctx, op, 'exports');
    checkEnvelope(envelope, op);
    const p = envelope.payload;
    validate<{ exportRef: string; token: string }>(validateExportDownload, p);
    assertRef(p.exportRef);
    const { tokenSecret } = need();
    const parsed = verifyGrantToken(
      tokenSecret,
      { tenantId: ctx.tenantId, principalId: ctx.actorId, objectRef: p.exportRef },
      p.token,
    );
    if (!parsed) throw notFound();
    const pre = await deps.withTenantTransaction(ctx, async (tx) => {
      const live = await tx.query(
        `SELECT 1 FROM cuspatlas.export_grants WHERE id = $1 AND export_id = $2
           AND principal_id = cuspatlas.current_actor_id() AND expires_at > now() AND revoked_at IS NULL`,
        [parsed.grantRef, p.exportRef],
      );
      if (live.rows.length === 0) throw notFound();
      return loadRequest(tx, p.exportRef);
    });
    await reauthorizeModules(ctx, pre);
    return deps.withTenantTransaction(ctx, async (tx) => {
      const r = await loadRequest(tx, p.exportRef);
      await assertRequesterOrAdmin(ctx, tx, r, op);
      if (r.state !== 'ready') throw conflict('export_not_ready');
      if (inline && r.practice_export_id === null && Number(r.byte_length) > maxInlineBytes)
        throw conflict('package_exceeds_inline_limit');
      await recordSensitiveRead(tx, {
        operation: op,
        resourceType: 'exportRequest',
        resourceRefs: r.subject_id ? [r.id, r.subject_id] : [r.id],
        queryFields: ranged ? ['range'] : [],
      });
      return r;
    });
  };
  /** Scoped package bytes verified against the digest recorded at build time (refused otherwise). */
  const storedBytes = (ctx: ActorContext, row: RequestRow) =>
    readVerifiedPackage(
      need().objectStore,
      ctx.tenantId,
      row.storage_key as string,
      row.package_digest as string,
    );

  return {
    /**
     * Requests and builds an export (human only, `exports.create`; tenant-wide membership). The
     * request is recorded (`building`, audit v1), built as the caller, then completed (`ready` or
     * `failed` with a diagnostic, audit v2) with a sensitive-read record. A module refusing the caller
     * fails the request and returns that refusal.
     */
    createExport(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ExportRequestView>> {
      const op = 'exports.create';
      return base.guarded(ctx, op, async () => {
        await base.tenantWide(ctx, op, 'exports');
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{
          scope: 'practice' | 'patient' | 'domain';
          subjectRef?: string;
          domain?: string;
          purpose: string;
        }>(validateExportCreate, p);
        if ((p.scope === 'patient') !== (p.subjectRef !== undefined)) throw failed('subject_scope_mismatch');
        if ((p.scope === 'domain') !== (p.domain !== undefined)) throw failed('domain_scope_mismatch');
        if (p.scope === 'practice' && !M1_PURPOSES.has(p.purpose))
          throw failed('purpose_not_allowed_for_scope');
        need();
        const r = await deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            await failStaleBuilds(tx, op);
            if (p.subjectRef !== undefined) {
              assertRef(p.subjectRef);
              const seen = await tx.query('SELECT 1 FROM cuspatlas.patients WHERE id = $1', [p.subjectRef]);
              if (seen.rows.length === 0) throw notFound();
            }
            const { rows } = await tx.query<RequestRow>(
              `INSERT INTO cuspatlas.export_requests (id, tenant_id, scope, subject_id, domain, format_version, purpose,
                 created_by)
               VALUES ($1, cuspatlas.current_tenant_id(), $2, $3, $4, 'cuspatlas-export/1', $5, cuspatlas.current_actor_id())
               RETURNING *`,
              [randomUUID(), p.scope, p.subjectRef ?? null, p.domain ?? null, p.purpose],
            );
            const row = rows[0] as RequestRow;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'exportRequest', resourceRef: row.id, resourceVersion: 1 },
              { changedFields: ['scope', 'state'] },
            );
            return { data: present(row), version: 1 };
          }),
        );
        // A replay answers with the current state of the request, never the stored building view.
        if (r.replayed) {
          const now = await deps.withTenantTransaction(ctx, async (tx) => {
            await failStaleBuilds(tx, op);
            return loadRequest(tx, r.data.exportRef);
          });
          return { ...r, data: present(now), version: now.version };
        }
        if (r.data.state !== 'building') return r;
        let outcome: Awaited<ReturnType<typeof build>> | { diagnostic: string };
        let rethrow: unknown = null;
        const start = await deps.withTenantTransaction(ctx, (tx) => loadRequest(tx, r.data.exportRef));
        try {
          outcome = await build(ctx, start);
        } catch (err) {
          outcome = { diagnostic: isRefusalError(err) ? err.code : 'build_failed' };
          if (isRefusalError(err)) rethrow = err;
        }
        const done = await deps.withTenantTransaction(ctx, async (tx) => {
          const o = outcome as Partial<Awaited<ReturnType<typeof build>>> & { diagnostic?: string };
          const failedState = o.diagnostic !== undefined;
          const { rows } = await tx.query<RequestRow>(
            `UPDATE cuspatlas.export_requests SET state = $2, artifact_format = $3, practice_export_id = $4,
               manifest = $5, manifest_digest = $6, package_digest = $7, byte_length = $8, document_count = $9,
               storage_key = $10, diagnostic = $11, version = version + 1, completed_at = now()
             WHERE id = $1 AND state = 'building' RETURNING *`,
            [
              r.data.exportRef,
              failedState ? 'failed' : 'ready',
              failedState ? null : o.artifactFormat,
              failedState ? null : (o.practiceExportId ?? null),
              failedState || !o.manifest ? null : JSON.stringify(o.manifest),
              failedState ? null : o.manifestDigest,
              failedState ? null : o.packageDigest,
              failedState ? null : o.byteLength,
              failedState ? null : o.documentCount,
              failedState ? null : (o.storageKey ?? null),
              failedState ? o.diagnostic : null,
            ],
          );
          const row = rows[0] as RequestRow;
          await recordCommand(
            tx,
            {
              operation: op,
              resourceType: 'exportRequest',
              resourceRef: row.id,
              resourceVersion: row.version,
            },
            { changedFields: ['state'] },
          );
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'exportRequest',
            resourceRefs: row.subject_id ? [row.id, row.subject_id] : [row.id],
            queryFields: [],
          });
          return row;
        });
        if (rethrow) throw rethrow;
        return { ...r, data: present(done), version: done.version };
      });
    },

    /** The caller's own export requests (human only); an export administrator sees every request. */
    listExports(ctx: ActorContext, query: unknown) {
      const op = 'exports.list';
      return base.guarded(ctx, op, async () => {
        const decision = await base.tenantWide(ctx, op, 'exports');
        validate<{ limit?: number; cursor?: string; state?: string }>(validateExportListQuery, query);
        const pg = base.page(ctx, query);
        const state = query.state ?? null;
        const mine = (await isExportAdmin(ctx)) ? null : ctx.actorId;
        return deps.withTenantTransaction(ctx, async (tx) => {
          await failStaleBuilds(tx, op);
          const at = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          const where = '($1::text IS NULL OR state = $1) AND ($2::uuid IS NULL OR created_by = $2)';
          const total = Number(
            (
              await tx.query<{ n: string }>(
                `SELECT count(*) AS n FROM cuspatlas.export_requests WHERE ${where}`,
                [state, mine],
              )
            ).rows[0]?.n ?? 0,
          );
          const { rows } = await tx.query<RequestRow>(
            `SELECT * FROM cuspatlas.export_requests WHERE ${where}
             ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
            [state, mine, pg.limit, pg.offset],
          );
          if (mine === null && rows.some((r) => r.created_by !== ctx.actorId))
            await recordSensitiveRead(tx, {
              operation: op,
              resourceType: 'exportAdminAccess',
              resourceRefs: rows.filter((r) => r.created_by !== ctx.actorId).map((r) => r.id),
              queryFields: state === null ? [] : ['state'],
            });
          return {
            ...listEnvelope({
              asOf: at,
              appliedFilters: { state },
              locationRefs: decision.locationRefs,
              limit: pg.limit,
              nextCursor: pg.next(rows.length, total),
              ordering: { key: 'createdAt', direction: 'desc', tieBreak: 'exportRef' },
              total,
            }),
            items: rows.map(present),
          };
        });
      });
    },

    readExport(ctx: ActorContext, query: unknown) {
      const op = 'exports.read';
      return base.guarded(ctx, op, async () => {
        await base.tenantWide(ctx, op, 'exports');
        validate<{ exportRef: string }>(validateExportQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          await failStaleBuilds(tx, op);
          const row = await loadRequest(tx, query.exportRef);
          await assertRequesterOrAdmin(ctx, tx, row, op);
          let manifest = row.manifest;
          if (manifest === null && row.practice_export_id !== null) {
            const m = await tx.query<{ manifest: Record<string, unknown> }>(
              'SELECT manifest FROM cuspatlas.practice_exports WHERE id = $1',
              [row.practice_export_id],
            );
            manifest = m.rows[0]?.manifest ?? null;
          }
          return { data: { ...present(row), manifest } };
        });
      });
    },

    /**
     * Mints a delivery grant (at most 300 s) bound to the caller; each call mints a new one. Only the
     * requester (or a recorded export administrator) may, and the module read authorization of the
     * export's scope is re-run for the caller now.
     */
    grantExport(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'exports.grant';
      return base.guarded(ctx, op, async () => {
        await base.tenantWide(ctx, op, 'exports');
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ exportRef: string }>(validateExportGrant, p);
        const { tokenSecret } = need();
        const pre = await deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadRequest(tx, p.exportRef);
          await assertRequesterOrAdmin(ctx, tx, row, op);
          return row;
        });
        await reauthorizeModules(ctx, pre);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadRequest(tx, p.exportRef);
          if (row.state !== 'ready') throw conflict('export_not_ready');
          const { rows } = await tx.query<{ id: string; exp: string }>(
            `INSERT INTO cuspatlas.export_grants (tenant_id, export_id, principal_id, created_at, expires_at)
             VALUES (cuspatlas.current_tenant_id(), $1, cuspatlas.current_actor_id(), now(), now() + make_interval(secs => $2))
             RETURNING id, floor(extract(epoch FROM expires_at))::bigint::text AS exp`,
            [row.id, GRANT_SECONDS],
          );
          const grant = rows[0] as { id: string; exp: string };
          await recordCommand(
            tx,
            { operation: op, resourceType: 'exportGrant', resourceRef: grant.id, resourceVersion: 1 },
            { changedFields: ['grant'] },
          );
          const token = signGrantToken(
            tokenSecret,
            { tenantId: ctx.tenantId, principalId: ctx.actorId, objectRef: row.id },
            grant.id,
            Number(grant.exp),
          );
          return {
            data: { grantRef: grant.id, token, expiresAt: new Date(Number(grant.exp) * 1000).toISOString() },
          };
        });
      });
    },

    /** Revokes a delivery grant before it expires (its holder, or a recorded export administrator). */
    revokeExportGrant(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'exports.grants.revoke';
      return base.guarded(ctx, op, async () => {
        await base.tenantWide(ctx, op, 'exports');
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ grantRef: string }>(validateExportGrantRevoke, p);
        assertRef(p.grantRef);
        const admin = await isExportAdmin(ctx);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{ id: string; principal_id: string; revoked_at: Date | null }>(
            'SELECT id, principal_id, revoked_at FROM cuspatlas.export_grants WHERE id = $1 FOR UPDATE',
            [p.grantRef],
          );
          const g = rows[0];
          if (!g || (g.principal_id !== ctx.actorId && !admin)) throw notFound();
          let revokedAt = g.revoked_at;
          if (revokedAt === null) {
            revokedAt =
              (
                await tx.query<{ revoked_at: Date }>(
                  `UPDATE cuspatlas.export_grants SET revoked_at = now(), revoked_by = cuspatlas.current_actor_id()
                   WHERE id = $1 RETURNING revoked_at`,
                  [g.id],
                )
              ).rows[0]?.revoked_at ?? new Date();
            await recordCommand(
              tx,
              { operation: op, resourceType: 'exportGrant', resourceRef: g.id, resourceVersion: 2 },
              { changedFields: ['revokedAt'] },
            );
          }
          return { data: { grantRef: g.id, revokedAt: new Date(revokedAt).toISOString() } };
        });
      });
    },

    /**
     * The package to the holder of a live, unrevoked grant (sensitive read) who is still the requester
     * (or a recorded export administrator) and still passes the module read authorization of the
     * export's scope. A practice export is read through the M1 grant and download as the same caller,
     * so M1 re-authorizes and re-verifies its bytes. Packages over the inline limit are refused with a
     * typed reason, never truncated.
     */
    downloadExport(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'exports.download';
      return base.guarded(ctx, op, async () => {
        const row = await authorizeDelivery(ctx, envelope, false, true);
        if (row.practice_export_id !== null) {
          if (!ex?.practice) throw unavailable();
          const g = await ex.practice.grant(
            ctx,
            envOf('practice.export.grant', { exportRef: row.practice_export_id }),
          );
          return ex.practice.download(
            ctx,
            envOf('practice.export.download', { exportRef: row.practice_export_id, token: g.data.token }),
          );
        }
        const bytes = await storedBytes(ctx, row);
        return { data: JSON.parse(Buffer.from(bytes).toString('utf8')) as ScopedPackage };
      });
    },

    /**
     * A8: the same delivery as `downloadExport` (same operation, policy, grant, revocation and audit) as
     * the stored bytes and their recorded digest, for streamed or ranged REST transfer. Byte delivery is
     * not bound by the inline JSON limit (the build cap still bounds the package). A grant serves any
     * number of ranges until it expires or is revoked; each range is re-authorized and re-verified.
     */
    downloadExportBytes(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
      request: PackageBytesRequest = {},
    ): Promise<{ data: PackageBytes }> {
      const op = 'exports.download';
      const ranged = request.ranged === true;
      return base.guarded(ctx, op, async () => {
        const row = await authorizeDelivery(ctx, envelope, ranged, false);
        if (row.practice_export_id !== null) {
          if (!ex?.practice?.downloadBytes) throw unavailable();
          const g = await ex.practice.grant(
            ctx,
            envOf('practice.export.grant', { exportRef: row.practice_export_id }),
          );
          return ex.practice.downloadBytes(
            ctx,
            envOf('practice.export.download', { exportRef: row.practice_export_id, token: g.data.token }),
            { ranged },
          );
        }
        const bytes = await storedBytes(ctx, row);
        return { data: { bytes, digestSha256: row.package_digest as string, byteLength: bytes.byteLength } };
      });
    },
  };
}
