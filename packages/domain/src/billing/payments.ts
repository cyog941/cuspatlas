import {
  type ActorContext,
  type AllocationView,
  type AttemptReconcile,
  type CommandEnvelope,
  type CommandResult,
  type EntryCommandData,
  type FundsTransfer,
  type HolderAmount,
  type Money,
  moneyFromMinorText,
  negateMoney,
  type PaymentCommandData,
  type PaymentMethod,
  type PaymentRecord,
  type PaymentRefund,
  type PaymentSettle,
  type PaymentView,
  type ReconcileCommandData,
  RefusalError,
  type TenantTransaction,
  validateAttemptReconcile,
  validateFundsTransfer,
  validatePaymentRecord,
  validatePaymentRefund,
  validatePaymentSettle,
} from '@cuspatlas/contracts';
import { idempotencyKeyDigest, sha256Hex } from '../commands/digest';
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
  type PatientRow,
  validate,
} from './base';
import { bumpAggregates, lockAggregates, PAYMENT_RESOURCE } from './entries';
import { dimensionBalance, type LineInput, postEntry, SignViolation } from './journal';
import {
  type CaptureRequest,
  createSyntheticPaymentProvider,
  type PaymentProviderPort,
  type ProviderAnswer,
} from './payment-port';

export const ATTEMPT_RESOURCE = 'billingPaymentAttempt';

export interface PaymentRow extends Record<string, unknown> {
  id: string;
  patient_id: string;
  guarantor_id: string | null;
  method: PaymentMethod;
  amount: string;
  currency: string;
  external_ref: string | null;
  attempt_id: string | null;
  received_at: Date;
  version: number;
  entry_id: string;
  reversal_id: string | null;
}

const PAYMENT_COLUMNS = `p.id, p.patient_id, p.guarantor_id, p.method, p.amount_minor::text AS amount, p.currency,
  p.external_ref, p.attempt_id, p.received_at, p.version,
  (SELECT e.id FROM cuspatlas.billing_journal_entries e WHERE e.payment_id = p.id AND e.kind = 'patientPayment'
     AND e.reverses_entry_id IS NULL) AS entry_id,
  (SELECT r.id FROM cuspatlas.billing_journal_entries r JOIN cuspatlas.billing_journal_entries e
     ON r.reverses_entry_id = e.id WHERE e.payment_id = p.id AND e.kind = 'patientPayment') AS reversal_id`;

export async function loadPayment(tx: TenantTransaction, paymentRef: string): Promise<PaymentRow> {
  assertRef(paymentRef);
  const { rows } = await tx.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM cuspatlas.billing_payments p WHERE p.id = $1`,
    [paymentRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

export function assertPaymentActive(row: PaymentRow): void {
  if (row.reversal_id !== null)
    throw conflict('payment_reversed', [{ kind: 'journalEntry', ref: row.reversal_id }]);
}

/** Unapplied funds of one payment per holding patient (positive amounts, patient-reference order). */
export async function unappliedHolders(
  tx: TenantTransaction,
  paymentId: string,
  currency: string,
): Promise<HolderAmount[]> {
  const { rows } = await tx.query<{ patient_id: string; s: string }>(
    `SELECT patient_id, (-sum(amount_minor))::text AS s FROM cuspatlas.billing_journal_lines
     WHERE payment_id = $1 AND account = 'unapplied_credit'
     GROUP BY patient_id HAVING sum(amount_minor) <> 0 ORDER BY patient_id`,
    [paymentId],
  );
  return rows.map((r) => ({ patientRef: r.patient_id, amount: moneyFromMinorText(currency, r.s) }));
}

const cashOf = (
  tx: TenantTransaction,
  paymentId: string,
  currency: string,
  account: 'undeposited_funds' | 'settled_cash',
) =>
  dimensionBalance(tx, currency, { account, charge: null, payer: null, payment: paymentId, patient: null });

/** The lines of a received payment: cash in hand (not settled) against the patient's unapplied credit. */
const receivedLines = (amount: Money, patientId: string, paymentId: string): LineInput[] => [
  { account: 'undeposited_funds', amount, patientId, paymentId },
  { account: 'unapplied_credit', amount: negateMoney(amount), patientId, paymentId },
];

/** A guarantor must be the patient's current, unrevoked guarantor (S5 relationship). */
export async function assertGuarantor(
  tx: TenantTransaction,
  patient: PatientRow,
  guarantor: PatientRow,
): Promise<void> {
  const { rows } = await tx.query<{ ok: number }>(
    `SELECT 1 AS ok FROM cuspatlas.patient_relationships
     WHERE subject_patient_id = $1 AND counterparty_patient_id = $2 AND kind = 'guarantor' AND revoked_at IS NULL
       AND effective_from <= now() AND (effective_until IS NULL OR effective_until > now())`,
    [patient.id, guarantor.id],
  );
  if (rows.length === 0) throw failed('guarantor_unresolved');
}

/** Inserts a received payment fact and posts it (undeposited funds against unapplied credit). */
export async function insertPayment(
  tx: TenantTransaction,
  o: {
    patientId: string;
    guarantorId: string | null;
    method: PaymentMethod;
    amount: Money;
    externalRef: string | null;
    attemptId: string | null;
    receivedAt: string | null;
  },
): Promise<{ paymentId: string; entryRef: string }> {
  let paymentId: string;
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cuspatlas.billing_payments (tenant_id, patient_id, guarantor_id, method, amount_minor, currency,
         external_ref, attempt_id, received_at, created_by)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()),
         cuspatlas.current_actor_id())
       RETURNING id`,
      [
        o.patientId,
        o.guarantorId,
        o.method,
        String(o.amount.minor),
        o.amount.currency,
        o.externalRef,
        o.attemptId,
        o.receivedAt,
      ],
    );
    paymentId = rows[0]?.id as string;
  } catch (err) {
    if (isPgError(err, '23505')) throw conflict('duplicate_receipt');
    throw err;
  }
  const entryRef = await postEntry(tx, {
    kind: 'patientPayment',
    currency: o.amount.currency,
    paymentId,
    externalRef: o.externalRef,
    lines: receivedLines(o.amount, o.patientId, paymentId),
  });
  return { paymentId, entryRef };
}

