import {
  type ActorContext,
  type AppealCommandData,
  type AppealDraft,
  type AppealReview,
  type AttachmentPackageCreate,
  CLAIM_QUEUES,
  type ClaimAttach,
  type ClaimCommandData,
  type ClaimIssue,
  type ClaimPrepare,
  type ClaimQueueName,
  type ClaimReplace,
  type ClaimSubmit,
  type ClaimVersioned,
  type ClaimWorkItem,
  type CommandEnvelope,
  type CommandResult,
  moneyFromMinorText,
  type PolicyCommandData,
  RefusalError,
  type SecondaryClaimPrepare,
  type SubmissionPolicyCreate,
  type TenantTransaction,
  validateAppealDraft,
  validateAppealReview,
  validateAttachmentPackageCreate,
  validateClaimAttach,
  validateClaimMeasuresQuery,
  validateClaimPrepare,
  validateClaimQueueQuery,
  validateClaimReplace,
  validateClaimSubmit,
  validateClaimVersioned,
  validateClaimWorklistQuery,
  validateSecondaryClaimPrepare,
  validateSubmissionPolicyCreate,
  validateSubmissionPolicyRevoke,
} from '@cuspatlas/contracts';
import { requireAdapter } from '../billing/adapters';
import {
  assertRef,
  type BillingBase,
  checkEnvelope,
  conflict,
  failed,
  inTenantCurrency,
  isPgError,
  loadPatient,
  loadSettings,
  mergeSet,
  notFound,
  validate,
} from '../billing/base';
import { lockAggregates } from '../billing/entries';
import { resolveAllowance } from '../billing/fees';
import { postEntry, SignViolation } from '../billing/journal';
import { committedReplay, providerTiming, withTimeout } from '../billing/payments';
import { loadRenderedProcedureEvent } from '../clinical/procedures';
import { canonicalJson, sha256Hex } from '../commands/digest';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import type { AttachmentSourcePort } from './attachments';
import {
  CLAIM_MEASURE_AGE_DAYS,
  CLAIM_QUEUE_SCAN,
  type ClaimFacts,
  chargesToCreate,
  compareWorkPriority,
  DEFAULT_FILING_DEADLINE_DAYS,
  escalationLevels,
  insurerReceivable,
  MEASURE_DEFINITIONS,
  queueItemOf,
  TIMELY_FILING_DAYS,
} from './claim-queues';
import { type ClaimsPartnerPort, createFakeClearinghouse, type TransportAnswer } from './clearinghouse';

export const CLAIM_RESOURCE = 'rcmClaim';
/** Days without adjudication after transmission before a follow-up is due (synthetic default). */
export const CLAIM_FOLLOW_UP_DAYS = 30;
/** Claims per worklist page (newest first). */
export const CLAIM_WORKLIST_PAGE = 200;
const SYN_DENIALS = { source: 'syn-denial-codes', version: 'v1' } as const;
const SYN_REJECTIONS = { source: 'syn-clearinghouse-rejections', version: 'v1' } as const;

export interface ClaimRow extends Record<string, unknown> {
  id: string;
  patient_id: string;
  coverage_id: string;
  payer_ref: string;
  version: number;
}
interface LineRow extends Record<string, unknown> {
  line_no: number;
  procedure_id: string;
  charge_id: string;
  code_ref: string;
  date_of_service: string;
  tooth_ref: string | null;
  rendering_provider_id: string;
  billed: string;
  allowance: string | null;
}
interface VersionRow extends Record<string, unknown> {
  id: string;
  version_no: number;
  reason: 'prepared' | 'attachment' | 'replacement';
  coverage_version: number;
  billed: string;
  currency: string;
}

const later = (reason: string) => new RefusalError({ code: 'conflict', retryable: true, detail: { reason } });

