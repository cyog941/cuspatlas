import {
  type EntryKind,
  type JournalEntry,
  type JournalLine,
  type LedgerAccount,
  type Money,
  MoneyError,
  money,
  moneyFromMinorText,
  sumMoney,
  type TenantTransaction,
} from '@cuspatlas/contracts';
import { conflict, failed, notFound } from './base';

/**
 * The append-only double-entry journal (B1, ADR 0008 M-6/M-7). Every billing command builds its
 * lines here and posts them through `postEntry`, which checks balance and the per-dimension sign
 * rules under the locks the command already holds; the database checks the same invariants again
 * at commit. Nothing in this module updates or deletes a posted row.
 */

export interface LineInput {
  readonly account: LedgerAccount;
  /** Signed: debit positive, credit negative; never zero. */
  readonly amount: Money;
  readonly patientId: string;
  readonly chargeId?: string | null;
  readonly paymentId?: string | null;
  readonly payerRef?: string | null;
  /** B5: the coverage an insurer receivable line names; the sign rule keys on it. */
  readonly coverageId?: string | null;
}

export interface EntryInput {
  readonly kind: EntryKind;
  readonly currency: string;
  readonly chargeId?: string | null;
  readonly paymentId?: string | null;
  readonly reversesEntryId?: string | null;
  readonly reasonCode?: string | null;
  readonly serviceDate?: string | null;
  readonly externalRef?: string | null;
  readonly lines: readonly LineInput[];
}

/** Which dimension each account's sign rule is evaluated over, and the sign it must keep. */
const SIGN: Readonly<
  Record<
    LedgerAccount,
    { keys: readonly ('charge' | 'payer' | 'payment' | 'patient')[]; nonNegative: boolean }
  >
> = {
  patient_receivable: { keys: ['charge'], nonNegative: true },
  insurer_receivable: { keys: ['charge', 'payer'], nonNegative: true },
  production_revenue: { keys: ['charge'], nonNegative: false },
  unapplied_credit: { keys: ['payment', 'patient'], nonNegative: false },
  undeposited_funds: { keys: ['payment'], nonNegative: true },
  settled_cash: { keys: ['payment'], nonNegative: true },
};

/** A posting would break an account's sign rule; the command maps it to its own reason. */
export class SignViolation extends Error {
  /** Every account whose rule the posting would break (all dimensions are checked first). */
  readonly accounts: readonly LedgerAccount[];
  constructor(accounts: readonly LedgerAccount[]) {
    super('sign_violation');
    this.name = 'SignViolation';
    this.accounts = accounts;
  }
}

/**
 * Structural validation of an entry before it reaches the database: at least two lines, one
 * currency, no zero line, exact integer minor units and a zero sum (refusal reasons
 * `malformed_entry`, `currency_mismatch`, `unbalanced_entry`).
 */
export function assertBalancedEntry(input: EntryInput): void {
  if (input.lines.length < 2 || input.lines.length > 64) throw failed('malformed_entry');
  try {
    for (const l of input.lines) {
      money(l.amount.currency, l.amount.minor);
      if (l.amount.currency !== input.currency) throw new MoneyError('currency_mismatch');
      if (l.amount.minor === 0) throw failed('malformed_entry');
    }
    if (
      sumMoney(
        input.currency,
        input.lines.map((l) => l.amount),
      ).minor !== 0
    )
      throw failed('unbalanced_entry');
  } catch (err) {
    if (err instanceof MoneyError) throw failed(err.code === 'invalid_money' ? 'malformed_entry' : err.code);
    throw err;
  }
}

const dimensionOf = (l: LineInput) => ({
  account: l.account,
  charge: SIGN[l.account].keys.includes('charge') ? (l.chargeId ?? null) : null,
  payer: SIGN[l.account].keys.includes('payer') ? (l.coverageId ?? l.payerRef ?? null) : null,
  payment: SIGN[l.account].keys.includes('payment') ? (l.paymentId ?? null) : null,
  patient: SIGN[l.account].keys.includes('patient') ? l.patientId : null,
});

