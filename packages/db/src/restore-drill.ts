import pg from 'pg';
import { createBackup } from './backup';
import { backupObjectStore, restoreObjectStore } from './object-store-backup';
import {
  type RestoreConnection,
  RestoreRefusedError,
  RestoreVerificationError,
  restoreBackup,
} from './restore';

/**
 * M8 timed restore exercise (synthetic only; production deployment is not authorized). Backs up the
 * whole synthetic database (F8 logical backup) and object store, restores both into a fresh isolated
 * target, reconciles every tenant table of one tenant (row count and content digest, source against
 * target), re-runs the database's own journal check on every restored entry, and measures elapsed
 * time against the recorded (recommended-pending-approval) objectives. A drill that misses a target
 * states the measured value and the gap; it is never rounded to pass. A failed restore leaves the
 * source untouched and reports the failure class instead of throwing.
 */
export const RESTORE_DRILL_REPORT_KIND = 'cuspatlas-restore-drill-report' as const;

export interface RecoveryObjectives {
  readonly rpoSeconds: number;
  readonly rtoSeconds: number;
  readonly status: string;
}

export interface RestoreDrillOptions {
  readonly sourceAdmin: pg.Pool;
  readonly sourceStoreRoot: string;
  readonly conn: RestoreConnection;
  readonly target: string;
  readonly targetStoreRoot: string;
  readonly backupDir: string;
  readonly objectsDir: string;
  readonly repoRoot: string;
  readonly migrationsDir: string;
  readonly tenantId: string;
  readonly objectives: RecoveryObjectives;
  /** Test hook: runs between the backup and the restore (for example to damage the backup). */
  readonly afterBackup?: () => Promise<void>;
}

export interface TableReconciliation {
  readonly table: string;
  readonly sourceRows: number;
  readonly targetRows: number;
  readonly matches: boolean;
}

export interface RestoreDrillReport {
  readonly kind: typeof RESTORE_DRILL_REPORT_KIND;
  readonly schemaVersion: 1;
  readonly synthetic: true;
  readonly result: 'passed' | 'failed';
  readonly failure: null | 'incomplete_backup' | 'restore_failed' | 'reconciliation_mismatch';
  readonly startedAt: string;
  readonly backupCompletedAt: string;
  readonly restoreCompletedAt: string | null;
  readonly measured: {
    readonly backupSeconds: number;
    readonly rtoSeconds: number | null;
    /** Worst-case loss window at restore time: restore start minus backup completion. */
    readonly rpoSeconds: number;
  };
  readonly objectives: RecoveryObjectives;
  readonly withinObjectives: { readonly rto: boolean; readonly rpo: boolean };
  readonly gap: string | null;
  readonly reconciliation: {
    readonly tables: number;
    readonly mismatches: readonly string[];
    readonly journalEntriesChecked: number;
    readonly objectFiles: number;
    readonly carriedTombstones: number;
  };
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const seconds = (a: number, b: number) => Math.round((b - a) / 10) / 100;

/** Row count and content digest of every tenant-scoped table, for one tenant (superuser, no RLS). */
export async function tenantTableDigests(
  admin: pg.Pool | pg.ClientBase,
  tenantId: string,
): Promise<Map<string, { rows: number; digest: string }>> {
  const { rows: tables } = await admin.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'cuspatlas' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name`,
  );
  const out = new Map<string, { rows: number; digest: string }>();
  for (const { table_name: t } of tables) {
    if (!IDENT.test(t)) throw new Error('Unexpected table name');
    const { rows } = await admin.query<{ n: number; d: string | null }>(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(r::text, '|' ORDER BY r::text), '')) AS d
       FROM cuspatlas."${t}" r WHERE r.tenant_id = $1`,
      [tenantId],
    );
    out.set(t, { rows: rows[0]?.n ?? 0, digest: rows[0]?.d ?? '' });
  }
  return out;
}

