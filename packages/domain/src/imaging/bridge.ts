import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type ActorContext,
  assertValid,
  type BridgeJobEnqueue,
  type BridgeKeyRotate,
  type BridgePair,
  type CommandEnvelope,
  CommitThenRefuse,
  type DeviceCapabilitiesSet,
  type DeviceRegister,
  type DeviceRevoke,
  IMAGING_PROPERTIES,
  type PairingCodeIssue,
  RefusalError,
  type SecurityReasonCode,
  type TenantTransaction,
  validateBridgeJobEnqueue,
  validateBridgeKeyRotate,
  validateBridgePair,
  validateBridgeResultReport,
  validateDeviceCapabilitiesSet,
  validateDeviceRegister,
  validateDeviceRevoke,
  validatePairingCodeIssue,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { checkEnvelope, checkRef, failed, type ImagingBase, notFound, refused } from './base';
import {
  BRIDGE_AUDIENCE,
  JOB_ENVELOPE_TYP,
  JOB_RESULT_TYP,
  keyId,
  pairingProofMessage,
  publicKeyFromRaw,
  rawFromPublicKey,
  rotationProofMessage,
  signCompact,
  verifyCompact,
  verifyProof,
} from './bridge-crypto';
import { safeBridgePath, underPrefix } from './bridge-paths';
import { acceptSession, gateSession, insertBridgeSession, type SessionRow } from './ingress';

export const DEVICE_RESOURCE = 'imagingDevice';
export const JOB_RESOURCE = 'imagingBridgeJob';
const PAIRING_RESOURCE = 'imagingDevicePairing';

/** Bounded retry: 30 s, 60 s, 120 s ... capped at 15 minutes (I7). */
export const bridgeBackoffSeconds = (attempt: number) => Math.min(30 * 2 ** Math.max(attempt - 1, 0), 900);

export interface DeviceRow extends Record<string, unknown> {
  id: string;
  label: string;
  state: 'pending' | 'active' | 'revoked';
  allowed_job_kinds: string[];
  allowed_path_prefixes: string[];
  key_version: number;
  last_heartbeat_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  version: number;
  created_at: Date;
}
export const DEVICE_COLUMNS = `id, label, state, allowed_job_kinds, allowed_path_prefixes, key_version,
  last_heartbeat_at, revoked_at, revoke_reason, version, created_at`;

export interface JobRow extends Record<string, unknown> {
  id: string;
  device_id: string;
  kind: 'acquire' | 'import' | 'probe';
  scope_path: string | null;
  intended_patient_id: string | null;
  state: string;
  attempts: number;
  max_attempts: number;
  claim_nonce: string | null;
  lease_expires_at: Date | null;
  next_attempt_at: Date;
  expires_at: Date;
  staging_key: string | null;
  observed_digest: string | null;
  observed_byte_length: string | null;
  ingress_id: string | null;
  object_id: string | null;
  result_digest: string | null;
  failure_reason: string | null;
  duplicate_reports: number;
  late_report_at: Date | null;
  deferral_id: string | null;
  version: number;
  created_by: string;
  created_at: Date;
}
export const JOB_COLUMNS = `id, device_id, kind, scope_path, intended_patient_id, state, attempts, max_attempts,
  claim_nonce, lease_expires_at, next_attempt_at, expires_at, staging_key, observed_digest, observed_byte_length,
  ingress_id, object_id, result_digest, failure_reason, duplicate_reports, late_report_at, deferral_id, version,
  created_by, created_at`;

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const iso = (d: Date | null) => (d === null ? null : d.toISOString());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAIRING_CODE = /^cpb1\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const unauth = (reasonCode: SecurityReasonCode) => new RefusalError({ code: 'unauthenticated', reasonCode });
const deviceDenied = (reasonCode: SecurityReasonCode) => new RefusalError({ code: 'forbidden', reasonCode });

export async function loadDevice(tx: TenantTransaction, ref: string, lock = ''): Promise<DeviceRow> {
  checkRef(ref);
  const { rows } = await tx.query<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS} FROM cuspatlas.imaging_devices WHERE id = $1 ${lock}`,
    [ref],
  );
  const r = rows[0];
  if (!r) throw notFound();
  return r;
}

export async function loadJob(tx: TenantTransaction, ref: string, lock = ''): Promise<JobRow> {
  checkRef(ref);
  const { rows } = await tx.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM cuspatlas.imaging_bridge_jobs WHERE id = $1 ${lock}`,
    [ref],
  );
  const r = rows[0];
  if (!r) throw notFound();
  return r;
}

export async function bumpJob(
  tx: TenantTransaction,
  op: string,
  job: JobRow,
  set: Record<string, unknown>,
): Promise<JobRow> {
  const cols = Object.keys(set);
  const { rows } = await tx.query<JobRow>(
    `UPDATE cuspatlas.imaging_bridge_jobs SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')},
       version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${JOB_COLUMNS}`,
    [job.id, ...cols.map((c) => set[c])],
  );
  const next = rows[0];
  if (!next) throw new Error('job update returned no row');
  await recordCommand(
    tx,
    { operation: op, resourceType: JOB_RESOURCE, resourceRef: next.id, resourceVersion: next.version },
    { changedFields: cols.map((c) => c.replace(/_([a-z])/g, (_m, x: string) => x.toUpperCase())) },
  );
  return next;
}

