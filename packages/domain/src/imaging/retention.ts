import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  type DeletionRequestCreate,
  IMAGING_PROPERTIES,
  type LegalHoldPlace,
  type LegalHoldRelease,
  type ObjectStorePort,
  type RecordClass,
  type RetentionPolicySet,
  type TenantTransaction,
  validateDeletionExecute,
  validateDeletionRequestCreate,
  validateLegalHoldPlace,
  validateLegalHoldRelease,
  validateRetentionPolicySet,
} from '@cuspatlas/contracts';
import { recordCommand } from '../events/record-command';
import { checkEnvelope, checkRef, type ImagingBase, notFound, refused } from './base';
import { loadObject, OBJECT_RESOURCE, type ObjectRow, type ReconcileStep } from './objects';

export const POLICY_RESOURCE = 'imagingRetentionPolicy';
export const HOLD_RESOURCE = 'imagingLegalHold';
export const DELETION_RESOURCE = 'imagingDeletion';

interface Evaluation {
  readonly blocked: boolean;
  readonly rule: string | null;
  readonly earliestAllowedAt: string | null;
  readonly blockingRefs: { kind: string; ref: string }[];
  readonly recordClass: RecordClass;
  readonly requiresSecondActor: boolean;
}

/** The original whose association and holds govern an object (a derived object follows its source). */
async function governing(tx: TenantTransaction, row: ObjectRow): Promise<string> {
  if (row.kind !== 'derived') return row.id;
  const { rows } = await tx.query<{ source_object_id: string }>(
    'SELECT source_object_id FROM cuspatlas.imaging_objects WHERE id = $1',
    [row.id],
  );
  return rows[0]?.source_object_id ?? row.id;
}

/**
 * Deletion evaluation, in order: active legal holds (on the object, its source original, or any
 * patient the original was ever associated with, including identities merged into it) override
 * everything; then the record class's latest retention policy (none configured = refused, no
 * universal default); then the minimum retention counted from receipt. Dual approval (I-D6) applies to
 * any image ever associated with a patient.
 */
export async function evaluateDeletionOf(tx: TenantTransaction, row: ObjectRow): Promise<Evaluation> {
  const owner = await governing(tx, row);
  const ever = await tx.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM cuspatlas.imaging_match_decisions WHERE object_id = $1',
    [owner],
  );
  const associated = (ever.rows[0]?.n ?? 0) > 0;
  const recordClass: RecordClass =
    row.kind === 'derived' ? 'derived' : associated ? 'associated_original' : 'unassociated_original';
  const requiresSecondActor = associated;
  // Review hardening: one database definition of the governing holds (the object, its source, its
  // derived children, every patient ever associated and identities merged into them), shared with the
  // trigger that re-checks the deleted transition.
  const holds = await tx.query<{ id: string }>(
    'SELECT h AS id FROM cuspatlas.imaging_object_holds($1) h LIMIT 20',
    [row.id],
  );
  const base = { recordClass, requiresSecondActor };
  if (holds.rows.length > 0)
    return {
      ...base,
      blocked: true,
      rule: 'legal_hold_active',
      earliestAllowedAt: null,
      blockingRefs: holds.rows.map((h) => ({ kind: HOLD_RESOURCE, ref: h.id })),
    };
  const policy = await tx.query<{ id: string; earliest: Date; due: boolean }>(
    `SELECT p.id, o.received_at + make_interval(months => p.minimum_retention_months) AS earliest,
       o.received_at + make_interval(months => p.minimum_retention_months) <= now() AS due
     FROM cuspatlas.imaging_retention_policies p, cuspatlas.imaging_objects o
     WHERE p.record_class = $1 AND o.id = $2 ORDER BY p.version DESC LIMIT 1`,
    [recordClass, row.id],
  );
  const p = policy.rows[0];
  if (!p)
    return {
      ...base,
      blocked: true,
      rule: 'retention_policy_missing',
      earliestAllowedAt: null,
      blockingRefs: [],
    };
  if (!p.due)
    return {
      ...base,
      blocked: true,
      rule: 'minimum_retention_not_met',
      earliestAllowedAt: p.earliest.toISOString(),
      blockingRefs: [{ kind: POLICY_RESOURCE, ref: p.id }],
    };
  return { ...base, blocked: false, rule: null, earliestAllowedAt: null, blockingRefs: [] };
}