/**
 * Phase 1 of a capture (review fix): the attempt is recorded as `pending` and committed BEFORE the
 * provider is called, so a provider throw, a timeout, a crash or a later refusal can never erase the
 * fact that money may have been captured. A provider key that already has an attempt (for example
 * a caller key reused after its idempotency record expired) is a typed 409, never a second capture.
 */
export async function insertPendingAttempt(
  tx: TenantTransaction,
  o: {
    patientId: string;
    guarantorId: string | null;
    instrumentRef: string;
    providerKey: string;
    amount: Money;
    /** In-flight lease (review M1): provider timeout plus margin, in milliseconds. */
    leaseMs: number;
  },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.billing_payment_attempts (tenant_id, patient_id, guarantor_id, method, instrument_ref,
       provider_key, amount_minor, currency, outcome, call_deadline, created_by)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, 'card_synthetic', $3, $4, $5, $6, 'pending',
       now() + make_interval(secs => $7::int / 1000.0), cuspatlas.current_actor_id())
     ON CONFLICT (tenant_id, provider_key) DO NOTHING
     RETURNING id`,
    [
      o.patientId,
      o.guarantorId,
      o.instrumentRef,
      o.providerKey,
      String(o.amount.minor),
      o.amount.currency,
      o.leaseMs,
    ],
  );
  const id = rows[0]?.id;
  if (id) return id;
  const { rows: existing } = await tx.query<{ id: string }>(
    'SELECT id FROM cuspatlas.billing_payment_attempts WHERE provider_key = $1',
    [o.providerKey],
  );
  throw conflict('duplicate_attempt', existing[0] ? [{ kind: 'paymentAttempt', ref: existing[0].id }] : []);
}

/** Default provider call timeout and lease margin (synthetic defaults, pending approval). */
export const PROVIDER_TIMEOUT_MS = 30_000;
export const PROVIDER_LEASE_MARGIN_MS = 30_000;

/**
 * Bounds an external call: a throw, or no answer within `timeoutMs`, is `fallback`. The far end may
 * still complete later; callers record that possibility as unknown, never as failed.
 */
export async function withTimeout<T>(call: () => Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call().catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The provider timing of a billing service (injectable for tests). */
export function providerTiming(deps: { providerTimeoutMs?: number; providerLeaseMarginMs?: number }) {
  const timeoutMs = deps.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS;
  return { timeoutMs, leaseMs: timeoutMs + (deps.providerLeaseMarginMs ?? PROVIDER_LEASE_MARGIN_MS) };
}

/** Phase 2: the provider call, outside any transaction. A throw or a timeout is `unknown`. */
export async function callProvider(
  provider: PaymentProviderPort,
  request: CaptureRequest,
  timeoutMs: number = PROVIDER_TIMEOUT_MS,
): Promise<ProviderAnswer> {
  const unknown: ProviderAnswer = { outcome: 'unknown' };
  return withTimeout(() => provider.capture(request), timeoutMs, unknown);
}

/**
 * Phase 3: records the provider's answer exactly once on the pending attempt. When a reconciliation
 * resolved the attempt first (its lease expired: a stalled request), the late answer is reconciled
 * with that resolution instead of being lost (review M1): a capture after a premature `not_captured`
 * corrects it once to `captured` and is posted by the caller; a capture a reconciliation already
 * posted is returned with its payment (`alreadyPosted`); anything else reports the resolution.
 */
export async function finalizeAttempt(
  tx: TenantTransaction,
  attemptId: string,
  answer: ProviderAnswer,
): Promise<{
  outcome: 'confirmed' | 'declined' | 'unknown';
  receiptId: string | null;
  alreadyPosted: { paymentId: string; entryId: string } | null;
}> {
  const confirmed = answer.outcome === 'confirmed' && answer.receiptId !== undefined;
  const outcome = confirmed ? 'confirmed' : answer.outcome === 'declined' ? 'declined' : 'unknown';
  const receiptId = confirmed ? (answer.receiptId as string) : null;
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE cuspatlas.billing_payment_attempts SET outcome = $2, provider_receipt = $3, version = version + 1,
       updated_at = now()
     WHERE id = $1 AND outcome = 'pending' RETURNING id`,
    [attemptId, outcome, receiptId],
  );
  if (rows.length > 0) return { outcome, receiptId, alreadyPosted: null };
  const { rows: cur } = await tx.query<{
    resolution: string | null;
    superseded: string | null;
    payment_id: string | null;
    entry_id: string | null;
  }>(
    `SELECT a.resolution, a.superseded_resolution AS superseded, p.id AS payment_id, p.entry_id
     FROM cuspatlas.billing_payment_attempts a
     LEFT JOIN LATERAL (SELECT p.id, e.id AS entry_id FROM cuspatlas.billing_payments p
                        JOIN cuspatlas.billing_journal_entries e ON e.payment_id = p.id AND e.tenant_id = p.tenant_id
                          AND e.kind = 'patientPayment' AND e.reverses_entry_id IS NULL
                        WHERE p.attempt_id = a.id) p ON true
     WHERE a.id = $1 FOR UPDATE OF a`,
    [attemptId],
  );
  const a = cur[0];
  if (!a || a.resolution === null) {
    throw conflict('duplicate_attempt', [{ kind: 'paymentAttempt', ref: attemptId }]);
  }
  if (a.resolution === 'captured' && a.payment_id !== null && a.entry_id !== null) {
    return {
      outcome: 'confirmed',
      receiptId: null,
      alreadyPosted: { paymentId: a.payment_id, entryId: a.entry_id },
    };
  }
  if (confirmed && a.resolution === 'not_captured' && a.superseded === null) {
    await correctToCaptured(tx, attemptId, receiptId as string);
    return { outcome: 'confirmed', receiptId, alreadyPosted: null };
  }
  return { outcome: 'declined', receiptId: null, alreadyPosted: null };
}