async function bumpDevice(
  tx: TenantTransaction,
  op: string,
  device: DeviceRow,
  set: Record<string, unknown>,
): Promise<DeviceRow> {
  const cols = Object.keys(set);
  const { rows } = await tx.query<DeviceRow>(
    `UPDATE cuspatlas.imaging_devices SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')},
       version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${DEVICE_COLUMNS}`,
    [device.id, ...cols.map((c) => set[c])],
  );
  const next = rows[0];
  if (!next) throw new Error('device update returned no row');
  await recordCommand(
    tx,
    { operation: op, resourceType: DEVICE_RESOURCE, resourceRef: next.id, resourceVersion: next.version },
    { changedFields: cols.map((c) => c.replace(/_([a-z])/g, (_m, x: string) => x.toUpperCase())) },
  );
  return next;
}

export function jobData(j: JobRow) {
  return {
    jobRef: j.id,
    deviceRef: j.device_id,
    kind: j.kind,
    scopePath: j.scope_path,
    intendedPatientRef: j.intended_patient_id,
    state: j.state,
    attempts: j.attempts,
    maxAttempts: j.max_attempts,
    leaseExpiresAt: iso(j.lease_expires_at),
    nextAttemptAt: j.next_attempt_at.toISOString(),
    expiresAt: j.expires_at.toISOString(),
    objectRef: j.object_id,
    failureReason: j.failure_reason,
    duplicateReports: j.duplicate_reports,
    lateReportAt: iso(j.late_report_at),
    deferralRef: j.deferral_id,
    version: j.version,
    createdAt: j.created_at.toISOString(),
  };
}

/** Device availability from its last heartbeat (I7); thresholds in seconds. */
export function availabilityOf(
  d: Pick<DeviceRow, 'state' | 'last_heartbeat_at'>,
  now: Date,
  staleSeconds: number,
  offlineSeconds: number,
): 'available' | 'stale' | 'offline' | 'unpaired' | 'revoked' {
  if (d.state === 'revoked') return 'revoked';
  if (d.state === 'pending') return 'unpaired';
  if (d.last_heartbeat_at === null) return 'offline';
  const age = (now.getTime() - d.last_heartbeat_at.getTime()) / 1000;
  if (age <= staleSeconds) return 'available';
  if (age <= offlineSeconds) return 'stale';
  return 'offline';
}

/** Staff view of a device: never a key, code or secret. */
export function deviceView(d: DeviceRow, now: Date, h: { staleSeconds: number; offlineSeconds: number }) {
  const state = availabilityOf(d, now, h.staleSeconds, h.offlineSeconds);
  return {
    deviceRef: d.id,
    label: d.label,
    state: d.state,
    allowedJobKinds: d.allowed_job_kinds,
    allowedPathPrefixes: d.allowed_path_prefixes,
    keyVersion: d.key_version,
    availability: {
      state,
      asOf: now.toISOString(),
      lastHeartbeatAt: iso(d.last_heartbeat_at),
      jobsVisible: state === 'available' ? ('complete' as const) : ('unknown_since_last_heartbeat' as const),
    },
    revokedAt: iso(d.revoked_at),
    revokeReason: d.revoke_reason,
    version: d.version,
    createdAt: d.created_at.toISOString(),
  };
}

function checkPaths(prefixes: readonly string[]): void {
  if (!prefixes.every(safeBridgePath)) throw failed('path_traversal');
}

/** Capability check of a job request against the device's current allowlist (enqueue and release). */
export function checkCapability(device: DeviceRow, kind: string, scopePath: string | null): void {
  if (device.state === 'pending') throw refused('device_unpaired');
  if (device.state === 'revoked') throw refused('device_revoked');
  if (!device.allowed_job_kinds.includes(kind)) throw refused('capability_not_allowlisted');
  if (scopePath !== null && !underPrefix(scopePath, device.allowed_path_prefixes))
    throw refused('path_outside_import_root');
}

/** Validates the path of a job request (syntax first, so traversal is never a capability question). */
export function jobPath(kind: string, importPath: string | undefined): string | null {
  if (importPath === undefined) {
    if (kind === 'import') throw failed('import_path_required');
    return null;
  }
  if (!safeBridgePath(importPath)) throw failed('path_traversal');
  return importPath;
}

/** Inserts a queued job (enqueue, acquisition, deferral release). */
export async function insertJob(
  tx: TenantTransaction,
  op: string,
  j: {
    deviceRef: string;
    kind: string;
    scopePath: string | null;
    intendedPatientRef: string | null;
    expiresInSeconds: number;
    deferralRef?: string;
  },
): Promise<JobRow> {
  const { rows } = await tx.query<JobRow>(
    `INSERT INTO cuspatlas.imaging_bridge_jobs (tenant_id, device_id, kind, scope_path, intended_patient_id, state,
       expires_at, deferral_id, created_by)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, 'queued', now() + make_interval(secs => $5), $6,
       cuspatlas.current_actor_id())
     RETURNING ${JOB_COLUMNS}`,
    [j.deviceRef, j.kind, j.scopePath, j.intendedPatientRef, j.expiresInSeconds, j.deferralRef ?? null],
  );
  const job = rows[0] as JobRow;
  await recordCommand(
    tx,
    { operation: op, resourceType: JOB_RESOURCE, resourceRef: job.id, resourceVersion: 1 },
    { changedFields: ['state', 'kind', 'scopePath'] },
  );
  return job;
}

