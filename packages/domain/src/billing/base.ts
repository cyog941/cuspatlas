import {
  type ActorContext,
  assertValid,
  BILLING_PROPERTIES,
  type CommandEnvelope,
  type Money,
  MoneyError,
  money,
  RefusalError,
  type TenantTransaction,
  validateBillingEntityRef,
  validateBillingIdempotencyKey,
  type WithTenantTransaction,
} from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, withAttemptRecording } from '../commands/boundary';
import { executeOnce } from '../commands/execute-once';
import type { CommandExecutor } from '../commands/executor';
import type { ActionName, Authorize } from '../policy/authorize';
import type { EligibilityPort } from '../rcm/coverage';
import { createSchedulingCursorCodec, type SchedulingCursorCodec } from '../scheduling/cursor';
import type { PaymentProviderPort } from './payment-port';

export interface BillingDeps {
  readonly authorize: Authorize;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly recording: AttemptRecordingDeps;
  /** Defaults to the durable executeOnce; tests may inject a different executor. */
  readonly execute?: CommandExecutor;
  /** Defaults to a per-process random HMAC key (cursor construction shared with scheduling). */
  readonly cursors?: SchedulingCursorCodec;
  /** Payment provider port (B2). Defaults to the in-process synthetic provider (B-S1 open). */
  readonly payments?: PaymentProviderPort;
  /** Eligibility source port (B5). Defaults to the in-process fake adapter (B-S3 open). */
  readonly eligibility?: EligibilityPort;
  /** Timeout of one external call (provider capture or lookup, eligibility check); default 30 s. */
  readonly providerTimeoutMs?: number;
  /** Margin added to the timeout for the in-flight lease of a pending attempt; default 30 s. */
  readonly providerLeaseMarginMs?: number;
  /** Claims partner port (B6/B7). Defaults to the in-process fake clearinghouse (B-S2 open). */
  readonly claims?: import('../rcm/clearinghouse').ClaimsPartnerPort;
}

export interface BillingBase {
  readonly deps: BillingDeps;
  readonly execute: CommandExecutor;
  readonly cursors: SchedulingCursorCodec;
  guarded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T>;
  authorize(ctx: ActorContext, action: ActionName): Promise<void>;
}

/**
 * Shared plumbing of the billing service (B1, B2). Each operation runs inside the attempt boundary;
 * authorization runs before validation and before the tenant transaction, so a replay is
 * reauthorized and no second pool connection is ever taken while a transaction is open. Billing is
 * tenant-wide (no location dimension yet; ADR 0008 unresolved list).
 */
export function createBillingBase(deps: BillingDeps): BillingBase {
  return {
    deps,
    execute: deps.execute ?? executeOnce,
    cursors: deps.cursors ?? createSchedulingCursorCodec(),
    guarded: (ctx, operation, work) =>
      withAttemptRecording(
        deps.recording,
        { correlationId: ctx.correlationId, tenantId: ctx.tenantId, actorId: ctx.actorId, operation },
        work,
      ),
    async authorize(ctx, action) {
      await deps.authorize(ctx, action, { tenantId: ctx.tenantId, id: 'billing' });
    },
  };
}

export const notFound = () =>
  new RefusalError({ code: 'not_found', reasonCode: 'resource_hidden_or_missing' });
/** Domain validation (422, terminal): the reason names the rule. */
export const failed = (reason: string) => new RefusalError({ code: 'validation_failed', detail: { reason } });
/** Stored-state conflict (409, terminal unless retryable): the reason names the blocking state. */
export const conflict = (reason: string, blockingRefs?: readonly { kind: string; ref: string }[]) =>
  new RefusalError({
    code: 'conflict',
    detail: blockingRefs === undefined || blockingRefs.length === 0 ? { reason } : { reason, blockingRefs },
  });

export const isPgError = (err: unknown, code: string) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;

