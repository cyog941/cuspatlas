import type { ActorContext, WithTenantTransaction } from '@cuspatlas/contracts';
import type { AttemptRecordingDeps } from '../commands/boundary';
import type { CommandExecutor } from '../commands/executor';
import type { CursorCodec } from '../cursor';
import type { ActionName, Authorize } from '../policy/authorize';
import type { PostMergeFactProbe } from './merge';
import type { MergeConfirmationCodec } from './merge-confirmation';

export interface PatientServiceDeps {
  readonly authorize: Authorize;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly recording: AttemptRecordingDeps;
  /** Defaults to the durable executeOnce; tests may inject a different executor. */
  readonly execute?: CommandExecutor;
  /** Defaults to a per-process random HMAC key. */
  readonly cursors?: CursorCodec;
  /** S6 merge confirmation tokens; defaults to a per-process key and a 15-minute expiry. */
  readonly mergeConfirmations?: MergeConfirmationCodec;
  /** S6 (S-D2): counters of clinical/financial facts on a survivor after a merge. None exist yet. */
  readonly postMergeFactProbes?: readonly PostMergeFactProbe[];
}

/** Shared plumbing handed to each patient command group. */
export interface PatientServiceContext {
  readonly deps: PatientServiceDeps;
  readonly execute: CommandExecutor;
  readonly cursors: CursorCodec;
  readonly confirmations: MergeConfirmationCodec;
  guarded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T>;
}
