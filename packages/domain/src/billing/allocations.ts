import {
  type ActorContext,
  type AllocationCommandData,
  type CommandEnvelope,
  type CommandResult,
  type EntryCommandData,
  moneyFromMinorText,
  negateMoney,
  type PaymentAllocate,
  type ResponsibilityTransfer,
  type TenantTransaction,
  validatePaymentAllocate,
  validateResponsibilityTransfer,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { loadCoverageForCharge } from '../rcm/coverage';
import {
  assertRef,
  type BillingBase,
  checkEnvelope,
  conflict,
  failed,
  inTenantCurrency,
  loadSettings,
  mergeSet,
  validate,
} from './base';
import { CHARGE_RESOURCE, type ChargeRow, loadCharge } from './charges';
import { bumpAggregates, lockAggregates, PAYMENT_RESOURCE } from './entries';
import { dimensionBalance, type LineInput, postEntry, SignViolation } from './journal';
import { assertPaymentActive, loadPayment, unappliedHolders } from './payments';

function assertChargeActive(row: ChargeRow): void {
  if (row.reversal_id !== null)
    throw conflict('charge_reversed', [{ kind: 'journalEntry', ref: row.reversal_id }]);
}

/**
 * B2 allocations and responsibility transfers. An allocation moves a payment's unapplied credit onto
 * a charge's patient receivable; it can never exceed the payment's available funds or what the charge
 * still owes. The payment row, then the charges in id order, are locked before anything is read, so
 * concurrent allocations serialize: one wins, the other sees the result and gets a typed conflict.
 */
export function createAllocationOperations(base: BillingBase) {
  const { deps, execute } = base;
  return {
    allocatePayment(
      ctx: ActorContext,
      paymentRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<AllocationCommandData>> {
      const op = 'billing.payments.allocate';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<PaymentAllocate>(validatePaymentAllocate, p);
        assertRef(paymentRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          // H2 M-10: a migrated opening credit item is allocated through the same command.
          const { rows: opening } = await tx.query<{ id: string }>(
            `SELECT id FROM cuspatlas.migration_opening_items WHERE id = $1 AND kind = 'unappliedCredit'`,
            [paymentRef],
          );
          if (opening[0]) return allocateOpeningCredit(base, ctx, tx, opening[0].id, envelope, p);
          const payment = await loadPayment(tx, paymentRef);
          const refs = [...new Set(p.allocations.map((a) => a.chargeRef))];
          for (const ref of refs) await loadCharge(tx, ref);
          const charges = refs;
          await lockAggregates(tx, { payments: [payment.id], charges });
          return execute<AllocationCommandData>(
            ctx,
            { ...envelope, payload: { paymentRef, ...p } },
            tx,
            async () => {
              if (refs.length !== p.allocations.length) throw failed('duplicate_charge');
              const settings = await loadSettings(tx);
              const amounts = p.allocations.map((a) => inTenantCurrency(settings, a.amount));
              const current = await loadPayment(tx, paymentRef);
              assertPaymentActive(current);
              const allocationRefs: string[] = [];
              for (const [i, a] of p.allocations.entries()) {
                const amount = amounts[i] as typeof a.amount;
                const charge = await loadCharge(tx, a.chargeRef);
                assertChargeActive(charge);
                const account = await mergeSet(tx, charge.patient_id);
                const holders = await unappliedHolders(tx, current.id, current.currency);
                const usable = holders.filter(
                  (h) => account.ids.includes(h.patientRef) && h.amount.minor > 0,
                );
                const available = usable.reduce((s, h) => s + BigInt(h.amount.minor), 0n);
                if (available === 0n && holders.some((h) => h.amount.minor > 0))
                  throw failed('patient_mismatch');
                if (available < BigInt(amount.minor)) throw conflict('insufficient_funds');
                const open = await dimensionBalance(tx, current.currency, {
                  account: 'patient_receivable',
                  charge: charge.id,
                  payer: null,
                  payment: null,
                  patient: null,
                });
                if (open.minor < amount.minor) throw conflict('charge_overallocated');
                // Funds are consumed from the holders of the charge's account in patient-reference
                // order (ADR 0008 M-5): usually one holder, more only after a merge or a transfer.
                const lines: LineInput[] = [];
                let rest = BigInt(amount.minor);
                for (const h of usable) {
                  if (rest === 0n) break;
                  const held = BigInt(h.amount.minor);
                  // biome-ignore lint/complexity/useMathMinMax: BigInt minor units; Math is not a money path.
                  const take = held < rest ? held : rest;
                  rest -= take;
                  lines.push({
                    account: 'unapplied_credit',
                    amount: moneyFromMinorText(current.currency, take.toString()),
                    patientId: h.patientRef,
                    paymentId: current.id,
                  });
                }
                lines.push({
                  account: 'patient_receivable',
                  amount: negateMoney(amount),
                  patientId: charge.patient_id,
                  chargeId: charge.id,
                  paymentId: current.id,
                });
                try {
                  allocationRefs.push(
                    await postEntry(tx, {
                      kind: 'allocation',
                      currency: current.currency,
                      chargeId: charge.id,
                      paymentId: current.id,
                      lines,
                    }),
                  );
                } catch (err) {
                  if (err instanceof SignViolation) {
                    throw conflict(
                      err.accounts.includes('unapplied_credit')
                        ? 'insufficient_funds'
                        : 'charge_overallocated',
                    );
                  }
                  throw err;
                }
              }
              const versions = await bumpAggregates(tx, { payments: [current.id], charges });
              const version = versions.get(current.id) ?? 1;
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: PAYMENT_RESOURCE,
                  resourceRef: current.id,
                  resourceVersion: version,
                },
                { changedFields: ['allocations'] },
              );
              return { data: { allocationRefs }, version };
            },
          );
        });
      });
    },

    /** Moves open responsibility for a charge between the patient and one of its coverages (B5 seam). */
    transferResponsibility(
      ctx: ActorContext,
      chargeRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<EntryCommandData>> {
      const op = 'billing.responsibility.transfer';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<ResponsibilityTransfer>(validateResponsibilityTransfer, p);
        assertRef(chargeRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const charge = await loadCharge(tx, chargeRef, 'FOR UPDATE OF c');
          const coverage = await loadCoverageForCharge(tx, p.coverageRef);
          return execute<EntryCommandData>(
            ctx,
            { ...envelope, payload: { chargeRef, ...p } },
            tx,
            async () => {
              assertChargeActive(charge);
              const settings = await loadSettings(tx);
              const amount = inTenantCurrency(settings, p.amount);
              // B5: the coverage must belong to the charge patient's account and be effective on the
              // service date of the charge.
              const account = await mergeSet(tx, charge.patient_id);
              if (!account.ids.includes(coverage.patient_id)) throw failed('coverage_patient_mismatch');
              if (!(await coverage.effectiveOn(charge.service_date))) throw failed('coverage_not_effective');
              const toInsurer = p.direction === 'to_insurer';
              const insurer: LineInput = {
                account: 'insurer_receivable',
                amount: toInsurer ? amount : negateMoney(amount),
                patientId: charge.patient_id,
                chargeId: charge.id,
                payerRef: coverage.payer_ref,
                coverageId: coverage.id,
              };
              const patient: LineInput = {
                account: 'patient_receivable',
                amount: toInsurer ? negateMoney(amount) : amount,
                patientId: charge.patient_id,
                chargeId: charge.id,
              };
              let entryRef: string;
              try {
                entryRef = await postEntry(tx, {
                  kind: 'responsibilityTransfer',
                  currency: amount.currency,
                  chargeId: charge.id,
                  reasonCode: p.reasonCode,
                  lines: toInsurer ? [insurer, patient] : [patient, insurer],
                });
              } catch (err) {
                if (err instanceof SignViolation) throw conflict('responsibility_exceeded');
                throw err;
              }
              const version =
                (await bumpAggregates(tx, { payments: [], charges: [charge.id] })).get(charge.id) ?? 1;
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: CHARGE_RESOURCE,
                  resourceRef: charge.id,
                  resourceVersion: version,
                },
                { changedFields: ['responsibility'] },
              );
              return { data: { entryRef }, version };
            },
          );
        });
      });
    },
  };
}

