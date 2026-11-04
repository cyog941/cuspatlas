import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  moneyFromMinorText,
  RefusalError,
  type RemittanceLineResolve,
  type RemittanceResolutionCommandData,
  type RemittanceResolutionDecide,
  type TenantTransaction,
  validateRemittanceLineResolve,
  validateRemittanceResolutionDecide,
  validateWorkflowPolicyPublish,
  type WorkflowPolicyCommandData,
  type WorkflowPolicyPublish,
} from '@cuspatlas/contracts';
import {
  assertRef,
  type BillingBase,
  checkEnvelope,
  conflict,
  failed,
  inTenantCurrency,
  isPgError,
  loadSettings,
  notFound,
  validate,
} from '../billing/base';
import { lockAggregates } from '../billing/entries';
import { postEntry, SignViolation } from '../billing/journal';
import { recordCommand } from '../events/record-command';
import {
  insurerOpen,
  loadRemittanceForUpdate,
  matchClaimLine,
  postRemittanceLine,
  REMITTANCE_RESOURCE,
} from './remittance';

export const WORKFLOW_POLICY_RESOURCE = 'rcmWorkflowPolicy';

interface LineRow extends Record<string, unknown> {
  claim_id: string | null;
  claim_line_no: number;
  paid: string;
  contractual: string;
  pr: string;
  status: string;
  review_reason: string | null;
}
interface ResolutionRow extends Record<string, unknown> {
  id: string;
  remittance_id: string;
  line_no: number;
  action: RemittanceLineResolve['action'];
  claim_id: string;
  claim_line_no: number;
  charge_id: string;
  coverage_id: string;
  residual: string;
  workflow_policy_id: string | null;
  needs_approval: boolean;
  requested_by: string;
}

/** The latest workflow policy version for a payer, or the tenant default (CL-08 policy data). */
export async function latestWorkflowPolicy(tx: TenantTransaction, payerRef: string | null) {
  const { rows } = await tx.query<{
    id: string;
    version_no: number;
    payer_ref: string | null;
    ack: number;
    follow: number;
    due: number;
    max: number;
    limit: string;
  }>(
    `SELECT id, version_no, payer_ref, acknowledgement_due_minutes AS ack, follow_up_minutes AS follow,
       exception_due_minutes AS due, max_escalations AS max, write_off_limit_minor::text AS limit
     FROM cuspatlas.rcm_workflow_policies WHERE payer_ref IS NOT DISTINCT FROM $1 OR payer_ref IS NULL
     ORDER BY (payer_ref IS NULL), version_no DESC LIMIT 1`,
    [payerRef],
  );
  return rows[0] ?? null;
}

const lineOf = async (tx: TenantTransaction, remittanceId: string, lineNo: number) => {
  const { rows } = await tx.query<LineRow>(
    `SELECT claim_id, claim_line_no, paid_minor::text AS paid, contractual_minor::text AS contractual,
       patient_responsibility_minor::text AS pr, status, review_reason
     FROM cuspatlas.rcm_remittance_lines WHERE remittance_id = $1 AND line_no = $2`,
    [remittanceId, lineNo],
  );
  return rows[0] ?? null;
};

/**
 * Resolution of B7 review lines (CL-10) as separate, linked facts: match an unmatched line to a claim
 * line (posts like a matched line), post the reported amounts with the residual as an approved
 * adjustment, route an underpayment or mismatch to appeal (only the paid amount posts; the rest stays
 * insurer responsibility, never moved to the patient), or write the residual off under a workflow
 * policy limit with another human's approval. The line itself is never edited; every posting is a
 * balanced entry tagged with the remittance and linked to the resolution.
 */
