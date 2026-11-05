import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  IMAGING_PROPERTIES,
  type StorageOrphanSweep,
  type TenantTransaction,
  validateStorageOrphanSweep,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { checkEnvelope, type ImagingBase, type StagingMaintenance, storeUnavailable } from './base';

export const ORPHAN_SWEEP_RESOURCE = 'imagingOrphanSweep';
/** Closeout D3: the completion of one durable removal intent. */
export const ORPHAN_REMOVAL_RESOURCE = 'imagingOrphanRemoval';
const OP = 'imaging.storage.sweepOrphanBytes';
/** Files listed per run; candidates (and content locks taken) per run. */
const MAX_LISTED = 10_000;
const MAX_ORPHANS = 200;
const BATCH = 500;
const DEFAULT_GRACE_HOURS = 24;

type KeptReason = 'liveObject' | 'tombstoneRetained' | 'legalHold' | 'exportPackage';
type Kept = Record<KeptReason | 'withinGrace' | 'contentLocked', number>;

/**
 * Why each content key is still referenced, or null when nothing references it. Storage keys are
 * tenant-prefixed (the imaging_objects CHECK binds the key to the row's tenant, and exports promote
 * under the caller's tenant), so the caller tenant's rows, visible through RLS, are every row that can
 * reference a key of its prefix. Every imaging object row counts, whatever its state: a quarantined or
 * tombstoned row keeps its bytes until the deletion path removes them. A held object outranks the rest.
 */
async function references(tx: TenantTransaction, keys: string[]): Promise<Map<string, KeptReason | null>> {
  const { rows } = await tx.query<{
    key: string;
    held: boolean;
    live: boolean;
    tombstoned: boolean;
    exported: boolean;
  }>(
    `SELECT k.key,
       EXISTS (SELECT 1 FROM cuspatlas.imaging_objects o WHERE o.storage_key = k.key
         AND EXISTS (SELECT 1 FROM cuspatlas.imaging_object_holds(o.id))) AS held,
       EXISTS (SELECT 1 FROM cuspatlas.imaging_objects o WHERE o.storage_key = k.key AND o.state <> 'deleted') AS live,
       EXISTS (SELECT 1 FROM cuspatlas.imaging_objects o WHERE o.storage_key = k.key AND o.state = 'deleted') AS tombstoned,
       (EXISTS (SELECT 1 FROM cuspatlas.practice_exports p WHERE p.storage_key = k.key)
         OR EXISTS (SELECT 1 FROM cuspatlas.export_requests e WHERE e.storage_key = k.key)) AS exported
     FROM unnest($1::text[]) AS k(key)`,
    [keys],
  );
  const out = new Map<string, KeptReason | null>();
  for (const r of rows) {
    out.set(
      r.key,
      r.held
        ? 'legalHold'
        : r.live
          ? 'liveObject'
          : r.tombstoned
            ? 'tombstoneRetained'
            : r.exported
              ? 'exportPackage'
              : null,
    );
  }
  // A key the query did not answer for is treated as referenced (fail closed).
  for (const k of keys) if (!out.has(k)) out.set(k, 'liveObject');
  return out;
}

/**
 * Closeout A5: orphan-bytes removal. Lists the caller tenant's content files and reports (dry run, the
 * default) or removes those no row references, older than the grace period. Each candidate is checked
 * again after taking its content lock without waiting (an ingest of the same bytes holds that lock
 * from promotion to commit, so a held lock means "keep"). One append-only sweep record and one audit
 * event per run. Removal needs imaging.delete on top of the operation's admin.configure.
 *
 * Closeout D3: removal is durable-first. A real run commits one removal intent per candidate with its
 * sweep record before any byte is touched; each intent (this run's, then any an earlier run left open)
 * is then finished in its own transaction under the content lock: references and age re-checked, bytes
 * removed, intent marked `removed` (or `kept`, or `absent` when the bytes were already gone) and
 * audited. A failure between those steps leaves the committed intent open for the next real run or a
 * same-key retry. The answer (removed, pending, resumed) is read back from the intents, so a retry and
 * the first call agree.
 */
