import { type ActorContext, RefusalError, type WithTenantTransaction } from '@cuspatlas/contracts';
import { type AttemptRecordingDeps, withAttemptRecording } from '../commands/boundary';
import type { ActionName, Authorize } from '../policy/authorize';

/**
 * A21 (OR-09) read composer framework. A composer is a cross-aggregate read that calls each owning
 * domain's published read function inside ONE tenant transaction. It writes nothing (the only row it
 * may add is the S4 sensitive-read access log of the patient data it returns). Every component carries
 * its own authorization outcome and freshness:
 *
 * - `ok`: the caller may see it; `freshness` says how current it is.
 * - `restricted`: the caller may not see it (the action and scope it would need are named; no value).
 * - `unavailable`: the producer does not exist in this deployment (its owner is named).
 *
 * Neither `restricted` nor `unavailable` ever counts as "none".
 */
export interface Freshness {
  readonly asOf: string;
  readonly state: 'current' | 'stale';
  /** What the value is computed from (live read in this transaction, or a stated upstream record). */
  readonly basis: string;
}
export type Component<T> =
  | { readonly status: 'ok'; readonly owner: string; readonly freshness: Freshness; readonly data: T }
  | {
      readonly status: 'restricted';
      readonly owner: string;
      readonly requiredAction: string;
      readonly requiredScope: string;
    }
  | {
      readonly status: 'unavailable';
      readonly owner: string;
      readonly reason: 'producer_not_deployed' | 'producer_failed' | 'record_missing';
    };

export interface ComponentSpec {
  readonly key: string;
  readonly owner: string;
  /** The owning domain's own read action: the component is visible exactly when this is allowed. */
  readonly action: ActionName;
  readonly scope: string;
}

export const ok = <T>(spec: ComponentSpec, data: T, freshness: Freshness): Component<T> => ({
  status: 'ok',
  owner: spec.owner,
  freshness,
  data,
});
export const restricted = <T>(spec: ComponentSpec): Component<T> => ({
  status: 'restricted',
  owner: spec.owner,
  requiredAction: spec.action,
  requiredScope: spec.scope,
});
export const unavailable = <T>(
  spec: ComponentSpec,
  reason: 'producer_not_deployed' | 'producer_failed' | 'record_missing' = 'producer_not_deployed',
): Component<T> => ({
  status: 'unavailable',
  owner: spec.owner,
  reason,
});
export const live = (asOf: Date): Freshness => ({
  asOf: asOf.toISOString(),
  state: 'current',
  basis: 'live read in the composing transaction',
});

export interface ComposerDeps {
  readonly authorize: Authorize;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly recording: AttemptRecordingDeps;
}

export interface ComposerBase {
  readonly deps: ComposerDeps;
  guarded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T>;
  authorize(ctx: ActorContext, action: ActionName): ReturnType<Authorize>;
  /**
   * Per-component decisions, taken BEFORE the composing transaction (authorize reads the live
   * membership on its own connection). A probe records no attempt: the composite read is the request.
   */
  permissions(ctx: ActorContext, specs: readonly ComponentSpec[]): Promise<Map<string, boolean>>;
}

export function createComposerBase(deps: ComposerDeps): ComposerBase {
  const authorize = (ctx: ActorContext, action: ActionName) =>
    deps.authorize(ctx, action, { tenantId: ctx.tenantId, id: 'composer' });
  return {
    deps,
    guarded: (ctx, operation, work) =>
      withAttemptRecording(
        deps.recording,
        { correlationId: ctx.correlationId, tenantId: ctx.tenantId, actorId: ctx.actorId, operation },
        work,
      ),
    authorize,
    async permissions(ctx, specs) {
      const out = new Map<string, boolean>();
      for (const s of specs) {
        try {
          await authorize(ctx, s.action);
          out.set(s.key, true);
        } catch (err) {
          if (err instanceof RefusalError && err.code === 'forbidden') out.set(s.key, false);
          else throw err;
        }
      }
      return out;
    },
  };
}

/** Age in whole years on a local date, only from a day-precision birth date (else null). */
export function ageOn(
  birth: { known: boolean; value?: string; precision?: string },
  onDate: string,
): number | null {
  if (!birth.known || birth.precision !== 'day' || typeof birth.value !== 'string') return null;
  const [by, bm, bd] = birth.value.split('-').map(Number) as [number, number, number];
  const [y, m, d] = onDate.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}