/** Current balance of one dimension (exact integer text from PostgreSQL, parsed without floats). */
export async function dimensionBalance(
  tx: TenantTransaction,
  currency: string,
  d: ReturnType<typeof dimensionOf>,
): Promise<Money> {
  const { rows } = await tx.query<{ s: string }>(
    `SELECT coalesce(sum(amount_minor), 0)::text AS s FROM cuspatlas.billing_journal_lines
     WHERE account = $1 AND ($2::uuid IS NULL OR charge_id = $2::uuid) AND ($3::text IS NULL OR coalesce(coverage_id::text, payer_ref) = $3::text)
       AND ($4::uuid IS NULL OR payment_id = $4::uuid) AND ($5::uuid IS NULL OR patient_id = $5::uuid)`,
    [d.account, d.charge, d.payer, d.payment, d.patient],
  );
  return moneyFromMinorText(currency, rows[0]?.s ?? '0');
}

/** Refuses the posting when any touched dimension would leave its sign rule (domain check). */
async function assertSigns(tx: TenantTransaction, input: EntryInput): Promise<void> {
  const seen = new Map<string, { d: ReturnType<typeof dimensionOf>; delta: bigint }>();
  for (const l of input.lines) {
    const d = dimensionOf(l);
    const key = JSON.stringify(d);
    const cur = seen.get(key) ?? { d, delta: 0n };
    cur.delta += BigInt(l.amount.minor);
    seen.set(key, cur);
  }
  const broken: LedgerAccount[] = [];
  for (const { d, delta } of seen.values()) {
    const after = BigInt((await dimensionBalance(tx, input.currency, d)).minor) + delta;
    if (SIGN[d.account].nonNegative ? after < 0n : after > 0n) broken.push(d.account);
  }
  if (broken.length > 0) throw new SignViolation(broken);
}

/**
 * Posts one entry and its lines in the caller's transaction. The caller holds the row locks of every
 * aggregate the entry touches, so the sign check cannot race. Returns the entry reference.
 */
