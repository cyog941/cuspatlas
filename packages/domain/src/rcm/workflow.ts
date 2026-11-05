import { createHash } from 'node:crypto';
import {
  type ActorContext,
  type ClaimWorkflowView,
  type CommandEnvelope,
  type CommandResult,
  isRefusalError,
  moneyFromMinorText,
  RefusalError,
  type TenantTransaction,
  type VisitPreparation,
  validateClaimWorkflowClose,
  validateClaimWorkflowStart,
  validateVisitPreparationQuery,
  type WorkflowCommandData,
} from '@cuspatlas/contracts';
import {
  assertRef,
  type BillingBase,
  checkEnvelope,
  conflict,
  failed,
  isPgError,
  loadSettings,
  notFound,
  validate,
} from '../billing/base';
import { canonicalJson, sha256Hex } from '../commands/digest';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { type ClaimRowLite, claimWorkItems, loadClaimRow } from './claims';
import { latestWorkflowPolicy } from './remittance-resolution';
import { lateSecondaryDue } from './secondary-due';

export const WORKFLOW_RESOURCE = 'rcmClaimWorkflow';
export const WORKFLOW_TIMER_AGGREGATE = 'rcmWorkflowTimer';
/** Automation attempts per action and subject before the workflow stops retrying (bounded). */
export const WORKFLOW_MAX_ATTEMPTS = 3;
/**
 * Minutes before the automation is tried again, by refused attempts so far on the claim's head version
 * (0 = the continuation of an action that succeeded). Bounded: no timer exists past the last attempt.
 */
export const WORKFLOW_RETRY_BACKOFF_MINUTES = [0, 5, 15] as const;
/** How long an advance waits for another advance of the same workflow before a retryable 409. */
const ADVANCE_WAIT_MS = 8000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Synthetic defaults when no workflow policy version exists (pending a practice policy). */
const DEFAULT_POLICY = { ack: 1440, follow: 43200, due: 1440, max: 2 } as const;

type Owner = 'billing' | 'front_office' | 'clinical' | 'billing_manager';
type OwedBy = 'practice' | 'patient' | 'payer' | 'platform';
interface Issue {
  readonly key: string;
  readonly reason: string;
  readonly owner: Owner;
  readonly owedBy: OwedBy;
  readonly sourceRef: string | null;
}
/** An automated action still pending after this observation: it needs a timer, not a person yet. */
interface Retry {
  readonly claimId: string;
  readonly claimVersion: number;
  readonly attempts: number;
}
interface Step {
  readonly step: string;
  readonly subjectKind: string;
  readonly subjectRef: string;
  readonly outcome: string;
  readonly attempt?: number;
  readonly inputVersions: Record<string, unknown>;
  readonly authority: Record<string, unknown>;
  readonly nextExpected: string | null;
}
interface WorkflowRow extends Record<string, unknown> {
  id: string;
  claim_id: string;
  workflow_policy_id: string | null;
  submission_policy_id: string | null;
  version: number;
}

/** The owning-domain commands the workflow may drive under a standing policy (never SQL writes). */
export interface WorkflowDrivers {
  validateClaim(ctx: ActorContext, claimRef: string, envelope: CommandEnvelope<unknown>): Promise<unknown>;
  submitClaim(ctx: ActorContext, claimRef: string, envelope: CommandEnvelope<unknown>): Promise<unknown>;
  pollClaim(ctx: ActorContext, claimRef: string): Promise<unknown>;
  prepareSecondaryClaim(
    ctx: ActorContext,
    claimRef: string,
    envelope: CommandEnvelope<unknown>,
  ): Promise<unknown>;
  resolveCoverage(ctx: ActorContext, patientRef: string, query: unknown): Promise<unknown>;
}

