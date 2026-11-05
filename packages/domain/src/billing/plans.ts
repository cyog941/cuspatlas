import {
  type ActorContext,
  type CommandEnvelope,
  type CommandResult,
  type Money,
  money,
  moneyFromMinorText,
  type PaymentPlanView,
  type PlanAmend,
  type PlanAttemptOutcome,
  type PlanAttemptView,
  type PlanAuthorize,
  type PlanAutopay,
  type PlanClose,
  type PlanCollect,
  type PlanCollectData,
  type PlanCommandData,
  type PlanCreate,
  type PlanEventKind,
  type PlanEventView,
  type PlanInstallment,
  type PlanWorkItem,
  type PlanWorklist,
  type PlanWorklistQuery,
  RefusalError,
  splitEvenly,
  subtractMoney,
  type TenantTransaction,
  validatePlanAmend,
  validatePlanAuthorize,
  validatePlanAutopay,
  validatePlanClose,
  validatePlanCollect,
  validatePlanCreate,
  validatePlanWorklistQuery,
} from '@cuspatlas/contracts';
import { sha256Hex } from '../commands/digest';
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
  mergeSet,
  notFound,
  validate,
} from './base';
import { createSyntheticPaymentProvider, type PaymentProviderPort } from './payment-port';
import {
  assertGuarantor,
  callProvider,
  committedReplay,
  finalizeAttempt,
  insertPayment,
  insertPendingAttempt,
  providerTiming,
} from './payments';

export const PLAN_RESOURCE = 'billingPaymentPlan';
/** Days before the card's expiry month ends at which the card counts as expiring (pending approval). */
export const CARD_EXPIRING_DAYS = 30;
/** Days after a declined attempt at which the failed-auto-pay item is due (pending approval). */
export const FAILED_AUTOPAY_DUE_DAYS = 2;
const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 50;

interface PlanRow extends Record<string, unknown> {
  id: string;
  patient_id: string;
  guarantor_id: string | null;
  currency: string;
  time_zone: string;
  version: number;
  today: string;
  as_of: Date;
}

