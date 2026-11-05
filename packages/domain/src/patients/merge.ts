import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type CommandResult,
  type DuplicateCandidate,
  type DuplicateCandidateList,
  type DuplicateReason,
  isRefusalError,
  type MergeMove,
  type MergeRequest,
  type MergeResult,
  PATIENT_PROPERTIES,
  RefusalError,
  type TenantTransaction,
  type UnmergeRequest,
  validateDuplicateQuery,
  validateMergeHistoryQuery,
  validateMergeRef,
  validateMergeRequest,
  validatePatientRef,
  validateUnmergeRequest,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { checkEnvelope, loadPatient, PATIENT_RESOURCE } from './identity';
import { conflict, invalid, MATCH_KEY, notFound, PATIENT_COLUMNS, type PatientRow, toSummary } from './model';
import { RELATIONSHIP_RESOURCE } from './relationships';
import type { PatientServiceContext } from './service-context';

export const MERGE_RESOURCE = 'patientMerge';
export const MERGE_POLICY_VERSION = 'patient-merge.pending-approval.1';

/**
 * Record classes whose patient reference a merge relinks (S6). A merge changes only the named
 * reference column (plus version bookkeeping) and proves it with a content digest computed over the
 * row without its reference and bookkeeping columns, before and after. Every future table with a
 * foreign key to `cuspatlas.patients` must appear here or in MERGE_EXCLUDED_REFERENCES (enforced by
 * tests/integration/patient-merge.test.ts); clinical (C) and financial (B) classes register with
 * their `factKind`, which also drives the S-D2 reversal rule.
 *
 * Limitation (recorded in the ledger): requests, bookings (S8/S10) and clinical records (C) do not
 * exist yet, so relationships are the only class a merge moves today.
 */
export interface MergeRecordClass {
  readonly recordClass: string;
  readonly table:
    | 'patient_relationships'
    | 'appointment_requests'
    | 'appointments'
    // C5/C8 clinical classes (appended by workstream C).
    | 'clinical_encounters'
    | 'clinical_history_streams'
    // C6/C7/C11 clinical classes (workstream C batch 2a).
    | 'clinical_charts'
    | 'clinical_perio_streams'
    | 'clinical_treatment_plans'
    // C13 consent (workstream C batch 3).
    | 'clinical_consents'
    | 'appointment_series'
    | 'waitlist_entries'
    // C16 lab cases and C17 referrals (workstream C batch 4).
    | 'clinical_lab_cases'
    | 'clinical_referrals'
    | 'imaging_match_decisions';
  readonly column: 'subject_patient_id' | 'counterparty_patient_id';
  /** Public name of the reference in the record's contract. */
  readonly referenceField: string;
  readonly factKind: 'administrative' | 'clinical' | 'financial';
  /** Columns left out of the content digest: every patient reference plus bookkeeping. */
  readonly digestExclude: readonly string[];
}

// Lifecycle columns a later command may legitimately change (revocation) are not content: they stay
// out of the digest so a post-merge revocation never blocks an unmerge (review hardening, REQUIRED 2).
const RELATIONSHIP_DIGEST_EXCLUDE = [
  'subject_patient_id',
  'counterparty_patient_id',
  'revoked_at',
  'revoked_by',
  'revoke_reason',
  'version',
  'updated_at',
];

const REQUEST_DIGEST_EXCLUDE = [
  'subject_patient_id',
  'provider_preference_id',
  'preferred_windows',
  'flexibility',
  'urgent',
  'contact_consent',
  'note',
  'state',
  'state_reason',
  'appointment_id',
  'expiry_policy_ref',
  'closed_at',
  'version',
  'updated_at',
];

