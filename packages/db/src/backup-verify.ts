import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { MANIFEST_FILE, sha256 } from './backup';
import { assertSyntheticDatabaseName } from './migrate';
import { type RestoreConnection, RestoreRefusedError, readVerifiedManifest, restoreBackup } from './restore';

/** What one backup verification found; recorded through `operations.backupVerifications.record`. */
export interface BackupVerificationInput {
  readonly backupDigest: string;
  readonly manifestVerified: boolean;
  readonly isolatedRestore: 'passed' | 'failed' | 'not_run';
  readonly restoreSeconds?: number;
  readonly failureCode?: string;
}

/**
 * M9 backup verification (deployment level; synthetic only): checks the latest backup's manifest and
 * every data file digest, then restores it into an isolated sample database, measures the restore,
 * and drops the sample. A backup that fails a digest is never restored; the sample is dropped
 * whatever happens. Never throws for a damaged backup: the result says what failed.
 */
export async function verifyBackup(o: {
  readonly backupDir: string;
  readonly conn: RestoreConnection;
  readonly migrationsDir: string;
  readonly sampleTarget: string;
}): Promise<BackupVerificationInput> {
  assertSyntheticDatabaseName(o.sampleTarget);
  let backupDigest = '0'.repeat(64);
  try {
    backupDigest = sha256(readFileSync(join(o.backupDir, MANIFEST_FILE)));
    readVerifiedManifest(o.backupDir);
  } catch (err) {
    const failureCode = err instanceof RestoreRefusedError ? err.code : 'manifest_unreadable';
    return { backupDigest, manifestVerified: false, isolatedRestore: 'not_run', failureCode };
  }
  const started = Date.now();
  try {
    await restoreBackup(o.conn, {
      backupDir: o.backupDir,
      target: o.sampleTarget,
      confirmTarget: o.sampleTarget,
      migrationsDir: o.migrationsDir,
    });
    return {
      backupDigest,
      manifestVerified: true,
      isolatedRestore: 'passed',
      restoreSeconds: Math.round((Date.now() - started) / 10) / 100,
    };
  } catch {
    return { backupDigest, manifestVerified: true, isolatedRestore: 'failed', failureCode: 'restore_failed' };
  } finally {
    const admin = new pg.Client({ ...o.conn });
    await admin.connect();
    try {
      // Identifier validated by assertSyntheticDatabaseName above.
      await admin.query(`DROP DATABASE IF EXISTS ${o.sampleTarget} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
}
