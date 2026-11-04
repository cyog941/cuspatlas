import type { ActorContext, WithTenantTransaction } from '@cuspatlas/contracts';
import type { AttemptRecordingDeps } from '../commands/boundary';
import type { CommandExecutor } from '../commands/executor';
import type { CursorCodec } from '../cursor';
import type { ActionName, Authorize } from '../policy/authorize';
import type { PostMergeFactProbe } from './merge';
import type { MergeConfirmationCodec } from './merge-confirmation';
import type { MatchKeyer } from './model';

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
  /**
   * Server pepper for tenant-bound match keys (at least 32 bytes). Required: transports pass the
   * configured secret, or the test-only pepper when the runtime environment is synthetic-test.
   */
  readonly matchKeyPepper: Uint8Array;
}

/** Shared plumbing handed to each patient command group. */
export interface PatientServiceContext {
  readonly deps: PatientServiceDeps;
  readonly execute: CommandExecutor;
  readonly cursors: CursorCodec;
  readonly confirmations: MergeConfirmationCodec;
  /** Match keyer bound to one tenant. */
  keyer(tenantId: string): MatchKeyer;
  guarded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T>;
}
