import { createHash } from 'node:crypto';
import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  CommitThenRefuse,
  IMAGING_PROPERTIES,
  type ImagingContentType,
  type IngressBegin,
  type IngressComplete,
  type IngressRead,
  type ObjectStorePort,
  type ProvenanceSource,
  RefusalError,
  type ScanVerdict,
  type TenantTransaction,
  validateImagingIdempotencyKey,
  validateIngressBegin,
  validateIngressComplete,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { hintKeys, tenantKeyer } from './association';
import { checkEnvelope, checkRef, failed, type ImagingBase, notFound, refused } from './base';
import { dotOnlyName, knownTimeZone, sniffContentType } from './gating';
import { OBJECT_RESOURCE, type ReconcileStep } from './objects';

export const INGRESS_RESOURCE = 'imagingIngress';
/** An ingress not completed within this many hours is swept as abandoned (staged bytes discarded). */
export const INGRESS_ABANDON_HOURS = 24;

type IngressState = 'awaiting_bytes' | 'staged' | 'accepted' | 'quarantined' | 'abandoned';

export interface SessionRow extends Record<string, unknown> {
  id: string;
  state: IngressState;
  declared_content_type: ImagingContentType;
  declared_byte_length: string;
  declared_digest: string;
  observed_digest: string | null;
  observed_byte_length: string | null;
  staging_key: string | null;
  scan_verdict: ScanVerdict | null;
  quarantine_reason: string | null;
  object_id: string | null;
  intended_patient_id: string | null;
  source: ProvenanceSource;
  device_ref: string | null;
  capture_software: string | null;
  original_filename: string | null;
  acquired_at: Date | null;
  acquired_time_zone: string | null;
  version: number;
  created_by: string;
  created_at: Date;
}

const SESSION_COLUMNS = `id, state, declared_content_type, declared_byte_length, declared_digest, observed_digest,
  observed_byte_length, staging_key, scan_verdict, quarantine_reason, object_id, intended_patient_id, source, device_ref,
  capture_software, original_filename, acquired_at, acquired_time_zone, version, created_by, created_at`;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ingressRef = (id: string) => [{ kind: INGRESS_RESOURCE, ref: id }];

function readData(r: SessionRow): IngressRead {
  return {
    ingressRef: r.id,
    state: r.state,
    declaredContentType: r.declared_content_type,
    declaredByteLength: Number(r.declared_byte_length),
    declaredDigest: r.declared_digest,
    observedDigest: r.observed_digest,
    observedByteLength: r.observed_byte_length === null ? null : Number(r.observed_byte_length),
    scan: r.scan_verdict,
    quarantineReason: r.quarantine_reason,
    objectRef: r.object_id,
    createdAt: r.created_at.toISOString(),
    version: r.version,
  };
}

/**
 * The caller's own ingress session. Upload and completion are private to the principal that began
 * the ingress; another principal (or tenant) gets the same 404 as a missing session.
 */
