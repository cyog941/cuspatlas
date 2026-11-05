import {
  CLAIM_QUEUES,
  type ClaimQueueName,
  moneyFromMinorText,
  type TenantTransaction,
} from '@cuspatlas/contracts';

/**
 * B11 / OR-07 claim work queues and headline measures. Queues are PREDICATES over the B6/B7/B8
 * lifecycle (the derived claim state, the head version's validation, appeals and B8 escalations);
 * they never add a lifecycle state and never write. Definitions: docs/api/claims-queues.md.
 */

/** filing_deadline_soon window when the caller names none (OR-07 "configurable days"). */
export const DEFAULT_FILING_DEADLINE_DAYS = 30;
/**
 * Timely filing limit from the earliest date of service. PROPOSED synthetic default pending billing
 * review (no payer-specific limit is modelled yet).
 */
export const TIMELY_FILING_DAYS = 365;
/** Claims (and to_create charges) one queue read scans; beyond it counts become lower bounds. */
export const CLAIM_QUEUE_SCAN = 1000;
/** Age threshold of the claims_over_30_days measure. */
export const CLAIM_MEASURE_AGE_DAYS = 30;

/** Claim states in which the claim is not yet (known to be) with the payer, so filing can lapse. */
const NOT_WITH_PAYER = new Set([
  'prepared',
  'validated',
  'replaced',
  'submission_pending',
  'submission_unknown',
  'transport_rejected',
  'payer_rejected',
]);
const EXCEPTION_STATES = new Set(['transport_rejected', 'payer_rejected', 'denied', 'submission_unknown']);
const OPEN_APPEAL = new Set(['draft', 'sent', 'send_unknown']);

export interface ClaimFacts {
  readonly subject: 'claim' | 'charge';
  readonly claimRef: string | null;
  readonly chargeRef: string | null;
  readonly patientRef: string;
  readonly payerRef: string | null;
  /** Derived claim state (vocabulary `claim`); null for a to_create charge. */
  readonly state: string | null;
  readonly createdAt: Date;
  /** Earliest date of service (head version lines, or the charge's service date). */
  readonly earliestServiceDate: string | null;
  readonly headIssueCodes: readonly string[];
  readonly appealStates: readonly string[];
  /** Highest escalation level among the claim's open B8 workflow exceptions (0 = none). */
  readonly escalationLevel: number;
}

const DAY = 86_400_000;
const utcDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
/** Completed whole days in a non-negative millisecond span (integer arithmetic, no float rounding). */
const wholeDays = (ms: number) => (ms <= 0 ? 0 : (ms - (ms % DAY)) / DAY);

export function filingDeadlineOf(f: ClaimFacts): string | null {
  if (f.earliestServiceDate === null) return null;
  if (f.subject === 'claim' && !NOT_WITH_PAYER.has(f.state ?? '')) return null;
  return new Date(utcDay(f.earliestServiceDate) + TIMELY_FILING_DAYS * DAY).toISOString().slice(0, 10);
}

/** Whole days from `today` (a local date) to the deadline; negative when it has passed. */
export function daysToDeadline(deadline: string | null, today: string): number | null {
  // Both instants are UTC midnights, so the difference is an exact multiple of a day.
  return deadline === null ? null : (utcDay(deadline) - utcDay(today)) / DAY;
}

/**
 * Exception severity: 2 for an exception state (rejected, denied, unknown outcome), 1 when the head
 * version has validation issues, 0 otherwise; plus the highest open B8 escalation level.
 */
export function exceptionSeverityOf(f: ClaimFacts): number {
  const base = EXCEPTION_STATES.has(f.state ?? '') ? 2 : f.headIssueCodes.length > 0 ? 1 : 0;
  return base + f.escalationLevel;
}

/** Every queue whose predicate selects this subject (a claim or a to_create charge). */
export function queuesOf(f: ClaimFacts, today: string, windowDays: number): ClaimQueueName[] {
  const days = daysToDeadline(filingDeadlineOf(f), today);
  const soon = days !== null && days <= windowDays;
  if (f.subject === 'charge') return soon ? ['to_create', 'filing_deadline_soon'] : ['to_create'];
  const s = f.state ?? '';
  const q = new Set<ClaimQueueName>(['all']);
  if (s === 'validated') q.add('ready_to_submit');
  if ((s === 'prepared' || s === 'replaced') && f.headIssueCodes.some((c) => c.startsWith('attachment_')))
    q.add('attachments_needed');
  if (s === 'transmitted' || s === 'payer_acknowledged') q.add('awaiting_payer');
  if (s === 'transport_rejected') q.add('returned');
  if (s === 'payer_rejected' || s === 'denied') q.add('rejected_or_denied');
  if (f.appealStates.some((a) => OPEN_APPEAL.has(a))) q.add('appeals');
  if (soon) q.add('filing_deadline_soon');
  if (s === 'paid') q.add('paid_closed');
  return CLAIM_QUEUES.filter((n) => q.has(n));
}

export interface ClaimQueueItem {
  readonly subject: 'claim' | 'charge';
  readonly claimRef: string | null;
  readonly chargeRef: string | null;
  readonly patientRef: string;
  readonly payerRef: string | null;
  readonly state: string | null;
  readonly queues: ClaimQueueName[];
  readonly filingDeadline: string | null;
  readonly daysToDeadline: number | null;
  readonly exceptionSeverity: number;
  readonly createdAt: string;
  readonly ageDays: number;
}

