import {
  type AcquisitionRequest,
  type ActorContext,
  assertValid,
  type BridgeJobReconcile,
  type CommandEnvelope,
  type DeferralResolve,
  IMAGING_PROPERTIES,
  type ObjectStorePort,
  type TenantTransaction,
  validateAcquisitionRequest,
  validateBridgeJobReconcile,
  validateDeferralResolve,
} from '@cuspatlas/contracts';
import { transactionNow } from '../clock';
import { recordCommand } from '../events/record-command';
import { checkEnvelope, checkRef, failed, type ImagingBase, notFound, refused } from './base';
import {
  availabilityOf,
  bumpJob,
  checkCapability,
  DEVICE_COLUMNS,
  type DeviceRow,
  insertJob,
  JOB_COLUMNS,
  type JobRow,
  jobPath,
  loadDevice,
  loadJob,
  sweepBridgeJobs,
} from './bridge';
import type { ReconcileStep } from './objects';

export const DEFERRAL_RESOURCE = 'imagingAcquisitionDeferral';

interface DeferralRow extends Record<string, unknown> {
  id: string;
  device_id: string;
  kind: 'acquire' | 'import';
  scope_path: string | null;
  intended_patient_id: string | null;
  patient_version: number | null;
  defer_reason: 'device_offline' | 'device_stale';
  state: 'deferred' | 'released' | 'cancelled';
  job_id: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_reason: string | null;
  version: number;
  created_by: string;
  created_at: Date;
}
const DEFERRAL_COLUMNS = `id, device_id, kind, scope_path, intended_patient_id, patient_version, defer_reason, state,
  job_id, resolved_by, resolved_at, resolution_reason, version, created_by, created_at`;

interface AcquisitionResult {
  state: 'queued' | 'deferred';
  jobRef: string | null;
  deferralRef: string | null;
  deferReason: string | null;
}

/** A deferred acquisition is due for a decision this long after it was requested (I7, pending approval). */
export const DEFERRAL_DUE_HOURS = 4;

export interface HealthOptions {
  readonly staleSeconds: number;
  readonly offlineSeconds: number;
  readonly maxDeferred: number;
}

async function loadDeferral(tx: TenantTransaction, ref: string): Promise<DeferralRow> {
  checkRef(ref);
  const { rows } = await tx.query<DeferralRow>(
    `SELECT ${DEFERRAL_COLUMNS} FROM cuspatlas.imaging_acquisition_deferrals WHERE id = $1 FOR UPDATE`,
    [ref],
  );
  const r = rows[0];
  if (!r) throw notFound();
  return r;
}

const deferralData = (d: DeferralRow) => ({
  deferralRef: d.id,
  deviceRef: d.device_id,
  state: d.state,
  deferReason: d.defer_reason,
  jobRef: d.job_id,
  resolutionReason: d.resolution_reason,
  version: d.version,
});

/**
 * Lease sweep as a reconcile step of `imaging.storage.reconcile` (I7 recovery). Its effects are visible
 * on the jobs and in the bridge worklist; the reconcile result keeps its I1/I8 counters.
 */
export const sweepBridgeStep: ReconcileStep = async (tx, _ctx, _store: ObjectStorePort, op) => {
  await sweepBridgeJobs(tx, op);
  // Assertion identifiers expired for over an hour can no longer be replayed; the database permits
  // deleting only those (bounded batch per sweep).
  await tx.query(
    `DELETE FROM cuspatlas.imaging_device_nonces WHERE ctid IN (
       SELECT ctid FROM cuspatlas.imaging_device_nonces WHERE expires_at < now() - interval '1 hour' LIMIT 1000)`,
  );
  return {};
};