export const MERGE_RECORD_CLASSES: readonly MergeRecordClass[] = [
  {
    recordClass: RELATIONSHIP_RESOURCE,
    table: 'patient_relationships',
    column: 'subject_patient_id',
    referenceField: 'subjectRef',
    factKind: 'administrative',
    digestExclude: RELATIONSHIP_DIGEST_EXCLUDE,
  },
  {
    recordClass: RELATIONSHIP_RESOURCE,
    table: 'patient_relationships',
    column: 'counterparty_patient_id',
    referenceField: 'counterpartyRef',
    factKind: 'administrative',
    digestExclude: RELATIONSHIP_DIGEST_EXCLUDE,
  },
  // S8: an open (or closed) appointment request follows its patient. Lifecycle and preference
  // columns change through later commands and are left out of the digest, so a later state change
  // never blocks an unmerge; the digest covers the request's immutable facts (origin, channel,
  // location, type, creator, creation).
  {
    recordClass: 'appointmentRequest',
    table: 'appointment_requests',
    column: 'subject_patient_id',
    referenceField: 'patientRef',
    factKind: 'administrative',
    digestExclude: REQUEST_DIGEST_EXCLUDE,
  },
  // S10: a booking follows its patient. The window, resources, creator and creation are covered by
  // the digest; lifecycle columns (status, cancellation, reschedule and request links) are not.
  {
    recordClass: 'appointment',
    table: 'appointments',
    column: 'subject_patient_id',
    referenceField: 'patientRef',
    factKind: 'administrative',
    digestExclude: [
      'subject_patient_id',
      'status',
      'cancel_reason',
      'cancelled_at',
      'rescheduled_to_id',
      'request_id',
      'version',
      'updated_at',
    ],
  },
  // C5 (workstream C): an encounter follows its patient. The digest covers identity, the visit, the
  // location and the opening authorship; the closure columns are write-once lifecycle facts (the
  // encounter guard trigger refuses any rewrite) and are left out so a later close never blocks an
  // unmerge. Role assignments carry no patient reference and are never touched by a merge.
  {
    recordClass: 'clinicalEncounter',
    table: 'clinical_encounters',
    column: 'subject_patient_id',
    referenceField: 'patientRef',
    factKind: 'clinical',
    digestExclude: [
      'subject_patient_id',
      'state',
      'disposition_code',
      'closed_by',
      'closed_by_role',
      'closed_by_credential_ref',
      'closed_at',
      'version',
      'updated_at',
    ],
  },
  // S13: a recurrence series follows its patient (its occurrences are appointments, registered above).
  // The pattern, anchor and creator are content; state, end and counters are lifecycle.
  {
    recordClass: 'appointmentSeries',
    table: 'appointment_series',
    column: 'subject_patient_id',
    referenceField: 'patientRef',
    factKind: 'administrative',
    digestExclude: [
      'subject_patient_id',
      'occurrence_count',
      'state',
      'end_reason',
      'ended_at',
      'version',
      'updated_at',
    ],
  },
  // C8 (workstream C): a history stream follows its patient. Versions, items, changes and
  // verifications reference the stream, never the patient, so a merge cannot touch them; the stream
  // keeps its source patient (origin_patient_id, excluded below). The digest covers the source and
  // creation; only the reference, the version head and bookkeeping are excluded.
  {
    recordClass: 'clinicalHistoryStream',
    table: 'clinical_history_streams',
    column: 'subject_patient_id',
    referenceField: 'patientRef',
    factKind: 'clinical',
    digestExclude: ['subject_patient_id', 'head_sequence', 'version', 'updated_at'],
  },
  // C6 (workstream C): a chart follows its patient. Entries reference the chart, never the patient,
  // so a merge cannot touch them; the chart keeps its source patient (origin_patient_id, excluded).
  {
    recordClass: 'clinicalChart',
    table: 'clinical_charts',
    column: 'subject_patient_id',
    referenceField: 'patientRef',
    factKind: 'clinical',
    digestExclude: ['subject_patient_id', 'head_sequence', 'version', 'updated_at'],
  },
  // C7 (workstream C): a perio stream follows its patient; exams, measurements and derivations
  // reference the stream, never the patient; the stream keeps its source patient.
  {
    recordClass: 'clinicalPerioStream',
    table: 'clinical_perio_streams',
    column: 'subject_patient_id',
    referenceField: 'patientRef',
    factKind: 'clinical',
    digestExclude: ['subject_patient_id', 'head_sequence', 'version', 'updated_at'],
  },
  // C11 (workstream C): a treatment plan follows its patient; versions, details, items and events
  // reference the plan, never the patient; the plan keeps its source patient.
  {
    recordClass: 'clinicalTreatmentPlan',
    table: 'clinical_treatment_plans',
    column: 'subject_patient_id',
    referenceField: 'patientRef',
    factKind: 'clinical',
    digestExclude: ['subject_patient_id', 'head_version', 'version', 'updated_at'],
  },
  // C13: a consent follows its patient; its content, signer authority and bindings never change
  // (a withdrawal is a separate record), so the digest covers everything but the reference and
  // bookkeeping.
  {
    recordClass: 'clinicalConsent',
    table: 'clinical_consents',
    column: 'subject_patient_id',
    referenceField: 'patientRef',
    factKind: 'clinical',
    digestExclude: ['subject_patient_id', 'version', 'updated_at'],
  },
  // S15: a waitlist entry follows its patient with its history (offers reference the entry).
  {
    recordClass: 'waitlistEntry',
    table: 'waitlist_entries',
    column: 'subject_patient_id',
    referenceField: 'patientRef',
    factKind: 'administrative',
    digestExclude: ['subject_patient_id', 'state', 'state_reason', 'appointment_id', 'version', 'updated_at'],
  },
  // C16: a lab case follows its patient; transitions and attachments reference the case; the case
  // keeps its source patient. State and the return facts are lifecycle (set by later commands).
  {
    recordClass: 'clinicalLabCase',
    table: 'clinical_lab_cases',
    column: 'subject_patient_id',
    referenceField: 'patientRef',
    factKind: 'clinical',
    digestExclude: [
      'subject_patient_id',
      'state',
      'received_date',
      'no_attachment_reason',
      'version',
      'updated_at',
    ],
  },
  // C17: a referral follows its patient; selections, shares, events and responses reference the
  // referral; the referral keeps its source patient. The state is lifecycle.
  {
    recordClass: 'clinicalReferral',
    table: 'clinical_referrals',
    column: 'subject_patient_id',
    referenceField: 'patientRef',
    factKind: 'clinical',
    digestExclude: ['subject_patient_id', 'state', 'version', 'updated_at'],
  },
  // I3: an image association decision (current or superseded) follows its patient. The digest covers
  // the object, basis, reason, decider and decision time; supersession bookkeeping is lifecycle. The
  // image bytes and their digest live on imaging_objects and are never touched by a merge.
  {
    recordClass: 'imagingAssociation',
    table: 'imaging_match_decisions',
    column: 'subject_patient_id',
    referenceField: 'patientRef',
    factKind: 'clinical',
    digestExclude: ['subject_patient_id', 'superseded_by_id', 'superseded_at', 'version', 'updated_at'],
  },
];