export function queueItemOf(f: ClaimFacts, now: Date, today: string, windowDays: number): ClaimQueueItem {
  const deadline = filingDeadlineOf(f);
  return {
    subject: f.subject,
    claimRef: f.claimRef,
    chargeRef: f.chargeRef,
    patientRef: f.patientRef,
    payerRef: f.payerRef,
    state: f.state,
    queues: queuesOf(f, today, windowDays),
    filingDeadline: deadline,
    daysToDeadline: daysToDeadline(deadline, today),
    exceptionSeverity: exceptionSeverityOf(f),
    createdAt: f.createdAt.toISOString(),
    ageDays: wholeDays(now.getTime() - f.createdAt.getTime()),
  };
}

/**
 * OR-D3 work-priority order (one documented global order): deadline proximity (fewest days to the
 * filing deadline first; no deadline last), then exception severity (highest first), then age (oldest
 * first), then `claimRef` ascending as the tie-break (a to_create charge, which has no claim, uses its
 * chargeRef in that position).
 */
export function compareWorkPriority(a: ClaimQueueItem, b: ClaimQueueItem): number {
  const da = a.daysToDeadline ?? Number.POSITIVE_INFINITY;
  const db = b.daysToDeadline ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da < db ? -1 : 1;
  if (a.exceptionSeverity !== b.exceptionSeverity) return b.exceptionSeverity - a.exceptionSeverity;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  const ka = a.claimRef ?? a.chargeRef ?? '';
  const kb = b.claimRef ?? b.chargeRef ?? '';
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** to_create: posted clinical-procedure charges, not reversed or replaced, on no claim, with coverage. */
export async function chargesToCreate(tx: TenantTransaction): Promise<ClaimFacts[]> {
  const { rows } = await tx.query<{ id: string; patient_id: string; service_date: string; created_at: Date }>(
    `SELECT c.id, c.patient_id, to_char(c.service_date, 'YYYY-MM-DD') AS service_date, c.created_at
     FROM cuspatlas.billing_charges c
     WHERE c.source = 'clinical_procedure'
       AND NOT EXISTS (SELECT 1 FROM cuspatlas.billing_journal_entries r JOIN cuspatlas.billing_journal_entries e
         ON r.reverses_entry_id = e.id WHERE e.charge_id = c.id AND e.kind = 'charge')
       AND NOT EXISTS (SELECT 1 FROM cuspatlas.billing_charges n WHERE n.replaces_charge_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM cuspatlas.rcm_claim_lines l WHERE l.charge_id = c.id)
       AND EXISTS (SELECT 1 FROM cuspatlas.rcm_coverages v WHERE v.patient_id = c.patient_id)
     ORDER BY c.created_at, c.id LIMIT ${CLAIM_QUEUE_SCAN + 1}`,
  );
  return rows.map((r) => ({
    subject: 'charge',
    claimRef: null,
    chargeRef: r.id,
    patientRef: r.patient_id,
    payerRef: null,
    state: null,
    createdAt: r.created_at,
    earliestServiceDate: r.service_date,
    headIssueCodes: [],
    appealStates: [],
    escalationLevel: 0,
  }));
}

/** Highest escalation level of each claim's open (unresolved) B8 workflow exceptions. */
export async function escalationLevels(tx: TenantTransaction): Promise<Map<string, number>> {
  const { rows } = await tx.query<{ claim_id: string; level: number }>(
    `SELECT w.claim_id, max(ev.level)::int AS level FROM cuspatlas.rcm_claim_workflows w
     JOIN cuspatlas.rcm_claim_workflow_exceptions x ON x.workflow_id = w.id
     JOIN cuspatlas.rcm_claim_workflow_exception_events ev ON ev.exception_id = x.id AND ev.kind = 'escalated'
     WHERE NOT EXISTS (SELECT 1 FROM cuspatlas.rcm_claim_workflow_exception_events r
       WHERE r.exception_id = x.id AND r.kind = 'resolved')
     GROUP BY w.claim_id`,
  );
  return new Map(rows.map((r) => [r.claim_id, r.level]));
}

/** open_insurer_receivable: the insurer_receivable journal balance, in the tenant currency. */
export async function insurerReceivable(tx: TenantTransaction, currency: string) {
  const { rows } = await tx.query<{ minor: string }>(
    `SELECT coalesce(sum(amount_minor), 0)::text AS minor FROM cuspatlas.billing_journal_lines
     WHERE account = 'insurer_receivable' AND currency = $1`,
    [currency],
  );
  return moneyFromMinorText(currency, rows[0]?.minor ?? '0');
}

export const MEASURE_DEFINITIONS = {
  open_insurer_receivable: {
    definitionVersion: 'open_insurer_receivable.1',
    unit: 'money',
    definition:
      'Sum of every posted journal line on the insurer_receivable account (debits positive, credits negative) in the tenant currency as of the read instant: amounts transferred to insurers on claim transmission, less insurer payments, settlements and reversals. Reconciles to the journal by construction.',
  },
  claims_over_30_days: {
    definitionVersion: 'claims_over_30_days.1',
    unit: 'claims',
    definition:
      'Count of claims (head of each claim) whose state is not paid or replaced and that were created more than 30 days before the read instant.',
  },
  needs_action: {
    definitionVersion: 'needs_action.1',
    unit: 'claims',
    definition:
      'Count of distinct claims with at least one open claim work item (the CL-08 derivation behind rcm.claims.worklist) as of the read instant.',
  },
  open_appeals: {
    definitionVersion: 'open_appeals.1',
    unit: 'appeals',
    definition:
      'Count of appeals in state draft, sent or send_unknown (not rejected at review) as of the read instant.',
  },
} as const;