/** I7: heartbeat-derived availability, deferred acquisitions, job reconciliation and the bridge worklist. */
export function createBridgeHealthOperations(base: ImagingBase, opts: HealthOptions) {
  const { deps } = base;
  const nowOf = async (tx: TenantTransaction) => await transactionNow(tx);

  /** The patient's current version (or merged state) for re-confirmation at release. */
  const patientState = async (tx: TenantTransaction, ref: string) => {
    const { rows } = await tx.query<{ version: number; merged: boolean }>(
      'SELECT version, merged_into IS NOT NULL AS merged FROM cuspatlas.patients WHERE id = $1 FOR SHARE',
      [ref],
    );
    return rows[0] ?? null;
  };

  return {
    /**
     * Requests an acquisition or import on a device. Available device: a queued job. Stale or offline
     * device: a visible deferred item with the reason (bounded per tenant; beyond the bound a typed
     * refusal, never unbounded growth). Unpaired or revoked: refused.
     */
    requestAcquisition(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.acquisitions.request';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid<AcquisitionRequest>(validateAcquisitionRequest, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as AcquisitionRequest;
        const scopePath = jobPath(p.kind, p.importPath);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const d = await loadDevice(tx, p.deviceRef, 'FOR SHARE');
          if (p.intendedPatientRef !== undefined) checkRef(p.intendedPatientRef);
          const pt = p.intendedPatientRef === undefined ? null : await patientState(tx, p.intendedPatientRef);
          if (p.intendedPatientRef !== undefined) {
            if (!pt) throw notFound();
            if (pt.merged) throw refused('patient_merged');
          }
          return base.execute(
            ctx,
            envelope,
            tx,
            async (): Promise<{ data: AcquisitionResult; version: number }> => {
              checkCapability(d, p.kind, scopePath);
              const now = await nowOf(tx);
              const availability = availabilityOf(d, now, opts.staleSeconds, opts.offlineSeconds);
              if (availability === 'available') {
                const job = await insertJob(tx, op, {
                  deviceRef: d.id,
                  kind: p.kind,
                  scopePath,
                  intendedPatientRef: p.intendedPatientRef ?? null,
                  expiresInSeconds: 3600,
                });
                return {
                  data: { state: 'queued', jobRef: job.id, deferralRef: null, deferReason: null },
                  version: 1,
                };
              }
              const open = await tx.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM cuspatlas.imaging_acquisition_deferrals WHERE state = 'deferred'`,
              );
              if ((open.rows[0]?.n ?? 0) >= opts.maxDeferred)
                throw refused(
                  'queue_bound_reached',
                  { limit: { name: 'maxDeferredAcquisitions', value: opts.maxDeferred } },
                  { replayable: false },
                );
              const reason = availability === 'stale' ? 'device_stale' : 'device_offline';
              const { rows } = await tx.query<DeferralRow>(
                `INSERT INTO cuspatlas.imaging_acquisition_deferrals (tenant_id, device_id, kind, scope_path,
                 intended_patient_id, patient_version, defer_reason, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id())
               RETURNING ${DEFERRAL_COLUMNS}`,
                [d.id, p.kind, scopePath, p.intendedPatientRef ?? null, pt?.version ?? null, reason],
              );
              const def = rows[0] as DeferralRow;
              await recordCommand(
                tx,
                { operation: op, resourceType: DEFERRAL_RESOURCE, resourceRef: def.id, resourceVersion: 1 },
                { changedFields: ['state', 'deferReason'] },
              );
              return {
                data: { state: 'deferred', jobRef: null, deferralRef: def.id, deferReason: reason },
                version: 1,
              };
            },
          );
        });
      });
    },

    /**
     * Releases a deferred acquisition to exactly one job once its device is available again (a changed
     * or merged patient needs explicit re-confirmation), or cancels it with a reason (for example after
     * a manual import). Recorded with actor and reason.
     */
    resolveDeferral(ctx: ActorContext, deferralRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.acquisitions.resolve';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(deferralRef);
        assertValid<DeferralResolve>(validateDeferralResolve, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as DeferralResolve;
        if (p.action === 'cancel' && p.reasonCode === undefined) throw failed('missing_reason');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const def = await loadDeferral(tx, deferralRef);
          return base.execute(ctx, { ...envelope, payload: { deferralRef, ...p } }, tx, async () => {
            if (def.state === 'released')
              throw refused('duplicate_release', {
                blockingRefs: [{ kind: 'imagingBridgeJob', ref: def.job_id as string }],
              });
            if (def.state === 'cancelled') throw refused('deferral_closed');
            if (p.action === 'cancel') {
              const { rows } = await tx.query<DeferralRow>(
                `UPDATE cuspatlas.imaging_acquisition_deferrals SET state = 'cancelled', resolved_by = cuspatlas.current_actor_id(),
                   resolved_at = now(), resolution_reason = $2, version = version + 1, updated_at = now()
                 WHERE id = $1 RETURNING ${DEFERRAL_COLUMNS}`,
                [def.id, p.reasonCode],
              );
              const next = rows[0] as DeferralRow;
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: DEFERRAL_RESOURCE,
                  resourceRef: def.id,
                  resourceVersion: next.version,
                },
                { changedFields: ['state', 'resolutionReason'] },
              );
              return { data: deferralData(next), version: next.version };
            }
            const d = await loadDevice(tx, def.device_id, 'FOR SHARE');
            checkCapability(d, def.kind, def.scope_path);
            const availability = availabilityOf(d, await nowOf(tx), opts.staleSeconds, opts.offlineSeconds);
            if (availability !== 'available') throw refused('device_offline', {}, { replayable: false });
            if (def.intended_patient_id !== null) {
              const pt = await patientState(tx, def.intended_patient_id);
              if (!pt || pt.merged || pt.version !== def.patient_version) {
                if (p.patientReconfirmed !== true || pt?.merged)
                  throw refused(
                    pt?.merged ? 'patient_merged' : 'patient_reconfirmation_required',
                    {},
                    { replayable: false },
                  );
              }
            }
            const job = await insertJob(tx, op, {
              deviceRef: d.id,
              kind: def.kind,
              scopePath: def.scope_path,
              intendedPatientRef: def.intended_patient_id,
              expiresInSeconds: 3600,
              deferralRef: def.id,
            });
            const { rows } = await tx.query<DeferralRow>(
              `UPDATE cuspatlas.imaging_acquisition_deferrals SET state = 'released', job_id = $2,
                 resolved_by = cuspatlas.current_actor_id(), resolved_at = now(), resolution_reason = $3,
                 patient_reconfirmed = $4, version = version + 1, updated_at = now()
               WHERE id = $1 RETURNING ${DEFERRAL_COLUMNS}`,
              [def.id, job.id, p.reasonCode ?? null, p.patientReconfirmed === true],
            );
            const next = rows[0] as DeferralRow;
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: DEFERRAL_RESOURCE,
                resourceRef: def.id,
                resourceVersion: next.version,
              },
              { changedFields: ['state', 'jobRef'] },
            );
            return { data: deferralData(next), version: next.version };
          });
        });
      });
    },

    /**
     * A person reconciles a job whose outcome is unknown or that failed or expired: requeue (a new
     * attempt cycle; the bytes, if they arrive again, deduplicate by digest under the I2 rule) or cancel.
     * Never automatic: an unknown outcome is never re-run by the system.
     */
    reconcileJob(ctx: ActorContext, jobRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.bridgeJobs.reconcile';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(jobRef);
        assertValid<BridgeJobReconcile>(validateBridgeJobReconcile, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as BridgeJobReconcile;
        return deps.withTenantTransaction(ctx, async (tx) => {
          await sweepBridgeJobs(tx, op);
          const j = await loadJob(tx, jobRef, 'FOR UPDATE');
          return base.execute(ctx, { ...envelope, payload: { jobRef, ...p } }, tx, async () => {
            if (!['outcome_unknown', 'failed', 'expired'].includes(j.state))
              throw refused('job_not_reconcilable');
            if (j.staging_key !== null && deps.objectStore)
              await deps.objectStore.discardStaged(ctx.tenantId, j.staging_key);
            const next =
              p.action === 'cancel'
                ? await bumpJob(tx, op, j, {
                    state: 'cancelled',
                    claim_nonce: null,
                    lease_expires_at: null,
                    staging_key: null,
                    failure_reason: p.reasonCode,
                  })
                : await bumpJob(tx, op, j, {
                    state: 'queued',
                    attempts: 0,
                    claim_nonce: null,
                    lease_expires_at: null,
                    staging_key: null,
                    observed_digest: null,
                    observed_byte_length: null,
                    ingress_id: null,
                    failure_reason: null,
                    next_attempt_at: new Date(),
                    expires_at: new Date(Date.now() + 3_600_000),
                  });
            return {
              data: { jobRef: next.id, state: next.state, version: next.version },
              version: next.version,
            };
          });
        });
      });
    },

    /**
     * Exception-first bridge worklist: deferred acquisitions, failed jobs, jobs whose outcome is unknown
     * (or whose lease ran out), late results, and devices that are not available while work waits for
     * them. Each item has an owner, a reason, a due time and a next action. Coverage names the devices
     * whose job picture is unknown: an empty list for an unavailable device is not "nothing to do".
     */
    bridgeWorklist(ctx: ActorContext) {
      const op = 'imaging.bridge.worklist';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const now = await nowOf(tx);
          const items: Record<string, unknown>[] = [];
          const devices = await tx.query<DeviceRow>(
            `SELECT ${DEVICE_COLUMNS} FROM cuspatlas.imaging_devices ORDER BY id`,
          );
          const byId = new Map(devices.rows.map((d) => [d.id, d]));
          const due = (from: Date, hours: number) =>
            new Date(from.getTime() + hours * 3_600_000).toISOString();
          const defs = await tx.query<DeferralRow>(
            `SELECT ${DEFERRAL_COLUMNS} FROM cuspatlas.imaging_acquisition_deferrals WHERE state = 'deferred'
             ORDER BY created_at, id LIMIT 100`,
          );
          for (const d of defs.rows) {
            const dev = byId.get(d.device_id);
            const availability = dev
              ? availabilityOf(dev, now, opts.staleSeconds, opts.offlineSeconds)
              : 'revoked';
            const overdue = now.getTime() - d.created_at.getTime() > DEFERRAL_DUE_HOURS * 3_600_000;
            items.push({
              workItemRef: d.id,
              kind: 'acquisition_deferred',
              reasonCode: availability === 'revoked' ? 'device_revoked' : d.defer_reason,
              explanation:
                'An acquisition was requested while its device was not available; it waits for a person to release it once the device is back, or to cancel it (for example after a manual import).',
              evidenceRefs: [
                { kind: DEFERRAL_RESOURCE, ref: d.id },
                { kind: 'imagingDevice', ref: d.device_id },
              ],
              owner: { queue: 'imaging', principalRef: d.created_by },
              nextActionOwedBy: 'practice',
              dueAt: due(d.created_at, DEFERRAL_DUE_HOURS),
              priority: overdue ? 'elevated' : 'routine',
              priorityRationale: overdue ? 'deferral_overdue' : 'default_routine',
              suggestedNextAction:
                availability === 'available'
                  ? 'release_deferral'
                  : availability === 'revoked'
                    ? 'manual_import'
                    : 'restore_device_or_manual_import',
              blockingDependencies: availability === 'available' ? [] : ['bridge_device'],
            });
          }
          const jobs = await tx.query<JobRow & { lease_over: boolean }>(
            `SELECT ${JOB_COLUMNS}, (lease_expires_at IS NOT NULL AND lease_expires_at <= now()) AS lease_over
             FROM cuspatlas.imaging_bridge_jobs
             WHERE state IN ('failed', 'outcome_unknown')
                OR (state IN ('claimed', 'transferring') AND lease_expires_at <= now())
                OR (state = 'expired' AND late_report_at IS NOT NULL)
             ORDER BY updated_at, id LIMIT 100`,
          );
          for (const j of jobs.rows) {
            const unknown =
              j.state === 'outcome_unknown' ||
              (j.lease_over && (j.state === 'transferring' || j.kind === 'acquire'));
            const kind =
              j.state === 'failed'
                ? 'bridge_job_failed'
                : unknown
                  ? 'bridge_outcome_unknown'
                  : j.state === 'expired'
                    ? 'bridge_late_result'
                    : 'bridge_lease_expired';
            items.push({
              workItemRef: j.id,
              kind,
              reasonCode:
                j.failure_reason ??
                (unknown
                  ? 'outcome_unknown'
                  : kind === 'bridge_late_result'
                    ? 'late_result'
                    : 'lease_expired'),
              explanation:
                kind === 'bridge_job_failed'
                  ? 'The bridge job failed (or ran out of attempts); nothing was imported.'
                  : kind === 'bridge_outcome_unknown'
                    ? 'No signed result arrived before the lease ended (bytes may have been received, or an acquisition may already have exposed the patient). The job is never re-run automatically: a late signed result completes it, or a person requeues or cancels it.'
                    : kind === 'bridge_late_result'
                      ? 'A result arrived after the job expired; it was not applied.'
                      : 'The claim lease ran out without bytes; the job is retried with bounded backoff.',
              evidenceRefs: [
                { kind: 'imagingBridgeJob', ref: j.id },
                { kind: 'imagingDevice', ref: j.device_id },
              ],
              owner: { queue: 'imaging', principalRef: j.created_by },
              nextActionOwedBy: kind === 'bridge_lease_expired' ? 'platform' : 'practice',
              dueAt: due(j.created_at, DEFERRAL_DUE_HOURS),
              priority: kind === 'bridge_lease_expired' ? 'routine' : 'elevated',
              priorityRationale: kind === 'bridge_lease_expired' ? 'default_routine' : 'acquisition_gap',
              suggestedNextAction:
                kind === 'bridge_outcome_unknown'
                  ? 'await_signed_result_or_reconcile'
                  : kind === 'bridge_lease_expired'
                    ? 'none_automatic_retry'
                    : 'requeue_or_manual_import',
              blockingDependencies: ['bridge_device'],
            });
          }
          const waiting = await tx.query<{ device_id: string; n: number }>(
            `SELECT device_id, count(*)::int AS n FROM cuspatlas.imaging_bridge_jobs
             WHERE state IN ('queued', 'claimed', 'transferring') GROUP BY device_id`,
          );
          const unavailable: string[] = [];
          for (const dev of devices.rows) {
            const a = availabilityOf(dev, now, opts.staleSeconds, opts.offlineSeconds);
            if (dev.state === 'active' && a !== 'available') unavailable.push(dev.id);
            const n = waiting.rows.find((w) => w.device_id === dev.id)?.n ?? 0;
            if (dev.state === 'active' && a !== 'available' && n > 0) {
              items.push({
                workItemRef: dev.id,
                kind: 'device_unavailable',
                reasonCode: a === 'stale' ? 'device_stale' : 'device_offline',
                explanation: `The device has not sent a heartbeat recently; ${n} job(s) wait for it and their progress is unknown.`,
                evidenceRefs: [{ kind: 'imagingDevice', ref: dev.id }],
                owner: { queue: 'imaging', principalRef: null },
                nextActionOwedBy: 'practice',
                dueAt: now.toISOString(),
                priority: 'elevated',
                priorityRationale: 'acquisition_gap',
                suggestedNextAction: 'check_bridge_device',
                blockingDependencies: ['bridge_device'],
              });
            }
          }
          return {
            asOf: now.toISOString(),
            coverage:
              unavailable.length === 0
                ? { status: 'available', unavailableDevices: [] }
                : { status: 'partial', unavailableDevices: unavailable },
            count: items.length,
            items,
          };
        });
      });
    },
  };
}
