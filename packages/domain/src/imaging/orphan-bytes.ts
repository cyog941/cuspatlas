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
import { checkEnvelope, type ImagingBase, storeUnavailable } from './base';

export const ORPHAN_SWEEP_RESOURCE = 'imagingOrphanSweep';
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
 * from promotion to commit, so a held lock means "keep"), and the file is removed only if it is still
 * older than the grace period (reusing bytes refreshes their write time). One append-only sweep record
 * and one audit event per run. Removal needs imaging.delete on top of the operation's admin.configure.
 */
export function createOrphanBytesOperations(base: ImagingBase) {
  const { deps, execute } = base;
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
        return deps.withTenantTransaction(ctx, async (tx) => {
          const result = await execute(ctx, envelope, tx, async () => {
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
            const now = Date.now();
            const old = files.filter((f) => {
              const young = now - f.modifiedAt.getTime() <= graceMs;
              if (young) kept.withinGrace += 1;
              return !young;
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
            const orphans: string[] = [];
            const removed: string[] = [];
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
              if (dryRun) {
                orphans.push(f.digestSha256);
                continue;
              }
              if (await maintenance.removeContentIfOlderThan(ctx.tenantId, f.storageKey, graceMs)) {
                orphans.push(f.digestSha256);
                removed.push(f.digestSha256);
              } else kept.withinGrace += 1;
            }
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.imaging_orphan_sweeps (tenant_id, actor_id, dry_run, grace_hours, scanned_count,
                 orphan_count, kept_within_grace, kept_live_object, kept_tombstone_retained, kept_legal_hold,
                 kept_export_package, kept_content_locked, orphan_digests, removed_digests)
               VALUES (cuspatlas.current_tenant_id(), cuspatlas.current_actor_id(), $1, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10, $11, $12) RETURNING id`,
              [
                dryRun,
                graceHours,
                files.length,
                orphans.length,
                kept.withinGrace,
                kept.liveObject,
                kept.tombstoneRetained,
                kept.legalHold,
                kept.exportPackage,
                kept.contentLocked,
                orphans,
                removed,
              ],
            );
            const sweepRef = rows[0]?.id as string;
            await recordCommand(
              tx,
              {
                operation: OP,
                resourceType: ORPHAN_SWEEP_RESOURCE,
                resourceRef: sweepRef,
                resourceVersion: 1,
              },
              { changedFields: dryRun ? ['orphanDigests'] : ['orphanDigests', 'removedDigests'] },
            );
            return {
              data: { sweepRef, dryRun, graceHours, scanned: files.length, orphans, removed, kept, more },
              version: 1,
            };
          });
          if (!result.replayed) return result;
          // The stored projection leaves the digest lists out; read them back from the sweep record.
          const data = result.data as { sweepRef: string };
          const rec = await tx.query<{ orphan_digests: string[]; removed_digests: string[] }>(
            'SELECT orphan_digests, removed_digests FROM cuspatlas.imaging_orphan_sweeps WHERE id = $1',
            [data.sweepRef],
          );
          const r = rec.rows[0];
          return {
            ...result,
            data: { ...data, orphans: r?.orphan_digests ?? [], removed: r?.removed_digests ?? [] },
          };
        });
      });
    },
  };
}