export async function postEntry(tx: TenantTransaction, input: EntryInput): Promise<string> {
  assertBalancedEntry(input);
  await assertSigns(tx, input);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.billing_journal_entries (tenant_id, kind, currency, line_count, charge_id, payment_id,
       reverses_entry_id, reason_code, service_date, external_ref, posted_by, correlation_id)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8::date, $9, cuspatlas.current_actor_id(), $10)
     RETURNING id`,
    [
      input.kind,
      input.currency,
      input.lines.length,
      input.chargeId ?? null,
      input.paymentId ?? null,
      input.reversesEntryId ?? null,
      input.reasonCode ?? null,
      input.serviceDate ?? null,
      input.externalRef ?? null,
      tx.ctx.correlationId,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('entry insert returned no row');
  await tx.query(
    `INSERT INTO cuspatlas.billing_journal_lines (tenant_id, entry_id, line_no, account, amount_minor, currency,
       patient_id, charge_id, payment_id, payer_ref, coverage_id)
     SELECT cuspatlas.current_tenant_id(), $1, l.n, l.account, l.amount, $2, l.patient, l.charge, l.payment, l.payer,
       l.coverage
     FROM unnest($3::smallint[], $4::text[], $5::bigint[], $6::uuid[], $7::uuid[], $8::uuid[], $9::text[], $10::uuid[])
       AS l (n, account, amount, patient, charge, payment, payer, coverage)`,
    [
      id,
      input.currency,
      input.lines.map((_, i) => i + 1),
      input.lines.map((l) => l.account),
      input.lines.map((l) => String(l.amount.minor)),
      input.lines.map((l) => l.patientId),
      input.lines.map((l) => l.chargeId ?? null),
      input.lines.map((l) => l.paymentId ?? null),
      input.lines.map((l) => l.payerRef ?? null),
      input.lines.map((l) => l.coverageId ?? null),
    ],
  );
  return id;
}

export interface EntryRow extends Record<string, unknown> {
  id: string;
  kind: EntryKind;
  currency: string;
  charge_id: string | null;
  payment_id: string | null;
  reverses_entry_id: string | null;
  reversed_by: string | null;
  reason_code: string | null;
  service_date: string | null;
  external_ref: string | null;
  posted_by: string;
  posted_at: Date;
}

interface LineRow extends Record<string, unknown> {
  entry_id: string;
  line_no: number;
  account: LedgerAccount;
  amount: string;
  patient_id: string;
  charge_id: string | null;
  payment_id: string | null;
  payer_ref: string | null;
  coverage_id: string | null;
}

export const ENTRY_COLUMNS = `e.id, e.kind, e.currency, e.charge_id, e.payment_id, e.reverses_entry_id,
  (SELECT r.id FROM cuspatlas.billing_journal_entries r WHERE r.reverses_entry_id = e.id) AS reversed_by,
  e.reason_code, to_char(e.service_date, 'YYYY-MM-DD') AS service_date, e.external_ref, e.posted_by, e.posted_at`;

/** One entry of the current tenant; hidden, missing and malformed references are one 404. */
export async function loadEntry(tx: TenantTransaction, entryRef: string): Promise<EntryRow> {
  const { rows } = await tx.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM cuspatlas.billing_journal_entries e WHERE e.id = $1`,
    [entryRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

export async function loadLines(tx: TenantTransaction, entryIds: readonly string[]): Promise<LineRow[]> {
  if (entryIds.length === 0) return [];
  const { rows } = await tx.query<LineRow>(
    `SELECT entry_id, line_no, account, amount_minor::text AS amount, patient_id, charge_id, payment_id, payer_ref,
       coverage_id
     FROM cuspatlas.billing_journal_lines WHERE entry_id = ANY ($1::uuid[]) ORDER BY entry_id, line_no`,
    [[...entryIds]],
  );
  return rows;
}

export function toEntry(row: EntryRow, lines: readonly LineRow[]): JournalEntry {
  return {
    entryRef: row.id,
    kind: row.kind,
    currency: row.currency,
    chargeRef: row.charge_id,
    paymentRef: row.payment_id,
    reversesEntryRef: row.reverses_entry_id,
    reversedByEntryRef: row.reversed_by,
    reasonCode: row.reason_code,
    externalRef: row.external_ref,
    serviceDate: row.service_date,
    postedAt: row.posted_at.toISOString(),
    postedByRef: row.posted_by,
    lines: lines
      .filter((l) => l.entry_id === row.id)
      .map(
        (l): JournalLine => ({
          lineNo: l.line_no,
          account: l.account,
          amount: moneyFromMinorText(row.currency, l.amount),
          patientRef: l.patient_id,
          chargeRef: l.charge_id,
          paymentRef: l.payment_id,
          payerRef: l.payer_ref,
          coverageRef: l.coverage_id,
        }),
      ),
  };
}

/** The lines that exactly negate an entry: the only shape a reversal may take (checked again in SQL). */
export function negatedLines(lines: readonly LineRow[], currency: string): LineInput[] {
  return lines.map((l) => ({
    account: l.account,
    amount: moneyFromMinorText(currency, l.amount.startsWith('-') ? l.amount.slice(1) : `-${l.amount}`),
    patientId: l.patient_id,
    chargeId: l.charge_id,
    paymentId: l.payment_id,
    payerRef: l.payer_ref,
    coverageId: l.coverage_id,
  }));
}

/** Unreversed, non-reversal entries other than `except` that touch a charge or a payment. */
export async function dependentEntries(
  tx: TenantTransaction,
  except: string,
  o: { chargeId?: string | null; paymentId?: string | null },
): Promise<{ kind: string; ref: string }[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT DISTINCT e.id, e.posted_at FROM cuspatlas.billing_journal_entries e
     JOIN cuspatlas.billing_journal_lines l ON l.entry_id = e.id AND l.tenant_id = e.tenant_id
     WHERE e.id <> $1 AND e.reverses_entry_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM cuspatlas.billing_journal_entries r WHERE r.reverses_entry_id = e.id)
       AND (($2::uuid IS NOT NULL AND l.charge_id = $2::uuid) OR ($3::uuid IS NOT NULL AND l.payment_id = $3::uuid))
     ORDER BY e.posted_at, e.id LIMIT 20`,
    [except, o.chargeId ?? null, o.paymentId ?? null],
  );
  return rows.map((r) => ({ kind: 'journalEntry', ref: r.id }));
}

/** Throws the conflict a reversal must give when the original is already reversed or is a reversal. */
export function assertReversible(row: EntryRow): void {
  if (row.reverses_entry_id !== null) throw conflict('reversal_not_reversible');
  if (row.reversed_by !== null)
    throw conflict('already_reversed', [{ kind: 'journalEntry', ref: row.reversed_by }]);
}
