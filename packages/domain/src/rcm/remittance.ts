import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  type Money,
  moneyFromMinorText,
  RefusalError,
  type RemittanceCommandData,
  type TenantTransaction,
  validateRemittanceAdvice,
  validateRemittanceIngest,
  validateRemittanceReverse,
  validateRemittanceSettle,
} from '@cuspatlas/contracts';
import {
  assertRef,
  type BillingBase,
  checkEnvelope,
  conflict,
  failed,
  inTenantCurrency,
  loadSettings,
  notFound,
  validate,
} from '../billing/base';
import { lockAggregates } from '../billing/entries';
import { type LineInput, loadLines, negatedLines, postEntry, SignViolation } from '../billing/journal';
import { providerTiming, withTimeout } from '../billing/payments';
import { canonicalJson, sha256Hex } from '../commands/digest';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { type ClaimsPartnerPort, createFakeClearinghouse, type RemittanceAdvice } from './clearinghouse';

export const REMITTANCE_RESOURCE = 'rcmRemittance';

interface MatchRow extends Record<string, unknown> {
  charge_id: string;
  patient_id: string;
  coverage_id: string;
  payer_ref: string;
  billed: string;
  allowance: string | null;
  insurer_open: string;
}

/**
 * B7 remittance (CL-09/CL-10) from the fake clearinghouse: ingestion is idempotent per remittance
 * reference; each line is matched to exactly one transmitted claim line or routed to review
 * (unmatched, amount mismatch, underpayment, insurer balance mismatch); a denial line is recorded,
 * never posted. Posted lines move insurer receivable to clearing (paid), adjustment expense
 * (contractual) and patient receivable (patient responsibility): an ERA is never cash. Settlement is
 * a separate EFT/check fact; corrections reverse every posting.
 */
