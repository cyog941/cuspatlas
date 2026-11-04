import {
  type ActorContext,
  type AdjustmentCommandData,
  type AdjustmentDecision,
  type AdjustmentKind,
  type AdjustmentPost,
  type CommandEnvelope,
  type CommandResult,
  type Money,
  moneyFromMinorText,
  negateMoney,
  type ReceivablesQuery,
  type ReceivablesReport,
  RefusalError,
  type TenantTransaction,
  validateAdjustmentDecision,
  validateAdjustmentPost,
  validateReceivablesQuery,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { claimAdjudicationOf, coverageOf, locationIdsOf, locationRefsOf } from '../rcm/lookups';
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
} from './base';
import { CHARGE_RESOURCE } from './charges';
import { bumpAggregates, lockAggregates } from './entries';
import { resolveAllowance } from './fees';
import { type LineInput, postEntry, SignViolation } from './journal';

export const ADJUSTMENT_RESOURCE = 'billingAdjustmentRequest';

/**
 * The configured adjustment reasons per kind (synthetic vocabulary, pending a billing reviewer;
 * B-D2). An unconfigured reason is refused (`reason_not_configured`), never stored as free text.
 */
export const ADJUSTMENT_REASONS: Readonly<Record<AdjustmentKind, readonly string[]>> = {
  contractual: ['contractual_allowance', 'payer_fee_schedule'],
  courtesy: ['courtesy_discount', 'professional_courtesy', 'service_recovery'],
  writeOff: ['small_balance', 'uncollectible', 'timely_filing'],
};

/** The lines of an adjustment: adjustment expense up, the chosen receivable down. */
export async function adjustmentLines(
  tx: TenantTransaction,
  o: { chargeId: string; patientId: string; amount: Money; coverageId: string | null },
): Promise<LineInput[]> {
  let receivable: LineInput = {
    account: 'patient_receivable',
    amount: negateMoney(o.amount),
    patientId: o.patientId,
    chargeId: o.chargeId,
  };
  if (o.coverageId !== null) {
    const cov = await coverageOf(tx, o.coverageId);
    if (!cov) throw failed('coverage_unknown');
    receivable = {
      account: 'insurer_receivable',
      amount: negateMoney(o.amount),
      patientId: o.patientId,
      chargeId: o.chargeId,
      payerRef: cov.payerRef,
      coverageId: o.coverageId,
    };
  }
  return [
    { account: 'adjustment_expense', amount: o.amount, patientId: o.patientId, chargeId: o.chargeId },
    receivable,
  ];
}

async function loadChargeRow(tx: TenantTransaction, chargeRef: string) {
  assertRef(chargeRef);
  const { rows } = await tx.query<{
    id: string;
    patient_id: string;
    service_date: string;
    amount: string;
    code: string | null;
  }>(
    `SELECT id, patient_id, to_char(service_date, 'YYYY-MM-DD') AS service_date, amount_minor::text AS amount,
       procedure_code AS code FROM cuspatlas.billing_charges
     WHERE id = $1`,
    [chargeRef],
  );
  const c = rows[0];
  if (!c) throw notFound();
  return c;
}

/** Posts an adjustment entry, mapping a sign failure to a typed refusal. */
async function postAdjustment(
  tx: TenantTransaction,
  o: {
    kind: 'adjustment' | 'writeOff';
    chargeId: string;
    patientId: string;
    serviceDate: string;
    reason: string;
  },
  lines: LineInput[],
  currency: string,
): Promise<string> {
  try {
    return await postEntry(tx, {
      kind: o.kind,
      currency,
      chargeId: o.chargeId,
      reasonCode: o.reason,
      serviceDate: o.serviceDate,
      lines,
    });
  } catch (err) {
    if (err instanceof SignViolation) throw conflict('adjustment_exceeds_balance');
    throw err;
  }
}