/**
 * H2 M-10: B2 allocation of a migrated opening credit (an opening item of kind unappliedCredit) onto a
 * charge, with the same invariants as a payment allocation: the charge is active and of the item's
 * account (merge set), the amount never exceeds what the item still holds nor what the charge still
 * owes, and the item then the charges are locked before anything is read so concurrent allocations
 * serialize. The entry draws on `opening_credit` (checked again by the database) and names no payment.
 */
async function allocateOpeningCredit(
  base: BillingBase,
  ctx: ActorContext,
  tx: TenantTransaction,
  itemId: string,
  envelope: CommandEnvelope<unknown>,
  p: PaymentAllocate,
): Promise<CommandResult<AllocationCommandData>> {
  const op = 'billing.payments.allocate';
  const refs = [...new Set(p.allocations.map((a) => a.chargeRef))];
  for (const ref of refs) await loadCharge(tx, ref);
  // The item's patient row serializes concurrent allocations of one opening credit (items never update).
  await tx.query(
    `SELECT p.id FROM cuspatlas.patients p JOIN cuspatlas.migration_opening_items i ON i.patient_id = p.id
     WHERE i.id = $1 FOR NO KEY UPDATE OF p`,
    [itemId],
  );
  await lockAggregates(tx, { payments: [], charges: refs });
  return base.execute<AllocationCommandData>(
    ctx,
    { ...envelope, payload: { paymentRef: itemId, ...p } },
    tx,
    async () => {
      if (refs.length !== p.allocations.length) throw failed('duplicate_charge');
      const settings = await loadSettings(tx);
      const { rows } = await tx.query<{ patient_id: string; currency: string }>(
        'SELECT patient_id, currency FROM cuspatlas.migration_opening_items WHERE id = $1',
        [itemId],
      );
      const item = rows[0] as { patient_id: string; currency: string };
      const allocationRefs: string[] = [];
      for (const a of p.allocations) {
        const amount = inTenantCurrency(settings, a.amount);
        const charge = await loadCharge(tx, a.chargeRef);
        assertChargeActive(charge);
        const account = await mergeSet(tx, charge.patient_id);
        if (!account.ids.includes(item.patient_id)) throw failed('patient_mismatch');
        const held = await dimensionBalance(tx, item.currency, {
          account: 'opening_credit',
          charge: null,
          payer: null,
          payment: null,
          patient: null,
          opening: itemId,
        });
        if (-held.minor < amount.minor) throw conflict('insufficient_funds');
        const open = await dimensionBalance(tx, item.currency, {
          account: 'patient_receivable',
          charge: charge.id,
          payer: null,
          payment: null,
          patient: null,
        });
        if (open.minor < amount.minor) throw conflict('charge_overallocated');
        try {
          allocationRefs.push(
            await postEntry(tx, {
              kind: 'allocation',
              currency: item.currency,
              chargeId: charge.id,
              lines: [
                { account: 'opening_credit', amount, patientId: item.patient_id, openingItemId: itemId },
                {
                  account: 'patient_receivable',
                  amount: negateMoney(amount),
                  patientId: charge.patient_id,
                  chargeId: charge.id,
                },
              ],
            }),
          );
        } catch (err) {
          if (err instanceof SignViolation)
            throw conflict(
              err.accounts.includes('opening_credit') ? 'insufficient_funds' : 'charge_overallocated',
            );
          throw err;
        }
      }
      await bumpAggregates(tx, { payments: [], charges: refs });
      const { rows: n } = await tx.query<{ v: number }>(
        'SELECT count(DISTINCT entry_id)::int AS v FROM cuspatlas.billing_journal_lines WHERE opening_item_id = $1',
        [itemId],
      );
      const version = n[0]?.v ?? 2;
      await recordCommand(
        tx,
        {
          operation: op,
          resourceType: 'migrationOpeningItem',
          resourceRef: itemId,
          resourceVersion: version,
        },
        { changedFields: ['allocations'] },
      );
      return { data: { allocationRefs }, version };
    },
  );
}