async function ownSession(tx: TenantTransaction, ref: string): Promise<SessionRow> {
  checkRef(ref);
  const { rows } = await tx.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM cuspatlas.imaging_ingress_sessions
     WHERE id = $1 AND created_by = cuspatlas.current_actor_id() FOR UPDATE`,
    [ref],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

async function bumpSession(
  tx: TenantTransaction,
  op: string,
  row: SessionRow,
  set: Record<string, unknown>,
): Promise<SessionRow> {
  const cols = Object.keys(set);
  const { rows } = await tx.query<SessionRow>(
    `UPDATE cuspatlas.imaging_ingress_sessions SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')},
       version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${SESSION_COLUMNS}`,
    [row.id, ...cols.map((c) => set[c])],
  );
  const next = rows[0];
  if (!next) throw new Error('ingress update returned no row');
  await recordCommand(
    tx,
    { operation: op, resourceType: INGRESS_RESOURCE, resourceRef: next.id, resourceVersion: next.version },
    { changedFields: cols.map((c) => c.replace(/_([a-z])/g, (_m, x: string) => x.toUpperCase())) },
  );
  return next;
}

/** First failing gate, in order: length, digest, malware scan, media sniffing. */
async function gate(
  base: ImagingBase,
  row: SessionRow,
  observedByCaller: string,
  bytes: Uint8Array,
): Promise<{ reason: string; verdict: ScanVerdict | null } | null> {
  if (bytes.byteLength !== Number(row.declared_byte_length))
    return { reason: 'size_mismatch', verdict: null };
  if (sha256(bytes) !== row.declared_digest || observedByCaller !== row.declared_digest)
    return { reason: 'digest_mismatch', verdict: null };
  const verdict: ScanVerdict = base.deps.scanner ? await base.deps.scanner.scan(bytes) : 'unknown';
  if (verdict === 'unknown') return { reason: 'scan_pending', verdict };
  if (verdict === 'infected') return { reason: 'malware_gated', verdict };
  const sniffed = sniffContentType(bytes);
  if (sniffed === null) return { reason: 'content_type_unrecognized', verdict };
  if (sniffed !== row.declared_content_type) return { reason: 'content_type_mismatch', verdict };
  return null;
}

/**
 * Runs the gates over a staged session. An undecided scan commits a visible staged hold (retryable
 * `scan_pending`); any other failure moves the bytes to quarantine with the reason. The caller commits
 * the returned refusal (CommitThenRefuse). Null when every gate passed. Shared by the I2 completion
 * and the I6 bridge result.
 */
export async function gateSession(
  base: ImagingBase,
  tx: TenantTransaction,
  ctx: ActorContext,
  op: string,
  row: SessionRow,
  observedByCaller: string,
): Promise<{ refusal: RefusalError; reason: string; held: boolean } | null> {
  const store = base.store();
  const bytes = await store.readStaged(ctx.tenantId, row.staging_key as string);
  const failure = await gate(base, row, observedByCaller, bytes);
  if (failure?.reason === 'scan_pending') {
    await bumpSession(tx, op, row, { scan_verdict: 'unknown' });
    return {
      reason: 'scan_pending',
      held: true,
      refusal: refused(
        'scan_pending',
        { blockingRefs: ingressRef(row.id) },
        { retryable: true, reasonCode: 'upload_gated' },
      ),
    };
  }
  if (failure) {
    const q = await store.quarantineStaged(ctx.tenantId, row.staging_key as string);
    await bumpSession(tx, op, row, {
      state: 'quarantined',
      quarantine_reason: failure.reason,
      quarantine_key: q.quarantineKey,
      staging_key: null,
      scan_verdict: failure.verdict,
    });
    return {
      reason: failure.reason,
      held: false,
      refusal: refused(failure.reason, { blockingRefs: ingressRef(row.id) }, { reasonCode: 'upload_gated' }),
    };
  }
  return null;
}

/**
 * Promotes a fully gated session: content lock, promotion, patient-scoped dedupe (an unscoped upload
 * never deduplicates into an associated object), object row, one provenance row, session accepted.
 */
export async function acceptSession(
  base: ImagingBase,
  tx: TenantTransaction,
  ctx: ActorContext,
  op: string,
  row: SessionRow,
): Promise<{ objectRef: string; deduplicated: boolean; provenanceRef: string; version: number }> {
  const store = base.store();
  // Serializes with byte removal of a deleted object sharing this content (review hardening).
  await tx.query('SELECT cuspatlas.imaging_lock_content(cuspatlas.current_tenant_id(), $1)', [
    row.declared_digest,
  ]);
  const { storageKey } = await store.promote(ctx.tenantId, row.staging_key as string, row.declared_digest);
  const scope = row.intended_patient_id;
  // An unscoped upload deduplicates only into an unscoped object never associated with anyone;
  // otherwise it is a separate object sharing the content-addressed bytes (review hardening).
  const existing = await tx.query<{ id: string }>(
    `SELECT o.id FROM cuspatlas.imaging_objects o WHERE o.kind = 'original' AND o.state = 'available'
           AND o.digest_sha256 = $1 AND o.dedupe_patient_id IS NOT DISTINCT FROM $2
           AND ($2::uuid IS NOT NULL OR NOT EXISTS (
             SELECT 1 FROM cuspatlas.imaging_match_decisions d WHERE d.object_id = o.id))
         ORDER BY o.created_at, o.id LIMIT 1 FOR UPDATE OF o`,
    [row.declared_digest, scope],
  );
  let objectId = existing.rows[0]?.id;
  const deduplicated = objectId !== undefined;
  if (!objectId) {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO cuspatlas.imaging_objects (tenant_id, kind, state, content_type, byte_length, digest_sha256,
             storage_key, dedupe_patient_id, created_by)
           VALUES (cuspatlas.current_tenant_id(), 'original', 'available', $1, $2, $3, $4, $5,
             cuspatlas.current_actor_id())
           RETURNING id`,
      [row.declared_content_type, Number(row.declared_byte_length), row.declared_digest, storageKey, scope],
    );
    objectId = inserted.rows[0]?.id as string;
    await recordCommand(
      tx,
      { operation: op, resourceType: OBJECT_RESOURCE, resourceRef: objectId, resourceVersion: 1 },
      { changedFields: ['state', 'digest', 'provenance'] },
    );
  }
  const prov = await tx.query<{ id: string }>(
    `INSERT INTO cuspatlas.imaging_object_provenance (tenant_id, object_id, ingress_id, source, operator_id,
           device_ref, capture_software, original_filename, acquired_at, acquired_time_zone)
         VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id(), $4, $5, $6, $7, $8)
         RETURNING id`,
    [
      objectId,
      row.id,
      row.source,
      row.device_ref,
      row.capture_software,
      row.original_filename,
      row.acquired_at,
      row.acquired_time_zone,
    ],
  );
  const next = await bumpSession(tx, op, row, {
    state: 'accepted',
    object_id: objectId,
    staging_key: null,
    scan_verdict: 'clean',
  });
  return {
    objectRef: objectId,
    deduplicated,
    provenanceRef: prov.rows[0]?.id as string,
    version: next.version,
  };
}

