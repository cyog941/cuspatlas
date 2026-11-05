import {
  type ActorContext,
  type Money,
  moneyFromMinorText,
  type TenantTransaction,
  validatePackageQuery,
} from '@cuspatlas/contracts';
import { postEntry } from '../billing/journal';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import {
  failed,
  loadPackage,
  MIGRATION_PACKAGE_RESOURCE,
  type MigrationBase,
  type PackageRow,
  validate,
} from './base';
import { type FinancialPlanner, type PlannedEntry, realDay, type StagedRecord } from './plan';

/**
 * M5: opening balances, unapplied credit and open items. A positive legacy balance becomes one
 * opening item and one `openingBalance` journal entry (opening receivable / opening equity); an
 * unapplied credit (a source payment, or a negative balance staff accepted as credit) keeps its own
 * item per source payment with its age basis (opening credit / opening equity). Open claims are
 * opening references only (no claim row, never submittable). No charge, payment or allocation is
 * created, so an opening figure can never be posted as a charge. Rules recommended-pending-approval.
 */
const INT = /^-?[0-9]{1,15}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The `migration_opening_items.amount_minor` cap: a larger figure is excluded, never a failed apply. */
const AMOUNT_CAP = 99_999_999_999n;
const NO_DAY = '1900-01-01';

/** Plans one financial row. `seen` is per plan: a second balance for one patient/currency/date is excluded. */
export function financialPlanner(): FinancialPlanner {
  return (s: StagedRecord, ctx) => {
    const p = s.payload;
    const amountField =
      s.entity === 'ledger_balances'
        ? 'balance_minor'
        : s.entity === 'unapplied_credits'
          ? 'amount_minor'
          : 'outstanding_minor';
    const raw = p[amountField] ?? '';
    if (!INT.test(raw) || (p.currency ?? '') !== ctx.currency)
      return { kind: 'excluded', code: 'validation_failed' };
    const n = BigInt(raw);
    if (n > AMOUNT_CAP || n < -AMOUNT_CAP) return { kind: 'excluded', code: 'validation_failed' };
    // A day-shaped date that is not a real calendar day would fail the `date` cast at apply.
    for (const f of ['as_of', 'received_on'])
      if (DAY.test(p[f] ?? '') && !realDay(p[f] as string))
        return { kind: 'excluded', code: 'validation_failed' };
    if (n === 0n) return { kind: 'excluded', code: 'zero_amount' };
    if (s.entity === 'open_claims') return { kind: 'action', action: 'openClaimReference' };
    if (s.entity === 'unapplied_credits')
      return n > 0n
        ? { kind: 'action', action: 'unappliedCredit' }
        : { kind: 'excluded', code: 'validation_failed' };
    if (n < 0n)
      return ctx.accepted
        ? { kind: 'action', action: 'unappliedCredit', accepted: true }
        : { kind: 'blocked', code: 'review_open' };
    // The key of the unique index (patient after link decisions, currency, as-of or its stand-in day).
    const day = DAY.test(p.as_of ?? '') ? (p.as_of as string) : NO_DAY;
    const linked = ctx.patient?.action === 'linkPatient' ? ctx.patient.linkPatient : undefined;
    const key = `${linked ? `pt:${linked}` : `src:${p.patient_id}`}|${p.currency}|${day}`;
    if (ctx.seen.has(key)) return { kind: 'excluded', code: 'duplicate_opening' };
    const posted = linked ? ctx.existing.get(`${linked}|${p.currency}|${day}`) : undefined;
    if (posted !== undefined && posted !== s.id) return { kind: 'excluded', code: 'duplicate_opening' };
    ctx.seen.add(key);
    return { kind: 'action', action: 'openingBalance' };
  };
}