const blockedRefusal = (e: Evaluation) =>
  refused(
    e.rule as string,
    {
      ...(e.blockingRefs.length > 0 ? { blockingRefs: e.blockingRefs } : {}),
      ...(e.earliestAllowedAt ? { earliestAllowedAt: e.earliestAllowedAt } : {}),
    },
    // A hold can be released and time passes: a same-key retry is evaluated again, never replayed.
    { replayable: false },
  );

interface RequestRow extends Record<string, unknown> {
  id: string;
  object_id: string;
  record_class: RecordClass;
  requires_second_actor: boolean;
  state: 'pending' | 'executed';
  bytes_state: 'pending' | 'removed' | 'retained_shared' | null;
  deleted_objects: number | null;
  requested_by: string;
  requested_at: Date;
  version: number;
}
const REQUEST_COLUMNS = `id, object_id, record_class, requires_second_actor, state, bytes_state, deleted_objects,
  requested_by, requested_at, version`;

/**
 * Removes the bytes of deleted objects whose content key no live object still uses (identical bytes
 * of another patient's object are shared inside the tenant and retained), writing the tombstones that
 * reconcile a restored backup. Idempotent: rerun by a retried execute or by reconcile.
 */
async function removeBytes(
  store: ObjectStorePort,
  tx: TenantTransaction,
  ctx: ActorContext,
  deletionId: string,
): Promise<'removed' | 'retained_shared'> {
  const { rows } = await tx.query<{
    id: string;
    storage_key: string;
    digest_sha256: string;
    shared: boolean;
  }>(
    `SELECT o.id, o.storage_key, o.digest_sha256, EXISTS (
       SELECT 1 FROM cuspatlas.imaging_objects x WHERE x.storage_key = o.storage_key AND x.state <> 'deleted') AS shared
     FROM cuspatlas.imaging_objects o WHERE o.deletion_id = $1 ORDER BY o.id`,
    [deletionId],
  );
  let shared = false;
  for (const r of rows) {
    await store.writeTombstone(ctx.tenantId, r.id, r.digest_sha256);
    // Serialized with an ingest of the same bytes (it holds this lock from promotion to commit), then
    // re-checked on a fresh snapshot: bytes a concurrent ingest just registered are never removed.
    await tx.query('SELECT cuspatlas.imaging_lock_content(cuspatlas.current_tenant_id(), $1)', [
      r.digest_sha256,
    ]);
    const live = await tx.query(
      `SELECT 1 FROM cuspatlas.imaging_objects WHERE storage_key = $1 AND state <> 'deleted' LIMIT 1`,
      [r.storage_key],
    );
    if (r.shared || live.rowCount > 0) shared = true;
    else await store.remove(ctx.tenantId, r.storage_key);
  }
  return shared ? 'retained_shared' : 'removed';
}

/** Takes every governing hold-subject lock of an object (sorted; see the review-hardening migration). */
async function lockHoldSubjects(tx: TenantTransaction, objectId: string): Promise<void> {
  // Recomputes after locking until the set is stable, so an association that committed while this
  // transaction waited is covered too.
  await tx.query('SELECT cuspatlas.imaging_lock_hold_subjects(cuspatlas.current_tenant_id(), $1)', [
    objectId,
  ]);
}