/** Foreign keys to patients that a merge deliberately does not move, with the reason. */
export const MERGE_EXCLUDED_REFERENCES: readonly { table: string; column: string; why: string }[] = [
  {
    table: 'appointment_patient_reassignments',
    column: 'prior_patient_id',
    why: 'S22: the reassignment history keeps both identities it recorded (never relinked)',
  },
  {
    table: 'appointment_patient_reassignments',
    column: 'new_patient_id',
    why: 'S22: the reassignment history keeps both identities it recorded (never relinked)',
  },
  {
    table: 'recall_tasks',
    column: 'subject_patient_id',
    why: 'a recall contact task stays with the identity it was created for; the follow-up worklist flags it (patient_merged) and recall is recomputed for the survivor',
  },
  { table: 'patients', column: 'merged_into', why: 'the merge link itself' },
  {
    table: 'migration_opening_items',
    column: 'patient_id',
    why: 'an opening financial fact is never relinked (like posted journal lines); the account is the merge set at read time',
  },
  {
    table: 'migration_applied_records',
    column: 'patient_id',
    why: 'migration provenance links a source record to the identity it became; merges are resolved at read time (M4)',
  },
  {
    table: 'migration_review_items',
    column: 'decision_patient_id',
    why: 'a migration identity decision records the identity staff chose at that time (M4 provenance); merges are resolved at read time',
  },
  {
    table: 'imaging_acquisition_deferrals',
    column: 'intended_patient_id',
    why: 'I7: the patient named when the acquisition was deferred; a later change or merge needs re-confirmation at release (never relinked silently)',
  },
  {
    table: 'imaging_bridge_jobs',
    column: 'intended_patient_id',
    why: 'I6: the patient named when the bridge job was queued (becomes the ingress dedupe scope, never an association)',
  },
  {
    table: 'imaging_ingress_sessions',
    column: 'intended_patient_id',
    why: 'I2: what the uploader named at upload time (a match candidate, never an association); the association decision is the record that follows the patient',
  },
  {
    table: 'imaging_objects',
    column: 'dedupe_patient_id',
    why: 'I2: the dedupe scope recorded at ingress; the association decision is the record that follows the patient',
  },
  {
    table: 'patient_status_history',
    column: 'patient_id',
    why: 'status facts stay with the identity they describe',
  },
  {
    table: 'patient_merges',
    column: 'survivor_patient_id',
    why: 'merge history keeps both source identifiers',
  },
  {
    table: 'patient_merges',
    column: 'merged_patient_id',
    why: 'merge history keeps both source identifiers',
  },
  // B1 (ADR 0008 M-11): posted financial history is never relinked; the account follows the merge
  // at read time (billing mergeSet) and BILLING_POST_MERGE_PROBE gates the unmerge.
  { table: 'billing_charges', column: 'patient_id', why: 'posted financial facts are never relinked' },
  // B6: a claim names the account (merge root) it was prepared for; submitted facts are never relinked.
  { table: 'rcm_claims', column: 'patient_id', why: 'submitted claim facts are never relinked' },
  { table: 'billing_journal_lines', column: 'patient_id', why: 'posted financial facts are never relinked' },
  // B2: payment and attempt facts keep the identity that tendered them; the account follows the merge.
  { table: 'billing_payments', column: 'patient_id', why: 'posted financial facts are never relinked' },
  { table: 'billing_payments', column: 'guarantor_id', why: 'posted financial facts are never relinked' },
  {
    table: 'billing_payment_attempts',
    column: 'patient_id',
    why: 'posted financial facts are never relinked',
  },
  {
    table: 'billing_payment_attempts',
    column: 'guarantor_id',
    why: 'posted financial facts are never relinked',
  },
  // B3: a plan names the parties that agreed it; the account follows the merge at read time.
  { table: 'billing_payment_plans', column: 'patient_id', why: 'agreed financial terms are never relinked' },
  {
    table: 'billing_payment_plans',
    column: 'guarantor_id',
    why: 'agreed financial terms are never relinked',
  },
  // B4: a statement is a snapshot addressed to the guarantor it was generated for.
  { table: 'billing_statements', column: 'guarantor_id', why: 'a generated statement is never restated' },
  // B5: coverage keeps the identity it was recorded for; resolution follows the merge set.
  { table: 'rcm_coverages', column: 'patient_id', why: 'coverage history is never relinked' },
  {
    table: 'rcm_coverage_versions',
    column: 'subscriber_patient_id',
    why: 'coverage history is never relinked',
  },
  {
    table: 'clinical_history_streams',
    column: 'origin_patient_id',
    why: 'a history stream keeps its source patient so merged histories stay distinguishable (C8)',
  },
  {
    table: 'clinical_charts',
    column: 'origin_patient_id',
    why: 'a chart keeps its source patient so merged charts stay distinguishable (C6)',
  },
  {
    table: 'clinical_perio_streams',
    column: 'origin_patient_id',
    why: 'a perio stream keeps its source patient so merged exams stay distinct (C7)',
  },
  {
    table: 'clinical_treatment_plans',
    column: 'origin_patient_id',
    why: 'a treatment plan keeps its source patient (C11)',
  },
  {
    table: 'clinical_consents',
    column: 'origin_patient_id',
    why: 'a consent keeps its source patient (C13)',
  },
  {
    table: 'clinical_consents',
    column: 'signer_patient_id',
    why: 'the signer recorded at capture is a historical fact (C13)',
  },
  {
    table: 'clinical_consent_withdrawals',
    column: 'signer_patient_id',
    why: 'the signer recorded at withdrawal is a historical fact (C13)',
  },
  {
    table: 'clinical_rendered_procedures',
    column: 'origin_patient_id',
    why: 'the patient a procedure was billed for when rendered is a historical fact (C14); the encounter moves',
  },
  {
    table: 'clinical_lab_cases',
    column: 'origin_patient_id',
    why: 'the patient a lab case was recorded for is a historical fact (C16); the subject moves',
  },
  {
    table: 'clinical_referrals',
    column: 'origin_patient_id',
    why: 'the patient a referral was recorded for is a historical fact (C17); the subject moves',
  },
  // E1 (recommended-pending-approval): a portal principal stays bound to the identity it was enrolled
  // for; once that identity is merged the principal is denied (portal_identity_merged) and staff
  // enroll a new principal for the survivor. A merge never retargets portal access silently.
  {
    table: 'portal_principals',
    column: 'person_patient_id',
    why: 'portal access never follows a merge silently; the merged identity is denied and re-enrolled',
  },
  // E6 (recommended-pending-approval): consent and opt-out facts, decisions and recall enrollments
  // stay with the identity they were recorded for; after a merge the survivor's own facts decide
  // (an absent consent suppresses: fail closed), and nothing is reassigned silently.
  {
    table: 'communication_consents',
    column: 'patient_id',
    why: 'consent facts stay with the identity that gave them; the survivor needs its own consent',
  },
  {
    table: 'suppression_decisions',
    column: 'subject_patient_id',
    why: 'decisions are history of what was decided for that identity at that time',
  },
  {
    table: 'recall_enrollments',
    column: 'patient_id',
    why: 'an enrollment records an S16 due item of that identity; recall is recomputed for the survivor',
  },
  {
    table: 'contact_verifications',
    column: 'patient_id',
    why: 'a verification attests a contact value of that identity; the survivor verifies its own contacts',
  },
  // E4/E5/E8 (recommended-pending-approval): submissions, review items, threads and call links are
  // facts about the identity they were recorded for; a merge never re-addresses them silently.
  {
    table: 'intake_submissions',
    column: 'patient_id',
    why: 'a submission is a fact given for that identity; staff re-enter what the survivor still needs',
  },
  {
    table: 'intake_review_items',
    column: 'patient_id',
    why: 'a review item proposes a change to that identity; an open one is rejected and re-proposed',
  },
  {
    table: 'message_threads',
    column: 'patient_id',
    why: 'a thread is correspondence about that identity; it is never re-addressed by a merge',
  },
  {
    table: 'call_links',
    column: 'patient_id',
    why: 'a call link is a confirmation about that identity; staff relink a merged call explicitly',
  },
  {
    table: 'outbound_messages',
    column: 'patient_id',
    why: 'a message is history of what was sent to that identity; it is never re-addressed by a merge',
  },
];