/** A deterministic UUID-shaped idempotency key per (workflow, action, subject, version). */
const keyOf = (...parts: (string | number)[]) => {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const NEXT: Record<string, string | null> = {
  assembly: 'readiness',
  correction: 'readiness',
  attachment_version: 'attachment_package',
  attachment_package: 'readiness',
  readiness: 'dispatch',
  dispatch: 'acknowledgement',
  transport_acknowledgement: 'payer_acknowledgement',
  transport_rejection: 'correction',
  payer_acknowledgement: 'adjudication',
  payer_rejection: 'correction',
  adjudication_paid: 'remittance',
  denial: 'appeal',
  appeal: 'appeal_review',
  appeal_review: 'adjudication',
  remittance_line: 'settlement',
  remittance_resolution: 'settlement',
  secondary_claim: 'readiness',
  settlement: 'allocation',
  allocation: 'statement',
  statement: 'patient_payment',
  patient_payment: 'closure',
  automation: null,
  timer: null,
  closure: null,
};
const EVENT_STEP: Record<string, string> = {
  transport_acknowledged: 'transport_acknowledgement',
  transport_rejected: 'transport_rejection',
  payer_acknowledged: 'payer_acknowledgement',
  payer_rejected: 'payer_rejection',
  adjudicated_paid: 'adjudication_paid',
  adjudicated_denied: 'denial',
};
/** Claim work items the workflow drives itself under a standing policy, and the action that does. */
const AUTOMATABLE: Record<string, string> = {
  validate_claim: 'validate',
  submit_claim: 'submit',
  reconcile_submission: 'poll',
};
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * The closed-loop claims workflow (CL-01..CL-12). One instance per claim lineage (the primary claim
 * plus its secondary) links the owning domains' facts by reference and never collapses their state
 * machines: every observed fact becomes one step (deduplicated by subject and outcome), every open
 * underlying issue one owned exception (deduplicated by issue key, escalated a bounded number of times
 * by durable timers the outbox worker delivers), and a standing submission policy lets the workflow
 * drive the owning commands (validate, submit, poll, prepare the secondary) under their own
 * authorization and refusals. Money moves only through B commands; closure is a separate fact.
 */
export function createWorkflowOperations(base: BillingBase, drivers: () => WorkflowDrivers) {
  const { deps, execute } = base;

  const loadWorkflow = async (tx: TenantTransaction, ref: string, lock = '') => {
    assertRef(ref);
    const { rows } = await tx.query<WorkflowRow>(
      `SELECT id, claim_id, workflow_policy_id, submission_policy_id, version FROM cuspatlas.rcm_claim_workflows
       WHERE id = $1 ${lock}`,
      [ref],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  };
  const lineage = async (tx: TenantTransaction, wf: WorkflowRow): Promise<ClaimRowLite[]> => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT $1::uuid AS id UNION ALL
       SELECT claim_id FROM cuspatlas.rcm_secondary_claims WHERE primary_claim_id = $1`,
      [wf.claim_id],
    );
    const out: ClaimRowLite[] = [];
    for (const r of rows) out.push(await loadClaimRow(tx, r.id));
    return out;
  };
  const policyOf = async (tx: TenantTransaction, wf: WorkflowRow, payerRef: string) => {
    if (wf.workflow_policy_id !== null) {
      const { rows } = await tx.query<{
        id: string;
        version_no: number;
        ack: number;
        follow: number;
        due: number;
        max: number;
      }>(
        `SELECT id, version_no, acknowledgement_due_minutes AS ack, follow_up_minutes AS follow,
           exception_due_minutes AS due, max_escalations AS max FROM cuspatlas.rcm_workflow_policies WHERE id = $1`,
        [wf.workflow_policy_id],
      );
      if (rows[0]) return rows[0];
    }
    const latest = await latestWorkflowPolicy(tx, payerRef);
    return latest
      ? {
          id: latest.id,
          version_no: latest.version_no,
          ack: latest.ack,
          follow: latest.follow,
          due: latest.due,
          max: latest.max,
        }
      : { id: null, version_no: 0, ...DEFAULT_POLICY };
  };
  /**
   * Refused automation attempts per `${action}:${claimRef}` on the claim's current head version
   * (bounded retries): a new version of the claim is a new budget, an old version's refusals stay history.
   */
  const refusedOf = async (tx: TenantTransaction, workflowId: string, claims: readonly ClaimRowLite[]) => {
    const { rows } = await tx.query<{ outcome: string; subject_ref: string; v: string | null; n: number }>(
      `SELECT outcome, subject_ref, input_versions ->> 'claimVersion' AS v, count(*)::int AS n
       FROM cuspatlas.rcm_claim_workflow_steps
       WHERE workflow_id = $1 AND step = 'automation' AND outcome LIKE '%_refused_%'
       GROUP BY outcome, subject_ref, input_versions ->> 'claimVersion'`,
      [workflowId],
    );
    const head = new Map(claims.map((c) => [c.id, String(c.version)]));
    const out = new Map<string, number>();
    for (const r of rows) {
      if (head.get(r.subject_ref) !== r.v) continue;
      const action = r.outcome.split('_refused_')[0] as string;
      const k = `${action}:${r.subject_ref}`;
      out.set(k, (out.get(k) ?? 0) + r.n);
    }
    return out;
  };
  const chargesOf = async (tx: TenantTransaction, claims: readonly ClaimRowLite[]) => {
    const { rows } = await tx.query<{ charge_id: string }>(
      `SELECT DISTINCT l.charge_id FROM cuspatlas.rcm_claim_lines l
       JOIN cuspatlas.rcm_claim_versions v ON v.id = l.version_id WHERE v.claim_id = ANY ($1::uuid[]) ORDER BY 1`,
      [claims.map((c) => c.id)],
    );
    return rows.map((r) => r.charge_id);
  };
  /** Open receivable per charge and account dimension (patient, and insurer per coverage). */
  const openOf = async (tx: TenantTransaction, charges: readonly string[]) => {
    const { rows } = await tx.query<{
      charge_id: string;
      account: string;
      coverage_id: string | null;
      s: string;
    }>(
      `SELECT charge_id, account, coverage_id, sum(amount_minor)::text AS s FROM cuspatlas.billing_journal_lines
       WHERE charge_id = ANY ($1::uuid[]) AND account IN ('patient_receivable', 'insurer_receivable')
       GROUP BY charge_id, account, coverage_id ORDER BY charge_id, account, coverage_id`,
      [charges],
    );
    return rows;
  };

  /** Every linked fact of the lineage as a step (references only, never copied state). */
  async function observeSteps(tx: TenantTransaction, wf: WorkflowRow, claims: readonly ClaimRowLite[]) {
    const steps: Step[] = [];
    const ids = claims.map((c) => c.id);
    const { rows: versions } = await tx.query<{
      id: string;
      claim_id: string;
      version_no: number;
      reason: string;
      coverage_version: number;
      content_digest: string;
      created_by: string;
    }>(
      `SELECT id, claim_id, version_no, reason, coverage_version, content_digest, created_by
       FROM cuspatlas.rcm_claim_versions WHERE claim_id = ANY ($1::uuid[]) ORDER BY claim_id, version_no`,
      [ids],
    );
    for (const v of versions) {
      const step =
        v.reason === 'prepared'
          ? 'assembly'
          : v.reason === 'replacement'
            ? 'correction'
            : 'attachment_version';
      steps.push({
        step,
        subjectKind: 'claimVersion',
        subjectRef: v.id,
        outcome: v.reason,
        inputVersions: {
          claimRef: v.claim_id,
          versionNo: v.version_no,
          coverageVersion: v.coverage_version,
          contentDigest: v.content_digest,
        },
        authority: { kind: 'actor', actorRef: v.created_by },
        nextExpected: NEXT[step] ?? null,
      });
    }
    const { rows: vals } = await tx.query<{
      id: string;
      version_id: string;
      valid: boolean;
      input_digest: string;
      validated_by: string;
    }>(
      `SELECT x.id, x.version_id, x.valid, x.input_digest, x.validated_by FROM cuspatlas.rcm_claim_validations x
       JOIN cuspatlas.rcm_claim_versions v ON v.id = x.version_id WHERE v.claim_id = ANY ($1::uuid[])`,
      [ids],
    );
    for (const x of vals)
      steps.push({
        step: 'readiness',
        subjectKind: 'claimValidation',
        subjectRef: x.id,
        outcome: x.valid ? 'valid' : 'invalid',
        inputVersions: { versionRef: x.version_id, inputDigest: x.input_digest },
        authority: { kind: 'actor', actorRef: x.validated_by },
        nextExpected: x.valid ? 'dispatch' : 'correction',
      });
    const { rows: pkgs } = await tx.query<{
      id: string;
      version_id: string;
      manifest_digest: string;
      created_by: string;
    }>(
      `SELECT id, version_id, manifest_digest, created_by FROM cuspatlas.rcm_claim_attachment_packages
       WHERE claim_id = ANY ($1::uuid[])`,
      [ids],
    );
    for (const k of pkgs)
      steps.push({
        step: 'attachment_package',
        subjectKind: 'attachmentPackage',
        subjectRef: k.id,
        outcome: 'bound',
        inputVersions: { versionRef: k.version_id, manifestDigest: k.manifest_digest },
        authority: { kind: 'actor', actorRef: k.created_by },
        nextExpected: 'readiness',
      });
    const { rows: subs } = await tx.query<{
      id: string;
      version_id: string;
      validation_id: string;
      authorization_mode: string;
      policy_id: string | null;
      outcome: string;
      resolved_by_lookup: boolean;
      submitted_by: string;
    }>(
      `SELECT id, version_id, validation_id, authorization_mode, policy_id, outcome, resolved_by_lookup, submitted_by
       FROM cuspatlas.rcm_claim_submissions WHERE claim_id = ANY ($1::uuid[])`,
      [ids],
    );
    for (const s of subs)
      steps.push({
        step: 'dispatch',
        subjectKind: 'claimSubmission',
        subjectRef: s.id,
        outcome: s.resolved_by_lookup ? `${s.outcome}_by_lookup` : s.outcome,
        inputVersions: { versionRef: s.version_id, validationRef: s.validation_id },
        authority:
          s.authorization_mode === 'policy'
            ? { kind: 'standing_policy', submissionPolicyRef: s.policy_id, executedBy: s.submitted_by }
            : { kind: 'explicit_approval', approvedBy: s.submitted_by },
        nextExpected:
          s.outcome === 'transmitted'
            ? 'payer_acknowledgement'
            : s.outcome === 'rejected'
              ? 'correction'
              : 'reconciliation',
      });
    const { rows: events } = await tx.query<{
      id: string;
      submission_id: string;
      kind: string;
      code: string | null;
      code_source: string | null;
      code_version: string | null;
    }>(
      `SELECT id, submission_id, kind, code, code_source, code_version FROM cuspatlas.rcm_claim_events
       WHERE claim_id = ANY ($1::uuid[])`,
      [ids],
    );
    for (const e of events) {
      const step = EVENT_STEP[e.kind] ?? 'partner_event';
      steps.push({
        step,
        subjectKind: 'claimEvent',
        subjectRef: e.id,
        outcome: e.kind,
        inputVersions: {
          submissionRef: e.submission_id,
          ...(e.code ? { code: e.code, codeSource: e.code_source, codeVersion: e.code_version } : {}),
        },
        authority: { kind: 'partner' },
        nextExpected: NEXT[step] ?? null,
      });
    }
    const { rows: appeals } = await tx.query<{
      id: string;
      denial_event_id: string;
      package_digest: string;
      drafted_by: string;
      decision: string | null;
      reviewed_by: string | null;
    }>(
      `SELECT a.id, a.denial_event_id, a.package_digest, a.drafted_by, r.decision, r.reviewed_by FROM cuspatlas.rcm_appeals a
       LEFT JOIN cuspatlas.rcm_appeal_reviews r ON r.appeal_id = a.id WHERE a.claim_id = ANY ($1::uuid[])`,
      [ids],
    );
    for (const a of appeals) {
      steps.push({
        step: 'appeal',
        subjectKind: 'appeal',
        subjectRef: a.id,
        outcome: 'drafted',
        inputVersions: { denialEventRef: a.denial_event_id, packageDigest: a.package_digest },
        authority: { kind: 'actor', actorRef: a.drafted_by },
        nextExpected: 'appeal_review',
      });
      if (a.decision !== null)
        steps.push({
          step: 'appeal_review',
          subjectKind: 'appeal',
          subjectRef: a.id,
          outcome: a.decision,
          inputVersions: { packageDigest: a.package_digest },
          authority: { kind: 'second_human_review', reviewedBy: a.reviewed_by },
          nextExpected: a.decision === 'approved' ? 'adjudication' : null,
        });
    }
    const { rows: lines } = await tx.query<{
      remittance_id: string;
      line_no: number;
      status: string;
      review_reason: string | null;
      content_digest: string;
    }>(
      `SELECT l.remittance_id, l.line_no, l.status, l.review_reason, r.content_digest FROM cuspatlas.rcm_remittance_lines l
       JOIN cuspatlas.rcm_remittances r ON r.id = l.remittance_id
       WHERE l.claim_id = ANY ($1::uuid[]) OR EXISTS (SELECT 1 FROM cuspatlas.rcm_remittance_line_resolutions x
         WHERE x.remittance_id = l.remittance_id AND x.line_no = l.line_no AND x.claim_id = ANY ($1::uuid[]))`,
      [ids],
    );
    const remittances = [...new Set(lines.map((l) => l.remittance_id))];
    for (const l of lines)
      steps.push({
        step: 'remittance_line',
        subjectKind: 'remittanceLine',
        subjectRef: `${l.remittance_id}:${l.line_no}`,
        outcome: l.review_reason ?? l.status,
        inputVersions: { remittanceDigest: l.content_digest },
        authority: { kind: 'partner' },
        nextExpected: l.status === 'review' ? 'remittance_resolution' : 'settlement',
      });
    const { rows: res } = await tx.query<{
      id: string;
      action: string;
      requested_by: string;
      decision: string | null;
      decided_by: string | null;
      needs_approval: boolean;
      policy: string | null;
    }>(
      `SELECT r.id, r.action, r.requested_by, d.decision, d.decided_by, r.needs_approval, r.workflow_policy_id AS policy
       FROM cuspatlas.rcm_remittance_line_resolutions r
       LEFT JOIN cuspatlas.rcm_remittance_resolution_decisions d ON d.resolution_id = r.id
       WHERE r.claim_id = ANY ($1::uuid[])`,
      [ids],
    );
    for (const r of res)
      steps.push({
        step: 'remittance_resolution',
        subjectKind: 'remittanceResolution',
        subjectRef: r.id,
        outcome:
          r.decision === null
            ? r.needs_approval
              ? `${r.action}_requested`
              : r.action
            : `${r.action}_${r.decision}`,
        inputVersions: { workflowPolicyRef: r.policy },
        authority:
          r.decision === null
            ? { kind: 'actor', actorRef: r.requested_by }
            : { kind: 'second_human_approval', requestedBy: r.requested_by, decidedBy: r.decided_by },
        nextExpected: r.decision === null && r.needs_approval ? 'resolution_approval' : 'settlement',
      });
    const { rows: secs } = await tx.query<{
      claim_id: string;
      primary_submission_id: string;
      evidence_digest: string;
    }>(
      'SELECT claim_id, primary_submission_id, evidence_digest FROM cuspatlas.rcm_secondary_claims WHERE primary_claim_id = $1',
      [wf.claim_id],
    );
    for (const s of secs)
      steps.push({
        step: 'secondary_claim',
        subjectKind: 'claim',
        subjectRef: s.claim_id,
        outcome: 'prepared',
        inputVersions: {
          primarySubmissionRef: s.primary_submission_id,
          cobEvidenceDigest: s.evidence_digest,
        },
        authority: { kind: 'owning_domain' },
        nextExpected: 'readiness',
      });
    const { rows: setts } = await tx.query<{ remittance_id: string; entry_id: string; settled_by: string }>(
      'SELECT remittance_id, entry_id, settled_by FROM cuspatlas.rcm_remittance_settlements WHERE remittance_id = ANY ($1::uuid[])',
      [remittances],
    );
    for (const s of setts)
      steps.push({
        step: 'settlement',
        subjectKind: 'journalEntry',
        subjectRef: s.entry_id,
        outcome: 'settled',
        inputVersions: { remittanceRef: s.remittance_id },
        authority: { kind: 'actor', actorRef: s.settled_by },
        nextExpected: 'allocation',
      });
    const charges = await chargesOf(tx, claims);
    const { rows: entries } = await tx.query<{
      id: string;
      kind: string;
      reverses: string | null;
      posted_by: string;
      remittance_id: string | null;
    }>(
      `SELECT id, kind, reverses_entry_id AS reverses, posted_by, remittance_id FROM cuspatlas.billing_journal_entries
       WHERE charge_id = ANY ($1::uuid[]) AND kind <> 'charge'`,
      [charges],
    );
    for (const e of entries) {
      const step = e.kind === 'allocation' ? 'patient_payment' : 'allocation';
      steps.push({
        step,
        subjectKind: 'journalEntry',
        subjectRef: e.id,
        outcome: e.reverses ? `${snake(e.kind)}_reversal` : snake(e.kind),
        inputVersions: e.remittance_id ? { remittanceRef: e.remittance_id } : {},
        authority: { kind: 'actor', actorRef: e.posted_by },
        nextExpected: NEXT[step] ?? null,
      });
    }
    const { rows: stmts } = await tx.query<{
      id: string;
      statement_version: number;
      snapshot_digest: string;
      created_by: string;
    }>(
      `SELECT s.id, s.statement_version, s.snapshot_digest, s.created_by FROM cuspatlas.billing_statements s
       WHERE s.created_at >= (SELECT created_at FROM cuspatlas.rcm_claim_workflows WHERE id = $1)
         AND s.covered_patient_ids && (SELECT array_agg(DISTINCT patient_id) FROM cuspatlas.rcm_claims WHERE id = ANY ($2::uuid[]))`,
      [wf.id, ids],
    );
    for (const s of stmts)
      steps.push({
        step: 'statement',
        subjectKind: 'statement',
        subjectRef: s.id,
        outcome: 'generated',
        inputVersions: { statementVersion: s.statement_version, snapshotDigest: s.snapshot_digest },
        authority: { kind: 'actor', actorRef: s.created_by },
        nextExpected: 'patient_payment',
      });
    return { steps, charges, remittances, stmts };
  }

  /** Every open underlying issue of the lineage, one per issue key (exception-first operation). */
  async function observeIssues(
    tx: TenantTransaction,
    wf: WorkflowRow,
    claims: readonly ClaimRowLite[],
    seen: Awaited<ReturnType<typeof observeSteps>>,
    now: Date,
  ): Promise<{ issues: Issue[]; retries: Retry[] }> {
    const refused = await refusedOf(tx, wf.id, claims);
    // Under a standing policy the workflow itself owns validate / submit / reconcile, until its bounded
    // attempts are spent: only then do they surface as a person's exception. While it owns them a
    // durable timer (never a person's memory) brings the workflow back to the pending action.
    const retries = new Map<string, Retry>();
    const automated = (kind: string, c: ClaimRowLite) => {
      const action = AUTOMATABLE[kind];
      const attempts = refused.get(`${action}:${c.id}`) ?? 0;
      const owned =
        wf.submission_policy_id !== null && action !== undefined && attempts < WORKFLOW_MAX_ATTEMPTS;
      if (owned) retries.set(c.id, { claimId: c.id, claimVersion: c.version, attempts });
      return owned;
    };
    const issues = new Map<string, Issue>();
    const add = (i: Issue) => {
      if (!issues.has(i.key)) issues.set(i.key, i);
    };
    for (const c of claims) {
      for (const w of await claimWorkItems(tx, c, now)) {
        // Silent-payer follow-up is driven by the policy timer, not the claim worklist default.
        if (w.kind === 'follow_up' || automated(w.kind, c)) continue;
        const ref = w.sourceRef && /^[0-9a-f-]{36}$/.test(w.sourceRef) ? w.sourceRef : c.id;
        add({
          key: `${w.kind === 'resolve_issue' ? w.reasonCode : w.kind}:${ref}`,
          reason: w.reasonCode,
          owner: w.owner,
          owedBy: 'practice',
          sourceRef: ref,
        });
      }
    }
    const ids = claims.map((c) => c.id);
    // A review line belongs to the workflows it concerns, never to every workflow sharing its ERA: a
    // matched line to its claim's lineage, a line a person resolved to the resolution's claim, and an
    // unmatched, unresolved line only to a lineage it could still match (a transmitted claim line of the
    // same payer and line number whose insurer responsibility is open). The remittance itself lists
    // every line with its review state for the ERA-level view.
    const { rows: review } = await tx.query<{
      remittance_id: string;
      line_no: number;
      review_reason: string;
      state: string | null;
    }>(
      `SELECT l.remittance_id, l.line_no, l.review_reason,
         CASE WHEN x.id IS NULL THEN NULL WHEN d.decision IS NOT NULL THEN d.decision WHEN x.needs_approval THEN 'pending'
              WHEN x.action = 'route_to_appeal' THEN 'routed' ELSE 'posted' END AS state
       FROM cuspatlas.rcm_remittance_lines l
       JOIN cuspatlas.rcm_remittances rem ON rem.id = l.remittance_id
       LEFT JOIN LATERAL (SELECT r.id, r.action, r.needs_approval, r.claim_id FROM cuspatlas.rcm_remittance_line_resolutions r
                          WHERE r.remittance_id = l.remittance_id AND r.line_no = l.line_no
                          ORDER BY r.created_at DESC, r.id DESC LIMIT 1) x ON true
       LEFT JOIN cuspatlas.rcm_remittance_resolution_decisions d ON d.resolution_id = x.id
       WHERE l.status = 'review' AND l.remittance_id = ANY ($1::uuid[])
         AND (l.claim_id = ANY ($2::uuid[])
           OR (x.id IS NOT NULL AND d.decision IS DISTINCT FROM 'rejected' AND x.claim_id = ANY ($2::uuid[]))
           OR ((x.id IS NULL OR d.decision = 'rejected') AND l.claim_id IS NULL AND EXISTS (
                 SELECT 1 FROM cuspatlas.rcm_claims c
                 JOIN cuspatlas.rcm_claim_submissions s ON s.claim_id = c.id AND s.outcome = 'transmitted'
                 JOIN cuspatlas.rcm_claim_lines cl ON cl.version_id = s.version_id AND cl.line_no = l.claim_line_no
                 WHERE c.id = ANY ($2::uuid[]) AND c.payer_ref = rem.payer_ref
                   AND (SELECT coalesce(sum(j.amount_minor), 0) FROM cuspatlas.billing_journal_lines j
                        WHERE j.charge_id = cl.charge_id AND j.account = 'insurer_receivable'
                          AND j.coverage_id = c.coverage_id) > 0)))`,
      [seen.remittances, ids],
    );
    for (const l of review) {
      const ref = `${l.remittance_id}:${l.line_no}`;
      if (l.state === null || l.state === 'rejected')
        add({
          key: `remittance_review:${ref}`,
          reason: l.review_reason,
          owner: 'billing',
          owedBy: 'practice',
          sourceRef: ref,
        });
      else if (l.state === 'pending')
        add({
          key: `resolution_approval:${ref}`,
          reason: 'second_human_approval',
          owner: 'billing_manager',
          owedBy: 'practice',
          sourceRef: ref,
        });
      else if (l.state === 'routed')
        add({
          key: `underpayment_appeal:${ref}`,
          reason: l.review_reason,
          owner: 'billing',
          owedBy: 'payer',
          sourceRef: ref,
        });
    }
    const open = await openOf(tx, seen.charges);
    const { rows: ranks } = await tx.query<{ id: string; rank: number }>(
      `SELECT c.id, (SELECT v.benefit_rank::int FROM cuspatlas.rcm_coverage_versions v WHERE v.coverage_id = c.id
         ORDER BY v.coverage_version DESC LIMIT 1) AS rank FROM cuspatlas.rcm_coverages c
       WHERE c.id = ANY ($1::uuid[])`,
      [[...new Set(open.map((o) => o.coverage_id).filter((x): x is string => x !== null))]],
    );
    const rankOf = new Map(ranks.map((r) => [r.id, r.rank]));
    const hasSecondary = claims.some((c) => c.rank === 2);
    // The standing policy prepares the secondary itself (bounded); only then is it a person's exception.
    const primary = claims[0];
    const secondaryOwned = (): boolean => {
      if (wf.submission_policy_id === null || !primary) return false;
      const attempts = refused.get(`secondary:${primary.id}`) ?? 0;
      if (attempts >= WORKFLOW_MAX_ATTEMPTS) return false;
      retries.set(primary.id, { claimId: primary.id, claimVersion: primary.version, attempts });
      return true;
    };
    // CL-11: a secondary coverage recorded after the primary ERA leaves the patient responsibility with
    // the patient; it is the secondary's to be claimed first, so it is due, and the patient is not billed.
    const late = hasSecondary ? [] : await lateSecondaryDue(tx, { claimIds: ids });
    for (const x of late)
      if (!secondaryOwned())
        add({
          key: `secondary_claim_due:${x.coverageId}`,
          reason: 'secondary_coverage_added_late',
          owner: 'billing',
          owedBy: 'practice',
          sourceRef: x.coverageId,
        });
    for (const o of open) {
      if (
        o.account === 'insurer_receivable' &&
        o.coverage_id &&
        BigInt(o.s) > 0n &&
        rankOf.get(o.coverage_id) === 2 &&
        !hasSecondary &&
        !secondaryOwned()
      )
        add({
          key: `secondary_claim_due:${o.coverage_id}`,
          reason: 'secondary_responsibility_open',
          owner: 'billing',
          owedBy: 'practice',
          sourceRef: o.coverage_id,
        });
    }
    for (const rem of seen.remittances) {
      const { rows } = await tx.query<{ s: string; reversed: boolean }>(
        `SELECT coalesce(sum(amount_minor), 0)::text AS s,
           EXISTS (SELECT 1 FROM cuspatlas.rcm_remittance_reversals x WHERE x.remittance_id = $1) AS reversed
         FROM cuspatlas.billing_journal_lines WHERE remittance_id = $1 AND account = 'insurer_clearing'`,
        [rem],
      );
      if (BigInt(rows[0]?.s ?? '0') > 0n)
        add({
          key: `settlement_due:${rem}`,
          reason: 'era_not_settled',
          owner: 'billing',
          owedBy: 'payer',
          sourceRef: rem,
        });
    }
    const insurerOpen = open
      .filter((o) => o.account === 'insurer_receivable')
      .reduce((s, o) => s + BigInt(o.s), 0n);
    const patientOpen = open
      .filter((o) => o.account === 'patient_receivable')
      .reduce((s, o) => s + BigInt(o.s), 0n);
    if (
      insurerOpen === 0n &&
      patientOpen > 0n &&
      late.length === 0 &&
      claims.every((c) => c.state === 'paid' || c.state === 'denied')
    ) {
      const { rows } = await tx.query<{ at: Date | null }>(
        'SELECT max(posted_at) AS at FROM cuspatlas.billing_journal_entries WHERE charge_id = ANY ($1::uuid[])',
        [seen.charges],
      );
      const lastPosting = rows[0]?.at ?? null;
      const { rows: st } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM cuspatlas.billing_statements WHERE id = ANY ($1::uuid[]) AND cutoff_at >= $2`,
        [seen.stmts.map((s) => s.id), lastPosting],
      );
      if ((st[0]?.n ?? 0) === 0)
        add({
          key: `statement_due:${wf.claim_id}`,
          reason: 'patient_responsibility_unbilled',
          owner: 'billing',
          owedBy: 'practice',
          sourceRef: wf.claim_id,
        });
    }
    const { rows: credit } = await tx.query<{ s: string }>(
      `SELECT coalesce(sum(l.amount_minor), 0)::text AS s FROM cuspatlas.billing_journal_lines l
       WHERE l.account = 'unapplied_credit' AND l.patient_id IN (SELECT patient_id FROM cuspatlas.rcm_claims WHERE id = ANY ($1::uuid[]))`,
      [ids],
    );
    if (BigInt(credit[0]?.s ?? '0') < 0n)
      add({
        key: `unapplied_credit:${claims[0]?.patient_id}`,
        reason: 'unapplied_credit',
        owner: 'billing',
        owedBy: 'practice',
        sourceRef: claims[0]?.patient_id ?? null,
      });
    // Fired payer follow-up timers whose submission is still without adjudication (CL-08).
    const { rows: follow } = await tx.query<{ subject_ref: string }>(
      `SELECT t.subject_ref FROM cuspatlas.rcm_claim_workflow_timers t
       JOIN cuspatlas.rcm_claim_workflow_timer_firings f ON f.timer_id = t.id
       WHERE t.workflow_id = $1 AND t.kind = 'payer_follow_up'
         AND NOT EXISTS (SELECT 1 FROM cuspatlas.rcm_claim_events e WHERE e.submission_id = t.subject_ref::uuid
                         AND e.kind IN ('adjudicated_paid', 'adjudicated_denied', 'payer_rejected'))`,
      [wf.id],
    );
    for (const f of follow)
      add({
        key: `payer_follow_up:${f.subject_ref}`,
        reason: 'no_adjudication_by_deadline',
        owner: 'billing',
        owedBy: 'payer',
        sourceRef: f.subject_ref,
      });
    return { issues: [...issues.values()], retries: [...retries.values()] };
  }

  /** Persists the observation: new steps, new and resolved exceptions, and the durable timers. */
  async function record(tx: TenantTransaction, wf: WorkflowRow, claims: readonly ClaimRowLite[]) {
    const { rows: clock } = await tx.query<{ now: Date }>('SELECT now() AS now');
    const now = (clock[0] as { now: Date }).now;
    const seen = await observeSteps(tx, wf, claims);
    let changed = 0;
    for (const s of seen.steps) changed += await insertStep(tx, wf.id, s);
    const policy = await policyOf(tx, wf, claims[0]?.payer_ref ?? '');
    const { issues, retries } = await observeIssues(tx, wf, claims, seen, now);
    const { rows: open } = await tx.query<{
      id: string;
      issue_key: string;
      occurrence: number;
      due_at: Date;
    }>(
      `SELECT x.id, x.issue_key, x.occurrence, x.due_at FROM cuspatlas.rcm_claim_workflow_exceptions x
       WHERE x.workflow_id = $1 AND NOT EXISTS (SELECT 1 FROM cuspatlas.rcm_claim_workflow_exception_events e
         WHERE e.exception_id = x.id AND e.kind = 'resolved')`,
      [wf.id],
    );
    const openKeys = new Map(open.map((o) => [o.issue_key, o]));
    const want = new Set(issues.map((i) => i.key));
    for (const o of open) {
      if (want.has(o.issue_key)) continue;
      await tx.query(
        `INSERT INTO cuspatlas.rcm_claim_workflow_exception_events (tenant_id, exception_id, kind, level, reason_code, recorded_by)
         VALUES (cuspatlas.current_tenant_id(), $1, 'resolved', 0, 'underlying_issue_cleared', cuspatlas.current_actor_id())
         ON CONFLICT DO NOTHING`,
        [o.id],
      );
      changed += 1;
    }
    for (const i of issues) {
      if (openKeys.has(i.key)) continue;
      const { rows } = await tx.query<{ id: string; due_at: Date }>(
        `INSERT INTO cuspatlas.rcm_claim_workflow_exceptions (tenant_id, workflow_id, issue_key, occurrence, reason_code, owner,
           owed_by, source_ref, due_at, opened_by)
         SELECT cuspatlas.current_tenant_id(), $1, $2,
           coalesce((SELECT max(occurrence) FROM cuspatlas.rcm_claim_workflow_exceptions WHERE workflow_id = $1 AND issue_key = $2), 0) + 1,
           $3, $4, $5, $6, now() + $7::int * interval '1 minute', cuspatlas.current_actor_id()
         ON CONFLICT DO NOTHING RETURNING id, due_at`,
        [wf.id, i.key, i.reason, i.owner, i.owedBy, i.sourceRef, policy.due],
      );
      if (rows[0]) {
        changed += 1;
        await timer(tx, wf.id, 'exception_escalation', rows[0].id, 1, rows[0].due_at, policy.id);
      }
    }
    // A transmitted submission without adjudication: a payer follow-up timer at the policy deadline.
    const { rows: silent } = await tx.query<{ id: string; at: Date }>(
      `SELECT s.id, s.created_at + $2::int * interval '1 minute' AS at FROM cuspatlas.rcm_claim_submissions s
       WHERE s.claim_id = ANY ($1::uuid[]) AND s.outcome = 'transmitted'
         AND NOT EXISTS (SELECT 1 FROM cuspatlas.rcm_claim_events e WHERE e.submission_id = s.id
                         AND e.kind IN ('adjudicated_paid', 'adjudicated_denied', 'payer_rejected'))`,
      [claims.map((c) => c.id), policy.follow],
    );
    for (const s of silent) changed += await timer(tx, wf.id, 'payer_follow_up', s.id, 0, s.at, policy.id);
    // An automated action that is still pending (the next step after one that succeeded, or one refused
    // with attempts left) brings the workflow back by a durable timer, so nothing waits for a manual advance.
    for (const x of retries) {
      const last = WORKFLOW_RETRY_BACKOFF_MINUTES.length - 1;
      // biome-ignore lint/complexity/useMathMinMax: billing sources avoid Math (no-float-money test)
      const minutes = WORKFLOW_RETRY_BACKOFF_MINUTES[x.attempts < last ? x.attempts : last];
      const { rows: due } = await tx.query<{ at: Date }>(
        "SELECT now() + $1::int * interval '1 minute' AS at",
        [minutes],
      );
      changed += await timer(
        tx,
        wf.id,
        'automation_retry',
        keyOf(x.claimId, 'automation_retry', x.claimVersion, x.attempts),
        x.attempts,
        (due[0] as { at: Date }).at,
        policy.id,
      );
    }
    return { changed, policy, issues, now };
  }

  async function insertStep(tx: TenantTransaction, workflowId: string, s: Step) {
    const { rowCount } = await tx.query(
      `INSERT INTO cuspatlas.rcm_claim_workflow_steps (tenant_id, workflow_id, step, subject_kind, subject_ref, outcome, attempt,
         input_versions, authority, next_expected, recorded_by)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, cuspatlas.current_actor_id())
       ON CONFLICT DO NOTHING`,
      [
        workflowId,
        s.step,
        s.subjectKind,
        s.subjectRef,
        s.outcome,
        s.attempt ?? 1,
        canonicalJson(s.inputVersions),
        canonicalJson(s.authority),
        s.nextExpected,
      ],
    );
    return rowCount;
  }

  /** A durable timer: its row plus one outbox event the worker leases at the due time. */
  async function timer(
    tx: TenantTransaction,
    workflowId: string,
    kind: 'payer_follow_up' | 'exception_escalation' | 'automation_retry',
    subjectRef: string,
    level: number,
    dueAt: Date,
    policyId: string | null,
  ) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cuspatlas.rcm_claim_workflow_timers (tenant_id, workflow_id, kind, subject_ref, level, due_at,
         workflow_policy_id, created_by)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id())
       ON CONFLICT DO NOTHING RETURNING id`,
      [workflowId, kind, subjectRef, level, dueAt, policyId],
    );
    const id = rows[0]?.id;
    if (!id) return 0;
    const { traceId, spanId } = {
      traceId: tx.ctx.correlationId.replaceAll('-', ''),
      spanId: createHash('sha256').update(id).digest('hex').slice(0, 16),
    };
    await tx.query(
      `INSERT INTO cuspatlas.outbox_events (id, event_version, tenant_id, actor_id, operation, aggregate_type, aggregate_id,
         aggregate_version, correlation_id, trace_id, span_id, occurred_at, payload_class, payload, next_attempt_at)
       VALUES (gen_random_uuid(), 1, cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), 'rcm.workflows.fireTimer',
         $1, $2, 1, $3, $4, $5, now(), 'field-names-only', '{"changedFields":["timer"]}'::jsonb, $6)`,
      [WORKFLOW_TIMER_AGGREGATE, id, tx.ctx.correlationId, traceId, spanId, dueAt],
    );
    return 1;
  }

  /**
   * Drives the owning commands under the workflow's standing submission policy (CL-05): each action
   * runs as the caller, through the domain's own authorization and refusals, with a deterministic
   * idempotency key, bounded attempts per action and subject, and is recorded as an automation step.
   */
  async function automate(ctx: ActorContext, wf: WorkflowRow) {
    if (wf.submission_policy_id === null) return [] as Step[];
    const d = drivers();
    const plan = await deps.withTenantTransaction(ctx, async (tx) => {
      const claims = await lineage(tx, wf);
      const actions: { action: string; claim: ClaimRowLite; extra?: string; attempts: number }[] = [];
      const counts = await refusedOf(tx, wf.id, claims);
      const refused = (action: string, subject: string) => counts.get(`${action}:${subject}`) ?? 0;
      const { rows: clock } = await tx.query<{ now: Date }>('SELECT now() AS now');
      const now = (clock[0] as { now: Date }).now;
      // The CL engine drives the owned claim work items (validate, submit, reconcile / poll).
      for (const c of claims) {
        const kinds = (await claimWorkItems(tx, c, now)).map((w) => w.kind);
        const next = kinds.includes('validate_claim')
          ? 'validate'
          : kinds.includes('submit_claim')
            ? 'submit'
            : kinds.includes('reconcile_submission') || kinds.includes('follow_up')
              ? 'poll'
              : null;
        if (next) actions.push({ action: next, claim: c, attempts: refused(next, c.id) });
      }
      const primary = claims[0];
      if (primary && primary.state === 'paid' && claims.length === 1) {
        const { rows } = await tx.query<{ coverage_id: string }>(
          `SELECT l.coverage_id FROM cuspatlas.billing_journal_lines l
           JOIN cuspatlas.rcm_coverage_versions v ON v.coverage_id = l.coverage_id
           WHERE l.account = 'insurer_receivable' AND l.charge_id IN (
             SELECT ln.charge_id FROM cuspatlas.rcm_claim_lines ln JOIN cuspatlas.rcm_claim_versions cv ON cv.id = ln.version_id
             WHERE cv.claim_id = $1)
           AND v.benefit_rank = 2 GROUP BY l.coverage_id HAVING sum(l.amount_minor) > 0 LIMIT 1`,
          [primary.id],
        );
        // A secondary coverage recorded after the ERA leaves the amount with the patient (CL-11).
        const coverageId =
          rows[0]?.coverage_id ?? (await lateSecondaryDue(tx, { claimIds: [primary.id] }))[0]?.coverageId;
        if (coverageId)
          actions.push({
            action: 'secondary',
            claim: primary,
            extra: coverageId,
            attempts: refused('secondary', primary.id),
          });
      }
      return actions;
    });
    const out: Step[] = [];
    const authority = {
      kind: 'standing_policy',
      submissionPolicyRef: wf.submission_policy_id,
      executedBy: ctx.actorId,
    };
    for (const a of plan) {
      if (a.attempts >= WORKFLOW_MAX_ATTEMPTS) continue;
      const env = (operation: string, payload: unknown) => ({
        operation,
        idempotencyKey: keyOf(wf.id, operation, a.claim.id, a.claim.version, a.attempts),
        payload,
      });
      let outcome = `${a.action}_done`;
      try {
        if (a.action === 'validate')
          await d.validateClaim(
            ctx,
            a.claim.id,
            env('rcm.claims.validate', { expectedVersion: a.claim.version }),
          );
        else if (a.action === 'submit')
          await d.submitClaim(
            ctx,
            a.claim.id,
            env('rcm.claims.submit', {
              expectedVersion: a.claim.version,
              authorization: { mode: 'policy', policyRef: wf.submission_policy_id },
            }),
          );
        else if (a.action === 'poll') await d.pollClaim(ctx, a.claim.id);
        else if (a.action === 'secondary')
          await d.prepareSecondaryClaim(
            ctx,
            a.claim.id,
            env('rcm.claims.prepareSecondary', { coverageRef: a.extra }),
          );
      } catch (err) {
        if (!isRefusalError(err)) throw err;
        const reason = (err.detail as { reason?: string } | undefined)?.reason ?? err.reasonCode ?? err.code;
        // Nothing new from the partner is not a failure of the workflow.
        if (a.action === 'poll' && reason === 'nothing_to_poll') continue;
        outcome = `${a.action}_refused_${snake(String(reason)).replace(/[^a-z0-9_]/g, '_')}`.slice(0, 64);
      }
      out.push({
        step: 'automation',
        subjectKind: 'claim',
        subjectRef: a.claim.id,
        outcome,
        attempt: outcome.includes('_refused') ? a.attempts + 1 : 1,
        inputVersions: { claimVersion: a.claim.version, claimState: a.claim.state },
        authority,
        nextExpected: null,
      });
    }
    return out;
  }

  /**
   * One observation of the workflow. The workflow row is locked before anything is evaluated and held
   * through the automation, so two advances never race one action into a refusal step: a concurrent
   * advance does not hold a connection while it waits (it polls `SKIP LOCKED`, so the pool cannot be
   * exhausted by waiters starving the holder's own commands), then sees the first one's facts. After
   * `ADVANCE_WAIT_MS` it is a retryable 409. The owning commands run in their own transactions and
   * never touch the workflow row.
   */
  async function advance(ctx: ActorContext, workflowRef: string) {
    const deadline = Date.now() + ADVANCE_WAIT_MS;
    for (;;) {
      const done = await advanceOnce(ctx, workflowRef);
      if (done) return done;
      if (Date.now() >= deadline)
        throw new RefusalError({ code: 'conflict', retryable: true, detail: { reason: 'workflow_busy' } });
      await sleep(75);
    }
  }
  async function advanceOnce(ctx: ActorContext, workflowRef: string) {
    return deps.withTenantTransaction(ctx, async (tx) => {
      assertRef(workflowRef);
      const { rows: locked } = await tx.query<WorkflowRow>(
        `SELECT id, claim_id, workflow_policy_id, submission_policy_id, version FROM cuspatlas.rcm_claim_workflows
         WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [workflowRef],
      );
      const wf = locked[0];
      if (!wf) {
        const { rows: exists } = await tx.query('SELECT 1 FROM cuspatlas.rcm_claim_workflows WHERE id = $1', [
          workflowRef,
        ]);
        if (exists.length === 0) throw notFound();
        return null;
      }
      const auto = await automate(ctx, wf);
      let changed = 0;
      for (const s of auto) changed += await insertStep(tx, wf.id, s);
      const claims = await lineage(tx, wf);
      const r = await record(tx, wf, claims);
      changed += r.changed;
      let version = wf.version;
      if (changed > 0) {
        version = (
          await tx.query<{ version: number }>(
            'UPDATE cuspatlas.rcm_claim_workflows SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version',
            [wf.id],
          )
        ).rows[0]?.version as number;
        await recordCommand(
          tx,
          {
            operation: 'rcm.workflows.advance',
            resourceType: WORKFLOW_RESOURCE,
            resourceRef: wf.id,
            resourceVersion: version,
          },
          { changedFields: ['steps'] },
        );
      }
      return {
        workflowRef: wf.id,
        outcome: 'advanced' as const,
        changes: changed,
        openExceptions: r.issues.length,
        version,
      };
    });
  }

  async function view(tx: TenantTransaction, wf: WorkflowRow): Promise<ClaimWorkflowView> {
    const claims = await lineage(tx, wf);
    const { rows: steps } = await tx.query<{
      step: string;
      subject_kind: string;
      subject_ref: string;
      outcome: string;
      attempt: number;
      input_versions: Record<string, unknown>;
      authority: Record<string, unknown>;
      next_expected: string | null;
      recorded_at: Date;
    }>(
      `SELECT step, subject_kind, subject_ref, outcome, attempt, input_versions, authority, next_expected, recorded_at
       FROM cuspatlas.rcm_claim_workflow_steps WHERE workflow_id = $1 ORDER BY recorded_at, id`,
      [wf.id],
    );
    const { rows: ex } = await tx.query<{
      id: string;
      issue_key: string;
      occurrence: number;
      reason_code: string;
      owner: Owner;
      owed_by: OwedBy;
      source_ref: string | null;
      opened_at: Date;
      due_at: Date;
      resolved: boolean;
      level: number;
    }>(
      `SELECT x.id, x.issue_key, x.occurrence, x.reason_code, x.owner, x.owed_by, x.source_ref, x.opened_at, x.due_at,
         EXISTS (SELECT 1 FROM cuspatlas.rcm_claim_workflow_exception_events e WHERE e.exception_id = x.id AND e.kind = 'resolved') AS resolved,
         coalesce((SELECT max(level) FROM cuspatlas.rcm_claim_workflow_exception_events e WHERE e.exception_id = x.id AND e.kind = 'escalated'), 0)::int AS level
       FROM cuspatlas.rcm_claim_workflow_exceptions x WHERE x.workflow_id = $1 ORDER BY x.opened_at, x.id`,
      [wf.id],
    );
    const { rows: timers } = await tx.query<{
      id: string;
      kind: string;
      subject_ref: string;
      level: number;
      due_at: Date;
      outcome: string | null;
    }>(
      `SELECT t.id, t.kind, t.subject_ref, t.level, t.due_at, f.outcome FROM cuspatlas.rcm_claim_workflow_timers t
       LEFT JOIN cuspatlas.rcm_claim_workflow_timer_firings f ON f.timer_id = t.id WHERE t.workflow_id = $1 ORDER BY t.due_at, t.id`,
      [wf.id],
    );
    const settings = await loadSettings(tx);
    const charges = await chargesOf(tx, claims);
    const open = await openOf(tx, charges);
    const { rows: closure } = await tx.query<{ breakdown: unknown[]; closed_at: Date }>(
      'SELECT breakdown, closed_at FROM cuspatlas.rcm_claim_workflow_closures WHERE workflow_id = $1',
      [wf.id],
    );
    return {
      workflowRef: wf.id,
      claimRef: wf.claim_id,
      workflowPolicyRef: wf.workflow_policy_id,
      submissionPolicyRef: wf.submission_policy_id,
      claims: claims.map((c) => ({ claimRef: c.id, rank: c.rank, state: c.state })),
      steps: steps.map((s) => ({
        step: s.step,
        subjectKind: s.subject_kind,
        subjectRef: s.subject_ref,
        outcome: s.outcome,
        attempt: s.attempt,
        inputVersions: s.input_versions,
        authority: s.authority,
        nextExpected: s.next_expected,
        recordedAt: s.recorded_at.toISOString(),
      })),
      exceptions: ex.map((x) => ({
        exceptionRef: x.id,
        issueKey: x.issue_key,
        occurrence: x.occurrence,
        reasonCode: x.reason_code,
        owner: x.owner,
        owedBy: x.owed_by,
        sourceRef: x.source_ref,
        state: x.resolved ? ('resolved' as const) : ('open' as const),
        escalationLevel: x.level,
        openedAt: x.opened_at.toISOString(),
        dueAt: x.due_at.toISOString(),
      })),
      timers: timers.map((t) => ({
        timerRef: t.id,
        kind: t.kind as 'payer_follow_up' | 'exception_escalation' | 'automation_retry',
        subjectRef: t.subject_ref,
        level: t.level,
        dueAt: t.due_at.toISOString(),
        firedOutcome: t.outcome,
      })),
      responsibilities: charges.map((ch) => ({
        chargeRef: ch,
        patient: moneyFromMinorText(
          settings.currency,
          open
            .filter((o) => o.charge_id === ch && o.account === 'patient_receivable')
            .reduce((s, o) => s + BigInt(o.s), 0n)
            .toString(),
        ),
        insurer: open
          .filter((o) => o.charge_id === ch && o.account === 'insurer_receivable' && BigInt(o.s) !== 0n)
          .map((o) => ({ coverageRef: o.coverage_id, amount: moneyFromMinorText(settings.currency, o.s) })),
      })),
      closure: closure[0]
        ? { closedAt: closure[0].closed_at.toISOString(), breakdown: closure[0].breakdown }
        : null,
      version: wf.version,
    } as ClaimWorkflowView;
  }

  return {
    startClaimWorkflow(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<WorkflowCommandData>> {
      const op = 'rcm.workflows.start';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ claimRef: string; workflowPolicyRef?: string; submissionPolicyRef?: string }>(
          validateClaimWorkflowStart,
          p,
        );
        return deps.withTenantTransaction(ctx, async (tx) => {
          const claim = await loadClaimRow(tx, p.claimRef);
          return execute<WorkflowCommandData>(ctx, envelope, tx, async () => {
            if (claim.rank !== 1) throw failed('not_a_primary_claim');
            for (const [ref, table] of [
              [p.workflowPolicyRef, 'rcm_workflow_policies'],
              [p.submissionPolicyRef, 'rcm_submission_policies'],
            ] as const) {
              if (ref === undefined) continue;
              assertRef(ref);
              const { rows } = await tx.query(`SELECT 1 FROM cuspatlas.${table} WHERE id = $1`, [ref]);
              if (rows.length === 0) throw notFound();
            }
            try {
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.rcm_claim_workflows (tenant_id, claim_id, workflow_policy_id, submission_policy_id, created_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id()) RETURNING id`,
                [claim.id, p.workflowPolicyRef ?? null, p.submissionPolicyRef ?? null],
              );
              const id = rows[0]?.id as string;
              await recordCommand(
                tx,
                { operation: op, resourceType: WORKFLOW_RESOURCE, resourceRef: id, resourceVersion: 1 },
                { changedFields: ['workflow'] },
              );
              return {
                data: { workflowRef: id, outcome: 'started', changes: 0, openExceptions: 0 },
                version: 1,
              };
            } catch (err) {
              if (isPgError(err, '23505')) throw conflict('workflow_exists');
              throw err;
            }
          });
        });
      });
    },

    advanceClaimWorkflow(ctx: ActorContext, workflowRef: string): Promise<{ data: WorkflowCommandData }> {
      const op = 'rcm.workflows.advance';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        const r = await advance(ctx, workflowRef);
        return {
          data: {
            workflowRef: r.workflowRef,
            outcome: r.outcome,
            changes: r.changes,
            openExceptions: r.openExceptions,
          },
        };
      });
    },

    getClaimWorkflow(ctx: ActorContext, workflowRef: string): Promise<ClaimWorkflowView> {
      const op = 'rcm.workflows.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const wf = await loadWorkflow(tx, workflowRef);
          const v = await view(tx, wf);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: WORKFLOW_RESOURCE,
            resourceRefs: [wf.id],
            queryFields: [],
          });
          return v;
        });
      });
    },

    /**
     * A durable timer fired by the outbox worker (or its REST twin). Recorded once per timer; an
     * escalation raises the exception one level (bounded by the policy) and schedules the next one; a
     * payer follow-up opens its owned exception through the observation; then the workflow advances.
     */
    fireWorkflowTimer(ctx: ActorContext, timerRef: string): Promise<{ data: WorkflowCommandData }> {
      const op = 'rcm.workflows.fireTimer';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertRef(timerRef);
        const fired = await deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            workflow_id: string;
            kind: string;
            subject_ref: string;
            level: number;
            due: boolean;
          }>(
            `SELECT id, workflow_id, kind, subject_ref, level, due_at <= now() AS due FROM cuspatlas.rcm_claim_workflow_timers
             WHERE id = $1`,
            [timerRef],
          );
          const t = rows[0];
          if (!t) throw notFound();
          if (!t.due)
            throw new RefusalError({
              code: 'conflict',
              retryable: true,
              detail: { reason: 'timer_not_due' },
            });
          const wf = await loadWorkflow(tx, t.workflow_id, 'FOR UPDATE');
          const { rows: done } = await tx.query(
            'SELECT 1 FROM cuspatlas.rcm_claim_workflow_timer_firings WHERE timer_id = $1',
            [t.id],
          );
          if (done.length > 0) return { workflowRef: wf.id, replay: true };
          let outcome = 'fired';
          if (t.kind === 'exception_escalation') {
            const claims = await lineage(tx, wf);
            const policy = await policyOf(tx, wf, claims[0]?.payer_ref ?? '');
            const { rows: ex } = await tx.query<{ resolved: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM cuspatlas.rcm_claim_workflow_exception_events e WHERE e.exception_id = x.id
                 AND e.kind = 'resolved') AS resolved FROM cuspatlas.rcm_claim_workflow_exceptions x WHERE x.id = $1`,
              [t.subject_ref],
            );
            if (!ex[0] || ex[0].resolved) outcome = 'already_resolved';
            else if (t.level > policy.max) outcome = 'escalation_exhausted';
            else {
              await tx.query(
                `INSERT INTO cuspatlas.rcm_claim_workflow_exception_events (tenant_id, exception_id, kind, level, reason_code, recorded_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, 'escalated', $2, 'deadline_passed', cuspatlas.current_actor_id())
                 ON CONFLICT DO NOTHING`,
                [t.subject_ref, t.level],
              );
              outcome = `escalated_level_${t.level}`;
              if (t.level < policy.max) {
                const { rows: next } = await tx.query<{ at: Date }>(
                  "SELECT now() + $1::int * interval '1 minute' AS at",
                  [policy.due],
                );
                await timer(
                  tx,
                  wf.id,
                  'exception_escalation',
                  t.subject_ref,
                  t.level + 1,
                  (next[0] as { at: Date }).at,
                  policy.id,
                );
              }
            }
          }
          await tx.query(
            `INSERT INTO cuspatlas.rcm_claim_workflow_timer_firings (tenant_id, timer_id, outcome, fired_by)
             VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id())`,
            [t.id, outcome],
          );
          await insertStep(tx, wf.id, {
            step: 'timer',
            subjectKind: 'workflowTimer',
            subjectRef: t.id,
            outcome,
            inputVersions: { kind: t.kind, level: t.level },
            authority: { kind: 'durable_timer', firedBy: ctx.actorId },
            nextExpected: null,
          });
          return { workflowRef: wf.id, replay: false };
        });
        const r = await advance(ctx, fired.workflowRef);
        return {
          data: {
            workflowRef: r.workflowRef,
            outcome: 'advanced',
            changes: r.changes,
            openExceptions: r.openExceptions,
          },
        };
      });
    },

    /**
     * CL-12 closure: only when every lineage charge has zero patient and insurer responsibility, no
     * exception is open, no resolution waits for approval, no ERA is unsettled and the account holds
     * no unapplied credit. The breakdown names how each charge was resolved (insurer payment, patient
     * payment, contractual or approved adjustment, write-off, transfer); unresolved is zero by rule.
     */
    closeClaimWorkflow(
      ctx: ActorContext,
      workflowRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<WorkflowCommandData>> {
      const op = 'rcm.workflows.close';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ expectedVersion: number }>(validateClaimWorkflowClose, p);
        const pre = await deps.withTenantTransaction(ctx, (tx) => loadWorkflow(tx, workflowRef));
        await advance(ctx, pre.id);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const wf = await loadWorkflow(tx, workflowRef, 'FOR UPDATE');
          return execute<WorkflowCommandData>(
            ctx,
            { ...envelope, payload: { workflowRef, ...p } },
            tx,
            async () => {
              const { rows: done } = await tx.query(
                'SELECT 1 FROM cuspatlas.rcm_claim_workflow_closures WHERE workflow_id = $1',
                [wf.id],
              );
              if (done.length > 0) throw conflict('workflow_closed');
              const claims = await lineage(tx, wf);
              const charges = await chargesOf(tx, claims);
              const blockers: { kind: string; ref: string }[] = [];
              for (const o of await openOf(tx, charges))
                if (BigInt(o.s) !== 0n)
                  blockers.push({
                    kind:
                      o.account === 'patient_receivable' ? 'patientResponsibility' : 'insurerResponsibility',
                    ref: o.charge_id,
                  });
              // Live under the lock (not from the observation made before it): an ERA that still holds
              // reported money in clearing is unsettled whatever the exceptions say.
              const { rows: eras } = await tx.query<{ remittance_id: string }>(
                `SELECT DISTINCT l.remittance_id FROM cuspatlas.rcm_remittance_lines l
                 WHERE l.claim_id = ANY ($1::uuid[]) OR EXISTS (SELECT 1 FROM cuspatlas.rcm_remittance_line_resolutions x
                   WHERE x.remittance_id = l.remittance_id AND x.line_no = l.line_no AND x.claim_id = ANY ($1::uuid[]))
                 ORDER BY 1`,
                [claims.map((c) => c.id)],
              );
              for (const e of eras) {
                const { rows } = await tx.query<{ s: string }>(
                  `SELECT coalesce(sum(amount_minor), 0)::text AS s FROM cuspatlas.billing_journal_lines
                   WHERE remittance_id = $1 AND account = 'insurer_clearing'`,
                  [e.remittance_id],
                );
                if (BigInt(rows[0]?.s ?? '0') > 0n)
                  blockers.push({ kind: 'unsettledRemittance', ref: e.remittance_id });
              }
              const { rows: ex } = await tx.query<{ id: string }>(
                `SELECT x.id FROM cuspatlas.rcm_claim_workflow_exceptions x WHERE x.workflow_id = $1
                 AND NOT EXISTS (SELECT 1 FROM cuspatlas.rcm_claim_workflow_exception_events e WHERE e.exception_id = x.id AND e.kind = 'resolved')`,
                [wf.id],
              );
              for (const x of ex) blockers.push({ kind: 'openException', ref: x.id });
              if (blockers.length > 0) throw conflict('closure_blocked', blockers.slice(0, 20));
              const { rows: parts } = await tx.query<{
                charge_id: string;
                kind: string;
                reason_code: string | null;
                s: string;
              }>(
                `SELECT l.charge_id, e.kind, coalesce(o.reason_code, e.reason_code) AS reason_code, sum(l.amount_minor)::text AS s
               FROM cuspatlas.billing_journal_lines l JOIN cuspatlas.billing_journal_entries e ON e.id = l.entry_id
               LEFT JOIN cuspatlas.billing_journal_entries o ON o.id = e.reverses_entry_id
               WHERE l.charge_id = ANY ($1::uuid[]) AND l.account IN ('patient_receivable', 'insurer_receivable')
               GROUP BY l.charge_id, e.kind, coalesce(o.reason_code, e.reason_code) ORDER BY 1, 2, 3`,
                [charges],
              );
              const settings = await loadSettings(tx);
              const breakdown = charges.map((ch) => {
                const mine = parts.filter((x) => x.charge_id === ch);
                const sum = (pred: (x: (typeof mine)[number]) => boolean) =>
                  moneyFromMinorText(
                    settings.currency,
                    (-mine.filter(pred).reduce((s, x) => s + BigInt(x.s), 0n)).toString(),
                  );
                const billed = moneyFromMinorText(
                  settings.currency,
                  mine
                    .filter((x) => x.kind === 'charge')
                    .reduce((s, x) => s + BigInt(x.s), 0n)
                    .toString(),
                );
                return {
                  chargeRef: ch,
                  billed,
                  insurerPayment: sum((x) => x.kind === 'insurerPayment'),
                  patientPayment: sum((x) => x.kind === 'allocation'),
                  contractualAdjustment: sum(
                    (x) => x.kind === 'adjustment' && x.reason_code === 'contractual_allowance',
                  ),
                  otherAdjustment: sum(
                    (x) => x.kind === 'adjustment' && x.reason_code !== 'contractual_allowance',
                  ),
                  writeOff: sum((x) => x.kind === 'writeOff'),
                  transfersNet: sum((x) => x.kind === 'responsibilityTransfer'),
                  unresolved: moneyFromMinorText(settings.currency, '0'),
                };
              });
              await tx.query(
                `INSERT INTO cuspatlas.rcm_claim_workflow_closures (tenant_id, workflow_id, breakdown, breakdown_digest, closed_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2::jsonb, $3, cuspatlas.current_actor_id())`,
                [wf.id, canonicalJson(breakdown), sha256Hex(canonicalJson(breakdown))],
              );
              await insertStep(tx, wf.id, {
                step: 'closure',
                subjectKind: 'claimWorkflow',
                subjectRef: wf.id,
                outcome: 'closed',
                inputVersions: {
                  workflowVersion: wf.version,
                  breakdownDigest: sha256Hex(canonicalJson(breakdown)),
                },
                authority: { kind: 'actor', actorRef: ctx.actorId },
                nextExpected: null,
              });
              const version = (
                await tx.query<{ version: number }>(
                  'UPDATE cuspatlas.rcm_claim_workflows SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version',
                  [wf.id],
                )
              ).rows[0]?.version as number;
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: WORKFLOW_RESOURCE,
                  resourceRef: wf.id,
                  resourceVersion: version,
                },
                { changedFields: ['closure'] },
              );
              return {
                data: { workflowRef: wf.id, outcome: 'closed', changes: 1, openExceptions: 0 },
                version,
              };
            },
          );
        });
      });
    },

    /**
     * CL-01 visit preparation: a read projection over B5 coverage resolution for a service date. Each
     * coverage shows its status, freshness and source; unknown or stale stays unknown or stale, and
     * payment is never implied (paymentAssurance none). Missing facts name their owner.
     */
    async prepareVisit(ctx: ActorContext, patientRef: string, query: unknown): Promise<VisitPreparation> {
      const op = 'rcm.visits.prepare';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ serviceDate: string }>(validateVisitPreparationQuery, query);
        const res = (await drivers().resolveCoverage(ctx, patientRef, query)) as {
          patientRef: string;
          serviceDate: string;
          coverages: {
            coverageRef: string;
            rank: string;
            payerRef: string;
            coverageStatus: string;
            eligibility: { eligibilityRef?: string; state?: string; freshness?: string } | null;
          }[];
          checkedAt: string;
        };
        const items: { code: string; owner: Owner; sourceRef: string | null }[] = [];
        if (res.coverages.length === 0)
          items.push({ code: 'no_coverage_on_file', owner: 'front_office', sourceRef: null });
        for (const c of res.coverages) {
          const code =
            c.coverageStatus === 'unknown'
              ? 'eligibility_unknown'
              : c.coverageStatus === 'stale'
                ? 'eligibility_stale'
                : c.coverageStatus === 'inactive'
                  ? 'coverage_inactive'
                  : c.eligibility?.state === 'unverified'
                    ? 'eligibility_unverified'
                    : null;
          if (code) items.push({ code, owner: 'front_office', sourceRef: c.coverageRef });
        }
        return {
          patientRef: res.patientRef,
          serviceDate: res.serviceDate,
          coverages: res.coverages.map((c) => ({
            coverageRef: c.coverageRef,
            rank: c.rank,
            payerRef: c.payerRef,
            coverageStatus: c.coverageStatus,
            eligibilityState: c.eligibility?.state ?? null,
            freshness: c.eligibility?.freshness ?? null,
            eligibilityRef: c.eligibility?.eligibilityRef ?? null,
          })),
          missing: items,
          ready: items.length === 0,
          paymentAssurance: 'none',
          checkedAt: res.checkedAt,
        } as VisitPreparation;
      });
    },
  };
}