async function loadClaim(tx: TenantTransaction, claimRef: string, lock = ''): Promise<ClaimRow> {
  assertRef(claimRef);
  const { rows } = await tx.query<ClaimRow>(
    `SELECT id, patient_id, coverage_id, payer_ref, version FROM cuspatlas.rcm_claims WHERE id = $1 ${lock}`,
    [claimRef],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}
async function headOf(tx: TenantTransaction, claimId: string): Promise<VersionRow> {
  const { rows } = await tx.query<VersionRow>(
    `SELECT id, version_no, reason, coverage_version, billed_total_minor::text AS billed, currency
     FROM cuspatlas.rcm_claim_versions WHERE claim_id = $1 ORDER BY version_no DESC LIMIT 1`,
    [claimId],
  );
  return rows[0] as VersionRow;
}
async function linesOf(tx: TenantTransaction, versionId: string): Promise<LineRow[]> {
  const { rows } = await tx.query<LineRow>(
    `SELECT line_no, procedure_id, charge_id, code_ref, to_char(date_of_service, 'YYYY-MM-DD') AS date_of_service,
       tooth_ref, rendering_provider_id, billed_minor::text AS billed, allowance_minor::text AS allowance
     FROM cuspatlas.rcm_claim_lines WHERE version_id = $1 ORDER BY line_no`,
    [versionId],
  );
  return rows;
}
async function attachmentsOf(tx: TenantTransaction, versionId: string) {
  const { rows } = await tx.query<{ object_ref: string; kind: string }>(
    'SELECT object_ref, kind FROM cuspatlas.rcm_claim_attachments WHERE version_id = $1 ORDER BY object_ref',
    [versionId],
  );
  return rows;
}
async function coverageVersionOf(tx: TenantTransaction, coverageId: string): Promise<number> {
  const { rows } = await tx.query<{ v: number }>(
    'SELECT max(coverage_version)::int AS v FROM cuspatlas.rcm_coverage_versions WHERE coverage_id = $1',
    [coverageId],
  );
  return rows[0]?.v ?? 1;
}
/** The posted, unreversed clinical charge of a procedure (the completion fact B relies on). */
async function chargeOf(tx: TenantTransaction, procedureRef: string, lock = false) {
  // `lock`: readiness holds the charge FOR SHARE from validation until the submission is recorded.
  const { rows } = await tx.query<{ id: string; amount: string; reversed: boolean }>(
    `SELECT c.id, c.amount_minor::text AS amount,
       EXISTS (SELECT 1 FROM cuspatlas.billing_journal_entries e JOIN cuspatlas.billing_journal_entries r
                 ON r.reverses_entry_id = e.id WHERE e.charge_id = c.id AND e.kind = 'charge') AS reversed
     FROM cuspatlas.billing_charges c WHERE c.procedure_ref = $1 AND c.source = 'clinical_procedure'
     ${lock ? 'FOR SHARE OF c' : ''}`,
    [procedureRef],
  );
  return rows[0] ?? null;
}

/** CL-04: the attachment package bound to one claim version, with its items, or null. */
export async function packageOf(tx: TenantTransaction, versionId: string) {
  const { rows } = await tx.query<{ id: string; manifest_digest: string }>(
    'SELECT id, manifest_digest FROM cuspatlas.rcm_claim_attachment_packages WHERE version_id = $1',
    [versionId],
  );
  const pkg = rows[0];
  if (!pkg) return null;
  const { rows: items } = await tx.query<{ object_ref: string; digest: string }>(
    'SELECT object_ref, digest FROM cuspatlas.rcm_claim_attachment_package_items WHERE package_id = $1 ORDER BY object_ref',
    [pkg.id],
  );
  return { ...pkg, items };
}

/** B8: the primary claim a secondary claim relies on, or null for a primary claim. */
export async function secondaryOf(tx: TenantTransaction, claimId: string): Promise<string | null> {
  const { rows } = await tx.query<{ primary_claim_id: string }>(
    'SELECT primary_claim_id FROM cuspatlas.rcm_secondary_claims WHERE claim_id = $1',
    [claimId],
  );
  return rows[0]?.primary_claim_id ?? null;
}

/**
 * B8 COB evidence: the remittance lines that posted one claim line (matched at ingestion, matched by a
 * resolution, or approved with a residual), each with whether its remittance was reversed since.
 */
export async function postedRemittanceLines(tx: TenantTransaction, claimId: string, lineNo: number) {
  const { rows } = await tx.query<{
    remittance_id: string;
    line_no: number;
    paid: string;
    contractual: string;
    pr: string;
    reversed: boolean;
  }>(
    `SELECT rl.remittance_id, rl.line_no, rl.paid_minor::text AS paid, rl.contractual_minor::text AS contractual,
       rl.patient_responsibility_minor::text AS pr,
       EXISTS (SELECT 1 FROM cuspatlas.rcm_remittance_reversals x WHERE x.remittance_id = rl.remittance_id) AS reversed
     FROM cuspatlas.rcm_remittance_lines rl
     WHERE (rl.status = 'posted' AND rl.claim_id = $1 AND rl.claim_line_no = $2)
        OR EXISTS (SELECT 1 FROM cuspatlas.rcm_remittance_line_resolutions r
                   LEFT JOIN cuspatlas.rcm_remittance_resolution_decisions d ON d.resolution_id = r.id
                   WHERE r.remittance_id = rl.remittance_id AND r.line_no = rl.line_no AND r.claim_id = $1
                     AND r.claim_line_no = $2 AND (r.action = 'match_claim_line' OR d.decision = 'approved'))
     ORDER BY rl.remittance_id, rl.line_no`,
    [claimId, lineNo],
  );
  return rows;
}

async function accountOpen(
  tx: TenantTransaction,
  chargeId: string,
  account: string,
  coverageId: string | null,
) {
  const { rows } = await tx.query<{ s: string }>(
    `SELECT coalesce(sum(amount_minor), 0)::text AS s FROM cuspatlas.billing_journal_lines
     WHERE charge_id = $1 AND account = $2 AND ($3::uuid IS NULL OR coverage_id = $3::uuid)`,
    [chargeId, account, coverageId],
  );
  return BigInt(rows[0]?.s ?? '0');
}

/** The benefit rank (1 primary .. 3 tertiary) of a coverage's latest version. */
export async function coverageRankOf(tx: TenantTransaction, coverageId: string): Promise<number> {
  const { rows } = await tx.query<{ r: number }>(
    `SELECT benefit_rank::int AS r FROM cuspatlas.rcm_coverage_versions WHERE coverage_id = $1
     ORDER BY coverage_version DESC LIMIT 1`,
    [coverageId],
  );
  return rows[0]?.r ?? 1;
}

/**
 * A procedure is on at most one open claim lineage per coverage rank (review MUST-FAIL 2). Holds the
 * procedures a version names (a concurrent second claim waits on the partial unique index, then
 * finds the hold and is refused) and releases those a replacement of the same lineage dropped.
 */
async function holdProcedures(
  tx: TenantTransaction,
  claimId: string,
  versionId: string,
  rank: number,
  procedureIds: readonly string[],
) {
  for (const p of [...new Set(procedureIds)]) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cuspatlas.rcm_claim_procedure_holds (tenant_id, procedure_id, benefit_rank, claim_id, version_id)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4)
       ON CONFLICT (tenant_id, procedure_id, benefit_rank) WHERE released_at IS NULL DO NOTHING RETURNING id`,
      [p, rank, claimId, versionId],
    );
    if (rows.length > 0) continue;
    const { rows: held } = await tx.query<{ claim_id: string }>(
      `SELECT claim_id FROM cuspatlas.rcm_claim_procedure_holds
       WHERE procedure_id = $1 AND benefit_rank = $2 AND released_at IS NULL`,
      [p, rank],
    );
    if (held[0]?.claim_id !== claimId)
      throw conflict('procedure_on_open_claim', held[0] ? [{ kind: 'claim', ref: held[0].claim_id }] : []);
  }
  await tx.query(
    `UPDATE cuspatlas.rcm_claim_procedure_holds SET released_at = now(), released_by_version_id = $2
     WHERE claim_id = $1 AND released_at IS NULL AND NOT (procedure_id = ANY ($3::uuid[]))`,
    [claimId, versionId, procedureIds],
  );
}

/** Assembles claim lines ONLY from C14 rendered procedures with posted charges (CL-02). */
async function buildLines(
  tx: TenantTransaction,
  setIds: readonly string[],
  coverageId: string,
  procedureRefs: readonly string[],
) {
  const lines: Omit<LineRow, 'line_no'>[] = [];
  for (const ref of procedureRefs) {
    const ev = await loadRenderedProcedureEvent(tx, ref);
    if (ev === null) throw notFound();
    if (ev.eventType !== 'procedure.rendered.v1') throw failed('missing_completion_fact');
    if (!setIds.includes(ev.patientRef)) throw failed('procedure_patient_mismatch');
    const charge = await chargeOf(tx, ev.procedureRef);
    if (!charge) throw later('missing_completion_fact');
    if (charge.reversed) throw failed('procedure_reversed');
    const allowance = await resolveAllowance(tx, ev.codeRef, ev.dateOfService, coverageId);
    lines.push({
      procedure_id: ev.procedureRef,
      charge_id: charge.id,
      code_ref: ev.codeRef,
      date_of_service: ev.dateOfService,
      tooth_ref: ev.toothSurface?.toothRef ?? null,
      rendering_provider_id: ev.renderingProviderRef,
      billed: charge.amount,
      allowance: allowance === null ? null : String(allowance.fee.minor),
    });
  }
  return lines;
}

async function insertVersion(
  tx: TenantTransaction,
  claimId: string,
  o: {
    versionNo: number;
    reason: VersionRow['reason'];
    reasonCode: string | null;
    supersedes: string | null;
    coverageVersion: number;
    currency: string;
    lines: readonly Omit<LineRow, 'line_no'>[];
    attachments: readonly { object_ref: string; kind: string }[];
  },
): Promise<string> {
  const billed = o.lines.reduce((s, l) => s + BigInt(l.billed as string), 0n);
  const digest = sha256Hex(
    canonicalJson({ lines: o.lines, attachments: o.attachments, cv: o.coverageVersion }),
  );
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.rcm_claim_versions (tenant_id, claim_id, version_no, reason, reason_code, supersedes_id,
       coverage_version, billed_total_minor, currency, line_count, content_digest, created_by)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, cuspatlas.current_actor_id())
     RETURNING id`,
    [
      claimId,
      o.versionNo,
      o.reason,
      o.reasonCode,
      o.supersedes,
      o.coverageVersion,
      billed.toString(),
      o.currency,
      o.lines.length,
      digest,
    ],
  );
  const id = rows[0]?.id as string;
  for (const [i, l] of o.lines.entries()) {
    await tx.query(
      `INSERT INTO cuspatlas.rcm_claim_lines (tenant_id, version_id, line_no, procedure_id, charge_id, code_ref,
         date_of_service, tooth_ref, rendering_provider_id, billed_minor, allowance_minor)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10)`,
      [
        id,
        i + 1,
        l.procedure_id,
        l.charge_id,
        l.code_ref,
        l.date_of_service,
        l.tooth_ref,
        l.rendering_provider_id,
        l.billed,
        l.allowance,
      ],
    );
  }
  for (const a of o.attachments) {
    await tx.query(
      `INSERT INTO cuspatlas.rcm_claim_attachments (tenant_id, version_id, object_ref, kind)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3)`,
      [id, a.object_ref, a.kind],
    );
  }
  return id;
}

/**
 * Readiness validation (CL-03): deterministic rules naming the exact missing fact, its owner and the
 * source reference. The input digest binds the result to the facts it read, so any change (a charge
 * reversed, coverage changed, eligibility recorded) invalidates it.
 */
