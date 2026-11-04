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
  validatePaymentAllocate,
  validateResponsibilityTransfer,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
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
                const available = usable.reduce((s, h) => s + h.amount.minor, 0);
                if (available === 0 && holders.some((h) => h.amount.minor > 0))
                  throw failed('patient_mismatch');
                if (available < amount.minor) throw conflict('insufficient_funds');
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
                let rest = amount.minor;
                for (const h of usable) {
                  if (rest === 0) break;
                  const take = Math.min(h.amount.minor, rest);
                  rest -= take;
                  lines.push({
                    account: 'unapplied_credit',
                    amount: moneyFromMinorText(current.currency, String(take)),
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

    /** Moves open responsibility for a charge between the patient and a (synthetic) payer. */
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
          return execute<EntryCommandData>(
            ctx,
            { ...envelope, payload: { chargeRef, ...p } },
            tx,
            async () => {
              assertChargeActive(charge);
              const settings = await loadSettings(tx);
              const amount = inTenantCurrency(settings, p.amount);
              const toInsurer = p.direction === 'to_insurer';
              const insurer: LineInput = {
                account: 'insurer_receivable',
                amount: toInsurer ? amount : negateMoney(amount),
                patientId: charge.patient_id,
                chargeId: charge.id,
                payerRef: p.payerRef,
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