/** Posts one opening fact in the apply transaction (the caller locked the package). */
export async function postOpening(
  tx: TenantTransaction,
  e: PlannedEntry,
  patientId: string,
  pkg: PackageRow,
): Promise<{
  targetKind: string;
  targetRef: string | null;
  detail: Record<string, unknown>;
  precision: string;
}> {
  const p = e.staged.payload;
  const kind =
    e.action === 'openingBalance'
      ? 'balance'
      : e.action === 'unappliedCredit'
        ? 'unappliedCredit'
        : 'openClaim';
  const raw = (p.balance_minor ?? p.amount_minor ?? p.outstanding_minor ?? '').replace('-', '');
  const asOf =
    kind === 'balance' && DAY.test(p.as_of ?? '')
      ? (p.as_of as string)
      : kind === 'unappliedCredit' && DAY.test(p.as_of ?? '')
        ? (p.as_of as string)
        : null;
  const ageBasis =
    kind === 'unappliedCredit' && DAY.test(p.received_on ?? '') ? (p.received_on as string) : null;
  const state =
    kind === 'openClaim' ? (/^[a-z_]{1,32}$/.test(p.state ?? '') ? (p.state as string) : 'unknown') : null;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.migration_opening_items (tenant_id, package_id, staged_record_id, kind, patient_id,
       guarantor_source_id, amount_minor, currency, as_of, as_of_precision, age_basis, claim_state, source_ref, created_by)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6::bigint, $7, $8::date, $9, $10::date, $11, $12,
       cuspatlas.current_actor_id())
     RETURNING id`,
    [
      pkg.id,
      e.staged.id,
      kind,
      patientId,
      /^[A-Za-z0-9._:/-]{1,64}$/.test(p.account_id ?? '') ? p.account_id : null,
      raw,
      p.currency,
      asOf,
      asOf ? 'day' : 'approximate',
      ageBasis,
      state,
      e.staged.source_id,
    ],
  );
  const itemId = rows[0]?.id as string;
  let entryRef: string | null = null;
  if (kind !== 'openClaim') {
    const amount = moneyFromMinorText(p.currency as string, raw);
    const neg = moneyFromMinorText(p.currency as string, `-${raw}`);
    entryRef = await postEntry(tx, {
      kind: 'openingBalance',
      currency: p.currency as string,
      reasonCode: kind === 'balance' ? 'migration_opening_balance' : 'migration_opening_credit',
      externalRef: `syn-mig-${e.staged.id}`,
      lines:
        kind === 'balance'
          ? [
              { account: 'opening_receivable', amount, patientId, openingItemId: itemId },
              { account: 'opening_equity', amount: neg, patientId, openingItemId: itemId },
            ]
          : [
              { account: 'opening_credit', amount: neg, patientId, openingItemId: itemId },
              { account: 'opening_equity', amount, patientId, openingItemId: itemId },
            ],
    });
  }
  return {
    targetKind: 'openingItem',
    targetRef: itemId,
    detail: {
      openingKind: kind,
      entryRef,
      asOfApproximate: asOf === null && kind === 'balance',
      acceptedProposal: e.accepted === true,
    },
    precision: asOf || ageBasis ? 'day' : 'unknown',
  };
}

interface Totals {
  balances: bigint;
  credits: bigint;
}

export function createOpeningOperations(base: MigrationBase) {
  const { deps } = base;
  return {
    /** Opening items of a package and the per-guarantor source vs imported totals. */
    listOpeningReconciliation(ctx: ActorContext, query: unknown) {
      const op = 'migration.openingItems.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<{ packageRef: string }>(validatePackageQuery, query);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const pkg = await loadPackage(tx, query.packageRef);
          const r = await openingReconciliation(tx, pkg);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: MIGRATION_PACKAGE_RESOURCE,
            resourceRefs: [pkg.id],
            queryFields: ['packageRef'],
          });
          return r;
        });
      });
    },
  };
}

export interface OpeningReconciliation {
  readonly currency: string;
  readonly items: readonly {
    openingRef: string;
    kind: string;
    patientRef: string;
    guarantorSourceId: string | null;
    amount: Money;
    asOf: string | null;
    asOfPrecision: string;
    ageBasis: string | null;
    claimState: string | null;
    sourceRef: string;
    entryRef: string | null;
  }[];
  readonly byGuarantor: readonly {
    guarantorSourceId: string;
    sourceBalance: Money;
    importedBalance: Money;
    balanceDifference: Money;
    sourceCredit: Money;
    importedCredit: Money;
    creditDifference: Money;
  }[];
  readonly totals: {
    sourceBalance: Money;
    importedBalance: Money;
    sourceCredit: Money;
    importedCredit: Money;
    difference: Money;
  };
}

/** Source figures come from the staged rows; imported figures from the posted journal lines. */
export async function openingReconciliation(
  tx: TenantTransaction,
  pkg: PackageRow,
): Promise<OpeningReconciliation> {
  const { rows: settings } = await tx.query<{ currency: string }>(
    'SELECT currency FROM cuspatlas.billing_settings',
  );
  const currency = settings[0]?.currency ?? 'USD';
  const { rows: items } = await tx.query<{
    id: string;
    kind: string;
    patient_id: string;
    guarantor_source_id: string | null;
    amount: string;
    currency: string;
    as_of: string | null;
    as_of_precision: string;
    age_basis: string | null;
    claim_state: string | null;
    source_ref: string;
    entry_id: string | null;
    posted: string | null;
  }>(
    `SELECT i.id, i.kind, i.patient_id, i.guarantor_source_id, i.amount_minor::text AS amount, i.currency,
       to_char(i.as_of, 'YYYY-MM-DD') AS as_of, i.as_of_precision, to_char(i.age_basis, 'YYYY-MM-DD') AS age_basis,
       i.claim_state, i.source_ref,
       (SELECT l.entry_id FROM cuspatlas.billing_journal_lines l WHERE l.opening_item_id = i.id LIMIT 1) AS entry_id,
       (SELECT sum(l.amount_minor)::text FROM cuspatlas.billing_journal_lines l
          WHERE l.opening_item_id = i.id AND l.account IN ('opening_receivable', 'opening_credit')
            AND EXISTS (SELECT 1 FROM cuspatlas.billing_journal_entries e
              WHERE e.id = l.entry_id AND e.tenant_id = l.tenant_id AND e.kind = 'openingBalance')) AS posted
     FROM cuspatlas.migration_opening_items i WHERE i.package_id = $1 ORDER BY i.source_ref, i.id`,
    [pkg.id],
  );
  const { rows: staged } = await tx.query<{ entity: string; payload: Record<string, string> }>(
    `SELECT entity, payload FROM cuspatlas.migration_staged_records
     WHERE package_id = $1 AND entity IN ('ledger_balances', 'unapplied_credits') AND issue_code IS NULL`,
    [pkg.id],
  );
  const by = new Map<string, { source: Totals; imported: Totals }>();
  const g = (k: string | null | undefined) => {
    const key = k && k !== '' ? k : '(none)';
    const v = by.get(key) ?? {
      source: { balances: 0n, credits: 0n },
      imported: { balances: 0n, credits: 0n },
    };
    by.set(key, v);
    return v;
  };
  for (const s of staged) {
    const raw = s.entity === 'ledger_balances' ? s.payload.balance_minor : s.payload.amount_minor;
    if (!raw || !INT.test(raw) || s.payload.currency !== currency) continue;
    const n = BigInt(raw);
    const t = g(s.payload.account_id).source;
    if (s.entity === 'unapplied_credits' || n < 0n) t.credits += n < 0n ? -n : n;
    else t.balances += n;
  }
  for (const i of items) {
    if (i.posted === null) continue;
    const n = BigInt(i.posted);
    const t = g(i.guarantor_source_id).imported;
    if (n < 0n) t.credits += -n;
    else t.balances += n;
  }
  const m = (v: bigint) => moneyFromMinorText(currency, v.toString());
  let sb = 0n;
  let ib = 0n;
  let sc = 0n;
  let ic = 0n;
  const byGuarantor = [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => {
      sb += v.source.balances;
      ib += v.imported.balances;
      sc += v.source.credits;
      ic += v.imported.credits;
      return {
        guarantorSourceId: k,
        sourceBalance: m(v.source.balances),
        importedBalance: m(v.imported.balances),
        balanceDifference: m(v.source.balances - v.imported.balances),
        sourceCredit: m(v.source.credits),
        importedCredit: m(v.imported.credits),
        creditDifference: m(v.source.credits - v.imported.credits),
      };
    });
  if (items.some((i) => i.currency !== currency)) throw failed('currency_mismatch');
  return {
    currency,
    items: items.map((i) => ({
      openingRef: i.id,
      kind: i.kind,
      patientRef: i.patient_id,
      guarantorSourceId: i.guarantor_source_id,
      amount: moneyFromMinorText(i.currency, i.amount),
      asOf: i.as_of,
      asOfPrecision: i.as_of_precision,
      ageBasis: i.age_basis,
      claimState: i.claim_state,
      sourceRef: i.source_ref,
      entryRef: i.entry_id,
    })),
    byGuarantor,
    totals: {
      sourceBalance: m(sb),
      importedBalance: m(ib),
      sourceCredit: m(sc),
      importedCredit: m(ic),
      difference: m(sb - ib - (sc - ic)),
    },
  };
}
