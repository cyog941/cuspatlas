import type { ActorContext, WithTenantTransaction } from '@cuspatlas/contracts';
import type { AttemptRecordingDeps } from '../commands/boundary';
import type { CommandExecutor } from '../commands/executor';
import type { CursorCodec } from '../cursor';
import type { ActionName, Authorize } from '../policy/authorize';

export interface PatientServiceDeps {
  readonly authorize: Authorize;
  readonly withTenantTransaction: WithTenantTransaction;
  readonly recording: AttemptRecordingDeps;
  /** Defaults to the durable executeOnce; tests may inject a different executor. */
  readonly execute?: CommandExecutor;
  /** Defaults to a per-process random HMAC key. */
  readonly cursors?: CursorCodec;
}

/** Shared plumbing handed to each patient command group. */
export interface PatientServiceContext {
  readonly deps: PatientServiceDeps;
  readonly execute: CommandExecutor;
  readonly cursors: CursorCodec;
  guarded<T>(ctx: ActorContext, operation: ActionName, work: () => Promise<T>): Promise<T>;
}