/**
 * The room a manual contractual adjustment of one charge may still take (review MUST-FAIL 4): the
 * charge must be a line of the named claim's adjudicated (paid) submission for that coverage, and the
 * total contractual write-down is capped at billed minus the payer allowance (resolveAllowance),
 * counting posted contractual entries net of their reversals and pending contractual requests.
 */
async function contractualRoom(
  tx: TenantTransaction,
  charge: { id: string; amount: string; code: string | null; service_date: string },
  claimRef: string,
  coverageId: string,
  excludeRequest: string | null,
): Promise<bigint> {
  assertRef(claimRef);
  const claim = await claimAdjudicationOf(tx, claimRef, charge.id);
  const c = claim;
  if (!c) throw notFound();
  if (c.coverage_id !== coverageId) throw failed('coverage_claim_mismatch');
  if (!c.on_claim) throw failed('charge_not_on_claim');
  if (!c.paid) throw conflict('claim_not_adjudicated');
  const allowance =
    charge.code === null ? null : await resolveAllowance(tx, charge.code, charge.service_date, coverageId);
  if (allowance === null) throw conflict('allowance_unknown');
  const reasons = ADJUSTMENT_REASONS.contractual;
  const { rows: used } = await tx.query<{ posted: string; pending: string }>(
    `SELECT
       (SELECT coalesce(sum(l.amount_minor), 0) FROM cuspatlas.billing_journal_lines l
          JOIN cuspatlas.billing_journal_entries e ON e.id = l.entry_id
          LEFT JOIN cuspatlas.billing_journal_entries o ON o.id = e.reverses_entry_id
        WHERE l.account = 'adjustment_expense' AND l.charge_id = $1 AND e.kind = 'adjustment'
          AND (e.reason_code = ANY ($2::text[]) OR o.reason_code = ANY ($2::text[])))::text AS posted,
       (SELECT coalesce(sum(r.amount_minor), 0) FROM cuspatlas.billing_adjustment_requests r
        WHERE r.charge_id = $1 AND r.kind = 'contractual' AND ($3::uuid IS NULL OR r.id <> $3::uuid)
          AND NOT EXISTS (SELECT 1 FROM cuspatlas.billing_adjustment_decisions d WHERE d.request_id = r.id))::text
         AS pending`,
    [charge.id, reasons, excludeRequest],
  );
  const gap = BigInt(charge.amount) - BigInt(allowance.fee.minor);
  return gap - BigInt(used[0]?.posted ?? '0') - BigInt(used[0]?.pending ?? '0');
}

/**
 * B9 adjustments and the receivables report. Contractual adjustments (insurer responsibility, the
 * B-D2 recommendation) post directly; courtesy adjustments and write-offs are requests that another
 * human posts by approving (no silent write-off; the database refuses a self-decision too). Every
 * adjustment is a journal entry with its reason and is corrected by reversal.
 */