export function createOrphanBytesOperations(base: ImagingBase) {
  const { deps, execute } = base;

  /** Finishes one open intent under the content lock; false when it stays open (locked or taken). */
  const finishOne = async (
    ctx: ActorContext,
    maintenance: StagingMaintenance,
    intentRef: string,
    sweepRef: string,
    graceMs: number,
  ): Promise<boolean> =>
    deps.withTenantTransaction(ctx, async (tx) => {
      const { rows } = await tx.query<{ id: string; digest_sha256: string; storage_key: string }>(
        `SELECT id, digest_sha256, storage_key FROM cuspatlas.imaging_orphan_removals
         WHERE id = $1 AND state = 'intended' FOR UPDATE SKIP LOCKED`,
        [intentRef],
      );
      const row = rows[0];
      if (!row) return false;
      const lock = await tx.query<{ ok: boolean }>(
        'SELECT cuspatlas.imaging_try_lock_content(cuspatlas.current_tenant_id(), $1) AS ok',
        [row.digest_sha256],
      );
      if (lock.rows[0]?.ok !== true) return false;
      let state: 'removed' | 'absent' | 'kept';
      let reason: KeptReason | 'withinGrace' | null = null;
      const why = (await references(tx, [row.storage_key])).get(row.storage_key);
      if (why) {
        state = 'kept';
        reason = why;
      } else {
        const at = await maintenance.contentModifiedAt(ctx.tenantId, row.storage_key);
        if (at === null) state = 'absent';
        else if (Date.now() - at.getTime() <= graceMs) {
          state = 'kept';
          reason = 'withinGrace';
        } else if (await maintenance.removeContentIfOlderThan(ctx.tenantId, row.storage_key, graceMs))
          state = 'removed';
        else if ((await maintenance.contentModifiedAt(ctx.tenantId, row.storage_key)) === null)
          state = 'absent';
        else {
          state = 'kept';
          reason = 'withinGrace';
        }
      }
      await tx.query(
        `UPDATE cuspatlas.imaging_orphan_removals SET state = $2, kept_reason = $3, completed_sweep_id = $4,
           completed_by = cuspatlas.current_actor_id(), completed_at = now()
         WHERE id = $1 AND state = 'intended'`,
        [row.id, state, reason, sweepRef],
      );
      await recordCommand(
        tx,
        { operation: OP, resourceType: ORPHAN_REMOVAL_RESOURCE, resourceRef: row.id, resourceVersion: 2 },
        { changedFields: ['state'] },
      );
      return true;
    });

  /**
   * Finishes this sweep's open intents first, then those earlier runs left open (at most MAX_ORPHANS
   * each). A failure of one intent leaves it open (reported as pending) and moves on.
   */
  const finishIntents = async (
    ctx: ActorContext,
    maintenance: StagingMaintenance,
    sweepRef: string,
    graceMs: number,
  ) => {
    const ids = await deps.withTenantTransaction(ctx, async (tx) => {
      const own = await tx.query<{ id: string }>(
        `SELECT id FROM cuspatlas.imaging_orphan_removals WHERE state = 'intended' AND sweep_id = $1
         ORDER BY created_at, id LIMIT $2`,
        [sweepRef, MAX_ORPHANS],
      );
      const earlier = await tx.query<{ id: string }>(
        `SELECT id FROM cuspatlas.imaging_orphan_removals WHERE state = 'intended' AND sweep_id <> $1
         ORDER BY created_at, id LIMIT $2`,
        [sweepRef, MAX_ORPHANS],
      );
      return [...own.rows, ...earlier.rows].map((r) => r.id);
    });
    for (const id of ids) {
      try {
        await finishOne(ctx, maintenance, id, sweepRef, graceMs);
      } catch {
        // Left open: the committed intent is finished (or reconciled) by a later run or retry.
      }
    }
  };

  /** The removal outcome of one sweep, read from its record and intents (the same answer on a retry). */
  const outcome = (ctx: ActorContext, sweepRef: string) =>
    deps.withTenantTransaction(ctx, async (tx) => {
      const rec = await tx.query<{ orphan_digests: string[]; removed_digests: string[] }>(
        'SELECT orphan_digests, removed_digests FROM cuspatlas.imaging_orphan_sweeps WHERE id = $1',
        [sweepRef],
      );
      const { rows } = await tx.query<{ digest_sha256: string; state: string; own: boolean }>(
        `SELECT digest_sha256, state, sweep_id = $1 AS own FROM cuspatlas.imaging_orphan_removals
         WHERE sweep_id = $1 OR completed_sweep_id = $1 ORDER BY created_at, id`,
        [sweepRef],
      );
      const own = rows.filter((r) => r.own);
      return {
        orphans: rec.rows[0]?.orphan_digests ?? [],
        // Sweeps recorded before D3 removed inside their own transaction and list removals on the record.
        removed: [
          ...(rec.rows[0]?.removed_digests ?? []),
          ...own.filter((r) => r.state === 'removed' || r.state === 'absent').map((r) => r.digest_sha256),
        ],
        pending: own.filter((r) => r.state === 'intended').length,
        resumed: rows.filter((r) => !r.own).length,
      };
    });

  return {
    sweepOrphanBytes(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      return base.recorded(ctx, OP, async () => {
        await base.authorize(ctx, OP);
        checkEnvelope(envelope, OP);
        assertValid<StorageOrphanSweep>(validateStorageOrphanSweep, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as StorageOrphanSweep;
        const dryRun = p.dryRun ?? true;
        const graceHours = p.graceHours ?? DEFAULT_GRACE_HOURS;
        // Destroying bytes is deletion authority as well as practice administration.
        if (!dryRun) await base.authorize(ctx, 'imaging.deletions.execute');
        base.store();
        const maintenance = deps.stagingMaintenance;
        if (!maintenance) {
          base.alert('imaging_object_store_unavailable');
          throw storeUnavailable();
        }
        const graceMs = graceHours * 3600 * 1000;
        const result = await deps.withTenantTransaction(ctx, async (tx) =>
          execute(ctx, envelope, tx, async () => {
            const listed = await maintenance.listContent(ctx.tenantId, MAX_LISTED + 1);
            let more = listed.length > MAX_LISTED;
            const files = listed.slice(0, MAX_LISTED);
            const kept: Kept = {
              withinGrace: 0,
              liveObject: 0,
              tombstoneRetained: 0,
              legalHold: 0,
              exportPackage: 0,
              contentLocked: 0,
            };
            // Keys an earlier run already intends to remove are finished below, never intended twice.
            const open = new Set(
              dryRun
                ? []
                : (
                    await tx.query<{ storage_key: string }>(
                      `SELECT storage_key FROM cuspatlas.imaging_orphan_removals WHERE state = 'intended'`,
                    )
                  ).rows.map((r) => r.storage_key),
            );
            const now = Date.now();
            const old = files.filter((f) => {
              const young = now - f.modifiedAt.getTime() <= graceMs;
              if (young) kept.withinGrace += 1;
              return !young && !open.has(f.storageKey);
            });
            const unreferenced: typeof old = [];
            for (let i = 0; i < old.length; i += BATCH) {
              const batch = old.slice(i, i + BATCH);
              const refs = await references(
                tx,
                batch.map((f) => f.storageKey),
              );
              for (const f of batch) {
                const why = refs.get(f.storageKey);
                if (why) kept[why] += 1;
                else unreferenced.push(f);
              }
            }
            if (unreferenced.length > MAX_ORPHANS) more = true;
            const orphans: typeof unreferenced = [];
            for (const f of unreferenced.slice(0, MAX_ORPHANS)) {
              const lock = await tx.query<{ ok: boolean }>(
                'SELECT cuspatlas.imaging_try_lock_content(cuspatlas.current_tenant_id(), $1) AS ok',
                [f.digestSha256],
              );
              if (lock.rows[0]?.ok !== true) {
                kept.contentLocked += 1;
                continue;
              }
              // Re-checked on a fresh snapshot while holding the lock: a row registered meanwhile wins.
              const why = (await references(tx, [f.storageKey])).get(f.storageKey);
              if (why) {
                kept[why] += 1;
                continue;
              }
              orphans.push(f);
            }
            const digests = orphans.map((f) => f.digestSha256);
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.imaging_orphan_sweeps (tenant_id, actor_id, dry_run, grace_hours, scanned_count,
                 orphan_count, kept_within_grace, kept_live_object, kept_tombstone_retained, kept_legal_hold,
                 kept_export_package, kept_content_locked, orphan_digests, removed_digests)
               VALUES (cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $1, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10, $11, '{}') RETURNING id`,
              [
                dryRun,
                graceHours,
                files.length,
                digests.length,
                kept.withinGrace,
                kept.liveObject,
                kept.tombstoneRetained,
                kept.legalHold,
                kept.exportPackage,
                kept.contentLocked,
                digests,
              ],
            );
            const sweepRef = rows[0]?.id as string;
            // D3: the removal intents commit with the sweep record, before any byte is touched.
            if (!dryRun && orphans.length > 0)
              await tx.query(
                `INSERT INTO cuspatlas.imaging_orphan_removals (tenant_id, sweep_id, digest_sha256, storage_key,
                   intended_by)
                 SELECT cuspatlas.current_tenant_id(), $1, x.d, x.k, cuspatlas.current_actor_id()
                 FROM unnest($2::text[], $3::text[]) AS x(d, k)`,
                [sweepRef, digests, orphans.map((f) => f.storageKey)],
              );
            await recordCommand(
              tx,
              {
                operation: OP,
                resourceType: ORPHAN_SWEEP_RESOURCE,
                resourceRef: sweepRef,
                resourceVersion: 1,
              },
              { changedFields: dryRun ? ['orphanDigests'] : ['orphanDigests', 'removalIntents'] },
            );
            return {
              data: {
                sweepRef,
                dryRun,
                graceHours,
                scanned: files.length,
                orphans: digests,
                removed: [] as string[],
                kept,
                more,
                pending: dryRun ? 0 : digests.length,
                resumed: 0,
              },
              version: 1,
            };
          }),
        );
        const data = result.data as { sweepRef: string; dryRun: boolean; graceHours: number };
        // A real run (or its retry) finishes the committed intents after the sweep record committed.
        if (!data.dryRun) await finishIntents(ctx, maintenance, data.sweepRef, data.graceHours * 3600 * 1000);
        if (!result.replayed && data.dryRun) return result;
        return { ...result, data: { ...data, ...(await outcome(ctx, data.sweepRef)) } };
      });
    },
  };
}
