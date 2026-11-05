import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type BackupVerificationInput, MANIFEST_FILE, type RestoreConnection } from '@cuspatlas/db';
import { BACKUP_VERIFICATION_MAX_AGE_SECONDS } from '@cuspatlas/domain';

/**
 * M9 backup verification job. `verify` checks the latest backup (manifest digests and an isolated
 * sample restore: `verifyBackup` in @cuspatlas/db); `record` records the result through the
 * `operations.backupVerifications.record` business operation as the worker's service principal. A
 * verification that cannot run is recorded as failed (never as passed by default), so readiness is
 * blocked and an alert work item appears.
 *
 * The worker tick runs it (`composeWorker`) when `CUSPATLAS_BACKUP_LOCATION` (a backup directory, or
 * a directory of backups whose newest manifest wins) and `CUSPATLAS_RESTORE_ADMIN_DATABASE_URL` (the
 * loopback maintenance database the isolated sample restore is created from) are configured, every
 * `CUSPATLAS_BACKUP_VERIFY_INTERVAL_SECONDS` (default 43200, at most the readiness freshness window).
 * Due-ness comes from each served tenant's last recorded verification, so a restart does not re-run
 * early; one verification per tick is recorded for every due tenant. Without a location or target the
 * job is disabled with one structured reason line (no path or connection detail is logged).
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

export const DEFAULT_BACKUP_VERIFY_INTERVAL_SECONDS = 43_200;

export type BackupVerificationConfig =
  | {
      readonly enabled: true;
      readonly location: string;
      readonly restore: RestoreConnection;
      readonly intervalSeconds: number;
    }
  | {
      readonly enabled: false;
      readonly reason: 'backup_location_not_configured' | 'restore_target_not_configured';
    };

/** Reads the backup verification settings; refuses a malformed interval or restore URL (no value echoed). */
export function resolveBackupVerificationConfig(env: NodeJS.ProcessEnv): BackupVerificationConfig {
  const raw = env.CUSPATLAS_BACKUP_VERIFY_INTERVAL_SECONDS;
  const intervalSeconds =
    raw === undefined || raw === '' ? DEFAULT_BACKUP_VERIFY_INTERVAL_SECONDS : Number(raw);
  if (
    !(
      Number.isInteger(intervalSeconds) &&
      intervalSeconds >= 60 &&
      intervalSeconds <= BACKUP_VERIFICATION_MAX_AGE_SECONDS
    )
  ) {
    throw new Error(
      `CUSPATLAS_BACKUP_VERIFY_INTERVAL_SECONDS must be an integer between 60 and ${BACKUP_VERIFICATION_MAX_AGE_SECONDS}`,
    );
  }
  const location = env.CUSPATLAS_BACKUP_LOCATION;
  if (!location) return { enabled: false, reason: 'backup_location_not_configured' };
  const url = env.CUSPATLAS_RESTORE_ADMIN_DATABASE_URL;
  if (!url) return { enabled: false, reason: 'restore_target_not_configured' };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('CUSPATLAS_RESTORE_ADMIN_DATABASE_URL must be a postgres connection URL');
  }
  const password = u.password ? decodeURIComponent(u.password) : env.PGPASSWORD;
  return {
    enabled: true,
    location,
    intervalSeconds,
    restore: {
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username),
      ...(password ? { password } : {}),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
    },
  };
}

/** The backup to verify: the location itself when it holds a manifest, else its newest backup. */
export function latestBackupDir(location: string): string {
  if (existsSync(join(location, MANIFEST_FILE))) return location;
  let best: { dir: string; at: number } | null = null;
  try {
    for (const entry of readdirSync(location, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(location, entry.name, MANIFEST_FILE);
      if (!existsSync(manifest)) continue;
      const at = statSync(manifest).mtimeMs;
      if (!best || at > best.at) best = { dir: join(location, entry.name), at };
    }
  } catch {
    // Unreadable location: verifyBackup records it as a failed verification.
  }
  return best?.dir ?? location;
}