/**
 * Counts clinical or financial facts that reference the survivor after the merge (S-D2). No such
 * record class exists yet; C and B register probes (or registry classes) when they add one.
 */
export interface PostMergeFactProbe {
  readonly factKind: 'clinical' | 'financial';
  count(tx: TenantTransaction, survivorRef: string, mergedAt: Date): Promise<number>;
}

const digestSql = (alias: string, exclude: readonly string[]) =>
  `encode(sha256(convert_to((to_jsonb(${alias}) ${exclude.map((c) => `- '${c}'`).join(' ')})::text, 'UTF8')), 'hex')`;
const PATIENT_DIGEST = digestSql('p', ['version', 'updated_at', 'merged_into']);

/** ADR 0003 Q3 weights (pending approval). */
const WEIGHT: Record<DuplicateReason, number> = {
  same_identifier: 50,
  same_legal_name: 40,
  same_birth_date: 30,
  birth_date_compatible: 10,
  birth_date_conflict: -30,
  same_phone: 15,
  same_email: 15,
  same_address: 10,
};
const KEY_REASON: Record<string, DuplicateReason> = {
  [MATCH_KEY.identifier]: 'same_identifier',
  [MATCH_KEY.name]: 'same_legal_name',
  [MATCH_KEY.birthDate]: 'same_birth_date',
  [MATCH_KEY.phone]: 'same_phone',
  [MATCH_KEY.email]: 'same_email',
  [MATCH_KEY.address]: 'same_address',
};
const IDENTITY_REASONS: ReadonlySet<DuplicateReason> = new Set([
  'same_identifier',
  'same_legal_name',
  'same_birth_date',
]);

interface MatchRow extends PatientRow {
  match_keys: string[];
}

interface PolicyRow extends Record<string, unknown> {
  unmerge_window_days: number;
  candidate_min_score: number;
}

async function mergePolicy(
  tx: TenantTransaction,
): Promise<{ unmergeWindowDays: number; candidateMinScore: number }> {
  const { rows } = await tx.query<PolicyRow>(
    'SELECT unmerge_window_days, candidate_min_score FROM cuspatlas.patient_policy_settings',
  );
  const r = rows[0];
  return { unmergeWindowDays: r?.unmerge_window_days ?? 30, candidateMinScore: r?.candidate_min_score ?? 40 };
}

function birthReason(a: PatientRow, b: PatientRow, exact: boolean): DuplicateReason | null {
  if (exact || a.birth_date_text === null || b.birth_date_text === null) return null;
  if (a.birth_date_precision === 'day' && b.birth_date_precision === 'day') return 'birth_date_conflict';
  const len = (p: string) => (p === 'day' ? 10 : p === 'month' ? 7 : 4);
  const n = Math.min(len(a.birth_date_precision), len(b.birth_date_precision));
  return a.birth_date_text.slice(0, n) === b.birth_date_text.slice(0, n)
    ? 'birth_date_compatible'
    : 'birth_date_conflict';
}

/** Scores one candidate. Contact-only overlap (phone, email, address, household) never qualifies. */
export function scoreCandidate(
  target: MatchRow,
  other: MatchRow,
): { score: number; reasons: DuplicateReason[] } | null {
  const shared = other.match_keys.filter((k) => target.match_keys.includes(k));
  const reasons = new Set<DuplicateReason>();
  for (const k of shared) {
    const r = KEY_REASON[k.slice(0, k.indexOf(':'))];
    if (r) reasons.add(r);
  }
  const birth = birthReason(target, other, reasons.has('same_birth_date'));
  if (birth) reasons.add(birth);
  if (![...reasons].some((r) => IDENTITY_REASONS.has(r))) return null;
  const list = [...reasons].sort();
  return { score: list.reduce((s, r) => s + WEIGHT[r], 0), reasons: list };
}