/**
 * Lease sweep (I7 failure and recovery): a claimed job whose lease ran out without bytes is retried
 * with bounded backoff (or fails after max attempts) when it is an import or probe; an acquire job
 * whose lease ran out is always `outcome_unknown` (the device may already have exposed the patient); a
 * job whose bytes were staged but whose result never arrived is `outcome_unknown` (never re-run automatically: a late signed result can still
 * complete it, or a person reconciles it); a queued job past its expiry is `expired`.
 */
export async function sweepBridgeJobs(
  tx: TenantTransaction,
  op: string,
  deviceRef?: string,
): Promise<{ requeued: number; failed: number; unknown: number; expired: number }> {
  const out = { requeued: 0, failed: 0, unknown: 0, expired: 0 };
  const { rows } = await tx.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM cuspatlas.imaging_bridge_jobs
     WHERE ($1::uuid IS NULL OR device_id = $1)
       AND ((state IN ('claimed', 'transferring') AND lease_expires_at <= now())
         OR (state = 'queued' AND expires_at <= now()))
     ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`,
    [deviceRef ?? null],
  );
  for (const j of rows) {
    if (j.state === 'queued') {
      await bumpJob(tx, op, j, { state: 'expired', failure_reason: 'job_expired' });
      out.expired += 1;
    } else if (j.state === 'transferring' || j.kind === 'acquire') {
      // Radiation safety: an acquire job whose lease ran out may already have exposed the patient, so
      // it is never requeued automatically (only import and probe are safe to repeat).
      await bumpJob(tx, op, j, { state: 'outcome_unknown', lease_expires_at: null });
      out.unknown += 1;
    } else if (j.attempts < j.max_attempts) {
      await bumpJob(tx, op, j, {
        state: 'queued',
        claim_nonce: null,
        lease_expires_at: null,
        next_attempt_at: new Date(Date.now() + bridgeBackoffSeconds(j.attempts) * 1000),
      });
      out.requeued += 1;
    } else {
      await bumpJob(tx, op, j, {
        state: 'failed',
        claim_nonce: null,
        lease_expires_at: null,
        failure_reason: 'attempts_exhausted',
      });
      out.failed += 1;
    }
  }
  return out;
}

export interface BridgeOptions {
  /** Heartbeat age after which a device is stale, then offline (seconds). */
  readonly staleSeconds: number;
  readonly offlineSeconds: number;
  /** Lease of a claimed job in seconds (default 300). */
  readonly leaseSeconds: number;
  /** Largest clock skew accepted for a signed result's reportedAt (default 300 s). */
  readonly resultSkewSeconds: number;
}

/** I6: device registration, pairing, allowlist, revocation, signed jobs and signed results. */
export function createBridgeOperations(base: ImagingBase, opts: BridgeOptions) {
  const { deps } = base;
  const health = { staleSeconds: opts.staleSeconds, offlineSeconds: opts.offlineSeconds };
  const signingKey = () => {
    if (!deps.bridgeSigningKey) {
      base.alert('imaging_bridge_signing_key_missing');
      throw new RefusalError({ code: 'service_unavailable', retryable: true });
    }
    return deps.bridgeSigningKey;
  };
  const serverPublic = () => {
    const raw = rawFromPublicKey(createPublicKey(signingKey()));
    return { raw, kid: keyId(raw) };
  };
  /** A device operation runs only for a device principal (the route authenticator guarantees it). */
  const asDevice = (ctx: ActorContext) => {
    if (ctx.principal !== 'device') throw deviceDenied('principal_kind_denied');
  };
  const activeDevice = async (tx: TenantTransaction, ctx: ActorContext, lock = 'FOR SHARE') => {
    const d = await loadDevice(tx, ctx.actorId, lock);
    if (d.state !== 'active')
      throw deviceDenied(d.state === 'pending' ? 'device_unpaired' : 'device_revoked');
    return d;
  };

  return {
    // ---- staff side ----
    registerDevice(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.devices.register';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid<DeviceRegister>(validateDeviceRegister, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as DeviceRegister;
        checkPaths(p.allowedPathPrefixes);
        return deps.withTenantTransaction(ctx, (tx) =>
          base.execute(ctx, envelope, tx, async () => {
            const id = randomUUID();
            await tx.query(`INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'device', $2)`, [
              id,
              `device-${id}`,
            ]);
            await tx.query(
              `INSERT INTO cuspatlas.imaging_devices (id, tenant_id, label, state, allowed_job_kinds,
                 allowed_path_prefixes, created_by)
               VALUES ($1, cuspatlas.current_tenant_id(), $2, 'pending', $3::text[], $4::text[],
                 cuspatlas.current_actor_id())`,
              [id, p.label, [...new Set(p.allowedJobKinds)], [...new Set(p.allowedPathPrefixes)]],
            );
            await recordCommand(
              tx,
              { operation: op, resourceType: DEVICE_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['state', 'allowedJobKinds', 'allowedPathPrefixes'] },
            );
            return { data: { deviceRef: id, state: 'pending', version: 1 }, version: 1 };
          }),
        );
      });
    },

    /**
     * Issues a one-time pairing code (shown once; only its SHA-256 is stored). Not idempotent by key:
     * each call supersedes the previous open code, so a code never enters command_idempotency.
     */
    issuePairingCode(ctx: ActorContext, deviceRef: string, body: unknown) {
      const op = 'imaging.devices.issuePairingCode';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(deviceRef);
        assertValid<PairingCodeIssue>(validatePairingCodeIssue, body ?? {}, IMAGING_PROPERTIES);
        const ttl = (body as PairingCodeIssue | undefined)?.ttlSeconds ?? 600;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const d = await loadDevice(tx, deviceRef, 'FOR UPDATE');
          if (d.state === 'active') throw refused('device_already_paired');
          if (d.state === 'revoked') throw refused('device_revoked');
          await tx.query(
            `UPDATE cuspatlas.imaging_device_pairings SET superseded_at = now()
             WHERE device_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
            [d.id],
          );
          const secret = randomBytes(32).toString('base64url');
          const { rows } = await tx.query<{ id: string; expires_at: Date }>(
            `INSERT INTO cuspatlas.imaging_device_pairings (tenant_id, device_id, secret_sha256, expires_at, created_by)
             VALUES (cuspatlas.current_tenant_id(), $1, $2, now() + make_interval(secs => $3), cuspatlas.current_actor_id())
             RETURNING id, expires_at`,
            [d.id, sha256(secret), ttl],
          );
          const pr = rows[0] as { id: string; expires_at: Date };
          await recordCommand(
            tx,
            { operation: op, resourceType: PAIRING_RESOURCE, resourceRef: pr.id, resourceVersion: 1 },
            { changedFields: ['expiresAt'] },
          );
          return {
            data: {
              deviceRef: d.id,
              pairingRef: pr.id,
              pairingCode: `cpb1.${ctx.tenantId}.${d.id}.${pr.id}.${secret}`,
              expiresAt: pr.expires_at.toISOString(),
            },
          };
        });
      });
    },

    setDeviceCapabilities(ctx: ActorContext, deviceRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.devices.setCapabilities';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(deviceRef);
        assertValid<DeviceCapabilitiesSet>(
          validateDeviceCapabilitiesSet,
          envelope.payload,
          IMAGING_PROPERTIES,
        );
        const p = envelope.payload as DeviceCapabilitiesSet;
        checkPaths(p.allowedPathPrefixes);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const d = await loadDevice(tx, deviceRef, 'FOR UPDATE');
          return base.execute(ctx, { ...envelope, payload: { deviceRef, ...p } }, tx, async () => {
            if (d.state === 'revoked') throw refused('device_revoked');
            if (d.version !== p.expectedVersion)
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: d.version } });
            const next = await bumpDevice(tx, op, d, {
              allowed_job_kinds: [...new Set(p.allowedJobKinds)],
              allowed_path_prefixes: [...new Set(p.allowedPathPrefixes)],
            });
            return {
              data: { deviceRef: d.id, state: next.state, version: next.version },
              version: next.version,
            };
          });
        });
      });
    },

    /**
     * Revokes a device: final. Its keys are revoked, and every open job (queued, claimed,
     * transferring, outcome unknown) is denied at once with its staged bytes discarded, so a job the
     * device already claimed cannot complete.
     */
    revokeDevice(ctx: ActorContext, deviceRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.devices.revoke';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(deviceRef);
        assertValid<DeviceRevoke>(validateDeviceRevoke, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as DeviceRevoke;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const d = await loadDevice(tx, deviceRef, 'FOR UPDATE');
          return base.execute(ctx, { ...envelope, payload: { deviceRef, ...p } }, tx, async () => {
            if (d.state === 'revoked') throw refused('device_revoked');
            const next = await bumpDevice(tx, op, d, {
              state: 'revoked',
              revoked_at: new Date(),
              revoked_by: ctx.actorId,
              revoke_reason: p.reasonCode,
            });
            await tx.query(
              `UPDATE cuspatlas.imaging_device_keys SET state = 'revoked', ended_at = now()
               WHERE device_id = $1 AND state = 'active'`,
              [d.id],
            );
            const open = await tx.query<JobRow>(
              `SELECT ${JOB_COLUMNS} FROM cuspatlas.imaging_bridge_jobs
               WHERE device_id = $1 AND state IN ('queued', 'claimed', 'transferring', 'outcome_unknown')
               ORDER BY id FOR UPDATE`,
              [d.id],
            );
            for (const j of open.rows) {
              if (j.staging_key !== null && deps.objectStore)
                await deps.objectStore.discardStaged(ctx.tenantId, j.staging_key);
              await bumpJob(tx, op, j, {
                state: 'denied',
                failure_reason: 'device_revoked',
                claim_nonce: null,
                lease_expires_at: null,
                staging_key: null,
              });
            }
            return {
              data: {
                deviceRef: d.id,
                state: 'revoked',
                version: next.version,
                deniedJobs: open.rows.length,
              },
              version: next.version,
            };
          });
        });
      });
    },

    enqueueBridgeJob(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.bridgeJobs.enqueue';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid<BridgeJobEnqueue>(validateBridgeJobEnqueue, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as BridgeJobEnqueue;
        const scopePath = jobPath(p.kind, p.importPath);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const d = await loadDevice(tx, p.deviceRef, 'FOR SHARE');
          if (p.intendedPatientRef !== undefined) {
            checkRef(p.intendedPatientRef);
            const pt = await tx.query('SELECT 1 FROM cuspatlas.patients WHERE id = $1', [
              p.intendedPatientRef,
            ]);
            if (pt.rowCount !== 1) throw notFound();
          }
          return base.execute(ctx, envelope, tx, async () => {
            checkCapability(d, p.kind, scopePath);
            const job = await insertJob(tx, op, {
              deviceRef: d.id,
              kind: p.kind,
              scopePath,
              intendedPatientRef: p.intendedPatientRef ?? null,
              expiresInSeconds: p.expiresInSeconds ?? 3600,
            });
            return {
              data: { jobRef: job.id, state: 'queued', expiresAt: job.expires_at.toISOString() },
              version: 1,
            };
          });
        });
      });
    },

    readBridgeJob(ctx: ActorContext, jobRef: string) {
      const op = 'imaging.bridgeJobs.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(jobRef);
        return deps.withTenantTransaction(ctx, async (tx) => jobData(await loadJob(tx, jobRef)));
      });
    },

    listDevices(ctx: ActorContext) {
      const op = 'imaging.devices.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const now = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          const { rows } = await tx.query<DeviceRow>(
            `SELECT ${DEVICE_COLUMNS} FROM cuspatlas.imaging_devices ORDER BY created_at DESC, id LIMIT 100`,
          );
          return rows.map((d) => deviceView(d, now, health));
        });
      });
    },

    readDevice(ctx: ActorContext, deviceRef: string) {
      const op = 'imaging.devices.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(deviceRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const now = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          return deviceView(await loadDevice(tx, deviceRef), now, health);
        });
      });
    },

    // ---- device side (principal kind `device`, bridge audience, REST only) ----

    /**
     * Pairing: the one-time code names the tenant, device and pairing; the bridge proves possession of
     * the private key it registers by signing a fixed message. Every failure is the same 401 to the
     * caller (the attempt row names the reason, with no tenant or actor: nothing is established yet).
     */
    async pairDevice(correlationId: string, body: unknown) {
      const op = 'imaging.bridge.pair';
      const fail = async (reasonCode: SecurityReasonCode): Promise<never> => {
        const err = unauth(reasonCode);
        try {
          await deps.recording.sink.record({
            correlationId,
            operation: op,
            tenantId: null,
            actorId: null,
            reasonCode,
          });
          err.attemptRecorded = true;
        } catch {
          deps.recording.alert('security_attempt_sink_unavailable');
          const u = new RefusalError({ code: 'service_unavailable', retryable: true });
          u.attemptRecorded = true;
          throw u;
        }
        throw err;
      };
      if (validateBridgePair(body) !== true) return fail('device_pairing_invalid');
      const p = body as BridgePair;
      const m = PAIRING_CODE.exec(p.pairingCode);
      const key = publicKeyFromRaw(p.publicKey);
      if (!m || !key) return fail('device_pairing_invalid');
      const [, tenantId, deviceId, pairingId, secret] = m as unknown as [
        string,
        string,
        string,
        string,
        string,
      ];
      if (![tenantId, deviceId, pairingId].every((x) => UUID.test(x))) return fail('device_pairing_invalid');
      if (!verifyProof(pairingProofMessage(pairingId, p.publicKey), p.proof, key))
        return fail('device_pairing_invalid');
      const server = serverPublic();
      const ctx: ActorContext = Object.freeze({
        tenantId,
        actorId: deviceId,
        principal: 'device',
        sessionId: pairingId,
        scopes: Object.freeze([]) as readonly string[],
        correlationId,
      });
      let outcome: { reason: SecurityReasonCode } | { data: Record<string, unknown> };
      try {
        outcome = await deps.withTenantTransaction(ctx, async (tx) => {
          const pr = await tx.query<{
            secret_sha256: string;
            expired: boolean;
            consumed_at: Date | null;
            superseded_at: Date | null;
          }>(
            `SELECT secret_sha256, expires_at <= now() AS expired, consumed_at, superseded_at
             FROM cuspatlas.imaging_device_pairings WHERE id = $1 AND device_id = $2 FOR UPDATE`,
            [pairingId, deviceId],
          );
          const row = pr.rows[0];
          const match =
            row !== undefined &&
            timingSafeEqual(Buffer.from(row.secret_sha256, 'hex'), Buffer.from(sha256(secret), 'hex'));
          if (!row || !match) return { reason: 'device_pairing_invalid' as const };
          if (row.consumed_at !== null) return { reason: 'device_pairing_used' as const };
          if (row.superseded_at !== null) return { reason: 'device_pairing_invalid' as const };
          if (row.expired) return { reason: 'device_pairing_expired' as const };
          const d = await loadDevice(tx, deviceId, 'FOR UPDATE');
          if (d.state !== 'pending') return { reason: 'device_pairing_used' as const };
          await tx.query(`UPDATE cuspatlas.imaging_device_pairings SET consumed_at = now() WHERE id = $1`, [
            pairingId,
          ]);
          await tx.query(
            `INSERT INTO cuspatlas.imaging_device_keys (tenant_id, device_id, key_version, public_key, state)
             VALUES (cuspatlas.current_tenant_id(), $1, 1, $2, 'active')`,
            [deviceId, p.publicKey],
          );
          const next = await bumpDevice(tx, op, d, { state: 'active', key_version: 1 });
          return {
            data: {
              deviceRef: deviceId,
              keyVersion: 1,
              audience: BRIDGE_AUDIENCE,
              jobSigningKey: server.raw,
              jobSigningKeyId: server.kid,
              assertionMaxSeconds: 120,
              version: next.version,
            },
          };
        });
      } catch (err) {
        // An unknown tenant or device fails the transaction's principal recheck: the same 401.
        if (err instanceof RefusalError && (err.code === 'forbidden' || err.code === 'not_found'))
          return fail('device_pairing_invalid');
        if ((err as { code?: unknown }).code === '23505') return fail('device_pairing_invalid');
        throw err;
      }
      if ('reason' in outcome) return fail(outcome.reason);
      return { data: outcome.data };
    },

    /** Claims the next ready job, rechecking the allowlist at execution; returns a signed envelope. */
    claimJob(ctx: ActorContext) {
      const op = 'imaging.bridge.claim';
      return base.recorded(ctx, op, async () => {
        asDevice(ctx);
        const key = signingKey();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const d = await activeDevice(tx, ctx);
          await sweepBridgeJobs(tx, op, d.id);
          for (let i = 0; i < 20; i += 1) {
            const { rows } = await tx.query<JobRow>(
              `SELECT ${JOB_COLUMNS} FROM cuspatlas.imaging_bridge_jobs
               WHERE device_id = $1 AND state = 'queued' AND next_attempt_at <= now() AND expires_at > now()
               ORDER BY next_attempt_at, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
              [d.id],
            );
            const j = rows[0];
            if (!j) return { data: { envelope: null, jobRef: null } };
            const allowed = await tx.query<{ ok: boolean }>(
              'SELECT cuspatlas.imaging_bridge_job_allowed($1, $2, $3) AS ok',
              [d.id, j.kind, j.scope_path],
            );
            if (allowed.rows[0]?.ok !== true) {
              // Revalidated at execution: an allowlist edit after enqueue denies the job, never runs it.
              await bumpJob(tx, op, j, {
                state: 'denied',
                failure_reason: d.allowed_job_kinds.includes(j.kind)
                  ? 'path_outside_import_root'
                  : 'capability_not_allowlisted',
              });
              continue;
            }
            const claimed = await bumpJob(tx, op, j, {
              state: 'claimed',
              attempts: j.attempts + 1,
              claim_nonce: randomUUID(),
              lease_expires_at: new Date(Date.now() + opts.leaseSeconds * 1000),
            });
            const now = new Date();
            const envelope = signCompact(
              { alg: 'EdDSA', typ: JOB_ENVELOPE_TYP, kid: serverPublic().kid },
              {
                v: 1,
                aud: BRIDGE_AUDIENCE,
                jobRef: claimed.id,
                deviceRef: d.id,
                tenantRef: ctx.tenantId,
                kind: claimed.kind,
                scopePath: claimed.scope_path,
                nonce: claimed.claim_nonce,
                attempt: claimed.attempts,
                issuedAt: now.toISOString(),
                leaseExpiresAt: iso(claimed.lease_expires_at),
                expiresAt: claimed.expires_at.toISOString(),
              },
              key,
            );
            return { data: { envelope, jobRef: claimed.id } };
          }
          return { data: { envelope: null, jobRef: null } };
        });
      });
    },

    /** Stages the bytes of a claimed acquire/import job (REST only, device only). */
    uploadJobContent(ctx: ActorContext, jobRef: string, body: unknown) {
      const op = 'imaging.bridge.content';
      return base.recorded(ctx, op, async () => {
        asDevice(ctx);
        checkRef(jobRef);
        if (!(body instanceof Uint8Array) || body.byteLength === 0)
          throw new RefusalError({ code: 'invalid_request' });
        if (body.byteLength > base.maxObjectBytes)
          throw failed('oversize_object', { limit: { name: 'maxObjectBytes', value: base.maxObjectBytes } });
        const store = base.store();
        return deps.withTenantTransaction(ctx, async (tx) => {
          await activeDevice(tx, ctx);
          const j = await loadJob(tx, jobRef, 'FOR UPDATE');
          if (j.device_id !== ctx.actorId) throw notFound();
          if (j.kind === 'probe') throw refused('job_kind_has_no_content');
          if (j.state === 'transferring') throw refused('bytes_already_received');
          if (j.state !== 'claimed') throw refused('job_not_claimed');
          if ((j.lease_expires_at as Date).getTime() <= Date.now()) throw refused('lease_expired');
          const staged = await store.stage(ctx.tenantId, body);
          const next = await bumpJob(tx, op, j, {
            state: 'transferring',
            staging_key: staged.stagingKey,
            observed_digest: staged.digestSha256,
            observed_byte_length: staged.byteLength,
          });
          return {
            data: {
              jobRef: next.id,
              state: next.state,
              observedDigest: staged.digestSha256,
              byteLength: staged.byteLength,
            },
          };
        });
      });
    },

    /**
     * A signed job result. The device signs {jobRef, deviceRef, nonce, attempt, outcome, artifact} with
     * its current key; the server checks the signature, the claim nonce and attempt (replay), freshness,
     * and that the signed artifact digest equals the staged bytes; then the I2 gates run and the object
     * is created (or deduplicated) with bridgeImport provenance. A result for a completed job is a
     * recorded duplicate (409 replayed_result, never a second object).
     */
    reportJobResult(ctx: ActorContext, jobRef: string, body: unknown) {
      const op = 'imaging.bridge.result';
      return base.recorded(ctx, op, async () => {
        asDevice(ctx);
        checkRef(jobRef);
        assertValid(validateBridgeResultReport, body, IMAGING_PROPERTIES);
        const token = (body as { result: string }).result;
        const store = base.store();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const d = await activeDevice(tx, ctx);
          // Visibility first: another tenant's or another device's job is the same 404 as a missing one.
          const j = await loadJob(tx, jobRef, 'FOR UPDATE');
          if (j.device_id !== d.id) throw notFound();
          const keyRow = await tx.query<{ public_key: string }>(
            `SELECT public_key FROM cuspatlas.imaging_device_keys WHERE device_id = $1 AND state = 'active'`,
            [d.id],
          );
          const pub = publicKeyFromRaw(keyRow.rows[0]?.public_key ?? '');
          const payload = pub ? verifyCompact(token, pub, JOB_RESULT_TYP) : null;
          if (!payload) throw unauth('device_signature_invalid');
          const r = parseResult(payload);
          if (!r || r.jobRef !== jobRef || r.deviceRef !== d.id) throw unauth('device_signature_invalid');
          if (Math.abs(Date.parse(r.reportedAt) - Date.now()) > opts.resultSkewSeconds * 1000)
            throw refused('result_stale', {}, { replayable: false });
          if (j.state === 'completed') {
            if (r.nonce === j.claim_nonce || r.artifact?.digestSha256 === j.result_digest) {
              await bumpJob(tx, op, j, { duplicate_reports: j.duplicate_reports + 1 });
              throw new CommitThenRefuse(
                refused(
                  'replayed_result',
                  { blockingRefs: [{ kind: 'imagingObject', ref: j.object_id as string }] },
                  { replayable: false },
                ),
              );
            }
            throw refused('job_closed', {}, { replayable: false });
          }
          if (['failed', 'expired', 'denied', 'cancelled'].includes(j.state)) {
            if (j.state === 'expired' || j.state === 'failed') {
              // Surfaced for operator review (worklist), never applied.
              await bumpJob(tx, op, j, { late_report_at: new Date() });
              throw new CommitThenRefuse(refused('late_result', {}, { replayable: false }));
            }
            throw refused(j.state === 'denied' ? 'job_denied' : 'job_closed', {}, { replayable: false });
          }
          if (j.state === 'queued') throw refused('job_not_claimed', {}, { replayable: false });
          if (r.nonce !== j.claim_nonce || r.attempt !== j.attempts)
            throw refused('stale_attempt', {}, { replayable: false });
          if (r.outcome === 'failed') {
            if (j.staging_key !== null) await store.discardStaged(ctx.tenantId, j.staging_key);
            const retry = r.retryable === true && j.attempts < j.max_attempts;
            const next = await bumpJob(tx, op, j, {
              state: retry ? 'queued' : 'failed',
              claim_nonce: null,
              lease_expires_at: null,
              staging_key: null,
              observed_digest: null,
              observed_byte_length: null,
              failure_reason: r.failureReason,
              ...(retry
                ? { next_attempt_at: new Date(Date.now() + bridgeBackoffSeconds(j.attempts) * 1000) }
                : {}),
            });
            return { data: { jobRef: j.id, state: next.state, objectRef: null, deduplicated: false } };
          }
          if (j.kind === 'probe') {
            if (r.artifact) throw failed('probe_has_no_artifact');
            const next = await bumpJob(tx, op, j, {
              state: 'completed',
              claim_nonce: null,
              lease_expires_at: null,
            });
            return { data: { jobRef: j.id, state: next.state, objectRef: null, deduplicated: false } };
          }
          if (!r.artifact) throw failed('artifact_required');
          if (j.staging_key === null || j.observed_digest === null) throw refused('bytes_not_received');
          if (
            r.artifact.digestSha256 !== j.observed_digest ||
            r.artifact.byteLength !== Number(j.observed_byte_length)
          )
            throw refused('artifact_digest_mismatch', {}, { replayable: false, reasonCode: 'upload_gated' });
          // The ingress record of this job (created once; a scan-pending retry reuses it).
          let session: SessionRow;
          if (j.ingress_id === null) {
            session = await insertBridgeSession(tx, op, ctx, {
              contentType: r.artifact.contentType,
              byteLength: r.artifact.byteLength,
              digest: r.artifact.digestSha256,
              intendedPatientRef: j.intended_patient_id,
              deviceRef: d.id,
              captureSoftware: r.captureSoftware ?? null,
              stagingKey: j.staging_key,
            });
            await bumpJob(tx, op, j, { ingress_id: session.id });
          } else {
            const { rows } = await tx.query<SessionRow>(
              `SELECT * FROM cuspatlas.imaging_ingress_sessions WHERE id = $1 FOR UPDATE`,
              [j.ingress_id],
            );
            session = rows[0] as SessionRow;
          }
          const gated = await gateSession(base, tx, ctx, op, session, r.artifact.digestSha256);
          if (gated) {
            const fresh = await loadJob(tx, jobRef, 'FOR UPDATE');
            if (gated.held) {
              throw new CommitThenRefuse(gated.refusal);
            }
            await bumpJob(tx, op, fresh, {
              state: 'failed',
              claim_nonce: null,
              lease_expires_at: null,
              staging_key: null,
              failure_reason: gated.reason,
            });
            throw new CommitThenRefuse(gated.refusal);
          }
          const accepted = await acceptSession(base, tx, ctx, op, session);
          const fresh = await loadJob(tx, jobRef, 'FOR UPDATE');
          await bumpJob(tx, op, fresh, {
            state: 'completed',
            claim_nonce: null,
            lease_expires_at: null,
            staging_key: null,
            object_id: accepted.objectRef,
            result_digest: r.artifact.digestSha256,
          });
          return {
            data: {
              jobRef: j.id,
              state: 'completed',
              objectRef: accepted.objectRef,
              deduplicated: accepted.deduplicated,
            },
          };
        });
      });
    },

    /** Heartbeat (I7): operational telemetry, no version bump and no audit row (documented). */
    heartbeat(ctx: ActorContext) {
      const op = 'imaging.bridge.heartbeat';
      return base.recorded(ctx, op, async () => {
        asDevice(ctx);
        return deps.withTenantTransaction(ctx, async (tx) => {
          await activeDevice(tx, ctx, 'FOR UPDATE');
          const { rows } = await tx.query<{ at: Date }>(
            `UPDATE cuspatlas.imaging_devices SET last_heartbeat_at = now() WHERE id = $1 RETURNING last_heartbeat_at AS at`,
            [ctx.actorId],
          );
          return { data: { deviceRef: ctx.actorId, at: (rows[0] as { at: Date }).at.toISOString() } };
        });
      });
    },

    /** Key rotation by the device itself: signed with the current key (assertion), proven with the new. */
    rotateKey(ctx: ActorContext, body: unknown) {
      const op = 'imaging.bridge.rotateKey';
      return base.recorded(ctx, op, async () => {
        asDevice(ctx);
        assertValid<BridgeKeyRotate>(validateBridgeKeyRotate, body, IMAGING_PROPERTIES);
        const p = body as BridgeKeyRotate;
        const key = publicKeyFromRaw(p.publicKey);
        if (!key) throw failed('public_key_invalid');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const d = await activeDevice(tx, ctx, 'FOR UPDATE');
          const nextVersion = d.key_version + 1;
          if (!verifyProof(rotationProofMessage(d.id, nextVersion, p.publicKey), p.proof, key))
            throw unauth('device_signature_invalid');
          await tx.query(
            `UPDATE cuspatlas.imaging_device_keys SET state = 'retired', ended_at = now()
             WHERE device_id = $1 AND state = 'active'`,
            [d.id],
          );
          await tx.query(
            `INSERT INTO cuspatlas.imaging_device_keys (tenant_id, device_id, key_version, public_key, state)
             VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, 'active')`,
            [d.id, nextVersion, p.publicKey],
          );
          const next = await bumpDevice(tx, op, d, { key_version: nextVersion });
          return { data: { deviceRef: d.id, keyVersion: nextVersion, version: next.version } };
        });
      });
    },
  };
}

interface ParsedResult {
  jobRef: string;
  deviceRef: string;
  nonce: string;
  attempt: number;
  outcome: 'completed' | 'failed';
  failureReason: string | null;
  retryable: boolean;
  reportedAt: string;
  captureSoftware?: string;
  artifact?: {
    contentType: 'image/png' | 'image/jpeg' | 'image/tiff' | 'application/pdf' | 'application/dicom';
    byteLength: number;
    digestSha256: string;
  };
}

const FAILURE_REASONS = [
  'device_busy',
  'transfer_interrupted',
  'source_missing',
  'device_error',
  'operator_cancelled',
];
const CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/tiff', 'application/pdf', 'application/dicom'];

/** Strict shape of a signed result payload (unknown keys refused). */
function parseResult(p: Record<string, unknown>): ParsedResult | null {
  const allowed = new Set([
    'v',
    'aud',
    'jobRef',
    'deviceRef',
    'nonce',
    'attempt',
    'outcome',
    'failureReason',
    'retryable',
    'reportedAt',
    'captureSoftware',
    'artifact',
  ]);
  if (Object.keys(p).some((k) => !allowed.has(k))) return null;
  if (p.v !== 1 || p.aud !== BRIDGE_AUDIENCE) return null;
  if (typeof p.jobRef !== 'string' || typeof p.deviceRef !== 'string' || typeof p.nonce !== 'string')
    return null;
  if (!UUID.test(p.jobRef) || !UUID.test(p.deviceRef) || !UUID.test(p.nonce)) return null;
  if (!Number.isInteger(p.attempt) || (p.attempt as number) < 1) return null;
  if (p.outcome !== 'completed' && p.outcome !== 'failed') return null;
  if (typeof p.reportedAt !== 'string' || Number.isNaN(Date.parse(p.reportedAt))) return null;
  if (
    p.captureSoftware !== undefined &&
    (typeof p.captureSoftware !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(p.captureSoftware))
  )
    return null;
  let failureReason: string | null = null;
  if (p.outcome === 'failed') {
    if (typeof p.failureReason !== 'string' || !FAILURE_REASONS.includes(p.failureReason)) return null;
    failureReason = p.failureReason;
    if (p.artifact !== undefined) return null;
  } else if (p.failureReason !== undefined) return null;
  let artifact: ParsedResult['artifact'];
  if (p.artifact !== undefined) {
    const a = p.artifact as Record<string, unknown>;
    if (
      typeof a !== 'object' ||
      a === null ||
      Object.keys(a).sort().join(',') !== 'byteLength,contentType,digestSha256'
    )
      return null;
    if (typeof a.contentType !== 'string' || !CONTENT_TYPES.includes(a.contentType)) return null;
    if (!Number.isInteger(a.byteLength) || (a.byteLength as number) < 1) return null;
    if (typeof a.digestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.digestSha256)) return null;
    artifact = a as unknown as ParsedResult['artifact'];
  }
  return {
    jobRef: p.jobRef,
    deviceRef: p.deviceRef,
    nonce: p.nonce,
    attempt: p.attempt as number,
    outcome: p.outcome,
    failureReason,
    retryable: p.retryable === true,
    reportedAt: p.reportedAt,
    ...(p.captureSoftware !== undefined ? { captureSoftware: p.captureSoftware as string } : {}),
    ...(artifact ? { artifact } : {}),
  };
}