async function readiness(tx: TenantTransaction, claim: ClaimRow, head: VersionRow, lock = false) {
  const lines = await linesOf(tx, head.id);
  const attachments = await attachmentsOf(tx, head.id);
  const issues: ClaimIssue[] = [];
  const cv = await coverageVersionOf(tx, claim.coverage_id);
  if (cv !== head.coverage_version)
    issues.push({ code: 'coverage_changed', owner: 'billing', sourceRef: claim.coverage_id });
  const facts: unknown[] = [cv];
  for (const l of lines) {
    const charge = await chargeOf(tx, l.procedure_id, lock);
    if (!charge || charge.reversed)
      issues.push({ code: 'charge_reversed', owner: 'billing', sourceRef: l.charge_id });
    const { rows: eff } = await tx.query<{ ok: boolean }>(
      `SELECT (v.effective_from <= $2::date AND (v.effective_until IS NULL OR v.effective_until >= $2::date)) AS ok
       FROM cuspatlas.rcm_coverage_versions v WHERE v.coverage_id = $1 ORDER BY v.coverage_version DESC LIMIT 1`,
      [claim.coverage_id, l.date_of_service],
    );
    if (eff[0]?.ok !== true)
      issues.push({ code: 'coverage_not_effective', owner: 'front_office', sourceRef: claim.coverage_id });
    const { rows: el } = await tx.query<{ id: string; state: string; inactive: boolean }>(
      `SELECT e.id, e.state, coalesce(e.benefits #>> '{status,value}' = 'inactive', false) AS inactive
       FROM cuspatlas.rcm_eligibility_records e
       WHERE e.coverage_id = $1 AND e.coverage_version = $2 AND e.service_date = $3::date
         AND e.state = 'verified' AND now() <= e.retrieved_at + make_interval(hours => e.freshness_hours)
       ORDER BY e.retrieved_at DESC, e.id LIMIT 1`,
      [claim.coverage_id, cv, l.date_of_service],
    );
    const rec = el[0];
    if (!rec)
      issues.push({ code: 'eligibility_not_current', owner: 'front_office', sourceRef: claim.coverage_id });
    else if (rec.state === 'verified' && rec.inactive)
      issues.push({ code: 'coverage_inactive', owner: 'front_office', sourceRef: rec.id });
    if (/^SYN-ATT-/.test(l.code_ref) && attachments.length === 0)
      issues.push({ code: 'attachment_required', owner: 'clinical', sourceRef: l.procedure_id });
    facts.push([l.charge_id, charge?.reversed ?? null, eff[0]?.ok ?? null, rec?.id ?? null]);
  }
  if (attachments.length > 0) {
    // CL-04: object references alone are not dispatchable; a manifest-bound package of this version is.
    const pkg = await packageOf(tx, head.id);
    if (!pkg) issues.push({ code: 'attachment_package_missing', owner: 'clinical', sourceRef: head.id });
    facts.push(['package', pkg?.id ?? null]);
  }
  const primary = await secondaryOf(tx, claim.id);
  if (primary !== null) {
    // A secondary relies on the primary's remittance: a reversal since preparation flags it for review.
    const { rows: rev } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cuspatlas.rcm_remittance_reversals x
       WHERE x.remittance_id IN (
         SELECT (r ->> 'remittanceRef')::uuid FROM cuspatlas.rcm_secondary_claims sc,
           jsonb_array_elements(sc.cob_evidence) e, jsonb_array_elements(e -> 'remittances') r
         WHERE sc.claim_id = $1)`,
      [claim.id],
    );
    if ((rev[0]?.n ?? 0) > 0) issues.push({ code: 'primary_reversed', owner: 'billing', sourceRef: primary });
    facts.push(['secondary', primary, rev[0]?.n ?? 0]);
  }
  const unique = [...new Map(issues.map((i) => [`${i.code}:${i.sourceRef}`, i])).values()];
  return { issues: unique, digest: sha256Hex(canonicalJson({ version: head.id, facts })) };
}

/**
 * B6 claims (CL-02..CL-08) against the fake clearinghouse only (B-S2 open). A claim version is
 * immutable; validation is bound to a version and its inputs; submission needs the explicit approval
 * of the human caller or a standing policy rechecked at execution; transport outcomes, payer
 * acknowledgements, rejections and adjudications (with synthetic denial codes and their source) are
 * distinct facts; an unknown outcome is reconciled by lookup, never resubmitted; a rejection or denial
 * is corrected by a linked replacement version; appeals are drafts another human reviews before send.
 */
export function createClaimOperations(
  base: BillingBase,
  partner: ClaimsPartnerPort | null = createFakeClearinghouse(),
  objects: AttachmentSourcePort,
) {
  const { deps, execute } = base;
  const timing = providerTiming(deps);
  const ready = () => requireAdapter(partner, 'clearinghouse');
  const bump = async (tx: TenantTransaction, claimId: string) => {
    const { rows } = await tx.query<{ version: number }>(
      'UPDATE cuspatlas.rcm_claims SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version',
      [claimId],
    );
    return rows[0]?.version as number;
  };
  const record = (tx: TenantTransaction, op: string, claimId: string, version: number, field: string) =>
    recordCommand(
      tx,
      { operation: op, resourceType: CLAIM_RESOURCE, resourceRef: claimId, resourceVersion: version },
      { changedFields: [field] },
    );
  const checkVersion = (claim: ClaimRow, expected: number) => {
    if (claim.version !== expected) throw conflict('stale_version');
  };
  const latestSubmission = async (tx: TenantTransaction, claimId: string) => {
    const { rows } = await tx.query<{
      id: string;
      version_id: string;
      submission_key: string;
      outcome: string;
      transport_ref: string | null;
      expired: boolean;
    }>(
      `SELECT id, version_id, submission_key, outcome, transport_ref,
         coalesce(call_deadline < now(), false) AS expired
       FROM cuspatlas.rcm_claim_submissions WHERE claim_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [claimId],
    );
    return rows[0] ?? null;
  };
  const transportEvent = async (
    tx: TenantTransaction,
    claimId: string,
    submission: { id: string; submission_key: string },
    a: TransportAnswer,
  ) => {
    if (a.outcome === 'unknown') return;
    await tx.query(
      `INSERT INTO cuspatlas.rcm_claim_events (tenant_id, claim_id, submission_id, kind, external_ref, code, code_source,
         code_version, occurred_at)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, now()) ON CONFLICT DO NOTHING`,
      [
        claimId,
        submission.id,
        a.outcome === 'transmitted' ? 'transport_acknowledged' : 'transport_rejected',
        `syn-evt-${sha256Hex(`transport:${submission.submission_key}`).slice(0, 32)}`,
        a.outcome === 'rejected' ? a.rejectionCode : null,
        a.outcome === 'rejected' ? SYN_REJECTIONS.source : null,
        a.outcome === 'rejected' ? SYN_REJECTIONS.version : null,
      ],
    );
  };
  /** Transmitted: the billed amounts become insurer responsibility of the claim's coverage. */
  const toInsurer = async (tx: TenantTransaction, claim: ClaimRow, versionId: string) => {
    const settings = await loadSettings(tx);
    for (const l of await linesOf(tx, versionId)) {
      const { rows } = await tx.query<{ open: string; patient_id: string }>(
        `SELECT coalesce(sum(amount_minor), 0)::text AS open, min(patient_id::text) AS patient_id
         FROM cuspatlas.billing_journal_lines WHERE charge_id = $1 AND account = 'patient_receivable'`,
        [l.charge_id],
      );
      const open = BigInt(rows[0]?.open ?? '0');
      const amount = open < BigInt(l.billed) ? open : BigInt(l.billed);
      if (amount <= 0n) continue;
      const m = moneyFromMinorText(settings.currency, amount.toString());
      const neg = moneyFromMinorText(settings.currency, (-amount).toString());
      const patientId = rows[0]?.patient_id as string;
      try {
        await postEntry(tx, {
          kind: 'responsibilityTransfer',
          currency: settings.currency,
          chargeId: l.charge_id,
          reasonCode: 'claim_transmitted',
          lines: [
            {
              account: 'insurer_receivable',
              amount: m,
              patientId,
              chargeId: l.charge_id,
              payerRef: claim.payer_ref,
              coverageId: claim.coverage_id,
            },
            { account: 'patient_receivable', amount: neg, patientId, chargeId: l.charge_id },
          ],
        });
      } catch (err) {
        if (!(err instanceof SignViolation)) throw err;
      }
    }
  };

  return {
    prepareClaim(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ClaimCommandData>> {
      const op = 'rcm.claims.prepare';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<ClaimPrepare>(validateClaimPrepare, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadPatient(tx, p.patientRef, 'FOR SHARE');
          return execute<ClaimCommandData>(ctx, envelope, tx, async () => {
            const set = await mergeSet(tx, patient.id);
            const { rows: cov } = await tx.query<{ id: string; payer_ref: string }>(
              'SELECT id, payer_ref FROM cuspatlas.rcm_coverages WHERE id = $1 AND patient_id = ANY ($2::uuid[])',
              [p.coverageRef, set.ids],
            );
            if (!cov[0]) throw failed('coverage_not_of_patient');
            const lines = await buildLines(tx, set.ids, cov[0].id, p.procedureRefs);
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.rcm_claims (tenant_id, patient_id, coverage_id, payer_ref, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id()) RETURNING id`,
              [set.root, cov[0].id, cov[0].payer_ref],
            );
            const claimId = rows[0]?.id as string;
            const versionRef = await insertVersion(tx, claimId, {
              versionNo: 1,
              reason: 'prepared',
              reasonCode: null,
              supersedes: null,
              coverageVersion: await coverageVersionOf(tx, cov[0].id),
              currency: (await loadSettings(tx)).currency,
              lines,
              attachments: [],
            });
            await holdProcedures(
              tx,
              claimId,
              versionRef,
              await coverageRankOf(tx, cov[0].id),
              lines.map((l) => l.procedure_id as string),
            );
            await record(tx, op, claimId, 1, 'claim');
            return { data: { claimRef: claimId, versionRef, versionNo: 1, outcome: 'prepared' }, version: 1 };
          });
        });
      });
    },

    validateClaim(
      ctx: ActorContext,
      claimRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ClaimCommandData>> {
      const op = 'rcm.claims.validate';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<ClaimVersioned>(validateClaimVersioned, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const claim = await loadClaim(tx, claimRef, 'FOR UPDATE');
          return execute<ClaimCommandData>(
            ctx,
            { ...envelope, payload: { claimRef, ...p } },
            tx,
            async () => {
              checkVersion(claim, p.expectedVersion);
              const head = await headOf(tx, claim.id);
              const r = await readiness(tx, claim, head, true);
              await tx.query(
                `INSERT INTO cuspatlas.rcm_claim_validations (tenant_id, version_id, valid, issues, input_digest, validated_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3::jsonb, $4, cuspatlas.current_actor_id())`,
                [head.id, r.issues.length === 0, canonicalJson(r.issues), r.digest],
              );
              const version = await bump(tx, claim.id);
              await record(tx, op, claim.id, version, 'validation');
              return {
                data: {
                  claimRef: claim.id,
                  versionRef: head.id,
                  versionNo: head.version_no,
                  outcome: r.issues.length === 0 ? 'valid' : 'invalid',
                  issueCount: r.issues.length,
                },
                version,
              };
            },
          );
        });
      });
    },

    attachToClaim(
      ctx: ActorContext,
      claimRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ClaimCommandData>> {
      return newVersion(ctx, claimRef, envelope, 'rcm.claims.attach');
    },
    replaceClaim(
      ctx: ActorContext,
      claimRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ClaimCommandData>> {
      return newVersion(ctx, claimRef, envelope, 'rcm.claims.replace');
    },

    submitClaim(
      ctx: ActorContext,
      claimRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ClaimCommandData>> {
      const op = 'rcm.claims.submit';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<ClaimSubmit>(validateClaimSubmit, p);
        ready();
        const replay = { ...envelope, payload: { claimRef, ...p } };
        // CL-04/CL-05: the package of the head version is rechecked against the object source (I owns
        // the bytes) before anything is dispatched; an altered or missing object refuses the dispatch.
        const bound = await deps.withTenantTransaction(ctx, async (tx) => {
          const claim = await loadClaim(tx, claimRef);
          const head = await headOf(tx, claim.id);
          return { head: head.id, pkg: await packageOf(tx, head.id) };
        });
        const pending = await deps.withTenantTransaction(ctx, async (tx) => {
          const claim = await loadClaim(tx, claimRef, 'FOR UPDATE');
          if (await committedReplay(tx, op, envelope.idempotencyKey)) return null;
          checkVersion(claim, p.expectedVersion);
          const head = await headOf(tx, claim.id);
          const prior = await latestSubmission(tx, claim.id);
          if (prior && prior.version_id === head.id)
            throw conflict('already_submitted', [{ kind: 'claimSubmission', ref: prior.id }]);
          const pkgNow = await packageOf(tx, head.id);
          // The recheck runs in this locked transaction with the claim's patient (I3 under RLS).
          const live: { ref: string; ok: boolean }[] = [];
          for (const i of pkgNow?.items ?? [])
            live.push({
              ref: i.object_ref,
              ok: (await objects.digestOf(tx, i.object_ref, claim.patient_id)) === i.digest,
            });
          if (
            pkgNow !== null &&
            (bound.head !== head.id || bound.pkg?.id !== pkgNow.id || live.some((x) => !x.ok))
          )
            throw conflict(
              'attachment_package_stale',
              live.filter((x) => !x.ok).map((x) => ({ kind: 'attachmentObject', ref: x.ref })),
            );
          const { rows: vr } = await tx.query<{ id: string; valid: boolean; input_digest: string }>(
            `SELECT id, valid, input_digest FROM cuspatlas.rcm_claim_validations WHERE version_id = $1
             ORDER BY validated_at DESC, id DESC LIMIT 1`,
            [head.id],
          );
          const v = vr[0];
          if (!v) throw conflict('validation_required');
          if (!v.valid) throw conflict('claim_not_ready');
          if ((await readiness(tx, claim, head, true)).digest !== v.input_digest)
            throw conflict('validation_stale');
          let policyId: string | null = null;
          if (p.authorization.mode === 'explicit') {
            if (ctx.principal !== 'human')
              throw new RefusalError({ code: 'forbidden', reasonCode: 'principal_kind_denied' });
          } else {
            const { rows: pol } = await tx.query<{
              id: string;
              payer_ref: string | null;
              max: string;
              revoked: boolean;
            }>(
              `SELECT p.id, p.payer_ref, p.max_billed_minor::text AS max,
                 EXISTS (SELECT 1 FROM cuspatlas.rcm_submission_policy_revocations r WHERE r.policy_id = p.id) AS revoked
               FROM cuspatlas.rcm_submission_policies p WHERE p.id = $1`,
              [p.authorization.policyRef],
            );
            const pol0 = pol[0];
            if (!pol0) throw failed('policy_unknown');
            if (pol0.revoked) throw conflict('policy_revoked');
            if (pol0.payer_ref !== null && pol0.payer_ref !== claim.payer_ref)
              throw conflict('policy_payer_mismatch');
            if (BigInt(head.billed) > BigInt(pol0.max)) throw conflict('policy_limit_exceeded');
            policyId = pol0.id;
          }
          const key = sha256Hex(`rcm-claim-submission:${ctx.tenantId}:${head.id}`);
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO cuspatlas.rcm_claim_submissions (tenant_id, claim_id, version_id, submission_key, authorization_mode,
               policy_id, validation_id, outcome, submitted_by, call_deadline)
             VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, 'pending', cuspatlas.current_actor_id(),
               now() + $7::bigint * interval '1 millisecond')
             RETURNING id`,
            [claim.id, head.id, key, p.authorization.mode, policyId, v.id, String(timing.leaseMs)],
          );
          return {
            claim,
            head,
            submission: { id: rows[0]?.id as string, submission_key: key },
            lines: (await linesOf(tx, head.id)).map((l) => ({
              lineNo: l.line_no,
              codeRef: l.code_ref,
              billedMinor: Number.parseInt(l.billed, 10),
            })),
          };
        });
        const unknown: TransportAnswer = { outcome: 'unknown' };
        const answer =
          pending === null
            ? null
            : await withTimeout(
                () =>
                  ready().submit({
                    submissionKey: pending.submission.submission_key,
                    payerRef: pending.claim.payer_ref,
                    claimRef: pending.claim.id,
                    versionNo: pending.head.version_no,
                    lines: pending.lines,
                  }),
                timing.timeoutMs,
                unknown,
              );
        return deps.withTenantTransaction(ctx, async (tx) => {
          await loadClaim(tx, claimRef, 'FOR UPDATE');
          return execute<ClaimCommandData>(ctx, replay, tx, async () => {
            if (pending === null || answer === null)
              throw new RefusalError({ code: 'conflict', retryable: true });
            await finalizeSubmission(tx, pending.claim, pending.submission, answer, false);
            const version = await bump(tx, pending.claim.id);
            await record(tx, op, pending.claim.id, version, 'submission');
            return {
              data: {
                claimRef: pending.claim.id,
                versionRef: pending.head.id,
                versionNo: pending.head.version_no,
                outcome: answer.outcome,
                submissionRef: pending.submission.id,
              },
              version,
            };
          });
        });
      });
    },

    /**
     * Responses from the partner (CL-05/CL-06): an unknown submission is resolved by lookup with its
     * key (never a new submission); a transmitted one records each new acknowledgement, rejection or
     * adjudication exactly once (idempotent per partner event reference).
     */
    pollClaim(ctx: ActorContext, claimRef: string): Promise<{ data: ClaimCommandData }> {
      const op = 'rcm.claims.poll';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        ready();
        const first = await deps.withTenantTransaction(ctx, async (tx) => {
          const claim = await loadClaim(tx, claimRef);
          const { rows: open } = await tx.query<{ id: string; transport: string | null }>(
            `SELECT a.id, (SELECT s.transport_ref FROM cuspatlas.rcm_claim_submissions s WHERE s.claim_id = a.claim_id
                AND s.transport_ref IS NOT NULL ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS transport
             FROM cuspatlas.rcm_appeals a JOIN cuspatlas.rcm_appeal_reviews r ON r.appeal_id = a.id
             WHERE a.claim_id = $1 AND r.decision = 'approved' AND r.sent_ref IS NULL
               AND NOT EXISTS (SELECT 1 FROM cuspatlas.rcm_appeal_send_resolutions x WHERE x.appeal_id = a.id)`,
            [claim.id],
          );
          return {
            claim,
            head: await headOf(tx, claim.id),
            sub: await latestSubmission(tx, claim.id),
            appeals: open,
          };
        });
        const sub = first.sub;
        // A submission left pending by a crash is looked up only after its call deadline (review SHOULD).
        const lookable =
          sub !== null && (sub.outcome === 'unknown' || (sub.outcome === 'pending' && sub.expired));
        if (!sub || sub.outcome === 'rejected' || (sub.outcome === 'pending' && !lookable)) {
          if (first.appeals.length === 0)
            throw conflict(sub?.outcome === 'pending' ? 'submission_in_flight' : 'nothing_to_poll');
        }
        const looked =
          sub && lookable
            ? await withTimeout(() => ready().lookup(sub.submission_key), timing.timeoutMs, null)
            : null;
        const events =
          sub && (sub.outcome === 'transmitted' || looked?.outcome === 'transmitted')
            ? await withTimeout(() => ready().poll(sub.submission_key), timing.timeoutMs, [])
            : [];
        // An appeal approved while its send was unknown: lookup by key, then (only when the partner never
        // received it) the same send with the same key. Never a second appeal.
        const appealSends: { id: string; sentRef: string; by: 'lookup' | 'resend_same_key' }[] = [];
        for (const a of first.appeals) {
          const appealKey = sha256Hex(`rcm-appeal:${ctx.tenantId}:${a.id}`);
          const found = await withTimeout(() => ready().lookupAppeal(appealKey), timing.timeoutMs, null);
          if (found && 'sentRef' in found)
            appealSends.push({ id: a.id, sentRef: found.sentRef, by: 'lookup' });
          else if (found && a.transport !== null) {
            const transportRef = a.transport;
            const sent = await withTimeout(
              () => ready().sendAppeal({ appealKey, transportRef }),
              timing.timeoutMs,
              null,
            );
            if (sent) appealSends.push({ id: a.id, sentRef: sent.sentRef, by: 'resend_same_key' });
          }
        }
        return deps.withTenantTransaction(ctx, async (tx) => {
          const claim = await loadClaim(tx, claimRef, 'FOR UPDATE');
          let changed = 0;
          if (sub && looked && (looked.outcome === 'transmitted' || looked.outcome === 'rejected')) {
            const { rows } = await tx.query<{ outcome: string }>(
              'SELECT outcome FROM cuspatlas.rcm_claim_submissions WHERE id = $1',
              [sub.id],
            );
            if (rows[0]?.outcome === 'unknown' || rows[0]?.outcome === 'pending') {
              await finalizeSubmission(tx, claim, sub, looked, true);
              changed += 1;
            }
          }
          for (const e of events) {
            const denial = e.kind === 'adjudicated_denied' || e.kind === 'payer_rejected';
            const src = e.kind === 'payer_rejected' ? SYN_REJECTIONS : SYN_DENIALS;
            const { rowCount } = await tx.query(
              `INSERT INTO cuspatlas.rcm_claim_events (tenant_id, claim_id, submission_id, kind, external_ref, code,
                 code_source, code_version, occurred_at)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8::timestamptz) ON CONFLICT DO NOTHING`,
              [
                claim.id,
                sub?.id,
                e.kind,
                e.eventRef,
                denial ? (e.code ?? null) : null,
                denial ? src.source : null,
                denial ? src.version : null,
                e.occurredAt,
              ],
            );
            changed += rowCount;
          }
          for (const a of appealSends) {
            const { rowCount } = await tx.query(
              `INSERT INTO cuspatlas.rcm_appeal_send_resolutions (tenant_id, appeal_id, sent_ref, resolved_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3) ON CONFLICT DO NOTHING`,
              [a.id, a.sentRef, a.by],
            );
            changed += rowCount;
          }
          let version = claim.version;
          if (changed > 0) {
            version = await bump(tx, claim.id);
            await record(tx, op, claim.id, version, 'responses');
          }
          return {
            data: {
              claimRef: claim.id,
              versionRef: first.head.id,
              versionNo: first.head.version_no,
              outcome: 'polled',
              eventCount: changed,
            },
          };
        });
      });
    },

    /**
     * B8 / CL-11: a secondary claim from the primary's adjudication and remittance (COB evidence).
     * The primary must be a rank-1 claim whose latest submission carries a paid adjudication and whose
     * lines each have a posted, unreversed remittance line; the secondary claims only the patient
     * responsibility the primary left (never what the primary paid), which sits as insurer
     * responsibility of the secondary coverage from that moment (the patient is not billed for it).
     * One secondary per primary; tertiary coordination is not supported (422).
     */
    prepareSecondaryClaim(
      ctx: ActorContext,
      claimRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ClaimCommandData>> {
      const op = 'rcm.claims.prepareSecondary';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<SecondaryClaimPrepare>(validateSecondaryClaimPrepare, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const primary = await loadClaim(tx, claimRef, 'FOR UPDATE');
          return execute<ClaimCommandData>(
            ctx,
            { ...envelope, payload: { claimRef, ...p } },
            tx,
            async () => {
              if ((await secondaryOf(tx, primary.id)) !== null) throw failed('not_a_primary_claim');
              if ((await coverageRankOf(tx, primary.coverage_id)) !== 1) throw failed('not_a_primary_claim');
              const set = await mergeSet(tx, primary.patient_id);
              assertRef(p.coverageRef);
              const { rows: cov } = await tx.query<{ id: string; payer_ref: string }>(
                'SELECT id, payer_ref FROM cuspatlas.rcm_coverages WHERE id = $1 AND patient_id = ANY ($2::uuid[])',
                [p.coverageRef, set.ids],
              );
              const sec = cov[0];
              if (!sec) throw failed('coverage_not_of_patient');
              const rank = await coverageRankOf(tx, sec.id);
              if (rank === 3) throw failed('tertiary_not_supported');
              if (rank !== 2) throw failed('coverage_not_secondary');
              const { rows: dup } = await tx.query<{ claim_id: string }>(
                'SELECT claim_id FROM cuspatlas.rcm_secondary_claims WHERE primary_claim_id = $1',
                [primary.id],
              );
              if (dup[0]) throw conflict('secondary_exists', [{ kind: 'claim', ref: dup[0].claim_id }]);
              const sub = await latestSubmission(tx, primary.id);
              if (!sub || sub.outcome !== 'transmitted') throw later('primary_pending');
              const { rows: ev } = await tx.query<{ kind: string }>(
                'SELECT kind FROM cuspatlas.rcm_claim_events WHERE submission_id = $1',
                [sub.id],
              );
              const kinds = ev.map((e) => e.kind);
              if (kinds.includes('adjudicated_denied')) throw conflict('primary_denied');
              if (!kinds.includes('adjudicated_paid')) throw later('primary_pending');
              const settings = await loadSettings(tx);
              const evidence: unknown[] = [];
              const lines: Omit<LineRow, 'line_no'>[] = [];
              for (const l of await linesOf(tx, sub.version_id)) {
                const posted = await postedRemittanceLines(tx, primary.id, l.line_no);
                if (posted.length === 0) throw conflict('missing_adjudication');
                const live = posted.filter((x) => !x.reversed);
                if (live.length === 0) throw conflict('primary_reversed');
                const pr = live.reduce((s, x) => s + BigInt(x.pr), 0n);
                evidence.push({
                  claimLineNo: l.line_no,
                  chargeRef: l.charge_id,
                  remittances: live.map((x) => ({
                    remittanceRef: x.remittance_id,
                    lineNo: x.line_no,
                    paid: x.paid,
                    contractual: x.contractual,
                    patientResponsibility: x.pr,
                  })),
                });
                if (pr <= 0n) continue;
                await lockAggregates(tx, { payments: [], charges: [l.charge_id] });
                const already = await accountOpen(tx, l.charge_id, 'insurer_receivable', sec.id);
                // A remittance posted before the secondary coverage was known left the amount with the
                // patient: it moves to the secondary insurer now (CL-11), never more than the primary left.
                if (already < pr) {
                  const patientOpen = await accountOpen(tx, l.charge_id, 'patient_receivable', null);
                  const move = pr - already < patientOpen ? pr - already : patientOpen;
                  if (move > 0n) {
                    await postEntry(tx, {
                      kind: 'responsibilityTransfer',
                      currency: settings.currency,
                      chargeId: l.charge_id,
                      reasonCode: 'secondary_claim_prepared',
                      lines: [
                        {
                          account: 'insurer_receivable',
                          amount: moneyFromMinorText(settings.currency, move.toString()),
                          patientId: set.root,
                          chargeId: l.charge_id,
                          payerRef: sec.payer_ref,
                          coverageId: sec.id,
                        },
                        {
                          account: 'patient_receivable',
                          amount: moneyFromMinorText(settings.currency, (-move).toString()),
                          patientId: set.root,
                          chargeId: l.charge_id,
                        },
                      ],
                    });
                  }
                }
                const billed = await accountOpen(tx, l.charge_id, 'insurer_receivable', sec.id);
                const claimable = billed < pr ? billed : pr;
                if (claimable <= 0n) continue;
                const allowance = await resolveAllowance(tx, l.code_ref, l.date_of_service, sec.id);
                const { line_no: _n, ...rest } = l;
                lines.push({
                  ...rest,
                  billed: claimable.toString(),
                  allowance: allowance === null ? null : String(allowance.fee.minor),
                });
              }
              if (lines.length === 0) throw failed('no_secondary_responsibility');
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.rcm_claims (tenant_id, patient_id, coverage_id, payer_ref, created_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id()) RETURNING id`,
                [set.root, sec.id, sec.payer_ref],
              );
              const claimId = rows[0]?.id as string;
              const versionRef = await insertVersion(tx, claimId, {
                versionNo: 1,
                reason: 'prepared',
                reasonCode: null,
                supersedes: null,
                coverageVersion: await coverageVersionOf(tx, sec.id),
                currency: settings.currency,
                lines,
                attachments: [],
              });
              await holdProcedures(
                tx,
                claimId,
                versionRef,
                2,
                lines.map((l) => l.procedure_id as string),
              );
              await tx.query(
                `INSERT INTO cuspatlas.rcm_secondary_claims (tenant_id, claim_id, primary_claim_id, primary_submission_id,
                   cob_evidence, evidence_digest)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4::jsonb, $5)`,
                [claimId, primary.id, sub.id, canonicalJson(evidence), sha256Hex(canonicalJson(evidence))],
              );
              await record(tx, op, claimId, 1, 'claim');
              const version = await bump(tx, primary.id);
              await record(tx, op, primary.id, version, 'secondary');
              return {
                data: { claimRef: claimId, versionRef, versionNo: 1, outcome: 'prepared' },
                version: 1,
              };
            },
          );
        });
      });
    },

    /**
     * CL-04 attachment package placeholder: binds the head version's object references (I owns the
     * bytes; syn-img-/syn-obj- references only) and their digests into one manifest. Each digest is
     * checked against the object source now and again before dispatch; the items must be exactly the
     * version's attachments; a submitted version is never repackaged (a new version is).
     */
    packageClaimAttachments(
      ctx: ActorContext,
      claimRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ClaimCommandData>> {
      const op = 'rcm.claims.packageAttachments';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<AttachmentPackageCreate>(validateAttachmentPackageCreate, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const claim = await loadClaim(tx, claimRef, 'FOR UPDATE');
          // Each digest is checked in this transaction against the claim's patient (I3 under RLS).
          const checked: boolean[] = [];
          for (const i of p.items)
            checked.push((await objects.digestOf(tx, i.objectRef, claim.patient_id)) === i.digest);
          return execute<ClaimCommandData>(
            ctx,
            { ...envelope, payload: { claimRef, ...p } },
            tx,
            async () => {
              checkVersion(claim, p.expectedVersion);
              const head = await headOf(tx, claim.id);
              const sub = await latestSubmission(tx, claim.id);
              if (sub && sub.version_id === head.id) throw conflict('claim_version_submitted');
              const refs = (await attachmentsOf(tx, head.id)).map((a) => a.object_ref).sort();
              const given = p.items.map((i) => i.objectRef).sort();
              if (refs.length === 0 || refs.join(',') !== given.join(','))
                throw failed('package_items_mismatch');
              if (checked.some((ok) => !ok)) throw failed('attachment_digest_mismatch');
              const items = [...p.items].sort((a, b) => a.objectRef.localeCompare(b.objectRef));
              const manifest = sha256Hex(canonicalJson({ version: head.id, items }));
              let packageRef: string;
              try {
                const { rows } = await tx.query<{ id: string }>(
                  `INSERT INTO cuspatlas.rcm_claim_attachment_packages (tenant_id, claim_id, version_id, manifest_digest, item_count,
                     created_by)
                   VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id()) RETURNING id`,
                  [claim.id, head.id, manifest, items.length],
                );
                packageRef = rows[0]?.id as string;
              } catch (err) {
                if (isPgError(err, '23505')) throw conflict('package_exists');
                throw err;
              }
              for (const i of items)
                await tx.query(
                  `INSERT INTO cuspatlas.rcm_claim_attachment_package_items (tenant_id, package_id, object_ref, digest)
                   VALUES (cuspatlas.current_tenant_id(), $1, $2, $3)`,
                  [packageRef, i.objectRef, i.digest],
                );
              const version = await bump(tx, claim.id);
              await record(tx, op, claim.id, version, 'attachmentPackage');
              return {
                data: {
                  claimRef: claim.id,
                  versionRef: head.id,
                  versionNo: head.version_no,
                  outcome: 'packaged',
                },
                version,
              };
            },
          );
        });
      });
    },

    getClaim(ctx: ActorContext, claimRef: string) {
      const op = 'rcm.claims.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const claim = await loadClaim(tx, claimRef);
          const view = await claimView(tx, claim);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: CLAIM_RESOURCE,
            resourceRefs: [claim.id],
            queryFields: [],
          });
          return view;
        });
      });
    },

    /** CL-08: every open claim fact as an owned work item with a due time and the next action. */
    listClaimWorklist(ctx: ActorContext, query: unknown) {
      const op = 'rcm.claims.worklist';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ owner?: ClaimWorkItem['owner'] }>(validateClaimWorklistQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          // Newest first, one bounded page; `truncated` says more open claims exist (review SHOULD).
          const { rows: page } = await tx.query<ClaimRow>(
            `SELECT id, patient_id, coverage_id, payer_ref, version FROM cuspatlas.rcm_claims
             ORDER BY created_at DESC, id DESC LIMIT ${CLAIM_WORKLIST_PAGE + 1}`,
          );
          const truncated = page.length > CLAIM_WORKLIST_PAGE;
          const claims = page.slice(0, CLAIM_WORKLIST_PAGE);
          const items: ClaimWorkItem[] = [];
          const { rows: clock } = await tx.query<{ now: Date }>('SELECT now() AS now');
          const now = (clock[0] as { now: Date }).now;
          for (const c of claims) items.push(...(await claimWorkItems(tx, c, now)));
          const data = items.filter((i) => query.owner === undefined || i.owner === query.owner);
          return { data, totalCount: data.length, checkedAt: now.toISOString(), truncated };
        });
      });
    },

    /** B11 / OR-07: one queue with the per-queue counts in one call, in OR-D3 work-priority order. */
    claimQueues(ctx: ActorContext, query: unknown) {
      const op = 'rcm.claims.queues';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ queue?: ClaimQueueName; filingDeadlineDays?: string; limit?: string }>(
          validateClaimQueueQuery,
          query,
        );
        const queue = query.queue ?? 'all';
        const windowDays =
          query.filingDeadlineDays === undefined
            ? DEFAULT_FILING_DEADLINE_DAYS
            : Number.parseInt(query.filingDeadlineDays, 10);
        const limit = Number.parseInt(query.limit ?? '50', 10);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { items } = await queueFacts(tx, windowDays);
          const counts = Object.fromEntries(
            CLAIM_QUEUES.map((q) => [q, items.filter((i) => i.queues.includes(q)).length]),
          ) as Record<ClaimQueueName, number>;
          const selected = items.filter((i) => i.queues.includes(queue)).sort(compareWorkPriority);
          return {
            data: {
              queue,
              filingDeadlineDays: windowDays,
              timelyFilingDays: TIMELY_FILING_DAYS,
              counts,
              queueCount: selected.length,
              items: selected.slice(0, limit),
            },
          };
        });
      });
    },

    /** B11 / OR-07 headline measures with declared definitions (A16 pattern), reconciling to the journal. */
    claimMeasures(ctx: ActorContext, query: unknown) {
      const op = 'rcm.claims.measures';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        await base.authorize(ctx, 'rcm.claims.queues');
        validate<Record<string, never>>(validateClaimMeasuresQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const settings = await loadSettings(tx);
          const { rows: clock } = await tx.query<{ now: Date }>('SELECT now() AS now');
          const now = (clock[0] as { now: Date }).now;
          const { rows: claims } = await tx.query<ClaimRow & { created_at: Date }>(
            'SELECT id, patient_id, coverage_id, payer_ref, version, created_at FROM cuspatlas.rcm_claims ORDER BY created_at, id',
          );
          let over = 0;
          let action = 0;
          let appeals = 0;
          for (const c of claims) {
            const v = await claimView(tx, c);
            if (
              v.state !== 'paid' &&
              v.state !== 'replaced' &&
              now.getTime() - c.created_at.getTime() > CLAIM_MEASURE_AGE_DAYS * 86_400_000
            )
              over++;
            if ((await claimWorkItems(tx, c, now)).length > 0) action++;
            appeals += v.appeals.filter((a) => a.state !== 'rejected').length;
          }
          const asOf = now.toISOString();
          const m = (
            key: keyof typeof MEASURE_DEFINITIONS,
            value: unknown,
            filters: Record<string, unknown>,
          ) => ({
            key,
            ...MEASURE_DEFINITIONS[key],
            value,
            filters,
            asOf,
          });
          return {
            data: {
              asOf,
              measures: [
                m('open_insurer_receivable', await insurerReceivable(tx, settings.currency), {
                  account: 'insurer_receivable',
                  currency: settings.currency,
                }),
                m('claims_over_30_days', over, {
                  olderThanDays: CLAIM_MEASURE_AGE_DAYS,
                  excludeStates: ['paid', 'replaced'],
                }),
                m('needs_action', action, {}),
                m('open_appeals', appeals, { states: ['draft', 'sent', 'send_unknown'] }),
              ],
            },
          };
        });
      });
    },

    draftAppeal(
      ctx: ActorContext,
      claimRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<AppealCommandData>> {
      const op = 'rcm.appeals.draft';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<AppealDraft>(validateAppealDraft, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const claim = await loadClaim(tx, claimRef, 'FOR UPDATE');
          return execute<AppealCommandData>(
            ctx,
            { ...envelope, payload: { claimRef, ...p } },
            tx,
            async () => {
              if (ctx.principal !== 'human')
                throw new RefusalError({ code: 'forbidden', reasonCode: 'principal_kind_denied' });
              const { rows: ev } = await tx.query<{ id: string }>(
                `SELECT id FROM cuspatlas.rcm_claim_events WHERE id = $1 AND claim_id = $2 AND kind = 'adjudicated_denied'`,
                [p.denialEventRef, claim.id],
              );
              if (!ev[0]) throw failed('denial_not_found');
              const head = await headOf(tx, claim.id);
              const digest = sha256Hex(
                canonicalJson({
                  head: head.id,
                  denial: ev[0].id,
                  attachments: [...(p.attachmentRefs ?? [])].sort(),
                }),
              );
              try {
                const { rows } = await tx.query<{ id: string }>(
                  `INSERT INTO cuspatlas.rcm_appeals (tenant_id, claim_id, denial_event_id, basis_code, package_digest, drafted_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id()) RETURNING id`,
                  [claim.id, ev[0].id, p.basisCode, digest],
                );
                const version = await bump(tx, claim.id);
                await record(tx, op, claim.id, version, 'appeal');
                return { data: { appealRef: rows[0]?.id as string, state: 'draft' }, version };
              } catch (err) {
                if (isPgError(err, '23505')) throw conflict('duplicate_appeal');
                throw err;
              }
            },
          );
        });
      });
    },

    reviewAppeal(
      ctx: ActorContext,
      appealRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<AppealCommandData>> {
      const op = 'rcm.appeals.review';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<AppealReview>(validateAppealReview, p);
        ready();
        assertRef(appealRef);
        const pre = await deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            claim_id: string;
            drafted_by: string;
            reviewed: boolean;
          }>(
            `SELECT a.id, a.claim_id, a.drafted_by,
               EXISTS (SELECT 1 FROM cuspatlas.rcm_appeal_reviews r WHERE r.appeal_id = a.id) AS reviewed
             FROM cuspatlas.rcm_appeals a WHERE a.id = $1`,
            [appealRef],
          );
          const a = rows[0];
          if (!a) throw notFound();
          if (a.drafted_by === ctx.actorId)
            throw new RefusalError({ code: 'self_approval_denied', reasonCode: 'self_approval_denied' });
          if (await committedReplay(tx, op, envelope.idempotencyKey)) return { a, transport: null };
          if (a.reviewed) throw conflict('already_reviewed');
          const sub = await latestSubmission(tx, a.claim_id);
          return { a, transport: sub?.transport_ref ?? null };
        });
        const sent =
          p.decision === 'approve_and_send' && pre.transport !== null
            ? await withTimeout(
                () =>
                  ready().sendAppeal({
                    appealKey: sha256Hex(`rcm-appeal:${ctx.tenantId}:${pre.a.id}`),
                    transportRef: pre.transport as string,
                  }),
                timing.timeoutMs,
                null,
              )
            : null;
        return deps.withTenantTransaction(ctx, async (tx) => {
          await loadClaim(tx, pre.a.claim_id, 'FOR UPDATE');
          return execute<AppealCommandData>(
            ctx,
            { ...envelope, payload: { appealRef, ...p } },
            tx,
            async () => {
              const approved = p.decision === 'approve_and_send';
              try {
                await tx.query(
                  `INSERT INTO cuspatlas.rcm_appeal_reviews (tenant_id, appeal_id, decision, sent_ref, reviewed_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id())`,
                  [pre.a.id, approved ? 'approved' : 'rejected', approved ? (sent?.sentRef ?? null) : null],
                );
              } catch (err) {
                if (isPgError(err, '23505')) throw conflict('already_reviewed');
                throw err;
              }
              const version = await bump(tx, pre.a.claim_id);
              await record(tx, op, pre.a.claim_id, version, 'appealReview');
              return {
                data: { appealRef: pre.a.id, state: !approved ? 'rejected' : sent ? 'sent' : 'send_unknown' },
                version,
              };
            },
          );
        });
      });
    },

    createSubmissionPolicy(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PolicyCommandData>> {
      const op = 'rcm.submissionPolicies.create';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<SubmissionPolicyCreate>(validateSubmissionPolicyCreate, p);
        return deps.withTenantTransaction(ctx, async (tx) =>
          execute<PolicyCommandData>(ctx, envelope, tx, async () => {
            const max = inTenantCurrency(await loadSettings(tx), p.maxBilled);
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.rcm_submission_policies (tenant_id, payer_ref, max_billed_minor, currency, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id()) RETURNING id`,
              [p.payerRef ?? null, String(max.minor), max.currency],
            );
            const id = rows[0]?.id as string;
            await recordCommand(
              tx,
              { operation: op, resourceType: 'rcmSubmissionPolicy', resourceRef: id, resourceVersion: 1 },
              { changedFields: ['policy'] },
            );
            return { data: { policyRef: id, state: 'active' }, version: 1 };
          }),
        );
      });
    },

    revokeSubmissionPolicy(
      ctx: ActorContext,
      policyRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PolicyCommandData>> {
      const op = 'rcm.submissionPolicies.revoke';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ reasonCode: string }>(validateSubmissionPolicyRevoke, p);
        assertRef(policyRef);
        return deps.withTenantTransaction(ctx, async (tx) =>
          execute<PolicyCommandData>(ctx, { ...envelope, payload: { policyRef, ...p } }, tx, async () => {
            const { rows } = await tx.query<{ id: string }>(
              'SELECT id FROM cuspatlas.rcm_submission_policies WHERE id = $1',
              [policyRef],
            );
            if (!rows[0]) throw notFound();
            try {
              await tx.query(
                `INSERT INTO cuspatlas.rcm_submission_policy_revocations (tenant_id, policy_id, reason_code, revoked_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id())`,
                [policyRef, p.reasonCode],
              );
            } catch (err) {
              if (isPgError(err, '23505')) throw conflict('already_revoked');
              throw err;
            }
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: 'rcmSubmissionPolicy',
                resourceRef: policyRef,
                resourceVersion: 2,
              },
              { changedFields: ['revocation'] },
            );
            return { data: { policyRef, state: 'revoked' }, version: 2 };
          }),
        );
      });
    },
  };

  async function finalizeSubmission(
    tx: TenantTransaction,
    claim: ClaimRow,
    submission: { id: string; submission_key: string },
    answer: TransportAnswer,
    byLookup: boolean,
  ) {
    await tx.query(
      `UPDATE cuspatlas.rcm_claim_submissions SET outcome = $2, transport_ref = $3, rejection_code = $4,
         resolved_by_lookup = $5, version = version + 1, updated_at = now() WHERE id = $1`,
      [
        submission.id,
        answer.outcome,
        answer.outcome === 'transmitted' ? answer.transportRef : null,
        answer.outcome === 'rejected' ? answer.rejectionCode : null,
        byLookup,
      ],
    );
    await transportEvent(tx, claim.id, submission, answer);
    // A secondary claim's amount is already the secondary coverage's responsibility (B8 / CL-11).
    if (answer.outcome === 'transmitted' && (await secondaryOf(tx, claim.id)) === null) {
      const { rows } = await tx.query<{ version_id: string }>(
        'SELECT version_id FROM cuspatlas.rcm_claim_submissions WHERE id = $1',
        [submission.id],
      );
      await toInsurer(tx, claim, rows[0]?.version_id as string);
    }
  }

  function newVersion(
    ctx: ActorContext,
    claimRef: string,
    envelope: CommandEnvelope<unknown>,
    op: 'rcm.claims.attach' | 'rcm.claims.replace',
  ) {
    return base.guarded(ctx, op, async () => {
      await base.authorize(ctx, op);
      checkEnvelope(envelope, op);
      const p = envelope.payload;
      if (op === 'rcm.claims.attach') validate<ClaimAttach>(validateClaimAttach, p);
      else validate<ClaimReplace>(validateClaimReplace, p);
      return deps.withTenantTransaction(ctx, async (tx) => {
        const claim = await loadClaim(tx, claimRef, 'FOR UPDATE');
        return execute<ClaimCommandData>(
          ctx,
          { ...envelope, payload: { claimRef, ...(p as object) } },
          tx,
          async () => {
            checkVersion(claim, (p as ClaimVersioned).expectedVersion);
            const head = await headOf(tx, claim.id);
            const sub = await latestSubmission(tx, claim.id);
            const headSubmitted = sub !== null && sub.version_id === head.id;
            let lines: Omit<LineRow, 'line_no'>[] = (await linesOf(tx, head.id)).map(
              ({ line_no: _n, ...l }) => l,
            );
            let attachments = await attachmentsOf(tx, head.id);
            let reasonCode: string | null = null;
            if (op === 'rcm.claims.attach') {
              if (headSubmitted) throw conflict('claim_version_submitted');
              const a = p as ClaimAttach;
              if (attachments.some((x) => x.object_ref === a.objectRef)) throw conflict('attachment_present');
              attachments = [...attachments, { object_ref: a.objectRef, kind: a.kind }];
            } else {
              const r = p as ClaimReplace;
              // A corrective replacement follows a rejection or denial of the LATEST submission, which
              // must be of the head version (review MUST-FAIL 1): never after a payment, never while the
              // outcome is pending or unknown, never on a rejection of an earlier version.
              if (!sub || !headSubmitted) throw conflict('replacement_not_needed');
              if (sub.outcome === 'pending' || sub.outcome === 'unknown')
                throw conflict('submission_unresolved', [{ kind: 'claimSubmission', ref: sub.id }]);
              if (sub.outcome === 'transmitted') {
                const { rows: ev } = await tx.query<{ kind: string }>(
                  'SELECT kind FROM cuspatlas.rcm_claim_events WHERE submission_id = $1',
                  [sub.id],
                );
                const kinds = ev.map((e) => e.kind);
                if (kinds.includes('adjudicated_paid')) throw conflict('claim_adjudicated_paid');
                if (!kinds.includes('payer_rejected') && !kinds.includes('adjudicated_denied'))
                  throw conflict('replacement_not_needed');
              }
              reasonCode = r.reasonCode;
              if (r.procedureRefs !== undefined && (await secondaryOf(tx, claim.id)) !== null)
                throw failed('secondary_lines_fixed');
              if (r.procedureRefs !== undefined) {
                const set = await mergeSet(tx, claim.patient_id);
                lines = await buildLines(tx, set.ids, claim.coverage_id, r.procedureRefs);
              }
            }
            const versionNo = head.version_no + 1;
            const versionRef = await insertVersion(tx, claim.id, {
              versionNo,
              reason: op === 'rcm.claims.attach' ? 'attachment' : 'replacement',
              reasonCode,
              supersedes: head.id,
              coverageVersion: await coverageVersionOf(tx, claim.coverage_id),
              currency: head.currency,
              lines,
              attachments,
            });
            await holdProcedures(
              tx,
              claim.id,
              versionRef,
              await coverageRankOf(tx, claim.coverage_id),
              lines.map((l) => l.procedure_id as string),
            );
            const version = await bump(tx, claim.id);
            await record(tx, op, claim.id, version, 'version');
            return { data: { claimRef: claim.id, versionRef, versionNo, outcome: 'versioned' }, version };
          },
        );
      });
    });
  }
}