interface MergeRow extends Record<string, unknown> {
  id: string;
  survivor_patient_id: string;
  merged_patient_id: string;
  reason_code: MergeResult['reasonCode'];
  move_count: number;
  merged_at: Date;
  reversal_reason: NonNullable<MergeResult['reversal']>['reasonCode'] | null;
  reversal_elevated: boolean | null;
  reversal_review_ref: string | null;
  reversed_at: Date | null;
}

const MERGE_SELECT = `SELECT m.id, m.survivor_patient_id, m.merged_patient_id, m.reason_code, m.move_count, m.merged_at,
    v.reason_code AS reversal_reason, v.elevated AS reversal_elevated, v.reconciliation_review_ref AS reversal_review_ref,
    v.reversed_at
  FROM cuspatlas.patient_merges m LEFT JOIN cuspatlas.patient_merge_reversals v ON v.merge_id = m.id`;

interface MoveRow extends Record<string, unknown> {
  record_class: string;
  record_ref: string;
  reference_column: string;
  prior_patient_id: string;
  new_patient_id: string;
  content_digest_before: string;
}

const fieldOf = (recordClass: string, column: string) =>
  MERGE_RECORD_CLASSES.find((c) => c.recordClass === recordClass && c.column === column)?.referenceField ??
  column;

async function loadMerge(tx: TenantTransaction, mergeRef: string): Promise<MergeResult> {
  const { rows } = await tx.query<MergeRow>(`${MERGE_SELECT} WHERE m.id = $1`, [mergeRef]);
  const m = rows[0];
  if (!m) throw notFound();
  const moves = await tx.query<MoveRow>(
    `SELECT record_class, record_ref, reference_column, prior_patient_id, new_patient_id, content_digest_before
     FROM cuspatlas.patient_merge_moves WHERE merge_id = $1 ORDER BY record_class, record_ref, reference_column`,
    [mergeRef],
  );
  return {
    mergeRef: m.id,
    survivorRef: m.survivor_patient_id,
    mergedRef: m.merged_patient_id,
    state: m.reversed_at === null ? 'merged' : 'reversed',
    reasonCode: m.reason_code,
    mergedAt: m.merged_at.toISOString(),
    reversedAt: m.reversed_at === null ? null : m.reversed_at.toISOString(),
    reversal:
      m.reversal_reason === null
        ? null
        : {
            reasonCode: m.reversal_reason,
            elevated: m.reversal_elevated === true,
            reconciliationReviewRef: m.reversal_review_ref,
          },
    moves: moves.rows.map(
      (r): MergeMove => ({
        recordClass: r.record_class,
        recordRef: r.record_ref,
        referenceField: fieldOf(r.record_class, r.reference_column),
        priorPatientRef: r.prior_patient_id,
        newPatientRef: r.new_patient_id,
      }),
    ),
    moveCount: m.move_count,
  };
}

/** Locks both patients in id order (no deadlock between overlapping merges); hidden like missing. */
async function lockPair(tx: TenantTransaction, a: string, b: string): Promise<Map<string, PatientRow>> {
  if (!validatePatientRef(a) || !validatePatientRef(b)) throw notFound();
  const { rows } = await tx.query<PatientRow & { digest: string }>(
    `SELECT ${PATIENT_COLUMNS}, ${PATIENT_DIGEST} AS digest FROM cuspatlas.patients p
     WHERE id = ANY ($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[a, b]],
  );
  if (rows.length !== 2) throw notFound();
  return new Map(rows.map((r) => [r.id, r]));
}

/** References that cannot be relinked under the S5 relationship rules (checked before any write). */
async function relationshipBlockers(
  tx: TenantTransaction,
  survivor: string,
  merged: string,
): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT r.id FROM cuspatlas.patient_relationships r
     WHERE (r.subject_patient_id = $1 AND r.counterparty_patient_id = $2)
        OR (r.subject_patient_id = $2 AND r.counterparty_patient_id = $1)
        OR (r.revoked_at IS NULL AND EXISTS (
              SELECT 1 FROM cuspatlas.patient_relationships o
              WHERE o.revoked_at IS NULL AND o.kind = r.kind AND (
                (r.subject_patient_id = $2 AND o.subject_patient_id = $1 AND o.counterparty_patient_id = r.counterparty_patient_id)
                OR (r.counterparty_patient_id = $2 AND o.counterparty_patient_id = $1 AND o.subject_patient_id = r.subject_patient_id)
                OR (r.kind = 'guarantor' AND r.subject_patient_id = $2 AND o.subject_patient_id = $1))))
     ORDER BY r.id LIMIT 20`,
    [survivor, merged],
  );
  return rows.map((r) => r.id);
}

interface Relinked {
  readonly cls: MergeRecordClass;
  readonly id: string;
  readonly version: number;
  readonly digest: string;
}