/** The one correction of a premature `not_captured` resolution to `captured` (review M1). */
export async function correctToCaptured(
  tx: TenantTransaction,
  attemptId: string,
  receiptId: string,
): Promise<number> {
  const { rows } = await tx.query<{ version: number }>(
    `UPDATE cuspatlas.billing_payment_attempts SET resolution = 'captured', superseded_resolution = 'not_captured',
       provider_receipt = $2, corrected_at = now(), corrected_by = cuspatlas.current_actor_id(),
       version = version + 1, updated_at = now()
     WHERE id = $1 AND resolution = 'not_captured' AND superseded_resolution IS NULL RETURNING version`,
    [attemptId, receiptId],
  );
  const version = rows[0]?.version;
  if (version === undefined) throw conflict('already_resolved');
  return version;
}

/** True when this caller key already has a stored result (the executor will replay it). */
export async function committedReplay(
  tx: TenantTransaction,
  operation: string,
  key: string,
): Promise<boolean> {
  const { rows } = await tx.query<{ ok: number }>(
    `SELECT 1 AS ok FROM cuspatlas.command_idempotency
     WHERE tenant_id = cuspatlas.current_tenant_id() AND principal_id = cuspatlas.current_actor_id()
       AND operation = $1 AND key_digest = $2 AND state IN ('committed', 'failed') AND expires_at > now()`,
    [operation, idempotencyKeyDigest(key)],
  );
  return rows.length > 0;
}