async function loadPlan(
  tx: TenantTransaction,
  planRef: string,
  lock: '' | 'FOR UPDATE' = '',
): Promise<PlanRow> {
  assertRef(planRef);
  const { rows } = await tx.query<PlanRow>(
    `SELECT id, patient_id, guarantor_id, currency, time_zone, version,
       to_char((now() AT TIME ZONE time_zone)::date, 'YYYY-MM-DD') AS today, now() AS as_of
     FROM cuspatlas.billing_payment_plans WHERE id = $1 ${lock}`,
    [planRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

interface Computed {
  readonly view: PaymentPlanView;
  /** Effective outcome of the latest attempt of the current terms, with its period. */
  readonly latest: (PlanAttemptView & { periodPaid: boolean }) | null;
  readonly inFlight: PlanAttemptView | null;
  readonly authorized: boolean;
  readonly paused: boolean;
}

const plusDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The last calendar day of a YYYY-MM card expiry month. */
function expiryLastDay(cardExpiry: string): string {
  const [y, m] = cardExpiry.split('-').map((s) => Number.parseInt(s, 10)) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Derives the whole plan view at read time (B3): the schedule of the current terms, collection from
 * the journal's payments of the plan's attempts (reversed payments do not count), and every state.
 * Nothing here is stored.
 */
async function computePlan(tx: TenantTransaction, row: PlanRow): Promise<Computed> {
  const m = (s: string | bigint) => moneyFromMinorText(row.currency, String(s));
  const { rows: termRows } = await tx.query<{
    terms_version: number;
    total: string;
    installment_count: number;
    first_due_on: string;
    basis: string;
    reason_code: string | null;
    created_at: Date;
  }>(
    `SELECT terms_version, contract_total_minor::text AS total, installment_count,
       to_char(first_due_on, 'YYYY-MM-DD') AS first_due_on, collected_basis_minor::text AS basis, reason_code, created_at
     FROM cuspatlas.billing_payment_plan_terms WHERE plan_id = $1 ORDER BY terms_version`,
    [row.id],
  );
  const current = termRows[termRows.length - 1];
  if (!current) throw new Error('plan without terms');
  const { rows: dates } = await tx.query<{ n: number; due_on: string }>(
    `SELECT n, to_char(($1::date + make_interval(months => n - 1))::date, 'YYYY-MM-DD') AS due_on
     FROM generate_series(1, $2::int) n ORDER BY n`,
    [current.first_due_on, current.installment_count],
  );
  const amounts = splitEvenly(m(BigInt(current.total) - BigInt(current.basis)), current.installment_count);
  const { rows: eventRows } = await tx.query<{
    id: string;
    kind: PlanEventKind;
    terms_version: number;
    authorization_ref: string | null;
    evidence_ref: string | null;
    instrument_ref: string | null;
    card_expiry: string | null;
    reason_code: string | null;
    created_by: string;
    created_at: Date;
  }>(
    `SELECT id, kind, terms_version, authorization_ref, evidence_ref, instrument_ref, card_expiry, reason_code,
       created_by, created_at
     FROM cuspatlas.billing_payment_plan_events WHERE plan_id = $1 ORDER BY created_at, id LIMIT 500`,
    [row.id],
  );
  const { rows: attemptRows } = await tx.query<{
    id: string;
    terms_version: number;
    period_no: number;
    attempt_no: number;
    outcome: PlanAttemptOutcome | 'submitted';
    block_reason: 'card_expired' | null;
    amount: string;
    payment_attempt_id: string | null;
    created_at: Date;
    provider_outcome: 'pending' | 'confirmed' | 'declined' | 'unknown' | null;
    resolution: 'captured' | 'not_captured' | null;
    payment_id: string | null;
    counted: boolean;
  }>(
    `SELECT pa.id, pa.terms_version, pa.period_no, pa.attempt_no, pa.outcome, pa.block_reason,
       pa.amount_minor::text AS amount, pa.payment_attempt_id, pa.created_at, a.outcome AS provider_outcome,
       a.resolution, pay.id AS payment_id,
       (pay.id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM cuspatlas.billing_journal_entries r
          JOIN cuspatlas.billing_journal_entries e ON r.reverses_entry_id = e.id
          WHERE e.payment_id = pay.id AND e.kind = 'patientPayment')) AS counted
     FROM cuspatlas.billing_payment_plan_attempts pa
     LEFT JOIN cuspatlas.billing_payment_attempts a ON a.id = pa.payment_attempt_id AND a.tenant_id = pa.tenant_id
     LEFT JOIN cuspatlas.billing_payments pay ON pay.attempt_id = pa.payment_attempt_id AND pay.tenant_id = pa.tenant_id
     WHERE pa.plan_id = $1 ORDER BY pa.created_at, pa.terms_version, pa.period_no, pa.attempt_no LIMIT 500`,
    [row.id],
  );
  const attempts: (PlanAttemptView & { counted: bigint })[] = attemptRows.map((a) => {
    // A provider attempt's outcome lives on the B2 attempt: pending (a lost finalize) reads as unknown,
    // and a reconciled unknown reads as its resolution.
    const provider = a.provider_outcome ?? a.outcome;
    const outcome: PlanAttemptOutcome =
      a.outcome === 'blocked'
        ? 'blocked'
        : a.resolution !== null
          ? a.resolution === 'captured'
            ? 'confirmed'
            : 'declined'
          : provider === 'pending' || provider === 'submitted'
            ? 'unknown'
            : (provider as PlanAttemptOutcome);
    return {
      planAttemptRef: a.id,
      termsVersion: a.terms_version,
      periodNo: a.period_no,
      attemptNo: a.attempt_no,
      outcome,
      blockReason: a.block_reason,
      amount: m(a.amount),
      attemptRef: a.payment_attempt_id,
      paymentRef: a.payment_id,
      attemptedAt: a.created_at.toISOString(),
      counted: a.counted ? BigInt(a.amount) : 0n,
    };
  });
  const collectedTotal = attempts.reduce((s, a) => s + a.counted, 0n);
  const today = row.today;
  let overdue = 0n;
  let overdueSince: string | null = null;
  let nextDueOn: string | null = null;
  const installments: PlanInstallment[] = dates.map((d, i) => {
    const amount = amounts[i] as Money;
    const got = attempts
      .filter((a) => a.termsVersion === current.terms_version && a.periodNo === d.n)
      .reduce((s, a) => s + a.counted, 0n);
    const remaining = BigInt(amount.minor) - got;
    if (remaining > 0n && nextDueOn === null) nextDueOn = d.due_on;
    if (remaining > 0n && d.due_on < today) {
      overdue += remaining;
      overdueSince ??= d.due_on;
    }
    const state: PlanInstallment['state'] =
      remaining <= 0n
        ? 'paid'
        : got > 0n
          ? 'partially_paid'
          : d.due_on < today
            ? 'overdue'
            : d.due_on === today
              ? 'due'
              : 'scheduled';
    return { periodNo: d.n, dueOn: d.due_on, amount, collected: m(got), state };
  });
  const events: PlanEventView[] = eventRows.map((e) => ({
    eventRef: e.id,
    kind: e.kind,
    termsVersion: e.terms_version,
    authorizationRef: e.authorization_ref,
    evidenceRef: e.evidence_ref,
    instrumentRef: e.instrument_ref,
    cardExpiry: e.card_expiry,
    reasonCode: e.reason_code,
    actorRef: e.created_by,
    recordedAt: e.created_at.toISOString(),
  }));
  const closing = events.find((e) => e.kind === 'voided' || e.kind === 'defaulted');
  const authorized = events.some((e) => e.kind === 'authorized' && e.termsVersion === current.terms_version);
  const enrolled = [...events].reverse().find((e) => e.kind === 'autopay_enrolled');
  const switches = events.filter((e) => e.kind.startsWith('autopay_'));
  const paused = switches[switches.length - 1]?.kind === 'autopay_paused';
  const contractTotal = m(current.total);
  const collected = m(collectedTotal);
  const balance = subtractMoney(contractTotal, collected);
  const inFlight = attempts.find((a) => a.outcome === 'unknown') ?? null;
  const currentAttempts = attempts.filter((a) => a.termsVersion === current.terms_version);
  const last = currentAttempts[currentAttempts.length - 1];
  const latest = last ? { ...last, periodPaid: installments[last.periodNo - 1]?.state === 'paid' } : null;
  let cardExpiryState: PaymentPlanView['cardExpiryState'] = 'absent';
  if (enrolled?.cardExpiry) {
    const end = expiryLastDay(enrolled.cardExpiry);
    cardExpiryState =
      end < today ? 'expired' : end <= plusDays(today, CARD_EXPIRING_DAYS) ? 'expiring' : 'current';
  }
  const autoPayState: PaymentPlanView['autoPayState'] = !enrolled
    ? 'not_enrolled'
    : paused
      ? 'paused'
      : inFlight
        ? 'blocked'
        : latest && !latest.periodPaid && (latest.outcome === 'declined' || latest.outcome === 'blocked')
          ? 'failed'
          : 'active';
  const view: PaymentPlanView = {
    planRef: row.id,
    patientRef: row.patient_id,
    guarantorRef: row.guarantor_id ?? row.patient_id,
    guarantorBasis: row.guarantor_id === null ? 'self' : 'relationship',
    timeZone: row.time_zone,
    termsVersion: current.terms_version,
    contractTotal,
    installment: amounts[0] as Money,
    installmentCount: current.installment_count,
    collected,
    balance,
    overdue: m(overdue),
    overdueSince,
    nextDueOn,
    authorizationState: authorized ? 'authorized' : 'unsigned',
    autoPayState,
    cardExpiryState,
    cardExpiry: enrolled?.cardExpiry ?? null,
    instrumentRef: enrolled?.instrumentRef ?? null,
    planState: closing
      ? closing.kind === 'voided'
        ? 'voided'
        : 'defaulted'
      : balance.minor <= 0
        ? 'completed'
        : 'open',
    closedReasonCode: closing?.reasonCode ?? null,
    installments,
    attempts: attempts.map(({ counted: _c, ...a }) => a),
    events,
    terms: termRows.map((t) => ({
      termsVersion: t.terms_version,
      contractTotal: m(t.total),
      installmentCount: t.installment_count,
      firstDueOn: t.first_due_on,
      collectedBasis: m(t.basis),
      reasonCode: t.reason_code,
      agreedAt: t.created_at.toISOString(),
    })),
    asOf: row.as_of.toISOString(),
    version: row.version,
  };
  const strip = (a: (typeof attempts)[number] | undefined | null) => {
    if (!a) return null;
    const { counted: _c, ...rest } = a;
    return rest;
  };
  return {
    view,
    latest: latest ? { ...(strip(last) as PlanAttemptView), periodPaid: latest.periodPaid } : null,
    inFlight: strip(inFlight),
    authorized,
    paused,
  };
}

/** The plan's work items (open plans only), grouped by underlying problem (one item per kind). */
async function itemsOf(tx: TenantTransaction, c: Computed): Promise<PlanWorkItem[]> {
  const v = c.view;
  if (v.planState !== 'open') return [];
  const startOf = async (date: string) => {
    const { rows } = await tx.query<{ at: Date; overdue: boolean }>(
      `SELECT ($1::date::timestamp AT TIME ZONE $2) AS at, ($1::date::timestamp AT TIME ZONE $2) < now() AS overdue`,
      [date, v.timeZone],
    );
    return rows[0] as { at: Date; overdue: boolean };
  };
  const base = {
    planRef: v.planRef,
    patientRef: v.patientRef,
    guarantorRef: v.guarantorRef,
    owner: 'practice' as const,
    queue: 'billing' as const,
  };
  const next = v.installments.find((i) => i.state !== 'paid');
  const nextAmount = next ? subtractMoney(next.amount, next.collected) : money(v.balance.currency, 0);
  const out: PlanWorkItem[] = [];
  const dueDate = v.nextDueOn ?? v.asOf.slice(0, 10);
  if (v.authorizationState === 'unsigned') {
    const at = await startOf(dueDate);
    out.push({
      ...base,
      kind: 'missing_signature',
      amount: v.balance,
      reasonCode: 'authorization_missing',
      dueAt: at.at.toISOString(),
      overdue: at.overdue,
      suggestedAction: 'obtain_signed_authorization',
      evidenceRefs: [],
    });
  }
  if (v.cardExpiryState === 'expired' || v.cardExpiryState === 'expiring') {
    const at = await startOf(dueDate);
    const blocked = c.latest && !c.latest.periodPaid && c.latest.outcome === 'blocked' ? c.latest : null;
    out.push({
      ...base,
      kind: 'expired_card',
      amount: nextAmount,
      reasonCode: v.cardExpiryState === 'expired' ? 'card_expired' : 'card_expiring',
      dueAt: at.at.toISOString(),
      overdue: at.overdue,
      suggestedAction: 'obtain_new_instrument_and_authorization',
      evidenceRefs: blocked ? [{ kind: 'planAttempt', ref: blocked.planAttemptRef }] : [],
    });
  }
  if (c.latest && !c.latest.periodPaid && c.latest.outcome === 'declined' && !c.inFlight) {
    const due = new Date(Date.parse(c.latest.attemptedAt) + FAILED_AUTOPAY_DUE_DAYS * DAY_MS);
    out.push({
      ...base,
      kind: 'failed_autopay',
      amount: nextAmount,
      reasonCode: 'autopay_declined',
      dueAt: due.toISOString(),
      overdue: due.getTime() < Date.parse(v.asOf),
      suggestedAction: 'contact_guarantor_or_retry',
      evidenceRefs: [{ kind: 'planAttempt', ref: c.latest.planAttemptRef }],
    });
  }
  if (v.overdue.minor > 0 && v.overdueSince !== null) {
    const at = await startOf(v.overdueSince);
    out.push({
      ...base,
      kind: 'overdue',
      amount: v.overdue,
      reasonCode: 'installment_overdue',
      dueAt: at.at.toISOString(),
      overdue: true,
      suggestedAction: 'contact_guarantor',
      evidenceRefs: [],
    });
  }
  return out;
}

const closedConflict = (v: PaymentPlanView) => {
  if (v.planState === 'voided') return conflict('plan_voided');
  if (v.planState === 'defaulted') return conflict('plan_defaulted');
  return conflict('plan_completed');
};

/**
 * B3 payment plans (ADR 0008, recommended-pending-billing-approval; card and auto-pay execution
 * blocked-on-discovery, B-S1). Terms are versioned; authorization, auto-pay and closure are
 * append-only facts; each installment attempt goes through the provider port with a key derived from
 * the plan, terms version, period and attempt number, so a repeated scheduler run cannot charge
 * twice. Collected money is ordinary journal money (B2) and stays when a plan is voided.
 */
export function createPlanOperations(
  base: BillingBase,
  provider: PaymentProviderPort = createSyntheticPaymentProvider(),
) {
  const { deps, execute } = base;
  const timing = providerTiming(deps);

  async function bump(tx: TenantTransaction, planId: string): Promise<number> {
    const { rows } = await tx.query<{ version: number }>(
      'UPDATE cuspatlas.billing_payment_plans SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version',
      [planId],
    );
    return rows[0]?.version as number;
  }

  async function insertEvent(
    tx: TenantTransaction,
    planId: string,
    termsVersion: number,
    e: {
      kind: PlanEventKind;
      authorizationRef?: string;
      evidenceRef?: string;
      instrumentRef?: string;
      cardExpiry?: string;
      reasonCode?: string;
    },
  ): Promise<string> {
    if (e.authorizationRef !== undefined) {
      const { rows } = await tx.query<{ id: string }>(
        // Review S6: an authorization reference is single-use across the tenant, not per plan.
        'SELECT id FROM cuspatlas.billing_payment_plan_events WHERE authorization_ref = $1',
        [e.authorizationRef],
      );
      const used = rows[0]?.id;
      if (used) throw conflict('authorization_reused', [{ kind: 'planEvent', ref: used }]);
    }
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cuspatlas.billing_payment_plan_events (tenant_id, plan_id, terms_version, kind, authorization_ref,
           evidence_ref, instrument_ref, card_expiry, reason_code, created_by)
         VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, cuspatlas.current_actor_id())
         RETURNING id`,
        [
          planId,
          termsVersion,
          e.kind,
          e.authorizationRef ?? null,
          e.evidenceRef ?? null,
          e.instrumentRef ?? null,
          e.cardExpiry ?? null,
          e.reasonCode ?? null,
        ],
      );
      return rows[0]?.id as string;
    } catch (err) {
      if (isPgError(err, '23505'))
        throw conflict(e.authorizationRef ? 'authorization_reused' : 'plan_closed');
      throw err;
    }
  }

  /** Authorize, validate, lock the plan, check the expected version and run once. */
  function onPlan<P extends object, T>(
    ctx: ActorContext,
    op: 'billing.plans.authorize' | 'billing.plans.amend' | 'billing.plans.autopay' | 'billing.plans.close',
    planRef: string,
    envelope: CommandEnvelope<unknown>,
    check: (p: unknown) => asserts p is P,
    work: (tx: TenantTransaction, row: PlanRow, c: Computed, p: P) => Promise<{ data: T; changed: string }>,
  ): Promise<CommandResult<T>> {
    return base.guarded(ctx, op, async () => {
      await base.authorize(ctx, op);
      checkEnvelope(envelope, op);
      const p = envelope.payload;
      check(p);
      assertRef(planRef);
      return deps.withTenantTransaction(ctx, async (tx) => {
        await loadPlan(tx, planRef, 'FOR UPDATE');
        return execute<T>(ctx, { ...envelope, payload: { planRef, ...(p as object) } }, tx, async () => {
          const row = await loadPlan(tx, planRef);
          const expected = (p as { expectedVersion?: number }).expectedVersion;
          if (expected !== undefined && expected !== row.version) {
            throw new RefusalError({ code: 'stale_version', detail: { currentVersion: row.version } });
          }
          const c = await computePlan(tx, row);
          const out = await work(tx, row, c, p);
          const version = await bump(tx, row.id);
          await recordCommand(
            tx,
            { operation: op, resourceType: PLAN_RESOURCE, resourceRef: row.id, resourceVersion: version },
            { changedFields: [out.changed] },
          );
          return { data: out.data, version };
        });
      });
    });
  }

  const assertOpenForChange = (c: Computed) => {
    if (c.view.planState === 'voided' || c.view.planState === 'defaulted') throw conflict('plan_closed');
  };
  const assertNoneInFlight = (c: Computed) => {
    if (c.inFlight)
      throw conflict('attempt_in_flight', [{ kind: 'paymentAttempt', ref: c.inFlight.attemptRef as string }]);
  };
  const planData = (
    row: PlanRow,
    c: Computed,
    eventRef: string | null,
    termsVersion = c.view.termsVersion,
  ) => ({
    planRef: row.id,
    termsVersion,
    eventRef,
  });

  return {
    createPlan(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PlanCommandData>> {
      const op = 'billing.plans.create';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<PlanCreate>(validatePlanCreate, p);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadPatient(tx, p.patientRef, 'FOR SHARE');
          const guarantor =
            p.guarantorRef === undefined ? null : await loadPatient(tx, p.guarantorRef, 'FOR SHARE');
          return execute<PlanCommandData>(ctx, envelope, tx, async () => {
            const settings = await loadSettings(tx);
            const total = inTenantCurrency(settings, p.contractTotal);
            const { rows: zone } = await tx.query<{ ok: number }>(
              'SELECT 1 AS ok FROM pg_timezone_names WHERE name = $1',
              [p.timeZone],
            );
            if (zone.length === 0) throw failed('invalid_time_zone');
            assertNotMerged(patient);
            if (guarantor) {
              assertNotMerged(guarantor);
              await assertGuarantor(tx, patient, guarantor);
            }
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.billing_payment_plans (tenant_id, patient_id, guarantor_id, currency, time_zone, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id()) RETURNING id`,
              [patient.id, guarantor?.id ?? null, total.currency, p.timeZone],
            );
            const planId = rows[0]?.id as string;
            await tx.query(
              `INSERT INTO cuspatlas.billing_payment_plan_terms (tenant_id, plan_id, terms_version, contract_total_minor,
                 currency, installment_count, first_due_on, collected_basis_minor, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, 1, $2, $3, $4, $5::date, 0, cuspatlas.current_actor_id())`,
              [planId, String(total.minor), total.currency, p.installmentCount, p.firstDueOn],
            );
            await recordCommand(
              tx,
              { operation: op, resourceType: PLAN_RESOURCE, resourceRef: planId, resourceVersion: 1 },
              { changedFields: ['plan'] },
            );
            return { data: { planRef: planId, termsVersion: 1, eventRef: null }, version: 1 };
          });
        });
      });
    },

    getPlan(ctx: ActorContext, planRef: string): Promise<PaymentPlanView> {
      const op = 'billing.plans.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertRef(planRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadPlan(tx, planRef);
          const c = await computePlan(tx, row);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: PLAN_RESOURCE,
            resourceRefs: [row.id],
            queryFields: [],
          });
          return c.view;
        });
      });
    },

    /** authorizePlan (B3 contract): records the signed-agreement fact for the current terms. */
    authorizePlan(ctx: ActorContext, planRef: string, envelope: CommandEnvelope<unknown>) {
      return onPlan<PlanAuthorize, PlanCommandData>(
        ctx,
        'billing.plans.authorize',
        planRef,
        envelope,
        (p): asserts p is PlanAuthorize => validate<PlanAuthorize>(validatePlanAuthorize, p),
        async (tx, row, c, p) => {
          assertOpenForChange(c);
          if (c.authorized) throw conflict('already_authorized');
          const eventRef = await insertEvent(tx, row.id, c.view.termsVersion, {
            kind: 'authorized',
            authorizationRef: p.authorizationRef,
            evidenceRef: p.evidenceRef,
          });
          return { data: planData(row, c, eventRef), changed: 'authorization' };
        },
      );
    },

    /** A new terms version; collected money becomes its basis and the new terms need a new signature. */
    amendPlan(ctx: ActorContext, planRef: string, envelope: CommandEnvelope<unknown>) {
      return onPlan<PlanAmend, PlanCommandData>(
        ctx,
        'billing.plans.amend',
        planRef,
        envelope,
        (p): asserts p is PlanAmend => validate<PlanAmend>(validatePlanAmend, p),
        async (tx, row, c, p) => {
          assertOpenForChange(c);
          assertNoneInFlight(c);
          const settings = await loadSettings(tx);
          const total = inTenantCurrency(settings, p.contractTotal);
          if (total.minor <= c.view.collected.minor) throw failed('amendment_below_collected');
          const termsVersion = c.view.termsVersion + 1;
          await tx.query(
            `INSERT INTO cuspatlas.billing_payment_plan_terms (tenant_id, plan_id, terms_version, contract_total_minor,
               currency, installment_count, first_due_on, collected_basis_minor, reason_code, created_by)
             VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6::date, $7, $8, cuspatlas.current_actor_id())`,
            [
              row.id,
              termsVersion,
              String(total.minor),
              total.currency,
              p.installmentCount,
              p.firstDueOn,
              String(c.view.collected.minor),
              p.reasonCode,
            ],
          );
          return { data: planData(row, c, null, termsVersion), changed: 'terms' };
        },
      );
    },

    /** Enrolls (new instrument and authorization), pauses or resumes auto-pay. */
    setAutopay(ctx: ActorContext, planRef: string, envelope: CommandEnvelope<unknown>) {
      return onPlan<PlanAutopay, PlanCommandData>(
        ctx,
        'billing.plans.autopay',
        planRef,
        envelope,
        (p): asserts p is PlanAutopay => validate<PlanAutopay>(validatePlanAutopay, p),
        async (tx, row, c, p) => {
          assertOpenForChange(c);
          const fields = [p.instrumentRef, p.cardExpiry, p.authorizationRef].filter((x) => x !== undefined);
          if (fields.length !== 0 && (fields.length !== 3 || p.state !== 'active'))
            throw failed('instrument_incomplete');
          if (fields.length === 3) {
            if (!c.authorized) throw conflict('unsigned_authorization');
            const eventRef = await insertEvent(tx, row.id, c.view.termsVersion, {
              kind: 'autopay_enrolled',
              instrumentRef: p.instrumentRef as string,
              cardExpiry: p.cardExpiry as string,
              authorizationRef: p.authorizationRef as string,
            });
            return { data: planData(row, c, eventRef), changed: 'autopay' };
          }
          if (c.view.instrumentRef === null) throw conflict('instrument_absent');
          const eventRef = await insertEvent(tx, row.id, c.view.termsVersion, {
            kind: p.state === 'paused' ? 'autopay_paused' : 'autopay_resumed',
          });
          return { data: planData(row, c, eventRef), changed: 'autopay' };
        },
      );
    },

    /**
     * recordInstallmentAttempt (B3 contract): one attempt for one installment period through the
     * provider port. The attempt is committed as pending under the plan lock before the provider is
     * called; the answer is then recorded once and a confirmed capture posted (executeOnce). A
     * declined attempt is a recorded fact; an unknown one blocks the plan until the B2 reconciliation
     * resolves it; an expired card records a blocked attempt without charging.
     */
    collectInstallment(
      ctx: ActorContext,
      planRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PlanCollectData>> {
      const op = 'billing.plans.collect';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<PlanCollect>(validatePlanCollect, p);
        assertRef(planRef);
        const replayEnvelope = { ...envelope, payload: { planRef, ...p } };
        const reserved = await deps.withTenantTransaction(ctx, async (tx) => {
          await loadPlan(tx, planRef, 'FOR UPDATE');
          if (await committedReplay(tx, op, envelope.idempotencyKey)) return null;
          const row = await loadPlan(tx, planRef);
          const c = await computePlan(tx, row);
          const v = c.view;
          if (v.planState !== 'open') throw closedConflict(v);
          if (!c.authorized) throw conflict('unsigned_authorization');
          const inst = v.installments[p.periodNo - 1];
          if (!inst) throw failed('period_not_found');
          if (inst.dueOn > row.today) throw failed('period_not_due');
          assertNoneInFlight(c);
          const prior = v.attempts.filter(
            (x) => x.termsVersion === v.termsVersion && x.periodNo === p.periodNo,
          );
          const remaining = subtractMoney(inst.amount, inst.collected);
          const last = prior[prior.length - 1];
          if (remaining.minor <= 0 || (last && p.retry !== true)) {
            throw conflict(
              'duplicate_period',
              last ? [{ kind: 'planAttempt', ref: last.planAttemptRef }] : [],
            );
          }
          if (v.instrumentRef === null) throw conflict('instrument_absent');
          if (c.paused) throw conflict('autopay_paused');
          const settings = await loadSettings(tx);
          const amount = p.amount === undefined ? remaining : inTenantCurrency(settings, p.amount);
          if (amount.minor > remaining.minor) throw failed('amount_exceeds_installment');
          // Review S2: a plan of a merged-away patient stays collectable; the money and the attempt
          // belong to the merge root's account (the survivor), never to the merged identity.
          const root = (await mergeSet(tx, row.patient_id)).root;
          const patient = await loadPatient(tx, root, 'FOR SHARE');
          assertNotMerged(patient);
          const attemptNo = prior.length + 1;
          const blocked = v.cardExpiryState === 'expired';
          // The provider key names the plan, terms version, period and attempt number: a scheduler
          // rerun (any idempotency key) or a retry after a lost commit cannot capture twice.
          const providerKey = sha256Hex(
            `billing-plan:${ctx.tenantId}:${row.id}:${v.termsVersion}:${p.periodNo}:${attemptNo}`,
          );
          const paymentAttemptId = blocked
            ? null
            : await insertPendingAttempt(tx, {
                patientId: patient.id,
                guarantorId: row.guarantor_id,
                instrumentRef: v.instrumentRef,
                providerKey,
                amount,
                leaseMs: timing.leaseMs,
              });
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO cuspatlas.billing_payment_plan_attempts (tenant_id, plan_id, terms_version, period_no,
               attempt_no, outcome, block_reason, payment_attempt_id, amount_minor, currency, created_by)
             VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, cuspatlas.current_actor_id())
             RETURNING id`,
            [
              row.id,
              v.termsVersion,
              p.periodNo,
              attemptNo,
              blocked ? 'blocked' : 'submitted',
              blocked ? 'card_expired' : null,
              paymentAttemptId,
              String(amount.minor),
              amount.currency,
            ],
          );
          return {
            planAttemptRef: rows[0]?.id as string,
            paymentAttemptId,
            providerKey,
            instrumentRef: v.instrumentRef,
            amount,
            patientId: patient.id,
            guarantorId: row.guarantor_id,
          };
        });
        const answer =
          reserved === null || reserved.paymentAttemptId === null
            ? null
            : await callProvider(
                provider,
                {
                  providerKey: reserved.providerKey,
                  amount: reserved.amount,
                  instrumentRef: reserved.instrumentRef,
                },
                timing.timeoutMs,
              );
        return deps.withTenantTransaction(ctx, async (tx) => {
          await loadPlan(tx, planRef, 'FOR UPDATE');
          return execute<PlanCollectData>(ctx, replayEnvelope, tx, async () => {
            if (reserved === null) throw new RefusalError({ code: 'conflict', retryable: true });
            const data = (outcome: PlanAttemptOutcome, paymentRef: string | null): PlanCollectData => ({
              planRef,
              planAttemptRef: reserved.planAttemptRef,
              outcome,
              attemptRef: reserved.paymentAttemptId,
              paymentRef,
            });
            let result = data('blocked', null);
            if (reserved.paymentAttemptId !== null && answer !== null) {
              const final = await finalizeAttempt(tx, reserved.paymentAttemptId, answer);
              let paymentRef: string | null = final.alreadyPosted?.paymentId ?? null;
              if (final.outcome === 'confirmed' && final.alreadyPosted === null) {
                // Money follows the merge set at posting time too (a merge during the provider call).
                const root = (await mergeSet(tx, reserved.patientId)).root;
                const posted = await insertPayment(tx, {
                  patientId: root,
                  guarantorId: reserved.guarantorId,
                  method: 'card_synthetic',
                  amount: reserved.amount,
                  externalRef: final.receiptId,
                  attemptId: reserved.paymentAttemptId,
                  receivedAt: null,
                });
                paymentRef = posted.paymentId;
              }
              result = data(final.outcome, paymentRef);
            }
            const version = await bump(tx, planRef);
            await recordCommand(
              tx,
              { operation: op, resourceType: PLAN_RESOURCE, resourceRef: planRef, resourceVersion: version },
              { changedFields: ['installmentAttempt'] },
            );
            return { data: result, version };
          });
        });
      });
    },

    /** voidPlan (B3 contract) and default: a human closure decision; history and money stay. */
    closePlan(ctx: ActorContext, planRef: string, envelope: CommandEnvelope<unknown>) {
      return onPlan<PlanClose, PlanCommandData>(
        ctx,
        'billing.plans.close',
        planRef,
        envelope,
        (p): asserts p is PlanClose => validate<PlanClose>(validatePlanClose, p),
        async (tx, row, c, p) => {
          assertOpenForChange(c);
          assertNoneInFlight(c);
          const eventRef = await insertEvent(tx, row.id, c.view.termsVersion, {
            kind: p.outcome,
            reasonCode: p.reasonCode,
          });
          return { data: planData(row, c, eventRef), changed: 'closure' };
        },
      );
    },

    /** listPlanWorklist (B3 contract): missing signature, expired card, failed auto-pay and overdue. */
    listPlanWorklist(ctx: ActorContext, query: unknown): Promise<PlanWorklist> {
      const op = 'billing.plans.worklist';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        validate<PlanWorklistQuery>(validatePlanWorklistQuery, query);
        const limit = query.limit === undefined ? DEFAULT_LIMIT : Number.parseInt(query.limit, 10);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            'SELECT id FROM cuspatlas.billing_payment_plans ORDER BY created_at, id',
          );
          const all: PlanWorkItem[] = [];
          for (const r of rows) {
            const c = await computePlan(tx, await loadPlan(tx, r.id));
            all.push(
              ...(await itemsOf(tx, c)).filter((i) => query.kind === undefined || i.kind === query.kind),
            );
          }
          all.sort((a, b) =>
            a.dueAt === b.dueAt
              ? a.planRef < b.planRef
                ? -1
                : a.planRef > b.planRef
                  ? 1
                  : 0
              : a.dueAt < b.dueAt
                ? -1
                : 1,
          );
          const data = all.slice(0, limit);
          const { rows: at } = await tx.query<{ at: Date }>('SELECT now() AS at');
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: 'patient',
            resourceRefs: [...new Set(data.map((d) => d.patientRef))].slice(0, 100),
            queryFields: Object.keys(query as object).filter((k) => k === 'kind' || k === 'limit'),
          });
          return {
            data,
            totalCount: all.length,
            truncated: all.length > data.length,
            checkedAt: (at[0]?.at ?? new Date()).toISOString(),
          };
        });
      });
    },
  };
}