/** Moves every registered reference from one patient to another; verifies each content digest. */
async function relink(
  tx: TenantTransaction,
  from: string,
  to: string,
  only?: ReadonlySet<string>,
): Promise<Relinked[]> {
  const out: Relinked[] = [];
  // Lock every affected row of each table in one statement, in id order, before any update: two
  // merges whose records cross (A->B and B->A relationships) then queue instead of deadlocking.
  const tables = [...new Set(MERGE_RECORD_CLASSES.map((c) => c.table))].sort();
  for (const table of tables) {
    const cols = MERGE_RECORD_CLASSES.filter((c) => c.table === table).map((c) => c.column);
    await tx.query(
      `SELECT id FROM cuspatlas.${table} WHERE ${cols.map((c) => `${c} = $1`).join(' OR ')} ORDER BY id FOR UPDATE`,
      [from],
    );
  }
  for (const cls of MERGE_RECORD_CLASSES) {
    const digest = digestSql('r', cls.digestExclude);
    const before = await tx.query<{ id: string; digest: string }>(
      `SELECT id, ${digest} AS digest FROM cuspatlas.${cls.table} r WHERE ${cls.column} = $1 ORDER BY id FOR UPDATE`,
      [from],
    );
    const ids = before.rows
      .map((r) => r.id)
      .filter((id) => only === undefined || only.has(`${cls.recordClass}:${cls.column}:${id}`));
    if (ids.length === 0) continue;
    const after = await tx.query<{ id: string; version: number; digest: string }>(
      `UPDATE cuspatlas.${cls.table} r SET ${cls.column} = $1, version = version + 1, updated_at = now()
       WHERE id = ANY ($2::uuid[]) AND ${cls.column} = $3 RETURNING id, version, ${digest} AS digest`,
      [to, ids, from],
    );
    const prior = new Map(before.rows.map((r) => [r.id, r.digest]));
    for (const r of after.rows) {
      // Relinking must never change content; a mismatch aborts the whole merge (fail closed).
      if (prior.get(r.id) !== r.digest) throw new Error('content digest changed during relink');
      out.push({ cls, id: r.id, version: r.version, digest: r.digest });
    }
    if (after.rows.length !== ids.length) throw new Error('relink lost a record');
  }
  return out;
}

