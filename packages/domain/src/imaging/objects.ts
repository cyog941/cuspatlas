import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  CommitThenRefuse,
  IMAGING_PROPERTIES,
  type ImageObjectData,
  type ImageObjectKind,
  type ImageObjectState,
  type ImagingContentType,
  isObjectStoreError,
  type ObjectContent,
  type ObjectListQuery,
  type ObjectStorePort,
  type ProvenanceRecord,
  type ProvenanceSource,
  type ReadGrantData,
  type ReadGrantRequest,
  RefusalError,
  type TenantTransaction,
  validateObjectListQuery,
  validateReadGrantRequest,
  validateReadGrantRevoke,
  validateStorageReconcile,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import { checkEnvelope, checkRef, type ImagingBase, notFound, refused } from './base';
import { signGrantToken, verifyGrantToken } from './tokens';

export const OBJECT_RESOURCE = 'imagingObject';
export const GRANT_RESOURCE = 'imagingReadGrant';
const DEFAULT_TTL = 60;

export interface ObjectRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  kind: ImageObjectKind;
  state: ImageObjectState;
  content_type: ImagingContentType;
  byte_length: string;
  digest_sha256: string;
  storage_key: string;
  quarantine_reason: string | null;
  received_at: Date;
  version: number;
}

export const OBJECT_COLUMNS = `o.id, o.tenant_id, o.kind, o.state, o.content_type, o.byte_length, o.digest_sha256,
  o.storage_key, o.quarantine_reason, o.received_at, o.version`;

interface ProvenanceRow extends Record<string, unknown> {
  id: string;
  object_id: string;
  ingress_id: string | null;
  source: ProvenanceSource;
  operator_id: string;
  device_ref: string | null;
  capture_software: string | null;
  original_filename: string | null;
  acquired_at: Date | null;
  acquired_time_zone: string | null;
  recorded_at: Date;
}