/**
 * B2 payment facts: recording (manual or through the synthetic provider port), settlement,
 * reconciliation of unknown provider outcomes, refunds and transfers of unapplied funds. Every money
 * movement is a journal entry; nothing is edited.
 */
export function createPaymentOperations(
  base: BillingBase,
  provider: PaymentProviderPort = createSyntheticPaymentProvider(),
) {
  const { deps, execute } = base;
  const timing = providerTiming(deps);

  /** Common shape of a command on one payment: authorize, validate, lock the payment, run once. */
  function onPayment<P, T>(
    ctx: ActorContext,
    op: 'billing.payments.settle' | 'billing.payments.refund' | 'billing.funds.transfer',
    paymentRef: string,
    envelope: CommandEnvelope<unknown>,
    check: (p: unknown) => asserts p is P,
    work: (tx: TenantTransaction, row: PaymentRow, p: P) => Promise<{ data: T; changed: string }>,
    before?: (tx: TenantTransaction, p: P) => Promise<void>,
  ): Promise<CommandResult<T>> {
    return base.guarded(ctx, op, async () => {
      await base.authorize(ctx, op);
      checkEnvelope(envelope, op);
      const p = envelope.payload;
      check(p);
      assertRef(paymentRef);
      return deps.withTenantTransaction(ctx, async (tx) => {
        const row = await loadPayment(tx, paymentRef);
        if (before) await before(tx, p);
        await lockAggregates(tx, { payments: [row.id], charges: [] });
        return execute<T>(ctx, { ...envelope, payload: { paymentRef, ...(p as object) } }, tx, async () => {
          const current = await loadPayment(tx, paymentRef);
          assertPaymentActive(current);
          const out = await work(tx, current, p);
          const version = (await bumpAggregates(tx, { payments: [row.id], charges: [] })).get(row.id) ?? 1;
          await recordCommand(
            tx,
            { operation: op, resourceType: PAYMENT_RESOURCE, resourceRef: row.id, resourceVersion: version },
            { changedFields: [out.changed] },
          );
          return { data: out.data, version };
        });
      });
    });
  }

  return {
    /**
     * recordPaymentIntent (B2 contract): records the fact, or the provider attempt and its outcome.
     * A card capture runs in three steps: validate and commit a pending attempt, call the provider
     * outside any transaction, then finalize the attempt and post the payment once (executeOnce).
     */
    recordPayment(
      ctx: ActorContext,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<PaymentCommandData>> {
      const op = 'billing.payments.record';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<PaymentRecord>(validatePaymentRecord, p);
        const card = p.method === 'card_synthetic';
        const prepare = async (tx: TenantTransaction, patient: PatientRow, guarantor: PatientRow | null) => {
          const settings = await loadSettings(tx);
          const amount = inTenantCurrency(settings, p.amount);
          if (card && p.instrumentRef === undefined) throw failed('instrument_required');
          if (!card && p.instrumentRef !== undefined) throw failed('instrument_not_allowed');
          if (card && p.externalRef !== undefined) throw failed('external_ref_not_allowed');
          if (p.receivedAt !== undefined) {
            const { rows } = await tx.query<{ future: boolean }>(
              `SELECT ($1::timestamptz > now() + interval '5 minutes') AS future`,
              [p.receivedAt],
            );
            if (rows[0]?.future === true) throw failed('received_in_future');
          }
          assertNotMerged(patient);
          if (guarantor) {
            assertNotMerged(guarantor);
            await assertGuarantor(tx, patient, guarantor);
          }
          return amount;
        };
        const post = async (
          tx: TenantTransaction,
          o: {
            patientId: string;
            guarantorId: string | null;
            amount: Money;
            externalRef: string | null;
            attemptId: string | null;
          },
        ) => {
          const posted = await insertPayment(tx, {
            patientId: o.patientId,
            guarantorId: o.guarantorId,
            method: p.method,
            amount: o.amount,
            externalRef: o.externalRef,
            attemptId: o.attemptId,
            receivedAt: p.receivedAt ?? null,
          });
          await recordCommand(
            tx,
            {
              operation: op,
              resourceType: PAYMENT_RESOURCE,
              resourceRef: posted.paymentId,
              resourceVersion: 1,
            },
            { changedFields: ['payment'] },
          );
          return {
            data: {
              outcome: 'confirmed' as const,
              paymentRef: posted.paymentId,
              attemptRef: o.attemptId,
              entryRef: posted.entryRef,
            },
            version: 1,
          };
        };
        if (!card) {
          return deps.withTenantTransaction(ctx, async (tx) => {
            const patient = await loadPatient(tx, p.patientRef, 'FOR SHARE');
            const guarantor =
              p.guarantorRef === undefined ? null : await loadPatient(tx, p.guarantorRef, 'FOR SHARE');
            return execute<PaymentCommandData>(ctx, envelope, tx, async () => {
              const amount = await prepare(tx, patient, guarantor);
              if (p.externalRef !== undefined) {
                const dup = await tx.query<{ id: string }>(
                  'SELECT id FROM cuspatlas.billing_payments WHERE method = $1 AND external_ref = $2',
                  [p.method, p.externalRef],
                );
                const id = dup.rows[0]?.id;
                if (id) throw conflict('duplicate_receipt', [{ kind: 'billingPayment', ref: id }]);
              }
              return post(tx, {
                patientId: patient.id,
                guarantorId: guarantor?.id ?? null,
                amount,
                externalRef: p.externalRef ?? null,
                attemptId: null,
              });
            });
          });
        }
        // The provider key is stable for every retry of this caller request (same scope as the
        // idempotency reservation); the pending attempt makes it single-use.
        const providerKey = sha256Hex(
          `billing-provider:${ctx.tenantId}:${ctx.actorId}:${op}:${idempotencyKeyDigest(envelope.idempotencyKey)}`,
        );
        const pending = await deps.withTenantTransaction(ctx, async (tx) => {
          const patient = await loadPatient(tx, p.patientRef, 'FOR SHARE');
          const guarantor =
            p.guarantorRef === undefined ? null : await loadPatient(tx, p.guarantorRef, 'FOR SHARE');
          if (await committedReplay(tx, op, envelope.idempotencyKey)) return null;
          const amount = await prepare(tx, patient, guarantor);
          const attemptId = await insertPendingAttempt(tx, {
            patientId: patient.id,
            guarantorId: guarantor?.id ?? null,
            instrumentRef: p.instrumentRef as string,
            providerKey,
            amount,
            leaseMs: timing.leaseMs,
          });
          return { attemptId, amount, patientId: patient.id, guarantorId: guarantor?.id ?? null };
        });
        const answer =
          pending === null
            ? null
            : await callProvider(
                provider,
                { providerKey, amount: pending.amount, instrumentRef: p.instrumentRef as string },
                timing.timeoutMs,
              );
        return deps.withTenantTransaction(ctx, async (tx) =>
          execute<PaymentCommandData>(ctx, envelope, tx, async () => {
            // Only a stored result can be replayed; without one there is nothing safe to answer.
            if (pending === null || answer === null)
              throw new RefusalError({ code: 'conflict', retryable: true });
            const final = await finalizeAttempt(tx, pending.attemptId, answer);
            if (final.alreadyPosted !== null) {
              // A reconciliation already posted this capture: answer with that payment, post nothing.
              return {
                data: {
                  outcome: 'confirmed' as const,
                  paymentRef: final.alreadyPosted.paymentId,
                  attemptRef: pending.attemptId,
                  entryRef: final.alreadyPosted.entryId,
                },
                version: 1,
              };
            }
            if (final.outcome !== 'confirmed') {
              // Declined: a recorded fact, nothing collected. Unknown: an open reconciliation item,
              // never posted as collected and never retried automatically.
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: ATTEMPT_RESOURCE,
                  resourceRef: pending.attemptId,
                  resourceVersion: 2,
                },
                { changedFields: ['attempt'] },
              );
              return {
                data: {
                  outcome: final.outcome,
                  paymentRef: null,
                  attemptRef: pending.attemptId,
                  entryRef: null,
                },
                version: 2,
              };
            }
            // Money follows the merge set: a capture whose payer was merged meanwhile goes to the survivor.
            const root = (await mergeSet(tx, pending.patientId)).root;
            return post(tx, {
              patientId: root,
              guarantorId: pending.guarantorId,
              amount: pending.amount,
              externalRef: final.receiptId,
              attemptId: pending.attemptId,
            });
          }),
        );
      });
    },

    getPayment(ctx: ActorContext, paymentRef: string): Promise<PaymentView> {
      const op = 'billing.payments.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertRef(paymentRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadPayment(tx, paymentRef);
          const m = (s: string) => moneyFromMinorText(row.currency, s);
          const { rows } = await tx.query<{ account: string; kind: string; s: string }>(
            `SELECT l.account, e.kind, sum(l.amount_minor)::text AS s FROM cuspatlas.billing_journal_lines l
             JOIN cuspatlas.billing_journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
             WHERE l.payment_id = $1 GROUP BY l.account, e.kind`,
            [row.id],
          );
          const sum = (pred: (r: { account: string; kind: string }) => boolean) =>
            rows.filter(pred).reduce((s, r) => s + BigInt(r.s), BigInt(0));
          const holders = await unappliedHolders(tx, row.id, row.currency);
          const unapplied = -sum((r) => r.account === 'unapplied_credit');
          const allocated = -sum((r) => r.account === 'patient_receivable');
          const refunded = sum((r) => r.account === 'unapplied_credit' && r.kind === 'refund');
          const settled = sum((r) => r.account === 'settled_cash');
          const unsettled = sum((r) => r.account === 'undeposited_funds');
          const allocs = await tx.query<{
            id: string;
            charge_id: string;
            patient_id: string;
            s: string;
            posted_at: Date;
            reversed_by: string | null;
          }>(
            `SELECT e.id, e.charge_id, l.patient_id, (-l.amount_minor)::text AS s, e.posted_at,
               (SELECT r.id FROM cuspatlas.billing_journal_entries r WHERE r.reverses_entry_id = e.id) AS reversed_by
             FROM cuspatlas.billing_journal_entries e
             JOIN cuspatlas.billing_journal_lines l ON l.entry_id = e.id AND l.tenant_id = e.tenant_id
               AND l.account = 'patient_receivable'
             WHERE e.payment_id = $1 AND e.kind = 'allocation' AND e.reverses_entry_id IS NULL
             ORDER BY e.posted_at, e.id LIMIT 100`,
            [row.id],
          );
          const allocations: AllocationView[] = allocs.rows.map((a) => ({
            allocationRef: a.id,
            chargeRef: a.charge_id,
            patientRef: a.patient_id,
            amount: m(a.s),
            allocatedAt: a.posted_at.toISOString(),
            reversedByEntryRef: a.reversed_by,
          }));
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: PAYMENT_RESOURCE,
            resourceRefs: [row.id],
            queryFields: [],
          });
          return {
            paymentRef: row.id,
            patientRef: row.patient_id,
            guarantorRef: row.guarantor_id,
            method: row.method,
            amount: m(row.amount),
            externalRef: row.external_ref,
            attemptRef: row.attempt_id,
            receivedAt: row.received_at.toISOString(),
            entryRef: row.entry_id,
            state: row.reversal_id === null ? 'received' : 'reversed',
            settlement: {
              state:
                settled === BigInt(0)
                  ? 'received'
                  : unsettled === BigInt(0)
                    ? 'settled'
                    : 'partially_settled',
              settled: m(settled.toString()),
              unsettled: m(unsettled.toString()),
            },
            allocated: m(allocated.toString()),
            refunded: m(refunded.toString()),
            unapplied: m(unapplied.toString()),
            unappliedByPatient: holders,
            allocations,
            version: row.version,
          };
        });
      });
    },

    /** Settlement (M-8): moves the payment's unsettled cash to settled cash. Received is not settled. */
    settlePayment(ctx: ActorContext, paymentRef: string, envelope: CommandEnvelope<unknown>) {
      return onPayment<PaymentSettle, EntryCommandData>(
        ctx,
        'billing.payments.settle',
        paymentRef,
        envelope,
        (p): asserts p is PaymentSettle => validate<PaymentSettle>(validatePaymentSettle, p),
        async (tx, row, p) => {
          const unsettled = await cashOf(tx, row.id, row.currency, 'undeposited_funds');
          if (unsettled.minor <= 0) throw conflict('nothing_to_settle');
          const entryRef = await postEntry(tx, {
            kind: 'settlement',
            currency: row.currency,
            paymentId: row.id,
            externalRef: p.settlementRef,
            reasonCode: p.reasonCode ?? null,
            lines: [
              { account: 'settled_cash', amount: unsettled, patientId: row.patient_id, paymentId: row.id },
              {
                account: 'undeposited_funds',
                amount: negateMoney(unsettled),
                patientId: row.patient_id,
                paymentId: row.id,
              },
            ],
          });
          return { data: { entryRef }, changed: 'settlement' };
        },
      );
    },

    /** A refund returns the original payer's unapplied money: unsettled cash first, then settled cash. */
    refundPayment(ctx: ActorContext, paymentRef: string, envelope: CommandEnvelope<unknown>) {
      return onPayment<PaymentRefund, EntryCommandData>(
        ctx,
        'billing.payments.refund',
        paymentRef,
        envelope,
        (p): asserts p is PaymentRefund => validate<PaymentRefund>(validatePaymentRefund, p),
        async (tx, row, p) => {
          const settings = await loadSettings(tx);
          const amount = inTenantCurrency(settings, p.amount);
          const holders = await unappliedHolders(tx, row.id, row.currency);
          const own = holders.find((x) => x.patientRef === row.patient_id)?.amount.minor ?? 0;
          if (own < amount.minor) throw conflict('refund_exceeds_funds');
          const unsettled = (await cashOf(tx, row.id, row.currency, 'undeposited_funds')).minor;
          const fromUnsettled =
            BigInt(unsettled) < BigInt(amount.minor) ? BigInt(unsettled) : BigInt(amount.minor);
          const fromSettled = BigInt(amount.minor) - fromUnsettled;
          const lines: LineInput[] = [
            { account: 'unapplied_credit', amount, patientId: row.patient_id, paymentId: row.id },
          ];
          if (fromUnsettled > 0n) {
            lines.push({
              account: 'undeposited_funds',
              amount: moneyFromMinorText(row.currency, String(-fromUnsettled)),
              patientId: row.patient_id,
              paymentId: row.id,
            });
          }
          if (fromSettled > 0n) {
            lines.push({
              account: 'settled_cash',
              amount: moneyFromMinorText(row.currency, String(-fromSettled)),
              patientId: row.patient_id,
              paymentId: row.id,
            });
          }
          try {
            const entryRef = await postEntry(tx, {
              kind: 'refund',
              currency: row.currency,
              paymentId: row.id,
              externalRef: p.refundRef ?? null,
              reasonCode: p.reasonCode,
              lines,
            });
            return { data: { entryRef }, changed: 'refund' };
          } catch (err) {
            if (err instanceof SignViolation) throw conflict('refund_exceeds_funds');
            throw err;
          }
        },
      );
    },

    /** moveUnappliedFunds (B2 contract): moves one payment's unapplied money to another patient. */
    transferFunds(ctx: ActorContext, paymentRef: string, envelope: CommandEnvelope<unknown>) {
      let to: PatientRow | null = null;
      let from: PatientRow | null = null;
      return onPayment<FundsTransfer, EntryCommandData>(
        ctx,
        'billing.funds.transfer',
        paymentRef,
        envelope,
        (p): asserts p is FundsTransfer => validate<FundsTransfer>(validateFundsTransfer, p),
        async (tx, row, p) => {
          if (!to || !from) throw new Error('transfer parties not loaded');
          const settings = await loadSettings(tx);
          const amount = inTenantCurrency(settings, p.amount);
          if (from.id === to.id) throw failed('same_patient');
          assertNotMerged(to);
          const holders = await unappliedHolders(tx, row.id, row.currency);
          const fromId = from.id;
          const available = holders.find((x) => x.patientRef === fromId)?.amount.minor ?? 0;
          if (available < amount.minor) throw conflict('insufficient_funds');
          try {
            const entryRef = await postEntry(tx, {
              kind: 'transfer',
              currency: row.currency,
              paymentId: row.id,
              reasonCode: p.reasonCode,
              lines: [
                { account: 'unapplied_credit', amount, patientId: from.id, paymentId: row.id },
                {
                  account: 'unapplied_credit',
                  amount: negateMoney(amount),
                  patientId: to.id,
                  paymentId: row.id,
                },
              ],
            });
            return { data: { entryRef }, changed: 'unappliedFunds' };
          } catch (err) {
            if (err instanceof SignViolation) throw conflict('insufficient_funds');
            throw err;
          }
        },
        async (tx, p) => {
          // Both parties must be visible patients of this tenant (404 otherwise), loaded before the lock.
          to = await loadPatient(tx, p.toPatientRef, 'FOR SHARE');
          const payment = await loadPayment(tx, paymentRef);
          from = await loadPatient(tx, p.fromPatientRef ?? payment.patient_id, 'FOR SHARE');
        },
      );
    },

    /** Resolves an unknown provider outcome by lookup with the original key; never a new capture. */
    reconcileAttempt(
      ctx: ActorContext,
      attemptRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<CommandResult<ReconcileCommandData>> {
      const op = 'billing.payments.reconcile';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        const p = envelope.payload;
        validate<AttemptReconcile>(validateAttemptReconcile, p);
        assertRef(attemptRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            patient_id: string;
            guarantor_id: string | null;
            instrument_ref: string;
            provider_key: string;
            amount: string;
            currency: string;
            outcome: string;
            resolution: string | null;
            superseded: string | null;
            in_flight: boolean;
            created_at: Date;
          }>(
            `SELECT id, patient_id, guarantor_id, instrument_ref, provider_key, amount_minor::text AS amount, currency,
               outcome, resolution, superseded_resolution AS superseded,
               (outcome = 'pending' AND coalesce(call_deadline > now(), false)) AS in_flight, created_at
             FROM cuspatlas.billing_payment_attempts WHERE id = $1 FOR UPDATE`,
            [attemptRef],
          );
          const a = rows[0];
          if (!a) throw notFound();
          return execute<ReconcileCommandData>(
            ctx,
            { ...envelope, payload: { attemptRef, ...(p as object) } },
            tx,
            async () => {
              if (a.outcome !== 'unknown' && a.outcome !== 'pending') throw conflict('not_reconcilable');
              // Review M1: the request that created a pending attempt may still be waiting for the
              // provider inside its lease; resolving under it could lose a capture.
              if (a.in_flight) throw conflict('attempt_in_flight');
              // A premature not_captured may be corrected once by a later lookup; nothing else reopens.
              const correcting = a.resolution === 'not_captured' && a.superseded === null;
              if (a.resolution !== null && !correcting) throw conflict('already_resolved');
              const unknown: ProviderAnswer = { outcome: 'unknown' };
              const answer = await withTimeout(
                () => provider.lookup({ providerKey: a.provider_key, instrumentRef: a.instrument_ref }),
                timing.timeoutMs,
                unknown,
              );
              const captured = answer.outcome === 'confirmed' && answer.receiptId !== undefined;
              if (correcting && !captured) throw conflict('already_resolved');
              if (!captured && answer.outcome !== 'declined') {
                throw new RefusalError({
                  code: 'conflict',
                  retryable: true,
                  detail: { reason: 'outcome_still_unknown' },
                });
              }
              const { rows: upd } = correcting
                ? { rows: [{ version: await correctToCaptured(tx, a.id, answer.receiptId as string) }] }
                : await tx.query<{ version: number }>(
                    `UPDATE cuspatlas.billing_payment_attempts SET outcome = 'unknown', resolution = $1,
                       resolved_at = now(), resolved_by = cuspatlas.current_actor_id(), provider_receipt = $2,
                       version = version + 1, updated_at = now()
                     WHERE id = $3 AND resolution IS NULL AND outcome IN ('unknown', 'pending') RETURNING version`,
                    [captured ? 'captured' : 'not_captured', captured ? answer.receiptId : null, a.id],
                  );
              const version = upd[0]?.version;
              if (version === undefined) throw conflict('already_resolved');
              let paymentRef: string | null = null;
              let entryRef: string | null = null;
              if (captured) {
                // A payer merged since the attempt: the captured money belongs to the survivor's account.
                const root = (await mergeSet(tx, a.patient_id)).root;
                const posted = await insertPayment(tx, {
                  patientId: root,
                  guarantorId: a.guarantor_id,
                  method: 'card_synthetic',
                  amount: moneyFromMinorText(a.currency, a.amount),
                  externalRef: answer.receiptId as string,
                  attemptId: a.id,
                  receivedAt: a.created_at.toISOString(),
                });
                paymentRef = posted.paymentId;
                entryRef = posted.entryRef;
              }
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: ATTEMPT_RESOURCE,
                  resourceRef: a.id,
                  resourceVersion: version,
                },
                { changedFields: ['resolution'] },
              );
              return {
                data: {
                  attemptRef: a.id,
                  outcome: captured ? 'confirmed' : 'declined',
                  paymentRef,
                  entryRef,
                },
                version,
              };
            },
          );
        });
      });
    },
  };
}