export function createAdjustmentOperations(base: BillingBase) {
  const { deps, execute } = base;
  return {
    postAdjustment(
      ctx: ActorContext,
      chargeRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<AdjustmentCommandData>> {
      const op = 'billing.adjustments.post';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<AdjustmentPost>(validateAdjustmentPost, p);
        assertRef(chargeRef);
        if (!ADJUSTMENT_REASONS[p.kind].includes(p.reasonCode)) throw failed('reason_not_configured');
        if ((p.responsibility === 'insurer') !== (p.coverageRef !== undefined))
          throw failed('coverage_required');
        if (p.kind === 'contractual' && p.responsibility !== 'insurer')
          throw failed('contractual_is_insurer');
        if ((p.kind === 'contractual') !== (p.claimRef !== undefined)) throw failed('claim_required');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const charge = await loadChargeRow(tx, chargeRef);
          await lockAggregates(tx, { payments: [], charges: [charge.id] });
          return execute<AdjustmentCommandData>(
            ctx,
            { ...envelope, payload: { chargeRef, ...(p as object) } },
            tx,
            async () => {
              const settings = await loadSettings(tx);
              const amount = inTenantCurrency(settings, p.amount);
              const coverageId = p.coverageRef ?? null;
              // Every manual adjustment is a request a second human posts (review MUST-FAIL 4); service
              // principals post contractual amounts only through remittance ingestion.
              if (ctx.principal !== 'human')
                throw new RefusalError({ code: 'forbidden', reasonCode: 'principal_kind_denied' });
              if (p.kind === 'contractual') {
                const room = await contractualRoom(
                  tx,
                  charge,
                  p.claimRef as string,
                  coverageId as string,
                  null,
                );
                if (BigInt(amount.minor) > room) throw failed('contractual_exceeds_allowance_gap');
              }
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.billing_adjustment_requests (tenant_id, charge_id, kind, responsibility, coverage_id,
                   reason_code, amount_minor, currency, requested_by, claim_id)
                 VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, cuspatlas.current_actor_id(), $8)
                 RETURNING id`,
                [
                  charge.id,
                  p.kind,
                  p.responsibility,
                  coverageId,
                  p.reasonCode,
                  String(amount.minor),
                  amount.currency,
                  p.claimRef ?? null,
                ],
              );
              const requestRef = rows[0]?.id as string;
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: ADJUSTMENT_RESOURCE,
                  resourceRef: requestRef,
                  resourceVersion: 1,
                },
                { changedFields: ['request'] },
              );
              return { data: { outcome: 'pending_approval', requestRef, entryRef: null }, version: 1 };
            },
          );
        });
      });
    },

    decideAdjustment(
      ctx: ActorContext,
      requestRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<AdjustmentCommandData>> {
      const op = 'billing.adjustments.decide';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<AdjustmentDecision>(validateAdjustmentDecision, p);
        assertRef(requestRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            charge_id: string;
            kind: 'contractual' | 'courtesy' | 'writeOff';
            coverage_id: string | null;
            claim_id: string | null;
            reason_code: string;
            amount: string;
            currency: string;
            requested_by: string;
          }>(
            `SELECT id, charge_id, kind, coverage_id, claim_id, reason_code, amount_minor::text AS amount, currency,
               requested_by FROM cuspatlas.billing_adjustment_requests WHERE id = $1`,
            [requestRef],
          );
          const r = rows[0];
          if (!r) throw notFound();
          const charge = await loadChargeRow(tx, r.charge_id);
          await lockAggregates(tx, { payments: [], charges: [charge.id] });
          return execute<AdjustmentCommandData>(
            ctx,
            { ...envelope, payload: { requestRef, ...(p as object) } },
            tx,
            async () => {
              if (r.requested_by === ctx.actorId) {
                throw new RefusalError({ code: 'self_approval_denied', reasonCode: 'self_approval_denied' });
              }
              let entryRef: string | null = null;
              if (p.decision === 'approved') {
                const amount = moneyFromMinorText(r.currency, r.amount);
                // The allowance gap is rechecked at approval (another posting may have used it).
                if (
                  r.kind === 'contractual' &&
                  BigInt(r.amount) >
                    (await contractualRoom(tx, charge, r.claim_id as string, r.coverage_id as string, r.id))
                )
                  throw failed('contractual_exceeds_allowance_gap');
                const lines = await adjustmentLines(tx, {
                  chargeId: charge.id,
                  patientId: charge.patient_id,
                  amount,
                  coverageId: r.coverage_id,
                });
                entryRef = await postAdjustment(
                  tx,
                  {
                    kind: r.kind === 'writeOff' ? 'writeOff' : 'adjustment',
                    chargeId: charge.id,
                    patientId: charge.patient_id,
                    serviceDate: charge.service_date,
                    reason: r.reason_code,
                  },
                  lines,
                  r.currency,
                );
              }
              try {
                await tx.query(
                  `INSERT INTO cuspatlas.billing_adjustment_decisions (tenant_id, request_id, decision, entry_id,
                     reason_code, decided_by)
                   VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id())`,
                  [r.id, p.decision, entryRef, p.reasonCode ?? null],
                );
              } catch (err) {
                if (isPgError(err, '23505')) throw conflict('already_decided');
                throw err;
              }
              await recordCommand(
                tx,
                { operation: op, resourceType: ADJUSTMENT_RESOURCE, resourceRef: r.id, resourceVersion: 2 },
                { changedFields: ['decision'] },
              );
              return {
                data: {
                  outcome: p.decision === 'approved' ? 'posted' : 'rejected',
                  requestRef: r.id,
                  entryRef,
                },
                version: 2,
              };
            },
          );
        });
      });
    },

    /**
     * Report-scope authorisation (B9): open receivables by charge location. Requires
     * `receivables.read` (never patients.read alone); a location-restricted reader sees only its
     * locations, and naming another location is a 403 (the caller states it).
     */
    receivablesReport(ctx: ActorContext, query: unknown): Promise<ReceivablesReport> {
      const op = 'billing.reports.receivables';
      return base.guarded(ctx, op, async () => {
        const decision = await deps.authorize(ctx, op, { tenantId: ctx.tenantId, id: 'billing' });
        validate<ReceivablesQuery>(validateReceivablesQuery, query);
        const allowed = decision.locationRefs;
        if (query.locationRef !== undefined && allowed !== null && !allowed.includes(query.locationRef)) {
          throw new RefusalError({ code: 'forbidden', reasonCode: 'location_denied' });
        }
        return deps.withTenantTransaction(ctx, async (tx) => {
          const settings = await loadSettings(tx);
          const allowedIds = allowed === null ? null : await locationIdsOf(tx, allowed);
          const askedIds =
            query.locationRef === undefined ? null : await locationIdsOf(tx, [query.locationRef]);
          const { rows: raw } = await tx.query<{
            location_id: string | null;
            pr: string;
            ir: string;
            n: number;
          }>(
            `SELECT c.location_id,
               coalesce(sum(l.amount_minor) FILTER (WHERE l.account = 'patient_receivable'), 0)::text AS pr,
               coalesce(sum(l.amount_minor) FILTER (WHERE l.account = 'insurer_receivable'), 0)::text AS ir,
               count(DISTINCT c.id)::int AS n
             FROM cuspatlas.billing_charges c
             JOIN cuspatlas.billing_journal_lines l ON l.charge_id = c.id AND l.tenant_id = c.tenant_id
               AND l.account IN ('patient_receivable', 'insurer_receivable')
             WHERE ($1::uuid[] IS NULL OR c.location_id = ANY ($1::uuid[]))
               AND ($2::uuid[] IS NULL OR c.location_id = ANY ($2::uuid[]))
             GROUP BY c.location_id`,
            [allowedIds, askedIds],
          );
          const refs = await locationRefsOf(
            tx,
            raw.map((x) => x.location_id).filter((x): x is string => x !== null),
          );
          const rows = raw
            .map((x) => ({
              ...x,
              location_ref: x.location_id === null ? null : (refs.get(x.location_id) ?? null),
            }))
            .sort((a, b) => (a.location_ref ?? '').localeCompare(b.location_ref ?? ''));
          const { rows: at } = await tx.query<{ at: Date }>('SELECT now() AS at');
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'billingReport',
            resourceRefs: [],
            queryFields: Object.keys(query as object),
          });
          return {
            rows: rows.map((r) => ({
              locationRef: r.location_ref,
              patientReceivable: moneyFromMinorText(settings.currency, r.pr),
              insurerReceivable: moneyFromMinorText(settings.currency, r.ir),
              charges: r.n,
            })),
            scope: allowed === null ? 'all_locations' : 'assigned_locations',
            checkedAt: (at[0]?.at ?? new Date()).toISOString(),
          };
        });
      });
    },
  };
}