/** I8: retention policy versions, legal holds and tombstone deletion with byte removal. */
export function createRetentionOperations(base: ImagingBase) {
  const { deps, execute } = base;

  async function loadRequest(tx: TenantTransaction, ref: string, lock = false): Promise<RequestRow> {
    checkRef(ref);
    const { rows } = await tx.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM cuspatlas.imaging_deletion_requests WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [ref],
    );
    const r = rows[0];
    if (!r) throw notFound();
    return r;
  }

  const executedData = (r: RequestRow, bytes: string) => ({
    deletionRef: r.id,
    objectRef: r.object_id,
    state: 'executed',
    deletedObjects: r.deleted_objects ?? 0,
    bytes,
  });

  return {
    setRetentionPolicy(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.retention.setPolicy';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid<RetentionPolicySet>(validateRetentionPolicySet, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as RetentionPolicySet;
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            // A policy change never deletes anything by itself: deletion is always its own request.
            const { rows } = await tx.query<{ id: string; version: number }>(
              `INSERT INTO cuspatlas.imaging_retention_policies (tenant_id, record_class, version, minimum_retention_months,
                 basis_code, jurisdiction_code, created_by)
               SELECT cuspatlas.current_tenant_id(), $1, coalesce(max(version), 0) + 1, $2, $3, $4, cuspatlas.current_actor_id()
               FROM cuspatlas.imaging_retention_policies WHERE record_class = $1
               RETURNING id, version`,
              [p.recordClass, p.minimumRetentionMonths, p.basisCode, p.jurisdictionCode],
            );
            const r = rows[0] as { id: string; version: number };
            await recordCommand(
              tx,
              { operation: op, resourceType: POLICY_RESOURCE, resourceRef: r.id, resourceVersion: 1 },
              { changedFields: ['recordClass', 'minimumRetentionMonths'] },
            );
            return {
              data: {
                policyRef: r.id,
                recordClass: p.recordClass,
                version: r.version,
                approvalStatus: 'recommended_pending_approval',
              },
              version: 1,
            };
          }),
        );
      });
    },

    listRetentionPolicies(ctx: ActorContext) {
      const op = 'imaging.retention.policies';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            record_class: RecordClass;
            version: number;
            minimum_retention_months: number;
            basis_code: string;
            jurisdiction_code: string;
            approval_status: string;
            created_at: Date;
          }>(
            `SELECT DISTINCT ON (record_class) id, record_class, version, minimum_retention_months, basis_code,
               jurisdiction_code, approval_status, created_at
             FROM cuspatlas.imaging_retention_policies ORDER BY record_class, version DESC`,
          );
          return rows.map((r) => ({
            policyRef: r.id,
            recordClass: r.record_class,
            version: r.version,
            minimumRetentionMonths: r.minimum_retention_months,
            basisCode: r.basis_code,
            jurisdictionCode: r.jurisdiction_code,
            approvalStatus: r.approval_status,
            createdAt: r.created_at.toISOString(),
          }));
        });
      });
    },

    placeLegalHold(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.legalHolds.place';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid<LegalHoldPlace>(validateLegalHoldPlace, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as LegalHoldPlace;
        return deps.withTenantTransaction(ctx, async (tx) => {
          // The subject must exist in the caller's tenant (another tenant's is the same 404 as missing).
          const exists = await tx.query(
            p.subject.kind === 'object'
              ? 'SELECT 1 FROM cuspatlas.imaging_objects WHERE id = $1'
              : 'SELECT 1 FROM cuspatlas.patients WHERE id = $1',
            [p.subject.ref],
          );
          if (exists.rowCount !== 1) throw notFound();
          return execute(ctx, envelope, tx, async () => {
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.imaging_legal_holds (tenant_id, subject_kind, subject_ref, reason_code, placed_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, cuspatlas.current_actor_id()) RETURNING id`,
              [p.subject.kind, p.subject.ref, p.reasonCode],
            );
            const id = rows[0]?.id as string;
            await recordCommand(
              tx,
              { operation: op, resourceType: HOLD_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['subject', 'reasonCode'] },
            );
            return { data: { legalHoldRef: id, state: 'active' }, version: 1 };
          });
        });
      });
    },

    releaseLegalHold(ctx: ActorContext, holdRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.legalHolds.release';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(holdRef);
        assertValid<LegalHoldRelease>(validateLegalHoldRelease, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as LegalHoldRelease;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{ id: string; released: boolean }>(
            'SELECT id, released_at IS NOT NULL AS released FROM cuspatlas.imaging_legal_holds WHERE id = $1 FOR UPDATE',
            [holdRef],
          );
          const h = rows[0];
          if (!h) throw notFound();
          return execute(ctx, { ...envelope, payload: { holdRef, ...p } }, tx, async () => {
            if (h.released) throw refused('legal_hold_released');
            await tx.query(
              `UPDATE cuspatlas.imaging_legal_holds SET released_by = cuspatlas.current_actor_id(), released_at = now(),
                 release_reason = $2 WHERE id = $1`,
              [h.id, p.reasonCode],
            );
            await recordCommand(
              tx,
              { operation: op, resourceType: HOLD_RESOURCE, resourceRef: h.id, resourceVersion: 2 },
              { changedFields: ['releasedAt', 'releaseReason'] },
            );
            return { data: { legalHoldRef: h.id, state: 'released' }, version: 2 };
          });
        });
      });
    },

    listLegalHolds(ctx: ActorContext) {
      const op = 'imaging.legalHolds.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            subject_kind: 'object' | 'patient';
            subject_ref: string;
            reason_code: string;
            placed_by: string;
            placed_at: Date;
            released_by: string | null;
            released_at: Date | null;
            release_reason: string | null;
          }>(
            `SELECT id, subject_kind, subject_ref, reason_code, placed_by, placed_at, released_by, released_at, release_reason
             FROM cuspatlas.imaging_legal_holds ORDER BY (released_at IS NULL) DESC, placed_at DESC, id LIMIT 100`,
          );
          return rows.map((h) => ({
            legalHoldRef: h.id,
            subjectKind: h.subject_kind,
            subjectRef: h.subject_ref,
            state: h.released_at === null ? 'active' : 'released',
            reasonCode: h.reason_code,
            placedBy: h.placed_by,
            placedAt: h.placed_at.toISOString(),
            releasedBy: h.released_by,
            releasedAt: h.released_at === null ? null : h.released_at.toISOString(),
            releaseReason: h.release_reason,
          }));
        });
      });
    },

    /** Records a deletion request; a request that would be blocked now is refused with its reason. */
    requestDeletion(ctx: ActorContext, objectRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.deletions.request';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(objectRef);
        assertValid<DeletionRequestCreate>(
          validateDeletionRequestCreate,
          envelope.payload,
          IMAGING_PROPERTIES,
        );
        const p = envelope.payload as DeletionRequestCreate;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadObject(tx, objectRef, 'FOR UPDATE');
          await lockHoldSubjects(tx, row.id);
          return execute(ctx, { ...envelope, payload: { objectRef, ...p } }, tx, async () => {
            if (row.state === 'deleted') throw refused('object_already_deleted');
            const pending = await tx.query<{ id: string }>(
              `SELECT id FROM cuspatlas.imaging_deletion_requests WHERE object_id = $1 AND state = 'pending'`,
              [row.id],
            );
            if (pending.rows[0])
              throw refused('deletion_already_requested', {
                blockingRefs: [{ kind: DELETION_RESOURCE, ref: pending.rows[0].id }],
              });
            const e = await evaluateDeletionOf(tx, row);
            if (e.blocked) throw blockedRefusal(e);
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.imaging_deletion_requests (tenant_id, object_id, record_class, requires_second_actor,
                 reason_code, requested_by)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id()) RETURNING id`,
              [row.id, e.recordClass, e.requiresSecondActor, p.reasonCode],
            );
            const id = rows[0]?.id as string;
            await recordCommand(
              tx,
              { operation: op, resourceType: DELETION_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['objectRef', 'reasonCode'] },
            );
            return {
              data: {
                deletionRef: id,
                objectRef: row.id,
                state: 'pending',
                requiresSecondActor: e.requiresSecondActor,
                recordClass: e.recordClass,
              },
              version: 1,
            };
          });
        });
      });
    },

    evaluateDeletion(ctx: ActorContext, deletionRef: string) {
      const op = 'imaging.deletions.evaluate';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(deletionRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const r = await loadRequest(tx, deletionRef);
          const row = await loadObject(tx, r.object_id);
          const e =
            r.state === 'executed'
              ? { blocked: false, rule: null, earliestAllowedAt: null, blockingRefs: [] }
              : await evaluateDeletionOf(tx, row);
          return {
            deletionRef: r.id,
            objectRef: r.object_id,
            state: r.state,
            blocked: e.blocked,
            rule: e.rule,
            earliestAllowedAt: e.earliestAllowedAt,
            blockingRefs: e.blockingRefs,
            requiresSecondActor: r.requires_second_actor,
            recordClass: r.record_class,
            requestedBy: r.requested_by,
            requestedAt: r.requested_at.toISOString(),
          };
        });
      });
    },

    /**
     * Executes a deletion: re-evaluated now (a hold placed after the request still blocks; nothing is
     * half-deleted), dual approval for associated images, then one transaction tombstones the object
     * and its derived objects, revokes their read grants and records the execution (audit + outbox).
     * Byte removal and tombstone markers follow the commit and are retried idempotently by a repeated
     * execute (same outcome reported) or by the reconcile sweep.
     */
    executeDeletion(ctx: ActorContext, deletionRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.deletions.execute';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(deletionRef);
        assertValid(validateDeletionExecute, envelope.payload, IMAGING_PROPERTIES);
        const store = base.store();
        const result = await deps.withTenantTransaction(ctx, async (tx) => {
          const pre = await loadRequest(tx, deletionRef);
          // Lock order: object, then the request.
          const row = await loadObject(tx, pre.object_id, 'FOR UPDATE');
          const r = await loadRequest(tx, deletionRef, true);
          // Waits for any transaction placing a hold on a governing subject; the evaluation below then
          // runs on a fresh snapshot and sees that hold (the deleted-transition trigger re-checks too).
          await lockHoldSubjects(tx, row.id);
          return execute(ctx, { ...envelope, payload: { deletionRef } }, tx, async () => {
            if (r.state === 'executed')
              return { data: executedData(r, r.bytes_state ?? 'pending'), version: r.version };
            if (r.requires_second_actor && r.requested_by === ctx.actorId)
              throw refused('second_approver_required');
            const e = await evaluateDeletionOf(tx, row);
            if (e.blocked) throw blockedRefusal(e);
            const deleted = await tx.query<{ id: string; version: number }>(
              `UPDATE cuspatlas.imaging_objects SET state = 'deleted', deleted_at = now(), deletion_id = $2,
                 version = version + 1, updated_at = now()
               WHERE (id = $1 OR source_object_id = $1) AND state <> 'deleted' RETURNING id, version`,
              [row.id, r.id],
            );
            for (const d of deleted.rows) {
              await recordCommand(
                tx,
                {
                  operation: op,
                  resourceType: OBJECT_RESOURCE,
                  resourceRef: d.id,
                  resourceVersion: d.version,
                },
                { changedFields: ['state', 'deletedAt'] },
              );
            }
            await tx.query(
              `UPDATE cuspatlas.imaging_read_grants SET revoked_at = now(), revoked_by = cuspatlas.current_actor_id()
               WHERE object_id = ANY ($1::uuid[]) AND revoked_at IS NULL`,
              [deleted.rows.map((d) => d.id)],
            );
            const done = await tx.query<RequestRow>(
              `UPDATE cuspatlas.imaging_deletion_requests SET state = 'executed', bytes_state = 'pending',
                 deleted_objects = $2, executed_by = cuspatlas.current_actor_id(), executed_at = now(),
                 version = version + 1, updated_at = now()
               WHERE id = $1 RETURNING ${REQUEST_COLUMNS}`,
              [r.id, deleted.rows.length],
            );
            const next = done.rows[0] as RequestRow;
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: DELETION_RESOURCE,
                resourceRef: r.id,
                resourceVersion: next.version,
              },
              { changedFields: ['state', 'executedAt'] },
            );
            return { data: executedData(next, 'pending'), version: next.version };
          });
        });
        // After the commit: tombstones and byte removal, then record the byte outcome (idempotent).
        const bytes = await deps.withTenantTransaction(ctx, async (tx) => {
          const r = await loadRequest(tx, deletionRef, true);
          if (r.bytes_state !== 'pending') return r.bytes_state as string;
          const outcome = await removeBytes(store, tx, ctx, r.id);
          await tx.query(
            `UPDATE cuspatlas.imaging_deletion_requests SET bytes_state = $2, version = version + 1, updated_at = now()
             WHERE id = $1`,
            [r.id, outcome],
          );
          return outcome;
        });
        return { ...result, data: { ...(result.data as Record<string, unknown>), bytes } };
      });
    },
  };
}