/**
 * I6: the ingress record of a bridge job, created when its signed result arrives. Declared values come
 * from the signed artifact; the bytes were staged by the job's content upload. Provenance is
 * `bridgeImport` with the device reference; the device principal is the creator.
 */
export async function insertBridgeSession(
  tx: TenantTransaction,
  op: string,
  _ctx: ActorContext,
  s: {
    contentType: ImagingContentType;
    byteLength: number;
    digest: string;
    intendedPatientRef: string | null;
    deviceRef: string;
    captureSoftware: string | null;
    stagingKey: string;
  },
): Promise<SessionRow> {
  const { rows } = await tx.query<SessionRow>(
    `INSERT INTO cuspatlas.imaging_ingress_sessions (tenant_id, declared_content_type, declared_byte_length,
       declared_digest, intended_patient_id, source, device_ref, capture_software, created_by)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, 'bridgeImport', $5, $6, cuspatlas.current_actor_id())
     RETURNING ${SESSION_COLUMNS}`,
    [s.contentType, s.byteLength, s.digest, s.intendedPatientRef, s.deviceRef, s.captureSoftware],
  );
  const row = rows[0] as SessionRow;
  await recordCommand(
    tx,
    { operation: op, resourceType: INGRESS_RESOURCE, resourceRef: row.id, resourceVersion: 1 },
    { changedFields: ['state', 'declaredDigest', 'provenance'] },
  );
  return bumpSession(tx, op, row, {
    state: 'staged',
    staging_key: s.stagingKey,
    observed_digest: s.digest,
    observed_byte_length: s.byteLength,
  });
}

