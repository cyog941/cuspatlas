import {
  type ActorContext,
  type BalanceQuery,
  type CommandEnvelope,
  type CommandResult,
  type EntryReverse,
  type JournalEntry,
  type LedgerAccount,
  type LedgerQuery,
  moneyFromMinorText,
  negateMoney,
  type Page,
  type PatientBalance,
  subtractMoney,
  type TenantTransaction,
  validateBalanceQuery,
  validateEntryReverse,
  validateLedgerQuery,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import {
  assertRef,
  type BillingBase,
  checkEnvelope,
  conflict,
  failed,
  isPgError,
  loadPatient,
  loadSettings,
  mergeSet,
  validate,
} from './base';
import { CHARGE_RESOURCE } from './charges';
import {
  assertReversible,
  dependentEntries,
  ENTRY_COLUMNS,
  type EntryRow,
  loadEntry,
  loadLines,
  negatedLines,
  postEntry,
  SignViolation,
  toEntry,
} from './journal';

export const PAYMENT_RESOURCE = 'billingPayment';

/** Aggregates an entry touches; each is locked (payments first, then charges, in id order). */
export interface AggregateLocks {
  readonly charges: readonly string[];
  readonly payments: readonly string[];
}

/** Locks the aggregates in the fixed order and bumps each version by one. Returns the new versions. */
export async function lockAggregates(tx: TenantTransaction, locks: AggregateLocks): Promise<void> {
  if (locks.payments.length > 0) {
    await tx.query(
      'SELECT id FROM cuspatlas.billing_payments WHERE id = ANY ($1::uuid[]) ORDER BY id FOR UPDATE',
      [[...locks.payments].sort()],
    );
  }
  if (locks.charges.length > 0) {
    await tx.query(
      'SELECT id FROM cuspatlas.billing_charges WHERE id = ANY ($1::uuid[]) ORDER BY id FOR UPDATE',
      [[...locks.charges].sort()],
    );
  }
}

export async function bumpAggregates(
  tx: TenantTransaction,
  locks: AggregateLocks,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const [table, ids] of [
    ['billing_payments', locks.payments],
    ['billing_charges', locks.charges],
  ] as const) {
    if (ids.length === 0) continue;
    const { rows } = await tx.query<{ id: string; version: number }>(
      `UPDATE cuspatlas.${table} SET version = version + 1, updated_at = now() WHERE id = ANY ($1::uuid[])
       RETURNING id, version`,
      [[...ids]],
    );
    for (const r of rows) out.set(r.id, r.version);
  }
  return out;
}

/** The refusal a reversal gives when it would break a sign rule, by the original's kind. */
function reversalRefusal(
  row: EntryRow,
  accounts: readonly LedgerAccount[],
  blocking: { kind: string; ref: string }[],
) {
  // A payment whose money was used (allocated, transferred or refunded) needs those entries reversed
  // first; one whose cash was settled needs the settlement reversed first.
  if (row.kind === 'patientPayment') {
    return conflict(
      accounts.includes('unapplied_credit') ? 'allocation_reversal_required' : 'settlement_reversal_required',
      blocking,
    );
  }
  return conflict('dependent_reversal_required', blocking);
}

const DEFAULT_LIMIT = 25;

