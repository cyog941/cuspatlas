import {
  type ActorContext,
  type ChargeCommandData,
  type ChargePost,
  type ChargeView,
  type CommandEnvelope,
  type CommandResult,
  moneyFromMinorText,
  negateMoney,
  type PayerAmount,
  type TenantTransaction,
  validateChargePost,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import {
  assertNotMerged,
  assertRef,
  type BillingBase,
  checkEnvelope,
  conflict,
  failed,
  inTenantCurrency,
  isPgError,
  loadPatient,
  loadSettings,
  notFound,
  validate,
} from './base';
import { postEntry } from './journal';

export const CHARGE_RESOURCE = 'billingCharge';

export interface ChargeRow extends Record<string, unknown> {
  id: string;
  patient_id: string;
  procedure_ref: string;
  procedure_code: string | null;
  service_date: string;
  amount: string;
  currency: string;
  replaces_charge_id: string | null;
  version: number;
  entry_id: string;
  reversal_id: string | null;
  replaced_by: string | null;
}

const CHARGE_COLUMNS = `c.id, c.patient_id, c.procedure_ref, c.procedure_code,
  to_char(c.service_date, 'YYYY-MM-DD') AS service_date, c.amount_minor::text AS amount, c.currency,
  c.replaces_charge_id, c.version,
  (SELECT e.id FROM cuspatlas.billing_journal_entries e WHERE e.charge_id = c.id AND e.kind = 'charge'
     AND e.reverses_entry_id IS NULL) AS entry_id,
  (SELECT r.id FROM cuspatlas.billing_journal_entries r JOIN cuspatlas.billing_journal_entries e
     ON r.reverses_entry_id = e.id WHERE e.charge_id = c.id AND e.kind = 'charge') AS reversal_id,
  (SELECT n.id FROM cuspatlas.billing_charges n WHERE n.replaces_charge_id = c.id) AS replaced_by`;

/** One charge of the current tenant, optionally locked as the serialization point. */
export async function loadCharge(
  tx: TenantTransaction,
  chargeRef: string,
  lock: '' | 'FOR UPDATE OF c' = '',
): Promise<ChargeRow> {
  assertRef(chargeRef);
  const { rows } = await tx.query<ChargeRow>(
    `SELECT ${CHARGE_COLUMNS} FROM cuspatlas.billing_charges c WHERE c.id = $1 ${lock}`,
    [chargeRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** Open patient and insurer responsibility and the allocated amount, derived from the lines. */
export async function chargeView(tx: TenantTransaction, row: ChargeRow): Promise<ChargeView> {
  const { rows } = await tx.query<{
    account: string;
    payer_ref: string | null;
    coverage_id: string | null;
    kind: string;
    s: string;
  }>(
    `SELECT l.account, l.payer_ref, l.coverage_id, e.kind, sum(l.amount_minor)::text AS s
     FROM cuspatlas.billing_journal_lines l
     JOIN cuspatlas.billing_journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
     WHERE l.charge_id = $1 AND l.account IN ('patient_receivable', 'insurer_receivable')
     GROUP BY l.account, l.payer_ref, l.coverage_id, e.kind ORDER BY l.account, l.coverage_id, l.payer_ref, e.kind`,
    [row.id],
  );
  const m = (s: string) => moneyFromMinorText(row.currency, s);
  let patient = BigInt(0);
  let allocated = BigInt(0);
  const insurer = new Map<string, { coverageRef: string | null; payerRef: string; sum: bigint }>();
  for (const r of rows) {
    const v = BigInt(r.s);
    if (r.account === 'patient_receivable') {
      patient += v;
      if (r.kind === 'allocation') allocated -= v;
    } else if (r.payer_ref !== null) {
      // Keyed like the sign rule: the coverage, or the payer reference of a legacy line.
      const key = r.coverage_id ?? r.payer_ref;
      const cur = insurer.get(key) ?? { coverageRef: r.coverage_id, payerRef: r.payer_ref, sum: BigInt(0) };
      cur.sum += v;
      insurer.set(key, cur);
    }
  }
  const insurerResponsibility: PayerAmount[] = [...insurer.values()]
    .filter((x) => x.sum !== BigInt(0))
    .map((x) => ({ coverageRef: x.coverageRef, payerRef: x.payerRef, amount: m(x.sum.toString()) }));
  return {
    chargeRef: row.id,
    patientRef: row.patient_id,
    procedureRef: row.procedure_ref,
    procedureCode: row.procedure_code,
    serviceDate: row.service_date,
    amount: m(row.amount),
    entryRef: row.entry_id,
    state: row.reversal_id === null ? 'posted' : 'reversed',
    reversalEntryRef: row.reversal_id,
    replacesChargeRef: row.replaces_charge_id,
    replacedByChargeRef: row.replaced_by,
    patientResponsibility: m(patient.toString()),
    insurerResponsibility,
    allocated: m(allocated.toString()),
    version: row.version,
  };
}

/**
 * B1 charge posting: the seam C14 will drive with rendered-procedure facts. Until then a charge is
 * posted from a synthetic procedure reference (`syn-proc-...`) and synthetic placeholder code. One
 * original charge per procedure; a correction is a reversal of the original plus a replacement that
 * names it.
 */
export function createChargeOperations(base: BillingBase) {
  const { deps, execute } = base;
  return {
    postCharge(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ChargeCommandData>> {
      const op = 'billing.charges.post';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<ChargePost>(validateChargePost, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadPatient(tx, p.patientRef, 'FOR SHARE');
          const replaced =
            p.replacesChargeRef === undefined
              ? null
              : await loadCharge(tx, p.replacesChargeRef, 'FOR UPDATE OF c');
          return execute<ChargeCommandData>(ctx, envelope, tx, async () => {
            const settings = await loadSettings(tx);
            const amount = inTenantCurrency(settings, p.amount);
            assertNotMerged(patient);
            const { rows: clock } = await tx.query<{ future: boolean }>(
              'SELECT ($1::date > current_date) AS future',
              [p.serviceDate],
            );
            if (clock[0]?.future === true) throw failed('service_date_in_future');
            if (replaced) {
              if (replaced.patient_id !== patient.id || replaced.procedure_ref !== p.procedureRef) {
                throw failed('replacement_mismatch');
              }
              if (replaced.replaced_by !== null) {
                throw conflict('charge_already_replaced', [
                  { kind: 'billingCharge', ref: replaced.replaced_by },
                ]);
              }
              if (replaced.reversal_id === null) {
                throw conflict('replaced_charge_not_reversed', [
                  { kind: 'journalEntry', ref: replaced.entry_id },
                ]);
              }
            } else {
              const existing = await tx.query<{ id: string }>(
                `SELECT id FROM cuspatlas.billing_charges WHERE procedure_ref = $1 AND replaces_charge_id IS NULL`,
                [p.procedureRef],
              );
              const id = existing.rows[0]?.id;
              if (id) throw conflict('charge_already_posted', [{ kind: 'billingCharge', ref: id }]);
            }
            let chargeId: string;
            try {
              const { rows } = await tx.query<{ id: string }>(
                `INSERT INTO cuspatlas.billing_charges (tenant_id, patient_id, source, procedure_ref, procedure_code,
                   service_date, amount_minor, currency, replaces_charge_id, created_by)
                 VALUES (cuspatlas.current_tenant_id(), $1, 'synthetic_procedure_seam', $2, $3, $4::date, $5, $6, $7,
                   cuspatlas.current_actor_id())
                 RETURNING id`,
                [
                  patient.id,
                  p.procedureRef,
                  p.procedureCode ?? null,
                  p.serviceDate,
                  String(amount.minor),
                  amount.currency,
                  replaced?.id ?? null,
                ],
              );
              chargeId = rows[0]?.id as string;
            } catch (err) {
              // Backstop for a concurrent duplicate: the unique indexes decide, the caller gets a conflict.
              if (isPgError(err, '23505'))
                throw conflict(replaced ? 'charge_already_replaced' : 'charge_already_posted');
              throw err;
            }
            const entryRef = await postEntry(tx, {
              kind: 'charge',
              currency: amount.currency,
              chargeId,
              serviceDate: p.serviceDate,
              lines: [
                { account: 'patient_receivable', amount, patientId: patient.id, chargeId },
                {
                  account: 'production_revenue',
                  amount: negateMoney(amount),
                  patientId: patient.id,
                  chargeId,
                },
              ],
            });
            await recordCommand(
              tx,
              { operation: op, resourceType: CHARGE_RESOURCE, resourceRef: chargeId, resourceVersion: 1 },
              { changedFields: ['charge'] },
            );
            return { data: { chargeRef: chargeId, entryRef }, version: 1 };
          });
        });
      });
    },

    getCharge(ctx: ActorContext, chargeRef: string): Promise<ChargeView> {
      const op = 'billing.charges.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const view = await chargeView(tx, await loadCharge(tx, chargeRef));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: CHARGE_RESOURCE,
            resourceRefs: [view.chargeRef],
            queryFields: [],
          });
          return view;
        });
      });
    },
  };
}