export function createRemittanceResolutionOperations(base: BillingBase) {
  const { deps, execute } = base;
  const bump = async (tx: TenantTransaction, id: string) =>
    (
      await tx.query<{ version: number }>(
        'UPDATE cuspatlas.rcm_remittances SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version',
        [id],
      )
    ).rows[0]?.version as number;
  const link = async (tx: TenantTransaction, resolutionId: string, entries: readonly string[]) => {
    for (const e of entries)
      await tx.query(
        `INSERT INTO cuspatlas.rcm_remittance_resolution_postings (tenant_id, resolution_id, entry_id)
         VALUES (cuspatlas.current_tenant_id(), $1, $2)`,
        [resolutionId, e],
      );
  };
  /** The residual (billed minus what the payer reported) as an adjustment or write-off. */
  const postResidual = async (
    tx: TenantTransaction,
    r: { remittance: string; charge: string; coverage: string; payer: string; patient: string },
    residual: bigint,
    kind: 'adjustment' | 'writeOff',
    currency: string,
  ) =>
    postEntry(tx, {
      kind,
      currency,
      chargeId: r.charge,
      remittanceId: r.remittance,
      reasonCode: kind === 'writeOff' ? 'remittance_residual_write_off' : 'remittance_residual_adjustment',
      lines: [
        {
          account: 'adjustment_expense',
          amount: moneyFromMinorText(currency, residual.toString()),
          patientId: r.patient,
          chargeId: r.charge,
        },
        {
          account: 'insurer_receivable',
          amount: moneyFromMinorText(currency, (-residual).toString()),
          patientId: r.patient,
          chargeId: r.charge,
          payerRef: r.payer,
          coverageId: r.coverage,
        },
      ],
    });

  return {
    resolveRemittanceLine(
      ctx: ActorContext,
      remittanceRef: string,
      lineNoText: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<RemittanceResolutionCommandData>> {
      const op = 'rcm.remittances.resolveLine';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<RemittanceLineResolve>(validateRemittanceLineResolve, p);
        if (!/^[1-9][0-9]{0,2}$/.test(lineNoText)) throw notFound();
        const lineNo = Number.parseInt(lineNoText, 10);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const rem = await loadRemittanceForUpdate(tx, remittanceRef);
          return execute<RemittanceResolutionCommandData>(
            ctx,
            { ...envelope, payload: { remittanceRef, lineNo, ...p } },
            tx,
            async () => {
              if (rem.reversed) throw conflict('remittance_reversed');
              const line = await lineOf(tx, rem.id, lineNo);
              if (!line) throw notFound();
              if (line.status !== 'review') throw conflict('line_not_in_review');
              const { rows: prior } = await tx.query<{ id: string }>(
                `SELECT r.id FROM cuspatlas.rcm_remittance_line_resolutions r WHERE r.remittance_id = $1 AND r.line_no = $2
                   AND NOT EXISTS (SELECT 1 FROM cuspatlas.rcm_remittance_resolution_decisions d
                                   WHERE d.resolution_id = r.id AND d.decision = 'rejected')`,
                [rem.id, lineNo],
              );
              if (prior[0])
                throw conflict('line_already_resolved', [{ kind: 'remittanceResolution', ref: prior[0].id }]);
              const unmatched = line.claim_id === null;
              if (p.action === 'match_claim_line' && !unmatched) throw failed('action_not_applicable');
              if (!unmatched && p.claimRef !== undefined && p.claimRef !== line.claim_id)
                throw failed('claim_mismatch');
              const claimRef = line.claim_id ?? p.claimRef;
              const claimLineNo = unmatched ? p.claimLineNo : line.claim_line_no;
              if (claimRef === undefined || claimLineNo === undefined) throw failed('claim_required');
              assertRef(claimRef);
              const m = await matchClaimLine(tx, claimRef, claimLineNo);
              if (!m) throw failed('claim_line_not_matchable');
              if (m.payer_ref !== rem.payer_ref) throw failed('payer_mismatch');
              await lockAggregates(tx, { payments: [], charges: [m.charge_id] });
              const open = await insurerOpen(tx, m.charge_id, m.coverage_id);
              const paid = BigInt(line.paid);
              const sum = paid + BigInt(line.contractual) + BigInt(line.pr);
              const billed = BigInt(m.billed);
              const amounts = {
                lineNo,
                claimRef,
                claimLineNo,
                paidMinor: line.paid,
                contractualMinor: line.contractual,
                patientResponsibilityMinor: line.pr,
              };
              let posted: string[] = [];
              let residual = 0n;
              let policyId: string | null = null;
              if (p.action === 'match_claim_line') {
                if (sum !== billed) throw conflict('amount_mismatch');
                if (m.allowance !== null && paid + BigInt(line.pr) < BigInt(m.allowance))
                  throw conflict('underpayment');
                if (open < sum) throw conflict('insurer_balance_mismatch');
                posted = await postRemittanceLine(tx, rem.id, m, amounts, rem.currency);
              } else if (p.action === 'route_to_appeal') {
                if (open < paid) throw conflict('insurer_balance_mismatch');
                posted = await postRemittanceLine(
                  tx,
                  rem.id,
                  m,
                  { ...amounts, contractualMinor: '0', patientResponsibilityMinor: '0' },
                  rem.currency,
                );
              } else {
                residual = billed - sum;
                if (residual < 0n) throw conflict('residual_negative');
                if (open < billed) throw conflict('insurer_balance_mismatch');
                if (p.action === 'write_off') {
                  const policy = await latestWorkflowPolicy(tx, rem.payer_ref);
                  if (!policy) throw conflict('write_off_policy_required');
                  if (residual > BigInt(policy.limit)) throw conflict('write_off_limit_exceeded');
                  policyId = policy.id;
                }
              }
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.rcm_remittance_line_resolutions (tenant_id, remittance_id, line_no, action, claim_id,
                   claim_line_no, charge_id, coverage_id, residual_minor, workflow_policy_id, reason_code, needs_approval,
                   requested_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   cuspatlas.current_actor_id()) RETURNING id`,
                [
                  rem.id,
                  lineNo,
                  p.action,
                  claimRef,
                  claimLineNo,
                  m.charge_id,
                  m.coverage_id,
                  residual.toString(),
                  policyId,
                  p.reasonCode,
                  p.action === 'post_with_adjustment' || p.action === 'write_off',
                ],
              );
              const resolutionRef = rows[0]?.id as string;
              await link(tx, resolutionRef, posted);
              const version = await bump(tx, rem.id);
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: REMITTANCE_RESOURCE,
                  resourceRef: rem.id,
                  resourceVersion: version,
                },
                { changedFields: ['resolution'] },
              );
              return {
                data: {
                  resolutionRef,
                  remittanceRef: rem.id,
                  lineNo,
                  action: p.action,
                  state:
                    p.action === 'match_claim_line'
                      ? 'posted'
                      : p.action === 'route_to_appeal'
                        ? 'routed'
                        : 'pending_approval',
                  entryRefs: posted,
                },
                version,
              };
            },
          );
        });
      });
    },

    decideRemittanceResolution(
      ctx: ActorContext,
      resolutionRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<RemittanceResolutionCommandData>> {
      const op = 'rcm.remittances.decideResolution';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<RemittanceResolutionDecide>(validateRemittanceResolutionDecide, p);
        assertRef(resolutionRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<ResolutionRow>(
            `SELECT id, remittance_id, line_no, action, claim_id, claim_line_no, charge_id, coverage_id,
               residual_minor::text AS residual, workflow_policy_id, needs_approval, requested_by
             FROM cuspatlas.rcm_remittance_line_resolutions WHERE id = $1`,
            [resolutionRef],
          );
          const r = rows[0];
          if (!r) throw notFound();
          const rem = await loadRemittanceForUpdate(tx, r.remittance_id);
          return execute<RemittanceResolutionCommandData>(
            ctx,
            { ...envelope, payload: { resolutionRef, ...p } },
            tx,
            async () => {
              if (r.requested_by === ctx.actorId)
                throw new RefusalError({ code: 'self_approval_denied', reasonCode: 'self_approval_denied' });
              if (!r.needs_approval) throw conflict('approval_not_required');
              const { rows: done } = await tx.query(
                'SELECT 1 FROM cuspatlas.rcm_remittance_resolution_decisions WHERE resolution_id = $1',
                [r.id],
              );
              if (done.length > 0) throw conflict('already_decided');
              let posted: string[] = [];
              if (p.decision === 'approved') {
                if (rem.reversed) throw conflict('remittance_reversed');
                const line = (await lineOf(tx, rem.id, r.line_no)) as LineRow;
                const m = await matchClaimLine(tx, r.claim_id, r.claim_line_no);
                if (!m) throw conflict('claim_line_not_matchable');
                await lockAggregates(tx, { payments: [], charges: [r.charge_id] });
                const residual = BigInt(r.residual);
                const total = BigInt(line.paid) + BigInt(line.contractual) + BigInt(line.pr) + residual;
                if ((await insurerOpen(tx, r.charge_id, r.coverage_id)) < total)
                  throw conflict('insurer_balance_mismatch');
                if (r.action === 'write_off') {
                  // The policy is rechecked now: a later version may have lowered the limit.
                  const policy = await latestWorkflowPolicy(tx, rem.payer_ref);
                  if (!policy) throw conflict('write_off_policy_required');
                  if (residual > BigInt(policy.limit)) throw conflict('write_off_limit_exceeded');
                }
                try {
                  posted = await postRemittanceLine(
                    tx,
                    rem.id,
                    m,
                    {
                      paidMinor: line.paid,
                      contractualMinor: line.contractual,
                      patientResponsibilityMinor: line.pr,
                    },
                    rem.currency,
                  );
                  if (residual > 0n)
                    posted.push(
                      await postResidual(
                        tx,
                        {
                          remittance: rem.id,
                          charge: m.charge_id,
                          coverage: m.coverage_id,
                          payer: m.payer_ref,
                          patient: m.patient_id,
                        },
                        residual,
                        r.action === 'write_off' ? 'writeOff' : 'adjustment',
                        rem.currency,
                      ),
                    );
                } catch (err) {
                  if (err instanceof SignViolation) throw conflict('insurer_balance_mismatch');
                  throw err;
                }
              }
              try {
                await tx.query(
                  `INSERT INTO cuspatlas.rcm_remittance_resolution_decisions (tenant_id, resolution_id, decision, reason_code,
                     decided_by)
                   VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id())`,
                  [r.id, p.decision, p.reasonCode ?? null],
                );
              } catch (err) {
                if (isPgError(err, '23505')) throw conflict('already_decided');
                throw err;
              }
              await link(tx, r.id, posted);
              const version = await bump(tx, rem.id);
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: REMITTANCE_RESOURCE,
                  resourceRef: rem.id,
                  resourceVersion: version,
                },
                { changedFields: ['resolutionDecision'] },
              );
              return {
                data: {
                  resolutionRef: r.id,
                  remittanceRef: rem.id,
                  lineNo: r.line_no,
                  action: r.action,
                  state: p.decision === 'approved' ? 'posted' : 'rejected',
                  entryRefs: posted,
                },
                version,
              };
            },
          );
        });
      });
    },

    publishWorkflowPolicy(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<WorkflowPolicyCommandData>> {
      const op = 'rcm.workflowPolicies.publish';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<WorkflowPolicyPublish>(validateWorkflowPolicyPublish, p);
        return deps.withTenantTransaction(ctx, async (tx) =>
          execute<WorkflowPolicyCommandData>(ctx, envelope, tx, async () => {
            const limit = inTenantCurrency(await loadSettings(tx), p.writeOffLimit);
            const { rows: v } = await tx.query<{ n: number }>(
              `SELECT coalesce(max(version_no), 0)::int + 1 AS n FROM cuspatlas.rcm_workflow_policies
               WHERE payer_ref IS NOT DISTINCT FROM $1`,
              [p.payerRef ?? null],
            );
            const versionNo = v[0]?.n ?? 1;
            try {
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.rcm_workflow_policies (tenant_id, payer_ref, version_no, acknowledgement_due_minutes,
                   follow_up_minutes, exception_due_minutes, max_escalations, write_off_limit_minor, currency, created_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, cuspatlas.current_actor_id())
                 RETURNING id`,
                [
                  p.payerRef ?? null,
                  versionNo,
                  p.acknowledgementDueMinutes,
                  p.followUpMinutes,
                  p.exceptionDueMinutes,
                  p.maxEscalations,
                  String(limit.minor),
                  limit.currency,
                ],
              );
              const id = rows[0]?.id as string;
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: WORKFLOW_POLICY_RESOURCE,
                  resourceRef: id,
                  resourceVersion: versionNo,
                },
                { changedFields: ['policy'] },
              );
              return { data: { policyRef: id, versionNo }, version: versionNo };
            } catch (err) {
              if (isPgError(err, '23505')) throw conflict('stale_version');
              throw err;
            }
          }),
        );
      });
    },
  };
}