export function createRemittanceOperations(
  base: BillingBase,
  partner: ClaimsPartnerPort = createFakeClearinghouse(),
) {
  const { deps, execute } = base;
  const timing = providerTiming(deps);
  const record = (tx: TenantTransaction, op: string, id: string, version: number, field: string) =>
    recordCommand(
      tx,
      { operation: op, resourceType: REMITTANCE_RESOURCE, resourceRef: id, resourceVersion: version },
      { changedFields: [field] },
    );
  const load = async (tx: TenantTransaction, ref: string) => {
    assertRef(ref);
    const { rows } = await tx.query<{
      id: string;
      payer_ref: string;
      currency: string;
      version: number;
      reversed: boolean;
      external: string;
      total: string;
    }>(
      `SELECT r.id, r.payer_ref, r.currency, r.version, r.remittance_ref AS external, r.total_paid_minor::text AS total,
         EXISTS (SELECT 1 FROM cuspatlas.rcm_remittance_reversals x WHERE x.remittance_id = r.id) AS reversed
       FROM cuspatlas.rcm_remittances r WHERE r.id = $1 FOR UPDATE`,
      [ref],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  };
  const clearing = async (
    tx: TenantTransaction,
    id: string,
    account: 'insurer_clearing' | 'insurer_cash',
  ) => {
    const { rows } = await tx.query<{ s: string; patient_id: string | null }>(
      `SELECT coalesce(sum(amount_minor), 0)::text AS s, min(patient_id::text) AS patient_id
       FROM cuspatlas.billing_journal_lines WHERE remittance_id = $1 AND account = $2`,
      [id, account],
    );
    return { sum: BigInt(rows[0]?.s ?? '0'), patientId: rows[0]?.patient_id ?? null };
  };
  const bump = async (tx: TenantTransaction, id: string) =>
    (
      await tx.query<{ version: number }>(
        'UPDATE cuspatlas.rcm_remittances SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version',
        [id],
      )
    ).rows[0]?.version as number;

  async function insurerOpen(tx: TenantTransaction, chargeId: string, coverageId: string) {
    const { rows } = await tx.query<{ s: string }>(
      `SELECT coalesce(sum(amount_minor), 0)::text AS s FROM cuspatlas.billing_journal_lines
       WHERE charge_id = $1 AND account = 'insurer_receivable' AND coverage_id = $2`,
      [chargeId, coverageId],
    );
    return BigInt(rows[0]?.s ?? '0');
  }

  async function matchLine(
    tx: TenantTransaction,
    claimRef: string,
    lineNo: number,
  ): Promise<MatchRow | null> {
    if (!/^[0-9a-f-]{36}$/.test(claimRef)) return null;
    const { rows } = await tx.query<MatchRow>(
      `SELECT l.charge_id, c.patient_id, c.coverage_id, c.payer_ref, l.billed_minor::text AS billed,
         l.allowance_minor::text AS allowance,
         (SELECT coalesce(sum(j.amount_minor), 0) FROM cuspatlas.billing_journal_lines j
          WHERE j.charge_id = l.charge_id AND j.account = 'insurer_receivable' AND j.coverage_id = c.coverage_id)::text
           AS insurer_open
       FROM cuspatlas.rcm_claims c
       JOIN cuspatlas.rcm_claim_submissions s ON s.claim_id = c.id AND s.outcome = 'transmitted'
       JOIN cuspatlas.rcm_claim_lines l ON l.version_id = s.version_id AND l.line_no = $2
       WHERE c.id = $1`,
      [claimRef, lineNo],
    );
    return rows.length === 1 ? (rows[0] as MatchRow) : null;
  }

  async function post(
    tx: TenantTransaction,
    remId: string,
    m: MatchRow,
    l: RemittanceAdvice['lines'][number],
    currency: string,
  ) {
    const amt = (n: number) => moneyFromMinorText(currency, String(n));
    const neg = (n: number) => moneyFromMinorText(currency, String(-n));
    const insurer = (n: number): LineInput => ({
      account: 'insurer_receivable',
      amount: neg(n),
      patientId: m.patient_id,
      chargeId: m.charge_id,
      payerRef: m.payer_ref,
      coverageId: m.coverage_id,
    });
    if (l.paidMinor > 0) {
      await postEntry(tx, {
        kind: 'insurerPayment',
        currency,
        chargeId: m.charge_id,
        remittanceId: remId,
        reasonCode: 'remittance_paid',
        lines: [
          {
            account: 'insurer_clearing',
            amount: amt(l.paidMinor),
            patientId: m.patient_id,
            payerRef: m.payer_ref,
            remittanceId: remId,
          },
          insurer(l.paidMinor),
        ],
      });
    }
    if (l.contractualMinor > 0) {
      await postEntry(tx, {
        kind: 'adjustment',
        currency,
        chargeId: m.charge_id,
        remittanceId: remId,
        reasonCode: 'contractual_allowance',
        lines: [
          {
            account: 'adjustment_expense',
            amount: amt(l.contractualMinor),
            patientId: m.patient_id,
            chargeId: m.charge_id,
          },
          insurer(l.contractualMinor),
        ],
      });
    }
    if (l.patientResponsibilityMinor > 0) {
      await postEntry(tx, {
        kind: 'responsibilityTransfer',
        currency,
        chargeId: m.charge_id,
        remittanceId: remId,
        reasonCode: 'remittance_patient_responsibility',
        lines: [
          {
            account: 'patient_receivable',
            amount: amt(l.patientResponsibilityMinor),
            patientId: m.patient_id,
            chargeId: m.charge_id,
          },
          insurer(l.patientResponsibilityMinor),
        ],
      });
    }
  }

  return {
    ingestRemittance(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<RemittanceCommandData>> {
      const op = 'rcm.remittances.ingest';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ remittanceRef: string }>(validateRemittanceIngest, p);
        const advice = await withTimeout(
          () => partner.fetchRemittance(p.remittanceRef),
          timing.timeoutMs,
          null,
        );
        // Every amount is a non-negative integer in minor units before anything is matched or posted
        // (review MUST-FAIL 3): a malformed advice is a typed 422, never a 500 or a partial posting.
        if (
          advice !== null &&
          (!validateRemittanceAdvice(advice) || advice.remittanceRef !== p.remittanceRef)
        )
          throw failed('malformed_remittance');
        const digest = advice === null ? null : sha256Hex(canonicalJson(advice));
        return deps.withTenantTransaction(ctx, async (tx) =>
          execute<RemittanceCommandData>(ctx, envelope, tx, async () => {
            const duplicate = async () => {
              const { rows: dup } = await tx.query<{ id: string; content_digest: string }>(
                'SELECT id, content_digest FROM cuspatlas.rcm_remittances WHERE remittance_ref = $1',
                [p.remittanceRef],
              );
              const d = dup[0];
              if (!d) return null;
              // Same reference, different content: an explicit supersede decision, never a silent dedupe.
              if (digest !== null && d.content_digest !== digest)
                throw conflict('remittance_content_changed', [{ kind: 'remittance', ref: d.id }]);
              return {
                data: { remittanceRef: d.id, outcome: 'duplicate' as const, posted: 0, review: 0, denied: 0 },
                version: 1,
              };
            };
            const prior = await duplicate();
            if (prior) return prior;
            if (advice === null || digest === null)
              throw new RefusalError({
                code: 'conflict',
                retryable: true,
                detail: { reason: 'remittance_unavailable' },
              });
            const settings = await loadSettings(tx);
            if (advice.currency !== settings.currency) throw failed('currency_mismatch');
            const total = advice.lines.reduce((s, l) => s + BigInt(l.paidMinor), 0n);
            if (total !== BigInt(advice.totalPaidMinor)) throw failed('partial_parse');
            // A concurrent ingest of the same reference waits on the unique key, then dedupes.
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.rcm_remittances (tenant_id, remittance_ref, payer_ref, currency, total_paid_minor, line_count,
                 content_digest, ingested_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id())
               ON CONFLICT (tenant_id, remittance_ref) DO NOTHING RETURNING id`,
              [
                advice.remittanceRef,
                advice.payerRef,
                advice.currency,
                String(advice.totalPaidMinor),
                advice.lines.length,
                digest,
              ],
            );
            if (!rows[0]) {
              const raced = await duplicate();
              if (!raced) throw conflict('remittance_unavailable');
              return raced;
            }
            const remId = rows[0].id;
            const counts = { posted: 0, review: 0, denied: 0 };
            for (const l of advice.lines) {
              const m = await matchLine(tx, l.claimRef, l.claimLineNo);
              let status: 'posted' | 'denied' | 'review' = 'posted';
              let why: string | null = null;
              const sum =
                BigInt(l.paidMinor) + BigInt(l.contractualMinor) + BigInt(l.patientResponsibilityMinor);
              if (!m || m.payer_ref !== advice.payerRef) [status, why] = ['review', 'unmatched_claim'];
              else if (l.denialCode !== undefined) status = 'denied';
              else if (sum !== BigInt(m.billed)) [status, why] = ['review', 'amount_mismatch'];
              else if (
                m.allowance !== null &&
                BigInt(l.paidMinor) + BigInt(l.patientResponsibilityMinor) < BigInt(m.allowance)
              )
                [status, why] = ['review', 'underpayment'];
              else if (BigInt(m.insurer_open) < sum) [status, why] = ['review', 'insurer_balance_mismatch'];
              if (status === 'posted' && m) {
                // All of a line's entries post together or not at all (review MUST-FAIL 3): the charge is
                // locked and its insurer balance re-read, so the whole line fits before the first entry;
                // a sign failure after that aborts the whole remittance (never a partial line).
                await lockAggregates(tx, { payments: [], charges: [m.charge_id] });
                const open = await insurerOpen(tx, m.charge_id, m.coverage_id);
                if (open < sum) [status, why] = ['review', 'insurer_balance_mismatch'];
                else {
                  try {
                    await post(tx, remId, m, l, advice.currency);
                  } catch (err) {
                    if (err instanceof SignViolation) throw conflict('remittance_line_not_postable');
                    throw err;
                  }
                }
              }
              counts[status] += 1;
              await tx.query(
                `INSERT INTO cuspatlas.rcm_remittance_lines (tenant_id, remittance_id, line_no, claim_id, claim_line_no, charge_id,
                   paid_minor, contractual_minor, patient_responsibility_minor, denial_code, status, review_reason)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                  remId,
                  l.lineNo,
                  m ? l.claimRef : null,
                  l.claimLineNo,
                  m?.charge_id ?? null,
                  String(l.paidMinor),
                  String(l.contractualMinor),
                  String(l.patientResponsibilityMinor),
                  l.denialCode ?? null,
                  status,
                  why,
                ],
              );
            }
            await record(tx, op, remId, 1, 'remittance');
            return { data: { remittanceRef: remId, outcome: 'ingested', ...counts }, version: 1 };
          }),
        );
      });
    },

    settleRemittance(
      ctx: ActorContext,
      remittanceRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<RemittanceCommandData>> {
      const op = 'rcm.remittances.settle';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ settlementRef: string; amount: Money }>(validateRemittanceSettle, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const rem = await load(tx, remittanceRef);
          return execute<RemittanceCommandData>(
            ctx,
            { ...envelope, payload: { remittanceRef, ...p } },
            tx,
            async () => {
              if (rem.reversed) throw conflict('remittance_reversed');
              const amount = inTenantCurrency(await loadSettings(tx), p.amount);
              const open = await clearing(tx, rem.id, 'insurer_clearing');
              // ERA versus deposit (review SHOULD): the deposit must equal the ERA total; a mismatch is never
              // posted. When the payer paid lines still in review, the gap between the ERA total and the
              // clearing balance is named by those lines until they are resolved.
              if (BigInt(amount.minor) !== BigInt(rem.total)) throw conflict('settlement_mismatch');
              if (open.sum !== BigInt(amount.minor) || open.patientId === null) {
                const { rows: gap } = await tx.query<{ line_no: number }>(
                  `SELECT line_no FROM cuspatlas.rcm_remittance_lines WHERE remittance_id = $1 AND status = 'review'
                     AND paid_minor > 0 ORDER BY line_no`,
                  [rem.id],
                );
                throw conflict(
                  gap.length > 0 ? 'settlement_pending_review' : 'settlement_mismatch',
                  gap.map((g) => ({ kind: 'remittanceLine', ref: `${rem.id}:${g.line_no}` })),
                );
              }
              const entryRef = await postEntry(tx, {
                kind: 'insurerSettlement',
                currency: rem.currency,
                remittanceId: rem.id,
                externalRef: p.settlementRef,
                reasonCode: 'eft_received',
                lines: [
                  {
                    account: 'insurer_cash',
                    amount,
                    patientId: open.patientId,
                    payerRef: rem.payer_ref,
                    remittanceId: rem.id,
                  },
                  {
                    account: 'insurer_clearing',
                    amount: moneyFromMinorText(rem.currency, String(-amount.minor)),
                    patientId: open.patientId,
                    payerRef: rem.payer_ref,
                    remittanceId: rem.id,
                  },
                ],
              });
              await tx.query(
                `INSERT INTO cuspatlas.rcm_remittance_settlements (tenant_id, remittance_id, settlement_ref, amount_minor, entry_id, settled_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id())`,
                [rem.id, p.settlementRef, String(amount.minor), entryRef],
              );
              const version = await bump(tx, rem.id);
              await record(tx, op, rem.id, version, 'settlement');
              return {
                data: { remittanceRef: rem.id, outcome: 'settled', posted: 1, review: 0, denied: 0 },
                version,
              };
            },
          );
        });
      });
    },

    reverseRemittance(
      ctx: ActorContext,
      remittanceRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<RemittanceCommandData>> {
      const op = 'rcm.remittances.reverse';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<{ reasonCode: string }>(validateRemittanceReverse, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const rem = await load(tx, remittanceRef);
          return execute<RemittanceCommandData>(
            ctx,
            { ...envelope, payload: { remittanceRef, ...p } },
            tx,
            async () => {
              if (rem.reversed) throw conflict('already_reversed');
              const { rows: entries } = await tx.query<{
                id: string;
                kind: 'insurerPayment' | 'adjustment' | 'responsibilityTransfer' | 'insurerSettlement';
                charge_id: string | null;
              }>(
                `SELECT e.id, e.kind, e.charge_id FROM cuspatlas.billing_journal_entries e
               WHERE e.remittance_id = $1 AND e.reverses_entry_id IS NULL ORDER BY e.posted_at DESC, e.id DESC`,
                [rem.id],
              );
              let n = 0;
              for (const e of entries) {
                try {
                  await postEntry(tx, {
                    kind: e.kind,
                    currency: rem.currency,
                    chargeId: e.charge_id,
                    remittanceId: rem.id,
                    reversesEntryId: e.id,
                    reasonCode: p.reasonCode,
                    lines: negatedLines(await loadLines(tx, [e.id]), rem.currency),
                  });
                } catch (err) {
                  if (err instanceof SignViolation) throw conflict('dependent_reversal_required');
                  throw err;
                }
                n += 1;
              }
              await tx.query(
                `INSERT INTO cuspatlas.rcm_remittance_reversals (tenant_id, remittance_id, reason_code, reversed_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, cuspatlas.current_actor_id())`,
                [rem.id, p.reasonCode],
              );
              const version = await bump(tx, rem.id);
              await record(tx, op, rem.id, version, 'reversal');
              return {
                data: { remittanceRef: rem.id, outcome: 'reversed', posted: n, review: 0, denied: 0 },
                version,
              };
            },
          );
        });
      });
    },

    getRemittance(ctx: ActorContext, remittanceRef: string) {
      const op = 'rcm.remittances.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          assertRef(remittanceRef);
          const { rows } = await tx.query<{
            id: string;
            payer_ref: string;
            currency: string;
            external: string;
            total: string;
            reversed: boolean;
          }>(
            `SELECT r.id, r.payer_ref, r.currency, r.remittance_ref AS external, r.total_paid_minor::text AS total,
               EXISTS (SELECT 1 FROM cuspatlas.rcm_remittance_reversals x WHERE x.remittance_id = r.id) AS reversed
             FROM cuspatlas.rcm_remittances r WHERE r.id = $1`,
            [remittanceRef],
          );
          const rem = rows[0];
          if (!rem) throw notFound();
          const { rows: lines } = await tx.query<{
            line_no: number;
            claim_id: string | null;
            status: 'posted' | 'denied' | 'review';
            review_reason: string | null;
            denial_code: string | null;
          }>(
            'SELECT line_no, claim_id, status, review_reason, denial_code FROM cuspatlas.rcm_remittance_lines WHERE remittance_id = $1 ORDER BY line_no',
            [rem.id],
          );
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: REMITTANCE_RESOURCE,
            resourceRefs: [rem.id],
            queryFields: [],
          });
          const m = (v: bigint) => moneyFromMinorText(rem.currency, v.toString());
          return {
            remittanceRef: rem.id,
            externalRef: rem.external,
            payerRef: rem.payer_ref,
            totalPaid: moneyFromMinorText(rem.currency, rem.total),
            clearing: m((await clearing(tx, rem.id, 'insurer_clearing')).sum),
            settled: m((await clearing(tx, rem.id, 'insurer_cash')).sum),
            reversed: rem.reversed,
            lines: lines.map((l) => ({
              lineNo: l.line_no,
              claimRef: l.claim_id,
              status: l.status,
              reviewReason: l.review_reason,
              denialCode: l.denial_code,
            })),
          };
        });
      });
    },
  };
}
