import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  type EntryKind,
  moneyFromMinorText,
  type StatementAccount,
  type StatementCommandData,
  type StatementGenerate,
  type StatementLine,
  type StatementStaleReason,
  type StatementView,
  type TenantTransaction,
  validateStatementGenerate,
} from '@cuspatlas/contracts';
import { canonicalJson, sha256Hex } from '../commands/digest';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import {
  assertNotMerged,
  assertRef,
  type BillingBase,
  checkEnvelope,
  conflict,
  failed,
  loadPatient,
  loadSettings,
  mergeSet,
  notFound,
  validate,
} from './base';

export const STATEMENT_RESOURCE = 'billingStatement';
/** Upper bound of snapshot lines in one statement (synthetic default, pending approval). */
export const MAX_STATEMENT_LINES = 2000;
/**
 * The patient-facing accounts a statement states: receivable less unapplied credit, migrated opening
 * receivable and opening credit included (H2 M-10).
 */
const PATIENT_FACING = ['patient_receivable', 'unapplied_credit', 'opening_receivable', 'opening_credit'];

interface Snapshot extends Record<string, unknown> {
  readonly basis: 'posted_through_cutoff';
  readonly cutoffAt: string;
  readonly currency: string;
  readonly guarantorRef: string;
  readonly accounts: StatementAccount[];
  readonly total: { currency: string; minor: number };
}

/**
 * The accounts a guarantor statement covers (ADR 0008, pending approval): every patient whose current
 * S5 guarantor is this guarantor, plus the guarantor's own account unless someone else guarantees it.
 * Each identity expands to its merge set, grouped by the surviving root.
 */