async function claimView(tx: TenantTransaction, claim: ClaimRow) {
  const { rows: versions } = await tx.query<VersionRow>(
    `SELECT id, version_no, reason, coverage_version, billed_total_minor::text AS billed, currency
     FROM cuspatlas.rcm_claim_versions WHERE claim_id = $1 ORDER BY version_no`,
    [claim.id],
  );
  const head = versions[versions.length - 1] as VersionRow;
  const out = [];
  for (const v of versions) {
    const { rows: val } = await tx.query<{
      valid: boolean;
      issues: ClaimIssue[];
      validated_at: Date;
      input_digest: string;
    }>(
      `SELECT valid, issues, validated_at, input_digest FROM cuspatlas.rcm_claim_validations WHERE version_id = $1
       ORDER BY validated_at DESC, id DESC LIMIT 1`,
      [v.id],
    );
    const val0 = val[0];
    const current =
      val0 !== undefined && v.id === head.id && (await readiness(tx, claim, v)).digest === val0.input_digest;
    out.push({
      versionRef: v.id,
      versionNo: v.version_no,
      reason: v.reason,
      billedTotal: moneyFromMinorText(v.currency, v.billed),
      lines: (await linesOf(tx, v.id)).map((l) => ({
        lineNo: l.line_no,
        procedureRef: l.procedure_id,
        chargeRef: l.charge_id,
        codeRef: l.code_ref,
        dateOfService: l.date_of_service,
        renderingProviderRef: l.rendering_provider_id,
        billed: moneyFromMinorText(v.currency, l.billed),
        allowance: l.allowance === null ? null : moneyFromMinorText(v.currency, l.allowance),
      })),
      attachments: (await attachmentsOf(tx, v.id)).map((a) => ({ objectRef: a.object_ref, kind: a.kind })),
      validation: val0
        ? { valid: val0.valid, issues: val0.issues, validatedAt: val0.validated_at.toISOString(), current }
        : null,
    });
  }
  const { rows: subs } = await tx.query<{
    id: string;
    version_no: number;
    authorization_mode: 'explicit' | 'policy';
    outcome: 'pending' | 'transmitted' | 'rejected' | 'unknown';
    rejection_code: string | null;
  }>(
    `SELECT s.id, v.version_no, s.authorization_mode, s.outcome, s.rejection_code FROM cuspatlas.rcm_claim_submissions s
     JOIN cuspatlas.rcm_claim_versions v ON v.id = s.version_id WHERE s.claim_id = $1 ORDER BY s.created_at, s.id`,
    [claim.id],
  );
  const { rows: events } = await tx.query<{
    id: string;
    kind: string;
    code: string | null;
    code_source: string | null;
    code_version: string | null;
    occurred_at: Date;
    submission_id: string;
  }>(
    `SELECT id, kind, code, code_source, code_version, occurred_at, submission_id FROM cuspatlas.rcm_claim_events
     WHERE claim_id = $1 ORDER BY recorded_at, occurred_at, id`,
    [claim.id],
  );
  const { rows: appeals } = await tx.query<{
    id: string;
    basis_code: string;
    decision: string | null;
    sent_ref: string | null;
  }>(
    `SELECT a.id, a.basis_code, r.decision, coalesce(r.sent_ref, x.sent_ref) AS sent_ref FROM cuspatlas.rcm_appeals a
     LEFT JOIN cuspatlas.rcm_appeal_reviews r ON r.appeal_id = a.id
     LEFT JOIN cuspatlas.rcm_appeal_send_resolutions x ON x.appeal_id = a.id
     WHERE a.claim_id = $1 ORDER BY a.created_at, a.id`,
    [claim.id],
  );
  const latest = subs[subs.length - 1];
  const mine = events.filter((e) => latest && e.submission_id === latest.id).map((e) => e.kind);
  const headView = out[out.length - 1];
  const state =
    !latest || latest.version_no !== head.version_no
      ? latest && head.reason === 'replacement' && !headView?.validation
        ? 'replaced'
        : headView?.validation?.valid && headView.validation.current
          ? 'validated'
          : 'prepared'
      : latest.outcome === 'pending'
        ? 'submission_pending'
        : latest.outcome === 'unknown'
          ? 'submission_unknown'
          : latest.outcome === 'rejected'
            ? 'transport_rejected'
            : mine.includes('adjudicated_paid')
              ? 'paid'
              : mine.includes('adjudicated_denied')
                ? 'denied'
                : mine.includes('payer_rejected')
                  ? 'payer_rejected'
                  : mine.includes('payer_acknowledged')
                    ? 'payer_acknowledged'
                    : 'transmitted';
  return {
    claimRef: claim.id,
    patientRef: claim.patient_id,
    coverageRef: claim.coverage_id,
    payerRef: claim.payer_ref,
    rank: await coverageRankOf(tx, claim.coverage_id),
    primaryClaimRef: await secondaryOf(tx, claim.id),
    state,
    headVersionNo: head.version_no,
    versions: out,
    submissions: subs.map((s) => ({
      submissionRef: s.id,
      versionNo: s.version_no,
      mode: s.authorization_mode,
      outcome: s.outcome,
      rejectionCode: s.rejection_code,
    })),
    events: events.map((e) => ({
      eventRef: e.id,
      kind: e.kind,
      code: e.code,
      codeSource: e.code_source,
      codeVersion: e.code_version,
      occurredAt: e.occurred_at.toISOString(),
    })),
    appeals: appeals.map((a) => ({
      appealRef: a.id,
      basisCode: a.basis_code,
      state:
        a.decision === null
          ? 'draft'
          : a.decision === 'rejected'
            ? 'rejected'
            : a.sent_ref
              ? 'sent'
              : 'send_unknown',
    })),
    version: claim.version,
  };
}