export function checkEnvelope(envelope: CommandEnvelope<unknown>, operation: string): void {
  if (envelope.operation !== operation) throw new RefusalError({ code: 'invalid_request' });
  assertValid(validateBillingIdempotencyKey, envelope.idempotencyKey, new Set(['idempotencyKey']));
}

/** A malformed reference is hidden exactly like a missing one. */
export function assertRef(ref: string): void {
  if (!validateBillingEntityRef(ref)) throw notFound();
}

export function validate<T>(fn: Parameters<typeof assertValid>[0], value: unknown): asserts value is T {
  assertValid<T>(fn, value, BILLING_PROPERTIES);
}

/** Maps a shared-helper failure to the typed refusal (currency mismatch, overflow, malformed). */
export function moneyRefusal(err: unknown): never {
  if (err instanceof MoneyError) throw failed(err.code);
  throw err;
}

export interface BillingSettings {
  readonly currency: string;
  readonly escalationDays: number;
}

/** Tenant billing configuration (RLS: the current tenant only). Defaults: USD, 7 days. */
export async function loadSettings(tx: TenantTransaction): Promise<BillingSettings> {
  const { rows } = await tx.query<{ currency: string; days: number }>(
    'SELECT currency, unapplied_escalation_days AS days FROM cuspatlas.billing_settings',
  );
  return { currency: rows[0]?.currency ?? 'USD', escalationDays: rows[0]?.days ?? 7 };
}

/** Every money input must be in the tenant currency; never converted (ADR 0008 M-3). */
export function inTenantCurrency(settings: BillingSettings, value: Money): Money {
  if (value.currency !== settings.currency) throw failed('currency_mismatch');
  try {
    return money(value.currency, value.minor);
  } catch (err) {
    return moneyRefusal(err);
  }
}

export interface PatientRow extends Record<string, unknown> {
  id: string;
  merged_into: string | null;
}

/**
 * Reads a patient of the current tenant (RLS). `FOR SHARE` serializes with a concurrent merge,
 * which locks both patients `FOR UPDATE`. Hidden, missing and malformed references are one 404.
 */
export async function loadPatient(
  tx: TenantTransaction,
  patientRef: string,
  lock: '' | 'FOR SHARE' = '',
): Promise<PatientRow> {
  assertRef(patientRef);
  const { rows } = await tx.query<PatientRow>(
    `SELECT id, merged_into FROM cuspatlas.patients WHERE id = $1 ${lock}`,
    [patientRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** A financial fact is posted to the surviving identity only (S6 merge). */
export function assertNotMerged(row: PatientRow): void {
  if (row.merged_into !== null) throw conflict('patient_merged', [{ kind: 'patient', ref: row.merged_into }]);
}

/**
 * The account a patient's money belongs to: the root of its merge chain plus every identity merged
 * into that root (ADR 0008 M-11). Merges never relink posted rows, so this is resolved at read and
 * command time; an unmerge separates the identities again without touching history.
 */
export async function mergeSet(
  tx: TenantTransaction,
  patientId: string,
): Promise<{ root: string; ids: string[] }> {
  const { rows } = await tx.query<{ root: string | null; ids: string[] | null }>(
    `WITH RECURSIVE up (id, merged_into, depth) AS (
       SELECT id, merged_into, 0 FROM cuspatlas.patients WHERE id = $1
       UNION ALL
       SELECT p.id, p.merged_into, up.depth + 1 FROM cuspatlas.patients p JOIN up ON p.id = up.merged_into
       WHERE up.depth < 32),
     root AS (SELECT id FROM up WHERE merged_into IS NULL LIMIT 1),
     down (id, depth) AS (
       SELECT id, 0 FROM root
       UNION ALL
       SELECT p.id, down.depth + 1 FROM cuspatlas.patients p JOIN down ON p.merged_into = down.id
       WHERE down.depth < 32)
     SELECT (SELECT id FROM root) AS root, (SELECT array_agg(id ORDER BY id) FROM down) AS ids`,
    [patientId],
  );
  const r = rows[0];
  if (!r?.root || !r.ids) throw notFound();
  return { root: r.root, ids: r.ids };
}
