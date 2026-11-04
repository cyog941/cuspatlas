import {
  type ActorContext,
  type BillingWorkItem,
  type BillingWorklist,
  type BillingWorklistKind,
  type BillingWorklistQuery,
  moneyFromMinorText,
  validateBillingWorklistQuery,
} from '@cuspatlas/contracts';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { type BillingBase, loadSettings, validate } from './base';

/** Hours until an unknown provider outcome is due for reconciliation (pending billing approval). */
export const UNKNOWN_OUTCOME_DUE_HOURS = 24;
const DEFAULT_LIMIT = 50;

interface ItemRow extends Record<string, unknown> {
  kind: BillingWorklistKind;
  subject_id: string;
  patient_id: string;
  amount: string;
  currency: string;
  age_basis: Date;
  due_at: Date;
  overdue: boolean;
}

/**
 * The exception-first billing worklist (B2, B-D4): undistributed (unapplied) funds per payment and
 * holder, and unknown provider outcomes awaiting reconciliation. Every item is derived from the
 * journal and the attempts at read time (never a stored balance) and carries owner, queue, reason,
 * age basis, due time and the suggested next action. A bounded page states its total and whether it
 * was truncated; partial is never presented as complete.
 */
export function createWorklistOperations(base: BillingBase) {
  const { deps } = base;
  return {
    listWorklist(ctx: ActorContext, query: unknown): Promise<BillingWorklist> {
      const op = 'billing.worklist.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<BillingWorklistQuery>(validateBillingWorklistQuery, query);
        const limit = query.limit === undefined ? DEFAULT_LIMIT : Number.parseInt(query.limit, 10);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const settings = await loadSettings(tx);
          const items = `
            SELECT 'unapplied_funds'::text AS kind, l.payment_id AS subject_id, l.patient_id,
              (-sum(l.amount_minor))::text AS amount, p.currency, p.received_at AS age_basis,
              p.received_at + make_interval(days => $2) AS due_at
            FROM cuspatlas.billing_journal_lines l
            JOIN cuspatlas.billing_payments p ON p.id = l.payment_id AND p.tenant_id = l.tenant_id
            WHERE l.account = 'unapplied_credit' AND ($1::text IS NULL OR $1::text = 'unapplied_funds')
            GROUP BY l.payment_id, l.patient_id, p.currency, p.received_at
            HAVING sum(l.amount_minor) < 0
            UNION ALL
            SELECT 'unknown_payment_outcome'::text, a.id, a.patient_id, a.amount_minor::text, a.currency, a.created_at,
              a.created_at + make_interval(hours => $3)
            FROM cuspatlas.billing_payment_attempts a
            WHERE a.outcome IN ('unknown', 'pending') AND a.resolution IS NULL
              AND ($1::text IS NULL OR $1::text = 'unknown_payment_outcome')`;
          const params = [query.kind ?? null, settings.escalationDays, UNKNOWN_OUTCOME_DUE_HOURS];
          const { rows } = await tx.query<ItemRow>(
            `SELECT i.*, (i.due_at < now()) AS overdue FROM (${items}) i
             ORDER BY i.due_at, i.subject_id, i.patient_id LIMIT $4`,
            [...params, limit],
          );
          const { rows: totals } = await tx.query<{ n: number; at: Date }>(
            `SELECT count(*)::int AS n, now() AS at FROM (${items}) i`,
            params,
          );
          const data: BillingWorkItem[] = rows.map((r) => ({
            kind: r.kind,
            subjectRef: r.subject_id,
            patientRef: r.patient_id,
            amount: moneyFromMinorText(r.currency, r.amount),
            ageBasis: r.age_basis.toISOString(),
            owner: 'practice',
            queue: 'billing',
            reasonCode: r.kind === 'unapplied_funds' ? 'unapplied_funds' : 'provider_outcome_unknown',
            dueAt: r.due_at.toISOString(),
            overdue: r.overdue,
            suggestedAction: r.kind === 'unapplied_funds' ? 'allocate_or_refund' : 'reconcile_attempt',
          }));
          const total = totals[0]?.n ?? 0;
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'patient',
            resourceRefs: [...new Set(data.map((d) => d.patientRef))].slice(0, 100),
            queryFields: Object.keys(query as object).filter((k) => k === 'kind' || k === 'limit'),
          });
          return {
            data,
            totalCount: total,
            truncated: total > data.length,
            checkedAt: (totals[0]?.at ?? new Date()).toISOString(),
          };
        });
      });
    },
  };
}