/**
 * CL-08: every open fact of one claim as an owned work item with a due time and the next action (the
 * claims worklist and the closed-loop workflow read the same derivation).
 */
export async function claimWorkItems(
  tx: TenantTransaction,
  c: ClaimRow,
  now: Date,
): Promise<ClaimWorkItem[]> {
  const items: ClaimWorkItem[] = [];
  const item = (
    claimRef: string,
    kind: string,
    owner: ClaimWorkItem['owner'],
    reasonCode: string,
    due: Date,
    sourceRef: string | null,
  ) =>
    items.push({
      kind,
      claimRef,
      owner,
      reasonCode,
      dueAt: due.toISOString(),
      overdue: due < now,
      sourceRef,
    });
  const v = await claimView(tx, c);
  const head = v.versions[v.versions.length - 1];
  const latest = v.submissions[v.submissions.length - 1];
  const headSubmitted = latest && latest.versionNo === v.headVersionNo;
  const day = (n: number) => new Date(now.getTime() + n * 86_400_000);
  if (!headSubmitted) {
    if (!head?.validation || !head.validation.current)
      item(c.id, 'validate_claim', 'billing', 'validation_required', day(1), head?.versionRef ?? null);
    else if (!head.validation.valid)
      for (const i of head.validation.issues)
        item(c.id, 'resolve_issue', i.owner, i.code, day(1), i.sourceRef);
    else item(c.id, 'submit_claim', 'billing', 'ready_to_submit', day(1), head.versionRef);
    return items;
  }
  if (v.state === 'submission_pending') {
    const { rows } = await tx.query<{ at: Date | null }>(
      'SELECT call_deadline AS at FROM cuspatlas.rcm_claim_submissions WHERE id = $1',
      [latest?.submissionRef],
    );
    // Visible once its call can no longer be in flight; reconciled by lookup (rcm.claims.poll).
    const at = rows[0]?.at ?? now;
    if (at <= now)
      item(c.id, 'reconcile_submission', 'billing', 'submission_pending', at, latest?.submissionRef ?? null);
  }
  if (v.state === 'submission_unknown')
    item(
      c.id,
      'reconcile_submission',
      'billing',
      'transport_outcome_unknown',
      day(0),
      latest?.submissionRef ?? null,
    );
  if (v.state === 'transport_rejected' || v.state === 'payer_rejected')
    item(c.id, 'correct_and_replace', 'billing', v.state, day(2), latest?.submissionRef ?? null);
  if (v.state === 'denied' && v.appeals.length === 0)
    item(c.id, 'review_denial', 'billing', 'denied', day(5), null);
  for (const a of v.appeals)
    if (a.state === 'draft')
      item(c.id, 'review_appeal', 'billing_manager', 'appeal_draft', day(3), a.appealRef);
  if (v.state === 'transmitted' || v.state === 'payer_acknowledged') {
    const { rows } = await tx.query<{ at: Date }>(
      'SELECT created_at AS at FROM cuspatlas.rcm_claim_submissions WHERE id = $1',
      [latest?.submissionRef],
    );
    const at = rows[0]?.at ?? now;
    item(
      c.id,
      'follow_up',
      'billing',
      'no_adjudication',
      new Date(at.getTime() + CLAIM_FOLLOW_UP_DAYS * 86_400_000),
      latest?.submissionRef ?? null,
    );
  }
  return items;
}