export async function runRestoreDrill(o: RestoreDrillOptions): Promise<RestoreDrillReport> {
  const started = Date.now();
  const client = await o.sourceAdmin.connect();
  try {
    await createBackup(client, { outDir: o.backupDir, repoRoot: o.repoRoot });
  } finally {
    client.release();
  }
  await backupObjectStore(o.sourceStoreRoot, o.objectsDir);
  const source = await tenantTableDigests(o.sourceAdmin, o.tenantId);
  const backupDone = Date.now();
  await o.afterBackup?.();
  const restoreStart = Date.now();
  const rpoSeconds = seconds(backupDone, restoreStart);
  const base = {
    kind: RESTORE_DRILL_REPORT_KIND,
    schemaVersion: 1 as const,
    synthetic: true as const,
    startedAt: new Date(started).toISOString(),
    backupCompletedAt: new Date(backupDone).toISOString(),
    objectives: o.objectives,
  };
  const failed = (failure: 'incomplete_backup' | 'restore_failed', detail: string): RestoreDrillReport => ({
    ...base,
    result: 'failed',
    failure,
    restoreCompletedAt: null,
    measured: { backupSeconds: seconds(started, backupDone), rtoSeconds: null, rpoSeconds },
    withinObjectives: { rto: false, rpo: rpoSeconds <= o.objectives.rpoSeconds },
    gap: `restore did not complete: ${detail}`,
    reconciliation: {
      tables: 0,
      mismatches: [],
      journalEntriesChecked: 0,
      objectFiles: 0,
      carriedTombstones: 0,
    },
  });
  try {
    await restoreBackup(o.conn, {
      backupDir: o.backupDir,
      target: o.target,
      confirmTarget: o.target,
      migrationsDir: o.migrationsDir,
    });
  } catch (err) {
    if (err instanceof RestoreRefusedError) return failed('incomplete_backup', err.code);
    if (err instanceof RestoreVerificationError) return failed('restore_failed', 'verification');
    throw err;
  }
  const store = await restoreObjectStore(o.objectsDir, o.targetStoreRoot, {
    tombstonesFrom: o.sourceStoreRoot,
  });
  const target = new pg.Pool({ ...o.conn, database: o.target, max: 2 });
  try {
    const restored = await tenantTableDigests(target, o.tenantId);
    const mismatches: string[] = [];
    for (const [t, s] of source) {
      const r = restored.get(t);
      if (!r || r.rows !== s.rows || r.digest !== s.digest) mismatches.push(t);
    }
    const { rows: entries } = await target.query<{ id: string }>(
      'SELECT id FROM cuspatlas.billing_journal_entries WHERE tenant_id = $1 ORDER BY posted_at, id',
      [o.tenantId],
    );
    for (const e of entries)
      await target.query('SELECT cuspatlas.billing_check_entry($1, $2)', [o.tenantId, e.id]);
    const done = Date.now();
    const rtoSeconds = seconds(restoreStart, done);
    const within = { rto: rtoSeconds <= o.objectives.rtoSeconds, rpo: rpoSeconds <= o.objectives.rpoSeconds };
    const gaps = [
      ...(within.rto ? [] : [`rto ${rtoSeconds}s exceeds target ${o.objectives.rtoSeconds}s`]),
      ...(within.rpo ? [] : [`rpo ${rpoSeconds}s exceeds target ${o.objectives.rpoSeconds}s`]),
      ...(mismatches.length > 0 ? [`${mismatches.length} tables differ`] : []),
    ];
    return {
      ...base,
      result: mismatches.length === 0 && within.rto && within.rpo ? 'passed' : 'failed',
      failure: mismatches.length > 0 ? 'reconciliation_mismatch' : null,
      restoreCompletedAt: new Date(done).toISOString(),
      measured: { backupSeconds: seconds(started, backupDone), rtoSeconds, rpoSeconds },
      withinObjectives: within,
      gap: gaps.length === 0 ? null : gaps.join('; '),
      reconciliation: {
        tables: source.size,
        mismatches,
        journalEntriesChecked: entries.length,
        objectFiles: store.files,
        carriedTombstones: store.carriedTombstones,
      },
    };
  } finally {
    await target.end();
  }
}