/**
 * Reconcile step (I8 backup interaction): an object the database lists as live but whose tombstone
 * exists in the object store was deleted after the backup that restored it; it becomes deleted again,
 * never available. Executed deletions whose byte removal is still pending are completed.
 */
export const reconcileDeletions: ReconcileStep = async (tx, ctx, store, op) => {
  let tombstoned = 0;
  const { rows } = await tx.query<{ id: string; version: number }>(
    `SELECT id, version FROM cuspatlas.imaging_objects WHERE state <> 'deleted' ORDER BY id LIMIT 500 FOR UPDATE`,
  );
  for (const r of rows) {
    if (!(await store.hasTombstone(ctx.tenantId, r.id))) continue;
    // A hold placed on a restored row before this sweep blocks the deleted transition (trigger); its
    // bytes are gone, so it is quarantined instead (never served) and left for review.
    const up = await tx
      .savepoint(() =>
        tx.query<{ version: number }>(
          `UPDATE cuspatlas.imaging_objects SET state = 'deleted', deleted_at = now(), version = version + 1,
             updated_at = now() WHERE id = $1 RETURNING version`,
          [r.id],
        ),
      )
      .catch(async (err: unknown) => {
        if ((err as { code?: unknown }).code !== '42501') throw err;
        return tx.query<{ version: number }>(
          `UPDATE cuspatlas.imaging_objects SET state = 'quarantined', quarantine_reason = 'tombstoned_under_hold',
             version = version + 1, updated_at = now() WHERE id = $1 AND state = 'available' RETURNING version`,
          [r.id],
        );
      });
    if (up.rowCount === 0) continue;
    await recordCommand(
      tx,
      {
        operation: op,
        resourceType: OBJECT_RESOURCE,
        resourceRef: r.id,
        resourceVersion: up.rows[0]?.version ?? r.version + 1,
      },
      { changedFields: ['state', 'deletedAt'] },
    );
    tombstoned += 1;
  }
  let bytesRemoved = 0;
  const pending = await tx.query<{ id: string }>(
    `SELECT id FROM cuspatlas.imaging_deletion_requests WHERE state = 'executed' AND bytes_state = 'pending'
     ORDER BY id LIMIT 100 FOR UPDATE`,
  );
  for (const p of pending.rows) {
    const outcome = await removeBytes(store, tx, ctx, p.id);
    await tx.query(
      `UPDATE cuspatlas.imaging_deletion_requests SET bytes_state = $2, version = version + 1, updated_at = now()
       WHERE id = $1`,
      [p.id, outcome],
    );
    bytesRemoved += 1;
  }
  return { tombstoned, bytesRemoved };
};
