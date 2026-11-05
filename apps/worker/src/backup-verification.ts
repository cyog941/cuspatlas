import type { BackupVerificationInput } from '@cuspatlas/db';

/**
 * M9 backup verification job. `verify` checks the latest backup (manifest digests and an isolated
 * sample restore: `verifyBackup` in @cuspatlas/db); `record` records the result through the
 * `operations.backupVerifications.record` business operation as the worker's service principal. A
 * verification that cannot run is recorded as failed (never as passed by default), so readiness is
 * blocked and an alert work item appears. Wiring into the worker tick needs the operator's backup
 * location and restore target (M-S3); until then the job runs from tests and operator tooling.
 */
export interface BackupVerificationJobDeps {
  verify(): Promise<BackupVerificationInput>;
  record(input: BackupVerificationInput): Promise<{ result?: unknown } | unknown>;
}

export const UNAVAILABLE_VERIFICATION: BackupVerificationInput = Object.freeze({
  backupDigest: '0'.repeat(64),
  manifestVerified: false,
  isolatedRestore: 'not_run',
  failureCode: 'verification_unavailable',
});

/** True when the last verification is older than the interval (or there is none). */
export function backupVerificationDue(lastAt: Date | null, now: Date, intervalSeconds: number): boolean {
  return lastAt === null || now.getTime() - lastAt.getTime() >= intervalSeconds * 1000;
}

export async function runBackupVerificationJob(
  deps: BackupVerificationJobDeps,
): Promise<{ recorded: boolean; result: string | null }> {
  let input: BackupVerificationInput;
  try {
    input = await deps.verify();
  } catch {
    input = UNAVAILABLE_VERIFICATION;
  }
  try {
    const out = (await deps.record(input)) as { result?: unknown } | null;
    return { recorded: true, result: typeof out?.result === 'string' ? out.result : null };
  } catch {
    return { recorded: false, result: null };
  }
}