/** A claim row with its benefit rank and derived lifecycle state (for the CL workflow). */
export interface ClaimRowLite extends ClaimRow {
  readonly rank: number;
  readonly state: string;
}
export async function loadClaimRow(tx: TenantTransaction, claimRef: string): Promise<ClaimRowLite> {
  const claim = await loadClaim(tx, claimRef);
  const v = await claimView(tx, claim);
  return { ...claim, rank: v.rank, state: v.state };
}

/** B11: the facts of every claim and to_create charge (bounded scan), each with its queues. */
async function queueFacts(tx: TenantTransaction, windowDays: number) {
  const { rows: clock } = await tx.query<{ now: Date }>('SELECT now() AS now');
  const now = (clock[0] as { now: Date }).now;
  const today = now.toISOString().slice(0, 10);
  const { rows: claims } = await tx.query<ClaimRow & { created_at: Date }>(
    `SELECT id, patient_id, coverage_id, payer_ref, version, created_at FROM cuspatlas.rcm_claims
     ORDER BY created_at, id LIMIT ${CLAIM_QUEUE_SCAN + 1}`,
  );
  const levels = await escalationLevels(tx);
  const facts: ClaimFacts[] = [];
  for (const c of claims.slice(0, CLAIM_QUEUE_SCAN)) {
    const v = await claimView(tx, c);
    const head = v.versions[v.versions.length - 1];
    const dates = (head?.lines ?? []).map((l) => String(l.dateOfService)).sort();
    facts.push({
      subject: 'claim',
      claimRef: c.id,
      chargeRef: null,
      patientRef: c.patient_id,
      payerRef: c.payer_ref,
      state: v.state,
      createdAt: c.created_at,
      earliestServiceDate: dates[0] ?? null,
      headIssueCodes:
        head?.validation && !head.validation.valid ? head.validation.issues.map((i) => i.code) : [],
      appealStates: v.appeals.map((a) => a.state),
      escalationLevel: levels.get(c.id) ?? 0,
    });
  }
  facts.push(...(await chargesToCreate(tx)).slice(0, CLAIM_QUEUE_SCAN));
  return { now, items: facts.map((f) => queueItemOf(f, now, today, windowDays)) };
}