/** B1 reversal and journal reads: one correction path for every entry kind, never an edit. */
export function createEntryOperations(base: BillingBase) {
  const { deps, execute, cursors } = base;
  return {
    reverseEntry(
      ctx: ActorContext,
      entryRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<{ entryRef: string; reversesEntryRef: string }>> {
      const op = 'billing.entries.reverse';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<EntryReverse>(validateEntryReverse, p);
        assertRef(entryRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const original = await loadEntry(tx, entryRef);
          const lines = await loadLines(tx, [original.id]);
          const locks: AggregateLocks = {
            payments: [...new Set(lines.map((l) => l.payment_id).filter((x): x is string => x !== null))],
            charges: [...new Set(lines.map((l) => l.charge_id).filter((x): x is string => x !== null))],
          };
          await lockAggregates(tx, locks);
          return execute(ctx, { ...envelope, payload: { entryRef, ...(p as object) } }, tx, async () => {
            // Re-read after the locks: a concurrent reversal that committed meanwhile is now visible.
            const row = await loadEntry(tx, entryRef);
            assertReversible(row);
            let reversal: string;
            try {
              reversal = await postEntry(tx, {
                kind: row.kind,
                currency: row.currency,
                chargeId: row.charge_id,
                paymentId: row.payment_id,
                reversesEntryId: row.id,
                reasonCode: p.reasonCode,
                serviceDate: row.service_date,
                remittanceId: row.remittance_id,
                lines: negatedLines(lines, row.currency),
              });
            } catch (err) {
              if (err instanceof SignViolation) {
                const blocking = await dependentEntries(tx, row.id, {
                  chargeId: row.kind === 'charge' ? row.charge_id : null,
                  paymentId: row.payment_id,
                });
                throw reversalRefusal(row, err.accounts, blocking);
              }
              if (isPgError(err, '23505')) throw conflict('already_reversed');
              throw err;
            }
            const versions = await bumpAggregates(tx, locks);
            const primary = row.payment_id ?? row.charge_id ?? locks.charges[0] ?? null;
            if (primary === null) throw new Error('entry without an owning aggregate');
            const version = versions.get(primary) ?? 1;
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: row.payment_id !== null ? PAYMENT_RESOURCE : CHARGE_RESOURCE,
                resourceRef: primary,
                resourceVersion: version,
              },
              { changedFields: ['reversal'] },
            );
            return { data: { entryRef: reversal, reversesEntryRef: row.id }, version };
          });
        });
      });
    },

    getEntry(ctx: ActorContext, entryRef: string): Promise<JournalEntry> {
      const op = 'billing.entries.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertRef(entryRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadEntry(tx, entryRef);
          const entry = toEntry(row, await loadLines(tx, [row.id]));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'journalEntry',
            resourceRefs: [entry.entryRef],
            queryFields: [],
          });
          return entry;
        });
      });
    },

    /** Entries touching the patient's account (merge set), oldest first, one bounded page at a time. */
    listLedger(ctx: ActorContext, patientRef: string, query: unknown): Promise<Page<JournalEntry>> {
      const op = 'billing.ledger.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<LedgerQuery>(validateLedgerQuery, query);
        assertRef(patientRef);
        const limit = query.limit === undefined ? DEFAULT_LIMIT : Number.parseInt(query.limit, 10);
        const scope = `ledger:${patientRef}`;
        const after = query.cursor === undefined ? null : cursors.decode(ctx.tenantId, scope, query.cursor);
        const [afterAt, afterId] = after === null ? [null, null] : after.split('_');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadPatient(tx, patientRef);
          const set = await mergeSet(tx, patient.id);
          const { rows } = await tx.query<EntryRow & { position: string }>(
            `SELECT ${ENTRY_COLUMNS},
               to_char(e.posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS position
             FROM cuspatlas.billing_journal_entries e
             WHERE EXISTS (SELECT 1 FROM cuspatlas.billing_journal_lines l
                           WHERE l.entry_id = e.id AND l.patient_id = ANY ($1::uuid[]))
               AND ($2::timestamp IS NULL OR (e.posted_at AT TIME ZONE 'UTC', e.id) > ($2::timestamp, $3::uuid))
             ORDER BY e.posted_at, e.id LIMIT $4`,
            [set.ids, afterAt ?? null, afterId ?? null, limit + 1],
          );
          const page = rows.slice(0, limit);
          const lines = await loadLines(
            tx,
            page.map((r) => r.id),
          );
          const data = page.map((r) => toEntry(r, lines));
          const last = page[page.length - 1];
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'patient',
            resourceRefs: set.ids.slice(0, 100),
            queryFields: Object.keys(query as object).filter((k) => k === 'limit' || k === 'cursor'),
          });
          return {
            data,
            nextCursor:
              rows.length > limit && last
                ? cursors.encode(ctx.tenantId, scope, `${last.position}_${last.id}`)
                : null,
          };
        });
      });
    },

    /**
     * readPatientBalance (B1 contract): derived from the journal lines of the patient's merge set at
     * `asOf` (default now, compared at the millisecond precision of published instants). Reads no
     * clinical table and constructs no estimate.
     */
    readBalance(ctx: ActorContext, patientRef: string, query: unknown): Promise<PatientBalance> {
      const op = 'billing.balances.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<BalanceQuery>(validateBalanceQuery, query);
        assertRef(patientRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadPatient(tx, patientRef);
          const settings = await loadSettings(tx);
          if (query.currency !== undefined && query.currency !== settings.currency)
            throw failed('currency_mismatch');
          const set = await mergeSet(tx, patient.id);
          const { rows } = await tx.query<{ account: LedgerAccount; s: string }>(
            `SELECT l.account, sum(l.amount_minor)::text AS s
             FROM cuspatlas.billing_journal_lines l
             JOIN cuspatlas.billing_journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
             WHERE l.patient_id = ANY ($1::uuid[]) AND l.currency = $2
               AND date_trunc('milliseconds', e.posted_at) <= coalesce($3::timestamptz, now())
             GROUP BY l.account`,
            [set.ids, settings.currency, query.asOf ?? null],
          );
          const { rows: stats } = await tx.query<{ n: number; last: Date | null; as_of: Date }>(
            `SELECT count(DISTINCT e.id)::int AS n, max(e.posted_at) AS last, coalesce($3::timestamptz, now()) AS as_of
             FROM cuspatlas.billing_journal_entries e
             JOIN cuspatlas.billing_journal_lines l ON l.entry_id = e.id AND l.tenant_id = e.tenant_id
             WHERE l.patient_id = ANY ($1::uuid[]) AND e.currency = $2
               AND date_trunc('milliseconds', e.posted_at) <= coalesce($3::timestamptz, now())`,
            [set.ids, settings.currency, query.asOf ?? null],
          );
          const total = (account: LedgerAccount) =>
            moneyFromMinorText(settings.currency, rows.find((r) => r.account === account)?.s ?? '0');
          const patientResponsibility = total('patient_receivable');
          // Unapplied credit is a credit balance (negative lines); it is reported as a positive amount.
          const unappliedCredit = negateMoney(total('unapplied_credit'));
          const s = stats[0];
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'patient',
            resourceRefs: set.ids.slice(0, 100),
            queryFields: Object.keys(query as object).filter((k) => k === 'currency' || k === 'asOf'),
          });
          return {
            patientRef: patient.id,
            accountPatientRef: set.root,
            coveredPatientRefs: set.ids,
            currency: settings.currency,
            asOf: (s?.as_of ?? new Date()).toISOString(),
            patientResponsibility,
            insurerResponsibility: total('insurer_receivable'),
            unappliedCredit,
            balance: subtractMoney(patientResponsibility, unappliedCredit),
            entryCount: s?.n ?? 0,
            lastPostedAt: s?.last ? s.last.toISOString() : null,
          };
        });
      });
    },
  };
}