async function coveredAccounts(tx: TenantTransaction, guarantorId: string): Promise<Map<string, string[]>> {
  const active = `kind = 'guarantor' AND revoked_at IS NULL AND effective_from <= now()
    AND (effective_until IS NULL OR effective_until > now())`;
  const { rows: dependents } = await tx.query<{ id: string }>(
    `SELECT DISTINCT subject_patient_id AS id FROM cuspatlas.patient_relationships
     WHERE counterparty_patient_id = $1 AND ${active} ORDER BY 1`,
    [guarantorId],
  );
  const { rows: own } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM cuspatlas.patient_relationships WHERE subject_patient_id = $1 AND ${active}`,
    [guarantorId],
  );
  const ids = dependents.map((d) => d.id);
  if ((own[0]?.n ?? 0) === 0) ids.unshift(guarantorId);
  const accounts = new Map<string, string[]>();
  for (const id of ids) {
    const set = await mergeSet(tx, id);
    accounts.set(set.root, set.ids);
  }
  return accounts;
}

const allIds = (accounts: Map<string, string[]>) => [...new Set([...accounts.values()].flat())].sort();

/** The snapshot of the covered accounts from the journal at the cutoff (millisecond precision). */
async function takeSnapshot(
  tx: TenantTransaction,
  guarantorId: string,
  cutoffAt: string,
  currency: string,
  accounts: Map<string, string[]>,
): Promise<Snapshot> {
  const rootOf = new Map<string, string>();
  for (const [root, ids] of accounts) for (const id of ids) rootOf.set(id, root);
  const { rows } = await tx.query<{
    id: string;
    kind: EntryKind;
    posted_at: Date;
    service_date: string | null;
    charge_id: string | null;
    payment_id: string | null;
    patient_id: string;
    s: string;
  }>(
    `SELECT e.id, e.kind, e.posted_at, to_char(e.service_date, 'YYYY-MM-DD') AS service_date, e.charge_id,
       e.payment_id, l.patient_id, sum(l.amount_minor)::text AS s
     FROM cuspatlas.billing_journal_lines l
     JOIN cuspatlas.billing_journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
     WHERE l.patient_id = ANY ($1::uuid[]) AND l.account = ANY ($2::text[]) AND l.currency = $3
       AND date_trunc('milliseconds', e.posted_at) <= $4::timestamptz
     GROUP BY e.id, e.kind, e.posted_at, e.service_date, e.charge_id, e.payment_id, l.patient_id
     ORDER BY e.posted_at, e.id, l.patient_id`,
    [allIds(accounts), PATIENT_FACING, currency, cutoffAt],
  );
  const perAccount = new Map<string, Map<string, { row: (typeof rows)[number]; sum: bigint }>>();
  for (const r of rows) {
    const root = rootOf.get(r.patient_id) as string;
    const entries = perAccount.get(root) ?? new Map();
    const cur = entries.get(r.id) ?? { row: r, sum: 0n };
    cur.sum += BigInt(r.s);
    entries.set(r.id, cur);
    perAccount.set(root, entries);
  }
  let total = 0n;
  let lineCount = 0;
  const out: StatementAccount[] = [...accounts.keys()].sort().map((root) => {
    let accountTotal = 0n;
    const lines: StatementLine[] = [];
    for (const { row, sum } of (perAccount.get(root) ?? new Map()).values()) {
      if (sum === 0n) continue;
      accountTotal += sum;
      lines.push({
        entryRef: row.id,
        kind: row.kind,
        postedAt: row.posted_at.toISOString(),
        serviceDate: row.service_date,
        chargeRef: row.charge_id,
        paymentRef: row.payment_id,
        amount: moneyFromMinorText(currency, sum.toString()),
      });
    }
    total += accountTotal;
    lineCount += lines.length;
    return {
      accountPatientRef: root,
      coveredPatientRefs: [...(accounts.get(root) ?? [])].sort(),
      total: moneyFromMinorText(currency, accountTotal.toString()),
      lines,
    };
  });
  if (lineCount > MAX_STATEMENT_LINES) throw failed('statement_too_large');
  return {
    basis: 'posted_through_cutoff',
    cutoffAt,
    currency,
    guarantorRef: guarantorId,
    accounts: out,
    total: moneyFromMinorText(currency, total.toString()),
  };
}

interface StatementRow extends Record<string, unknown> {
  id: string;
  guarantor_id: string;
  statement_version: number;
  cutoff_at: Date;
  basis: 'posted_through_cutoff';
  currency: string;
  total: string;
  total_class: 'due' | 'zero' | 'credit';
  covered_patient_ids: string[];
  snapshot: Snapshot;
  snapshot_digest: string;
  supersedes_id: string | null;
  superseded_by: string | null;
  created_by: string;
  created_at: Date;
  checked_at: Date;
}

/**
 * B4 statements (ADR 0008, recommended-pending-billing-approval). Generation is one audited command
 * that stores a canonical snapshot and its digest; the row is never updated. Freshness is derived on
 * every read by comparing the snapshot with the journal now; a regeneration is a new version that
 * names the one it supersedes. Delivery (and any consent or suppression decision) belongs to E7: the
 * record carries channel `none`.
 */
export function createStatementOperations(
  base: BillingBase,
  /** Charges whose patient responsibility a secondary coverage may still owe (the rcm domain's read, injected). */
  pendingSecondary: (
    tx: TenantTransaction,
    patientIds: readonly string[],
  ) => Promise<readonly { readonly chargeId: string }[]> = async () => [],
) {
  const { deps, execute } = base;
  return {
    generateStatement(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<StatementCommandData>> {
      const op = 'billing.statements.generate';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<StatementGenerate>(validateStatementGenerate, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const guarantor = await loadPatient(tx, p.guarantorRef);
          // One generation per guarantor at a time (row lock; a second generation waits, then sees the
          // version the first committed): versions form a single chain.
          await tx.query('SELECT id FROM cuspatlas.patients WHERE id = $1 FOR NO KEY UPDATE', [guarantor.id]);
          return execute<StatementCommandData>(ctx, envelope, tx, async () => {
            const { rows: when } = await tx.query<{ future: boolean; cutoff: Date }>(
              `SELECT ($1::timestamptz > now()) AS future, date_trunc('milliseconds', $1::timestamptz) AS cutoff`,
              [p.cutoffAt],
            );
            if (when[0]?.future === true) throw failed('cutoff_in_future');
            assertNotMerged(guarantor);
            const settings = await loadSettings(tx);
            const accounts = await coveredAccounts(tx, guarantor.id);
            if (accounts.size === 0) throw failed('guarantor_unresolved');
            // CL-11: patient responsibility that a late-recorded secondary coverage may owe is not yet the
            // patient's to be billed; a statement is refused until the secondary claim resolves it.
            const waiting = await pendingSecondary(tx, allIds(accounts));
            if (waiting.length > 0)
              throw conflict(
                'secondary_claim_pending',
                waiting.slice(0, 20).map((x) => ({ kind: 'charge', ref: x.chargeId })),
              );
            const cutoffAt = (when[0] as { cutoff: Date }).cutoff.toISOString();
            const snapshot = await takeSnapshot(tx, guarantor.id, cutoffAt, settings.currency, accounts);
            const digest = sha256Hex(canonicalJson(snapshot));
            const { rows: prev } = await tx.query<{ id: string; statement_version: number }>(
              `SELECT id, statement_version FROM cuspatlas.billing_statements WHERE guarantor_id = $1
               ORDER BY statement_version DESC LIMIT 1`,
              [guarantor.id],
            );
            const version = (prev[0]?.statement_version ?? 0) + 1;
            const supersedes = prev[0]?.id ?? null;
            const t = BigInt(snapshot.total.minor);
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.billing_statements (tenant_id, guarantor_id, statement_version, cutoff_at, basis,
                 currency, snapshot_total_minor, total_class, covered_patient_ids, snapshot, snapshot_digest, line_count,
                 supersedes_id, created_by, correlation_id)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9::jsonb, $10, $11, $12,
                 cuspatlas.current_actor_id(), $13)
               RETURNING id`,
              [
                guarantor.id,
                version,
                cutoffAt,
                p.basis,
                settings.currency,
                t.toString(),
                t > 0n ? 'due' : t < 0n ? 'credit' : 'zero',
                allIds(accounts),
                canonicalJson(snapshot),
                digest,
                snapshot.accounts.reduce((n, a) => n + a.lines.length, 0),
                supersedes,
                ctx.correlationId,
              ],
            );
            const statementRef = rows[0]?.id as string;
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: STATEMENT_RESOURCE,
                resourceRef: statementRef,
                resourceVersion: 1,
              },
              { changedFields: ['statement'] },
            );
            return {
              data: {
                statementRef,
                statementVersion: version,
                snapshotDigest: digest,
                supersedesStatementRef: supersedes,
              },
              version: 1,
            };
          });
        });
      });
    },

    /** The stored snapshot with its digest check and the freshness derived now (deriveStatementFreshness). */
    getStatement(ctx: ActorContext, statementRef: string): Promise<StatementView> {
      const op = 'billing.statements.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertRef(statementRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<StatementRow>(
            `SELECT s.id, s.guarantor_id, s.statement_version, s.cutoff_at, s.basis, s.currency,
               s.snapshot_total_minor::text AS total, s.total_class, s.covered_patient_ids, s.snapshot, s.snapshot_digest,
               s.supersedes_id, s.created_by, s.created_at, now() AS checked_at,
               (SELECT n.id FROM cuspatlas.billing_statements n WHERE n.supersedes_id = s.id) AS superseded_by
             FROM cuspatlas.billing_statements s WHERE s.id = $1`,
            [statementRef],
          );
          const row = rows[0];
          if (!row) throw notFound();
          const m = (v: string | bigint) => moneyFromMinorText(row.currency, String(v));
          const ids = [...row.covered_patient_ids].sort();
          const { rows: after } = await tx.query<{
            n: number;
            current: string;
            pre: string;
            last: Date | null;
          }>(
            `WITH effects AS (
               SELECT e.id, e.posted_at, sum(l.amount_minor) AS s,
                 date_trunc('milliseconds', e.posted_at) > $3::timestamptz AS late
               FROM cuspatlas.billing_journal_lines l
               JOIN cuspatlas.billing_journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
               WHERE l.patient_id = ANY ($1::uuid[]) AND l.account = ANY ($2::text[]) AND l.currency = $4
               GROUP BY e.id, e.posted_at, l.patient_id)
             SELECT count(DISTINCT id) FILTER (WHERE late AND s <> 0)::int AS n,
               coalesce(sum(s), 0)::text AS current, coalesce(sum(s) FILTER (WHERE NOT late), 0)::text AS pre,
               max(posted_at) AS last FROM effects`,
            [ids, PATIENT_FACING, row.cutoff_at.toISOString(), row.currency],
          );
          const accountsNow = await coveredAccounts(tx, row.guarantor_id);
          const reasons: StatementStaleReason[] = [];
          const lateCount = after[0]?.n ?? 0;
          if (lateCount > 0) reasons.push('posted_after_cutoff');
          // Review S1: an entry posted before the cutoff but committed after the snapshot (a late
          // commit) changes the pre-cutoff total without being "posted after" it.
          if (BigInt(after[0]?.pre ?? '0') !== BigInt(row.total)) reasons.push('pre_cutoff_changed');
          if (allIds(accountsNow).join(',') !== ids.join(',')) reasons.push('account_membership_changed');
          if (row.superseded_by !== null) reasons.push('superseded');
          const total = BigInt(row.total);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: STATEMENT_RESOURCE,
            resourceRefs: [row.id],
            queryFields: [],
          });
          return {
            statementRef: row.id,
            guarantorRef: row.guarantor_id,
            statementVersion: row.statement_version,
            cutoffAt: row.cutoff_at.toISOString(),
            basis: row.basis,
            currency: row.currency,
            total: m(total),
            amountDue: m(total > 0n ? total : 0n),
            creditBalance: m(total < 0n ? -total : 0n),
            totalClass: row.total_class,
            coveredPatientRefs: ids,
            accounts: row.snapshot.accounts,
            snapshotDigest: row.snapshot_digest,
            integrity:
              sha256Hex(canonicalJson(row.snapshot)) === row.snapshot_digest ? 'verified' : 'mismatch',
            supersedesStatementRef: row.supersedes_id,
            supersededByStatementRef: row.superseded_by,
            generatedAt: row.created_at.toISOString(),
            generatedByRef: row.created_by,
            delivery: { channel: 'none', state: 'not_requested', owner: 'E7' },
            freshness: {
              state: reasons.length === 0 ? 'fresh' : 'stale',
              reasons,
              currentTotal: m(after[0]?.current ?? '0'),
              postedAfterCutoff: lateCount,
              lastPostedAt: after[0]?.last ? after[0].last.toISOString() : null,
              checkedAt: row.checked_at.toISOString(),
            },
          };
        });
      });
    },
  };
}