async function bumpPatients(
  tx: TenantTransaction,
  merged: string,
  mergedInto: string | null,
  survivor: string,
) {
  const m = await tx.query<{ version: number }>(
    `UPDATE cuspatlas.patients SET merged_into = $1, version = version + 1, updated_at = now() WHERE id = $2 RETURNING version`,
    [mergedInto, merged],
  );
  const s = await tx.query<{ version: number }>(
    `UPDATE cuspatlas.patients SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
    [survivor],
  );
  const mv = m.rows[0]?.version;
  const sv = s.rows[0]?.version;
  if (mv === undefined || sv === undefined) throw new Error('patient bump failed');
  return { mergedVersion: mv, survivorVersion: sv };
}

type Ack = { readonly ref: string; readonly result?: MergeResult };

/** Duplicate candidates, merge, unmerge and merge history (S6). */
export function createMergeCommands(s: PatientServiceContext) {
  const { deps, execute, guarded } = s;
  const confirmations = s.confirmations;
  const probes = deps.postMergeFactProbes ?? [];

  async function resultOf(tx: TenantTransaction, r: CommandResult<Ack>): Promise<CommandResult<MergeResult>> {
    return { ...r, data: r.data.result ?? (await loadMerge(tx, r.data.ref)) };
  }

  /** Whether the caller holds an action, checked before the transaction (no nested connection). */
  async function holds(
    ctx: ActorContext,
    action: 'patients.unmerge.reconcile',
    id: string,
  ): Promise<boolean> {
    try {
      await deps.authorize(ctx, action, { tenantId: ctx.tenantId, id });
      return true;
    } catch (err) {
      if (isRefusalError(err) && err.code === 'forbidden') return false;
      throw err;
    }
  }

  return {
    findDuplicateCandidates(
      ctx: ActorContext,
      patientRef: string,
      query: unknown = {},
    ): Promise<DuplicateCandidateList> {
      return guarded(ctx, 'patients.duplicates.find', async () => {
        await deps.authorize(ctx, 'patients.duplicates.find', { tenantId: ctx.tenantId, id: patientRef });
        assertValid<Record<string, never>>(validateDuplicateQuery, query, PATIENT_PROPERTIES);
        if (!validatePatientRef(patientRef)) throw notFound();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows: targets } = await tx.query<MatchRow>(
            `SELECT ${PATIENT_COLUMNS}, match_keys FROM cuspatlas.patients WHERE id = $1`,
            [patientRef],
          );
          const target = targets[0];
          if (!target) throw notFound();
          if (target.merged_into !== null) throw conflict('patient_merged');
          const policy = await mergePolicy(tx);
          const { rows } = await tx.query<MatchRow>(
            `SELECT ${PATIENT_COLUMNS}, match_keys FROM cuspatlas.patients
             WHERE id <> $1 AND merged_into IS NULL AND match_keys && $2::text[] ORDER BY id LIMIT 200`,
            [patientRef, target.match_keys],
          );
          const data: DuplicateCandidate[] = [];
          for (const other of rows) {
            const scored = scoreCandidate(target, other);
            if (!scored || scored.score < policy.candidateMinScore) continue;
            const { token, expiresAt } = confirmations.issue({
              tenantId: ctx.tenantId,
              actorId: ctx.actorId,
              a: target.id,
              b: other.id,
              versions: { [target.id]: target.version, [other.id]: other.version },
            });
            data.push({
              candidateRef: other.id,
              score: scored.score,
              reasons: scored.reasons,
              summary: toSummary(other),
              confirmationToken: token,
              confirmationExpiresAt: expiresAt,
            });
          }
          data.sort((x, y) => y.score - x.score || (x.candidateRef < y.candidateRef ? -1 : 1));
          const page = data.slice(0, 20);
          await recordSensitiveRead(tx, {
            operation: 'patients.duplicates.find',
            resourceType: PATIENT_RESOURCE,
            resourceRefs: [target.id, ...page.map((c) => c.candidateRef)],
            queryFields: [],
          });
          return { data: page, minScore: policy.candidateMinScore, policyVersion: MERGE_POLICY_VERSION };
        });
      });
    },

    mergePatients(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<MergeResult>> {
      return guarded(ctx, 'patients.merge', async () => {
        await deps.authorize(ctx, 'patients.merge', { tenantId: ctx.tenantId, id: 'merge' });
        checkEnvelope(envelope, 'patients.merge');
        const payload = envelope.payload;
        assertValid<MergeRequest>(validateMergeRequest, payload, PATIENT_PROPERTIES);
        if (payload.survivorRef === payload.mergedRef) throw invalid('merge_same_patient');
        const bound = confirmations.verify(payload.confirmationToken, {
          tenantId: ctx.tenantId,
          actorId: ctx.actorId,
          a: payload.survivorRef,
          b: payload.mergedRef,
        });
        return deps.withTenantTransaction(ctx, async (tx) => {
          const pair = await lockPair(tx, payload.survivorRef, payload.mergedRef);
          const survivor = pair.get(payload.survivorRef) as PatientRow & { digest: string };
          const merged = pair.get(payload.mergedRef) as PatientRow & { digest: string };
          return resultOf(
            tx,
            await execute<Ack>(ctx, envelope, tx, async () => {
              if (survivor.merged_into !== null || merged.merged_into !== null)
                throw conflict('patient_already_merged');
              if (bound[survivor.id] !== survivor.version || bound[merged.id] !== merged.version) {
                throw conflict('confirmation_stale');
              }
              const blockers = await relationshipBlockers(tx, survivor.id, merged.id);
              if (blockers.length > 0) {
                throw conflict(
                  'merge_blocked',
                  blockers.map((ref) => ({ kind: RELATIONSHIP_RESOURCE, ref })),
                );
              }
              const moved = await relink(tx, merged.id, survivor.id);
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.patient_merges (tenant_id, survivor_patient_id, merged_patient_id,
                   survivor_version_before, merged_version_before, survivor_digest, merged_digest, reason_code,
                   move_count, merged_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, cuspatlas.current_actor_id())
                 RETURNING id`,
                [
                  survivor.id,
                  merged.id,
                  survivor.version,
                  merged.version,
                  survivor.digest,
                  merged.digest,
                  payload.reasonCode,
                  moved.length,
                ],
              );
              const mergeRef = rows[0]?.id;
              if (!mergeRef) throw new Error('insert returned no row');
              for (const m of moved) {
                await tx.query(
                  `INSERT INTO cuspatlas.patient_merge_moves (tenant_id, merge_id, record_class, record_ref,
                     reference_column, prior_patient_id, new_patient_id, content_digest_before, content_digest_after)
                   VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $7)`,
                  [mergeRef, m.cls.recordClass, m.id, m.cls.column, merged.id, survivor.id, m.digest],
                );
                await recordCommand(
                  tx,
                  {
                    operation: 'patients.merge',
                    resourceType: m.cls.recordClass,
                    resourceRef: m.id,
                    resourceVersion: m.version,
                  },
                  { changedFields: [m.cls.referenceField] },
                );
              }
              const v = await bumpPatients(tx, merged.id, survivor.id, survivor.id);
              await recordCommand(
                tx,
                {
                  operation: 'patients.merge',
                  resourceType: PATIENT_RESOURCE,
                  resourceRef: merged.id,
                  resourceVersion: v.mergedVersion,
                },
                { changedFields: ['mergedIntoRef'] },
              );
              await recordCommand(
                tx,
                {
                  operation: 'patients.merge',
                  resourceType: PATIENT_RESOURCE,
                  resourceRef: survivor.id,
                  resourceVersion: v.survivorVersion,
                },
                { changedFields: ['mergedRecords'] },
              );
              await recordCommand(
                tx,
                {
                  operation: 'patients.merge',
                  resourceType: MERGE_RESOURCE,
                  resourceRef: mergeRef,
                  resourceVersion: 1,
                },
                { changedFields: ['survivorRef', 'mergedRef', 'moves'] },
              );
              return { data: { ref: mergeRef, result: await loadMerge(tx, mergeRef) }, version: 1 };
            }),
          );
        });
      });
    },

    unmergePatients(
      ctx: ActorContext,
      mergeRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<MergeResult>> {
      return guarded(ctx, 'patients.unmerge', async () => {
        await deps.authorize(ctx, 'patients.unmerge', { tenantId: ctx.tenantId, id: mergeRef });
        checkEnvelope(envelope, 'patients.unmerge');
        const payload = envelope.payload;
        assertValid<UnmergeRequest>(validateUnmergeRequest, payload, PATIENT_PROPERTIES);
        if (!validateMergeRef(mergeRef)) throw notFound();
        const elevated = await holds(ctx, 'patients.unmerge.reconcile', mergeRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          // The pair is locked before the merge state is read, so a second concurrent unmerge waits and
          // then sees the first reversal (merge_already_reversed).
          const head = await loadMerge(tx, mergeRef);
          const pair = await lockPair(tx, head.survivorRef, head.mergedRef);
          const merge = await loadMerge(tx, mergeRef);
          const survivor = pair.get(merge.survivorRef) as PatientRow;
          const merged = pair.get(merge.mergedRef) as PatientRow;
          return resultOf(
            tx,
            await execute<Ack>(ctx, { ...envelope, payload: { mergeRef, ...payload } }, tx, async () => {
              if (merge.state === 'reversed') throw conflict('merge_already_reversed');
              if (survivor.merged_into !== null) throw conflict('survivor_merged');
              if (merged.merged_into !== survivor.id) throw conflict('merge_state_inconsistent');
              const policy = await mergePolicy(tx);
              const { rows: clock } = await tx.query<{ inside: boolean }>(
                `SELECT (merged_at + make_interval(days => $2) > now()) AS inside FROM cuspatlas.patient_merges WHERE id = $1`,
                [mergeRef, policy.unmergeWindowDays],
              );
              let facts = 0;
              for (const p of probes) facts += await p.count(tx, survivor.id, new Date(merge.mergedAt));
              // S-D2 (pending approval): outside the window, or after new clinical/financial facts on the
              // survivor, reversal needs the elevated role and a reconciliation review reference.
              const needsReview = clock[0]?.inside !== true || facts > 0;
              if (needsReview && !elevated) {
                throw new RefusalError({
                  code: 'forbidden',
                  reasonCode: 'unmerge_review_required',
                  detail: { reason: 'unmerge_requires_reconciliation_review' },
                });
              }
              if (needsReview && payload.reconciliationReviewRef === undefined) {
                throw invalid('reconciliation_review_required');
              }
              const moves = await tx.query<MoveRow>(
                `SELECT record_class, record_ref, reference_column, prior_patient_id, new_patient_id, content_digest_before
                 FROM cuspatlas.patient_merge_moves WHERE merge_id = $1`,
                [mergeRef],
              );
              // Every moved record must still reference the survivor; otherwise it was re-pointed since.
              const wanted = new Set(
                moves.rows.map((m) => `${m.record_class}:${m.reference_column}:${m.record_ref}`),
              );
              const restored = await relink(tx, survivor.id, merged.id, wanted);
              const got = new Set(restored.map((r) => `${r.cls.recordClass}:${r.cls.column}:${r.id}`));
              const missing = moves.rows.filter(
                (m) => !got.has(`${m.record_class}:${m.reference_column}:${m.record_ref}`),
              );
              if (missing.length > 0) {
                throw conflict(
                  'unmerge_blocked',
                  missing.slice(0, 20).map((m) => ({ kind: m.record_class, ref: m.record_ref })),
                );
              }
              const digests = new Map(
                moves.rows.map((m) => [
                  `${m.record_class}:${m.reference_column}:${m.record_ref}`,
                  m.content_digest_before,
                ]),
              );
              const changed = restored.filter(
                (r) => digests.get(`${r.cls.recordClass}:${r.cls.column}:${r.id}`) !== r.digest,
              );
              if (changed.length > 0) {
                // Content changed since the merge: refuse, typed, naming the records (never a 500).
                throw conflict(
                  'unmerge_blocked',
                  [
                    ...new Map(changed.map((r) => [r.id, { kind: r.cls.recordClass, ref: r.id }])).values(),
                  ].slice(0, 20),
                );
              }
              for (const r of restored) {
                await recordCommand(
                  tx,
                  {
                    operation: 'patients.unmerge',
                    resourceType: r.cls.recordClass,
                    resourceRef: r.id,
                    resourceVersion: r.version,
                  },
                  { changedFields: [r.cls.referenceField] },
                );
              }
              await tx.query(
                `INSERT INTO cuspatlas.patient_merge_reversals (tenant_id, merge_id, reason_code, elevated,
                   reconciliation_review_ref, move_count, reversed_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, cuspatlas.current_actor_id())`,
                [
                  mergeRef,
                  payload.reasonCode,
                  needsReview,
                  payload.reconciliationReviewRef ?? null,
                  restored.length,
                ],
              );
              const v = await bumpPatients(tx, merged.id, null, survivor.id);
              await recordCommand(
                tx,
                {
                  operation: 'patients.unmerge',
                  resourceType: PATIENT_RESOURCE,
                  resourceRef: merged.id,
                  resourceVersion: v.mergedVersion,
                },
                { changedFields: ['mergedIntoRef'] },
              );
              await recordCommand(
                tx,
                {
                  operation: 'patients.unmerge',
                  resourceType: PATIENT_RESOURCE,
                  resourceRef: survivor.id,
                  resourceVersion: v.survivorVersion,
                },
                { changedFields: ['mergedRecords'] },
              );
              // The merge aggregate: version 1 merged, version 2 reversed. The merge link itself is kept.
              await recordCommand(
                tx,
                {
                  operation: 'patients.unmerge',
                  resourceType: MERGE_RESOURCE,
                  resourceRef: mergeRef,
                  resourceVersion: 2,
                },
                { changedFields: ['reversal'] },
              );
              return { data: { ref: mergeRef, result: await loadMerge(tx, mergeRef) }, version: 2 };
            }),
          );
        });
      });
    },

    listMergeHistory(
      ctx: ActorContext,
      patientRef: string,
      query: unknown = {},
    ): Promise<{ data: MergeResult[] }> {
      return guarded(ctx, 'patients.merges.list', async () => {
        await deps.authorize(ctx, 'patients.merges.list', { tenantId: ctx.tenantId, id: patientRef });
        assertValid<Record<string, never>>(validateMergeHistoryQuery, query, PATIENT_PROPERTIES);
        if (!validatePatientRef(patientRef)) throw notFound();
        return deps.withTenantTransaction(ctx, async (tx) => {
          // Merged patients are readable here: merge history is how a merged record stays reachable.
          await loadPatient(tx, patientRef);
          const { rows } = await tx.query<{ id: string }>(
            `SELECT id FROM cuspatlas.patient_merges WHERE survivor_patient_id = $1 OR merged_patient_id = $1
             ORDER BY merged_at, id LIMIT 50`,
            [patientRef],
          );
          const data: MergeResult[] = [];
          for (const r of rows) data.push(await loadMerge(tx, r.id));
          await recordSensitiveRead(tx, {
            operation: 'patients.merges.list',
            resourceType: MERGE_RESOURCE,
            resourceRefs: data.map((d) => d.mergeRef),
            queryFields: [],
          });
          return { data };
        });
      });
    },
  };
}