/** The object row, or 404 (another tenant's object is invisible under RLS, so it is missing too). */
export async function loadObject(
  tx: TenantTransaction,
  objectRef: string,
  lock: '' | 'FOR UPDATE' | 'FOR SHARE' = '',
): Promise<ObjectRow> {
  checkRef(objectRef);
  const { rows } = await tx.query<ObjectRow>(
    `SELECT ${OBJECT_COLUMNS} FROM cuspatlas.imaging_objects o WHERE o.id = $1 ${lock}`,
    [objectRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

async function provenanceOf(
  tx: TenantTransaction,
  ids: readonly string[],
): Promise<Map<string, ProvenanceRecord[]>> {
  const out = new Map<string, ProvenanceRecord[]>();
  if (ids.length === 0) return out;
  const { rows } = await tx.query<ProvenanceRow>(
    `SELECT id, object_id, ingress_id, source, operator_id, device_ref, capture_software, original_filename,
       acquired_at, acquired_time_zone, recorded_at
     FROM cuspatlas.imaging_object_provenance WHERE object_id = ANY ($1::uuid[]) ORDER BY recorded_at, id`,
    [[...ids]],
  );
  for (const r of rows) {
    const list = out.get(r.object_id) ?? [];
    if (list.length < 50) {
      list.push({
        provenanceRef: r.id,
        source: r.source,
        operatorRef: r.operator_id,
        deviceRef: r.device_ref,
        captureSoftware: r.capture_software,
        originalFilename: r.original_filename,
        acquiredAt: r.acquired_at === null ? null : r.acquired_at.toISOString(),
        acquiredTimeZone: r.acquired_time_zone,
        ingressRef: r.ingress_id,
        recordedAt: r.recorded_at.toISOString(),
      });
    }
    out.set(r.object_id, list);
  }
  return out;
}

export function objectData(row: ObjectRow, provenance: readonly ProvenanceRecord[]): ImageObjectData {
  return {
    objectRef: row.id,
    kind: row.kind,
    state: row.state,
    contentType: row.content_type,
    byteLength: Number(row.byte_length),
    digestSha256: row.digest_sha256,
    receivedAt: row.received_at.toISOString(),
    quarantineReason: row.quarantine_reason,
    version: row.version,
    provenance,
  };
}

/** Projections other imaging tasks add to an object read (association, composition). */
export type ObjectReadExtension = (
  tx: TenantTransaction,
  rows: readonly ObjectRow[],
) => Promise<Map<string, Record<string, unknown>>>;

export async function describeObjects(
  tx: TenantTransaction,
  rows: readonly ObjectRow[],
  extensions: readonly ObjectReadExtension[],
): Promise<ImageObjectData[]> {
  const prov = await provenanceOf(
    tx,
    rows.map((r) => r.id),
  );
  const extra = await Promise.all(extensions.map((e) => e(tx, rows)));
  return rows.map((r) => {
    const base = objectData(r, prov.get(r.id) ?? []);
    return Object.assign({}, base, ...extra.map((m) => m.get(r.id) ?? {})) as ImageObjectData;
  });
}

/** Moves an object to quarantine (state change, audit, outbox) inside the caller's transaction. */
export async function quarantineObject(
  tx: TenantTransaction,
  operation: string,
  row: ObjectRow,
  reason: string,
): Promise<number> {
  const { rows } = await tx.query<{ version: number }>(
    `UPDATE cuspatlas.imaging_objects SET state = 'quarantined', quarantine_reason = $2, version = version + 1,
       updated_at = now() WHERE id = $1 AND state = 'available' RETURNING version`,
    [row.id, reason],
  );
  const version = rows[0]?.version;
  if (version === undefined) return row.version;
  await recordCommand(
    tx,
    { operation, resourceType: OBJECT_RESOURCE, resourceRef: row.id, resourceVersion: version },
    { changedFields: ['state', 'quarantineReason'] },
  );
  return version;
}

const integrityRefusal = (reason: string) => refused(reason, {}, { reasonCode: 'object_integrity_failed' });

/** I1: metadata reads, short-lived read grants, verified content reads and the integrity sweep. */
export function createObjectOperations(
  base: ImagingBase,
  extensions: readonly ObjectReadExtension[],
  reconcileSteps: readonly ReconcileStep[],
) {
  const { deps, execute } = base;

  return {
    readObject(ctx: ActorContext, objectRef: string): Promise<ImageObjectData> {
      const op = 'imaging.objects.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(objectRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadObject(tx, objectRef);
          const [data] = await describeObjects(tx, [row], extensions);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: OBJECT_RESOURCE,
            resourceRefs: [row.id],
            queryFields: [],
          });
          return data as ImageObjectData;
        });
      });
    },

    listObjects(ctx: ActorContext, query: unknown): Promise<ImageObjectData[]> {
      const op = 'imaging.objects.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        assertValid<ObjectListQuery>(validateObjectListQuery, query, IMAGING_PROPERTIES);
        const q = query as ObjectListQuery;
        const limit = q.limit === undefined ? 25 : Number(q.limit);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<ObjectRow>(
            `SELECT ${OBJECT_COLUMNS} FROM cuspatlas.imaging_objects o
             WHERE ($1::text IS NULL OR o.state = $1) ORDER BY o.received_at DESC, o.id LIMIT $2`,
            [q.state ?? null, limit],
          );
          const data = await describeObjects(tx, rows, extensions);
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: OBJECT_RESOURCE,
            resourceRefs: rows.map((r) => r.id),
            queryFields: q.state === undefined ? [] : ['state'],
          });
          return data;
        });
      });
    },

    /**
     * Issues a short-lived read grant bound to the caller, the object and an expiry (at most 300 s).
     * Not idempotent by design: each call mints a new grant, so no token or secret ever enters the
     * idempotency table. A grant row is audited; the token itself is never stored.
     */
    grantRead(ctx: ActorContext, objectRef: string, body: unknown): Promise<ReadGrantData> {
      const op = 'imaging.objects.grantRead';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(objectRef);
        assertValid<ReadGrantRequest>(validateReadGrantRequest, body, IMAGING_PROPERTIES);
        const ttl = (body as ReadGrantRequest).ttlSeconds ?? DEFAULT_TTL;
        const secret = base.secret();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadObject(tx, objectRef, 'FOR SHARE');
          if (row.state !== 'available') throw refused('object_not_available');
          const { rows } = await tx.query<{ id: string; exp: string }>(
            `INSERT INTO cuspatlas.imaging_read_grants (tenant_id, object_id, principal_id, expires_at)
             VALUES (cuspatlas.current_tenant_id(), $1, cuspatlas.current_actor_id(),
               date_trunc('second', now()) + make_interval(secs => $2))
             RETURNING id, extract(epoch FROM expires_at)::bigint::text AS exp`,
            [row.id, ttl],
          );
          const grant = rows[0];
          if (!grant) throw new Error('grant insert returned no row');
          await recordCommand(
            tx,
            { operation: op, resourceType: GRANT_RESOURCE, resourceRef: grant.id, resourceVersion: 1 },
            { changedFields: ['objectRef', 'expiresAt'] },
          );
          const expires = Number(grant.exp);
          return {
            grantRef: grant.id,
            objectRef: row.id,
            token: signGrantToken(
              secret,
              { tenantId: ctx.tenantId, principalId: ctx.actorId, objectRef: row.id },
              grant.id,
              expires,
            ),
            expiresAt: new Date(expires * 1000).toISOString(),
            contentPath: `/v1/imaging/objects/${row.id}/content`,
          };
        });
      });
    },

    /** Revokes a grant: its own holder, or any member who may write imaging records. */
    revokeGrant(ctx: ActorContext, grantRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.objects.revokeGrant';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(grantRef);
        assertValid(validateReadGrantRevoke, envelope.payload, IMAGING_PROPERTIES);
        const writer = await base.can(ctx, 'imaging.grants.revokeAny');
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            object_id: string;
            principal_id: string;
            revoked: boolean;
          }>(
            `SELECT id, object_id, principal_id, revoked_at IS NOT NULL AS revoked
             FROM cuspatlas.imaging_read_grants WHERE id = $1 FOR UPDATE`,
            [grantRef],
          );
          const g = rows[0];
          if (!g || (g.principal_id !== ctx.actorId && !writer)) throw notFound();
          return execute(ctx, { ...envelope, payload: { grantRef } }, tx, async () => {
            if (g.revoked) throw refused('grant_already_revoked');
            await tx.query(
              `UPDATE cuspatlas.imaging_read_grants SET revoked_at = now(), revoked_by = cuspatlas.current_actor_id()
               WHERE id = $1`,
              [g.id],
            );
            await recordCommand(
              tx,
              { operation: op, resourceType: GRANT_RESOURCE, resourceRef: g.id, resourceVersion: 2 },
              { changedFields: ['revokedAt'] },
            );
            return { data: { grantRef: g.id, objectRef: g.object_id, state: 'revoked' }, version: 2 };
          });
        });
      });
    },

    /**
     * Verified content read (REST only). Order: authorization, object visibility (another tenant's
     * object is 404 like a missing one), token (HMAC bound to tenant, caller, object and expiry, then
     * the live grant row: revoked or expired is 403), state, then bytes verified against the
     * registered digest. A mismatch or missing bytes quarantine the object (committed), raise a fixed
     * alert line and refuse; the bytes are kept in quarantine for investigation, never served.
     */
    readContent(ctx: ActorContext, objectRef: string, token: unknown): Promise<ObjectContent> {
      const op = 'imaging.objects.content';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(objectRef);
        const store = base.store();
        const secret = base.secret();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadObject(tx, objectRef, 'FOR SHARE');
          const binding = { tenantId: ctx.tenantId, principalId: ctx.actorId, objectRef: row.id };
          const parsed = verifyGrantToken(secret, binding, token);
          const tokenDenied = () =>
            new RefusalError({ code: 'forbidden', reasonCode: 'object_token_invalid' });
          if (!parsed || parsed.expiresEpochSeconds * 1000 <= Date.now()) throw tokenDenied();
          const grant = await tx.query(
            `SELECT 1 FROM cuspatlas.imaging_read_grants WHERE id = $1 AND object_id = $2
               AND principal_id = cuspatlas.current_actor_id() AND revoked_at IS NULL AND expires_at > now()
               AND extract(epoch FROM expires_at)::bigint = $3`,
            [parsed.grantRef, row.id, parsed.expiresEpochSeconds],
          );
          if (grant.rowCount !== 1) throw tokenDenied();
          if (row.state !== 'available') throw refused('object_not_available');
          let bytes: Uint8Array;
          try {
            bytes = await store.read(ctx.tenantId, row.storage_key, row.digest_sha256);
          } catch (err) {
            if (!isObjectStoreError(err) || (err.code !== 'digest_mismatch' && err.code !== 'missing'))
              throw err;
            const reason = err.code === 'missing' ? 'bytes_missing' : 'digest_mismatch';
            if (err.code === 'digest_mismatch') {
              await store.quarantineStored(ctx.tenantId, row.storage_key, row.id).catch(() => undefined);
            }
            await quarantineObject(tx, op, row, reason);
            base.alert('imaging_object_integrity_failed');
            throw new CommitThenRefuse(integrityRefusal(reason));
          }
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: OBJECT_RESOURCE,
            resourceRefs: [row.id],
            queryFields: [],
          });
          return { contentType: row.content_type, bytes, digestSha256: row.digest_sha256 };
        });
      });
    },

    /**
     * Integrity sweep (I1 failure and recovery): verifies the bytes of available objects against their
     * registered digest and quarantines missing or altered ones. Bounded per run; `more` says whether
     * another run is needed.
     */
    reconcileStorage(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.storage.reconcile';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid(validateStorageReconcile, envelope.payload, IMAGING_PROPERTIES);
        const store = base.store();
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            const counts = {
              checked: 0,
              quarantined: 0,
              tombstoned: 0,
              abandonedIngress: 0,
              bytesRemoved: 0,
            };
            const { rows } = await tx.query<ObjectRow>(
              `SELECT ${OBJECT_COLUMNS} FROM cuspatlas.imaging_objects o WHERE o.state = 'available'
               ORDER BY o.received_at, o.id LIMIT 501 FOR UPDATE`,
            );
            for (const row of rows.slice(0, 500)) {
              counts.checked += 1;
              try {
                await store.read(ctx.tenantId, row.storage_key, row.digest_sha256);
              } catch (err) {
                if (!isObjectStoreError(err) || err.code === 'unavailable' || err.code === 'path_traversal')
                  throw err;
                await quarantineObject(
                  tx,
                  op,
                  row,
                  err.code === 'missing' ? 'bytes_missing' : 'digest_mismatch',
                );
                counts.quarantined += 1;
                base.alert('imaging_object_integrity_failed');
              }
            }
            for (const step of reconcileSteps) {
              const more = await step(tx, ctx, store, op);
              counts.tombstoned += more.tombstoned ?? 0;
              counts.abandonedIngress += more.abandonedIngress ?? 0;
              counts.bytesRemoved += more.bytesRemoved ?? 0;
            }
            return { data: { ...counts, more: rows.length > 500 }, version: 1 };
          }),
        );
      });
    },
  };
}

/** Reconciliation steps of later tasks (ingress sweep, deletion tombstones), run after the byte check. */
export type ReconcileStep = (
  tx: TenantTransaction,
  ctx: ActorContext,
  store: ObjectStorePort,
  operation: string,
) => Promise<{ tombstoned?: number; abandonedIngress?: number; bytesRemoved?: number }>;

export type ObjectOperations = ReturnType<typeof createObjectOperations>;