/** I2: staging, gating, verification and patient-scoped dedupe. */
export function createIngressOperations(base: ImagingBase) {
  const { deps, execute } = base;

  return {
    beginIngress(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.ingress.begin';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid<IngressBegin>(validateIngressBegin, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as IngressBegin;
        if (p.byteLength > base.maxObjectBytes)
          throw failed('oversize_object', { limit: { name: 'maxObjectBytes', value: base.maxObjectBytes } });
        const v = p.provenance;
        if (v.originalFilename !== undefined && dotOnlyName(v.originalFilename))
          throw failed('path_traversal');
        if ((v.acquiredAt === undefined) !== (v.acquiredTimeZone === undefined))
          throw failed('acquired_time_zone_required');
        if (v.acquiredTimeZone !== undefined && !knownTimeZone(v.acquiredTimeZone))
          throw failed('unknown_time_zone');
        return deps.withTenantTransaction(ctx, async (tx) => {
          if (p.intendedPatientRef !== undefined) {
            checkRef(p.intendedPatientRef);
            const pt = await tx.query('SELECT 1 FROM cuspatlas.patients WHERE id = $1 FOR SHARE', [
              p.intendedPatientRef,
            ]);
            if (pt.rowCount !== 1) throw notFound();
          }
          return execute(ctx, envelope, tx, async () => {
            const { rows } = await tx.query<{ id: string; created_at: Date }>(
              `INSERT INTO cuspatlas.imaging_ingress_sessions (tenant_id, declared_content_type, declared_byte_length,
                 declared_digest, intended_patient_id, source, device_ref, capture_software, original_filename,
                 acquired_at, acquired_time_zone, hint_match_keys, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[],
                 cuspatlas.current_actor_id())
               RETURNING id, created_at`,
              [
                p.contentType,
                p.byteLength,
                p.declaredDigest,
                p.intendedPatientRef ?? null,
                v.source,
                v.deviceRef ?? null,
                v.captureSoftware ?? null,
                v.originalFilename ?? null,
                v.acquiredAt ?? null,
                v.acquiredTimeZone ?? null,
                hintKeys(p.patientHints, tenantKeyer(deps.matchKeyPepper, ctx.tenantId)),
              ],
            );
            const row = rows[0];
            if (!row) throw new Error('ingress insert returned no row');
            await recordCommand(
              tx,
              { operation: op, resourceType: INGRESS_RESOURCE, resourceRef: row.id, resourceVersion: 1 },
              { changedFields: ['state', 'declaredDigest', 'provenance'] },
            );
            return {
              data: {
                ingressRef: row.id,
                state: 'awaiting_bytes',
                maxBytes: base.maxObjectBytes,
                expiresAt: new Date(
                  row.created_at.getTime() + INGRESS_ABANDON_HOURS * 3_600_000,
                ).toISOString(),
              },
              version: 1,
            };
          });
        });
      });
    },

    /** Stages the bytes of the caller's own ingress (REST only). Idempotent by key and byte digest. */
    uploadIngressContent(ctx: ActorContext, ref: string, key: string, body: unknown) {
      const op = 'imaging.ingress.upload';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(ref);
        assertValid(validateImagingIdempotencyKey, key, new Set(['idempotencyKey']));
        if (!(body instanceof Uint8Array) || body.byteLength === 0)
          throw new RefusalError({ code: 'invalid_request' });
        const bytes = body;
        const store = base.store();
        const digest = sha256(bytes);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await ownSession(tx, ref);
          return execute(
            ctx,
            { operation: op, idempotencyKey: key, payload: { ingressRef: ref, digest } },
            tx,
            async () => {
              if (row.state !== 'awaiting_bytes')
                throw refused(row.state === 'staged' ? 'bytes_already_received' : 'ingress_not_open');
              if (bytes.byteLength > Number(row.declared_byte_length))
                throw failed('oversize_object', {
                  limit: { name: 'declaredByteLength', value: Number(row.declared_byte_length) },
                });
              const staged = await store.stage(ctx.tenantId, bytes);
              const next = await bumpSession(tx, op, row, {
                state: 'staged',
                staging_key: staged.stagingKey,
                observed_digest: staged.digestSha256,
                observed_byte_length: staged.byteLength,
              });
              return {
                data: {
                  ingressRef: next.id,
                  state: 'staged',
                  observedDigest: staged.digestSha256,
                  byteLength: bytes.byteLength,
                },
                version: next.version,
              };
            },
          );
        });
      });
    },

    /**
     * Completes the caller's own ingress. Gating failures commit the quarantine (bytes moved to the
     * quarantine area, reason recorded) and then refuse 409 with the reason; an unknown scan verdict
     * commits a visible `staged` hold and refuses retryably (`scan_pending`). Only a fully gated ingress
     * reaches the idempotent handler that creates (or deduplicates into) an available object.
     */
    completeIngress(ctx: ActorContext, ref: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.ingress.complete';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(ref);
        assertValid<IngressComplete>(validateIngressComplete, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as IngressComplete;
        base.store();
        const env = { ...envelope, payload: { ingressRef: ref, observedDigest: p.observedDigest } };
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await ownSession(tx, ref);
          if (row.state === 'accepted') {
            // Same key: the executor replays the recorded completion. Another key: a duplicate.
            return execute(ctx, env, tx, async () => {
              throw refused('duplicate_completion', {
                blockingRefs: [{ kind: OBJECT_RESOURCE, ref: row.object_id as string }],
              });
            });
          }
          if (row.state === 'quarantined')
            throw refused(
              row.quarantine_reason ?? 'quarantined',
              { blockingRefs: ingressRef(row.id) },
              { reasonCode: 'upload_gated' },
            );
          if (row.state === 'awaiting_bytes') throw refused('bytes_not_received', {}, { replayable: false });
          if (row.state !== 'staged' || row.staging_key === null) throw refused('ingress_not_open');
          const gated = await gateSession(base, tx, ctx, op, row, p.observedDigest);
          if (gated) throw new CommitThenRefuse(gated.refusal);
          return execute(ctx, env, tx, async () => {
            const a = await acceptSession(base, tx, ctx, op, row);
            return {
              data: {
                ingressRef: row.id,
                objectRef: a.objectRef,
                state: 'available',
                deduplicated: a.deduplicated,
                provenanceRef: a.provenanceRef,
              },
              version: a.version,
            };
          });
        });
      });
    },

    readIngress(ctx: ActorContext, ref: string): Promise<IngressRead> {
      const op = 'imaging.ingress.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(ref);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<SessionRow>(
            `SELECT ${SESSION_COLUMNS} FROM cuspatlas.imaging_ingress_sessions WHERE id = $1`,
            [ref],
          );
          const row = rows[0];
          if (!row) throw notFound();
          return readData(row);
        });
      });
    },

    /**
     * Exception-first worklist of ingress that did not become an object: quarantined (with the reason),
     * held on an undecided scan, or still incomplete after an hour. Never an empty list when it cannot
     * be computed; at most 100 items.
     */
    listIngressFailures(ctx: ActorContext) {
      const op = 'imaging.ingress.failures';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const now = (await tx.query<{ at: Date }>('SELECT now() AS at')).rows[0]?.at ?? new Date();
          const { rows } = await tx.query<SessionRow>(
            `SELECT ${SESSION_COLUMNS} FROM cuspatlas.imaging_ingress_sessions
             WHERE state = 'quarantined' OR (state = 'staged' AND scan_verdict = 'unknown')
                OR (state IN ('awaiting_bytes', 'staged') AND created_at < now() - interval '1 hour')
             ORDER BY created_at, id LIMIT 101`,
          );
          const items = rows.slice(0, 100).map((r) => {
            const reason =
              r.state === 'quarantined'
                ? (r.quarantine_reason as string)
                : r.scan_verdict === 'unknown'
                  ? 'scan_pending'
                  : 'upload_incomplete';
            return {
              workItemRef: r.id,
              kind:
                r.state === 'quarantined'
                  ? 'ingress_quarantined'
                  : reason === 'scan_pending'
                    ? 'ingress_scan_pending'
                    : 'ingress_incomplete',
              reasonCode: reason,
              explanation:
                r.state === 'quarantined'
                  ? 'The upload failed a gate and is held in quarantine; it is never served or associated.'
                  : reason === 'scan_pending'
                    ? 'The malware scanner could not decide; the upload is held until a scan verdict exists.'
                    : 'The upload has not completed; it is swept as abandoned after 24 hours.',
              evidenceRefs: ingressRef(r.id),
              owner: { queue: 'imaging', principalRef: r.created_by },
              nextActionOwedBy: reason === 'scan_pending' ? 'platform' : 'practice',
              dueAt: new Date(r.created_at.getTime() + INGRESS_ABANDON_HOURS * 3_600_000).toISOString(),
              priority: r.state === 'quarantined' ? 'elevated' : 'routine',
              priorityRationale: r.state === 'quarantined' ? 'gated_upload' : 'default_routine',
              suggestedNextAction:
                r.state === 'quarantined'
                  ? 'review_quarantine'
                  : reason === 'scan_pending'
                    ? 'retry_completion'
                    : 'reupload',
              blockingDependencies: reason === 'scan_pending' ? ['malware_scanner'] : [],
            };
          });
          const total = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM cuspatlas.imaging_ingress_sessions
             WHERE state = 'quarantined' OR (state = 'staged' AND scan_verdict = 'unknown')
                OR (state IN ('awaiting_bytes', 'staged') AND created_at < now() - interval '1 hour')`,
          );
          return {
            asOf: now.toISOString(),
            coverage: { status: 'available' },
            count: total.rows[0]?.n ?? 0,
            items,
          };
        });
      });
    },
  };
}

/** Reconcile step: abandons ingress older than 24 hours and discards its staged bytes. */
export const sweepAbandonedIngress: ReconcileStep = async (tx, ctx, store: ObjectStorePort, op) => {
  const { rows } = await tx.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM cuspatlas.imaging_ingress_sessions
     WHERE state IN ('awaiting_bytes', 'staged') AND created_at < now() - make_interval(hours => $1)
     ORDER BY created_at, id LIMIT 500 FOR UPDATE`,
    [INGRESS_ABANDON_HOURS],
  );
  for (const row of rows) {
    if (row.staging_key !== null) await store.discardStaged(ctx.tenantId, row.staging_key);
    await bumpSession(tx, op, row, { state: 'abandoned', staging_key: null });
  }
  return { abandonedIngress: rows.length };
};
