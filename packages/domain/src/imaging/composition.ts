import {
  type ActorContext,
  type AnnotationCreate,
  type AnnotationSupersede,
  assertValid,
  type CommandEnvelope,
  CommitThenRefuse,
  type DerivedCreate,
  IMAGING_PROPERTIES,
  isObjectStoreError,
  type MountCreate,
  type MountQuery,
  type MountRevise,
  type MountSlot,
  type MountTemplate,
  RefusalError,
  type TenantTransaction,
  type Transform,
  validateAnnotationCreate,
  validateAnnotationSupersede,
  validateDerivedCreate,
  validateMountCreate,
  validateMountQuery,
  validateMountRevise,
} from '@cuspatlas/contracts';
import { canonicalJson, sha256Hex } from '../commands/digest';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import type { AssociationSource, CorrectionGuard } from './association';
import { checkEnvelope, checkRef, failed, type ImagingBase, notFound, refused } from './base';
import { loadObject, OBJECT_RESOURCE, type ObjectReadExtension, type ObjectRow } from './objects';
import { decodePng, encodePng, PngError, type Raster } from './png';

export const MOUNT_RESOURCE = 'imagingMount';
export const ANNOTATION_RESOURCE = 'imagingAnnotation';
export const DERIVATION_RESOURCE = 'imagingDerivation';

/** Mount templates and their slot counts (imaging-mount-templates.pending-approval.1). */
export const MOUNT_TEMPLATES: Readonly<Record<MountTemplate, number>> = {
  'pa-1': 1,
  'pano-1': 1,
  'bitewing-2': 2,
  'bitewing-4': 4,
  'photo-8': 8,
  'fmx-18': 18,
};

/** A derived object follows its source original's association. */
export const sourceOfDerived: AssociationSource = async (tx, row) => {
  if (row.kind !== 'derived') return row.id;
  const { rows } = await tx.query<{ source_object_id: string }>(
    'SELECT source_object_id FROM cuspatlas.imaging_objects WHERE id = $1',
    [row.id],
  );
  return rows[0]?.source_object_id ?? row.id;
};

async function currentPatientOf(tx: TenantTransaction, row: ObjectRow): Promise<string | null> {
  const owner = await sourceOfDerived(tx, row);
  const { rows } = await tx.query<{ subject_patient_id: string }>(
    `SELECT subject_patient_id FROM cuspatlas.imaging_match_decisions WHERE object_id = $1 AND superseded_by_id IS NULL`,
    [owner],
  );
  return rows[0]?.subject_patient_id ?? null;
}

/** I3 correction guard: an object in a current mount version needs the mount amended first. */
export const mountGuard: CorrectionGuard = async (tx, objectId) => {
  const { rows } = await tx.query<{ mount_id: string }>(
    `SELECT s.mount_id FROM cuspatlas.imaging_mount_slots s JOIN cuspatlas.imaging_mounts m ON m.id = s.mount_id
     WHERE s.object_id = $1 AND s.mount_version = m.version ORDER BY s.mount_id LIMIT 20`,
    [objectId],
  );
  if (rows.length > 0)
    throw refused('mount_amendment_required', {
      blockingRefs: rows.map((r) => ({ kind: MOUNT_RESOURCE, ref: r.mount_id })),
    });
};

/** Object read projection (I4): derivation provenance, derived objects and current annotation count. */
export const compositionExtension: ObjectReadExtension = async (tx, rows) => {
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const der = await tx.query<{
      id: string;
      source_object_id: string;
      source_digest_sha256: string;
      transform: Transform;
      author_id: string;
      created_at: Date;
    }>(
      `SELECT id, source_object_id, source_digest_sha256, transform, author_id, created_at FROM cuspatlas.imaging_derivations
       WHERE derived_object_id = $1 ORDER BY created_at, id LIMIT 1`,
      [r.id],
    );
    const d = der.rows[0];
    const kids = await tx.query<{ id: string }>(
      `SELECT id FROM cuspatlas.imaging_objects WHERE source_object_id = $1 AND state = 'available'
       ORDER BY created_at, id LIMIT 100`,
      [r.id],
    );
    const ann = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cuspatlas.imaging_annotations WHERE object_id = $1 AND state = 'current'`,
      [r.id],
    );
    out.set(r.id, {
      derivation:
        d === undefined
          ? null
          : {
              derivationRef: d.id,
              sourceObjectRef: d.source_object_id,
              sourceDigestSha256: d.source_digest_sha256,
              transform: d.transform,
              authorRef: d.author_id,
              derivedAt: d.created_at.toISOString(),
            },
      derivedObjects: kids.rows.map((k) => k.id),
      annotationCount: ann.rows[0]?.n ?? 0,
    });
  }
  return out;
};

/** Applies a transform to a decoded raster; the source raster is never mutated. */
export function applyTransform(r: Raster, t: Transform): Raster {
  const c = r.channels;
  if (t.kind === 'crop') {
    if (t.x + t.width > r.width || t.y + t.height > r.height) throw failed('crop_out_of_bounds');
    const out = new Uint8Array(t.width * t.height * c);
    for (let y = 0; y < t.height; y += 1)
      out.set(
        r.pixels.subarray(((t.y + y) * r.width + t.x) * c, ((t.y + y) * r.width + t.x + t.width) * c),
        y * t.width * c,
      );
    return { width: t.width, height: t.height, channels: c, pixels: out };
  }
  if (t.kind === 'invert') {
    const out = Uint8Array.from(r.pixels);
    for (let i = 0; i < out.length; i += 1) if (c !== 4 || i % 4 !== 3) out[i] = 255 - (out[i] as number);
    return { ...r, pixels: out };
  }
  const turns = t.degrees / 90;
  let cur = r;
  for (let n = 0; n < turns; n += 1) {
    const w = cur.height;
    const h = cur.width;
    const out = new Uint8Array(cur.pixels.length);
    for (let y = 0; y < cur.height; y += 1)
      for (let x = 0; x < cur.width; x += 1) {
        // Clockwise quarter turn: (x, y) -> (height - 1 - y, x).
        const dst = (x * w + (cur.height - 1 - y)) * c;
        out.set(cur.pixels.subarray((y * cur.width + x) * c, (y * cur.width + x + 1) * c), dst);
      }
    cur = { width: w, height: h, channels: c, pixels: out };
  }
  return cur;
}

interface MountSlotRow extends Record<string, unknown> {
  slot: number;
  object_id: string;
}

/** I4: mounts (versioned ordered groups), annotations (versioned, separate) and derived images. */
export function createCompositionOperations(base: ImagingBase) {
  const { deps, execute } = base;

  async function checkSlots(tx: TenantTransaction, template: MountTemplate, slots: readonly MountSlot[]) {
    const n = MOUNT_TEMPLATES[template];
    const seenSlots = new Set<number>();
    const seenObjects = new Set<string>();
    for (const s of slots) {
      if (s.slot > n || seenSlots.has(s.slot) || seenObjects.has(s.objectRef)) throw failed('invalid_slot');
      seenSlots.add(s.slot);
      seenObjects.add(s.objectRef);
    }
    const patients = new Set<string | null>();
    for (const s of [...slots].sort((a, b) => a.objectRef.localeCompare(b.objectRef))) {
      const row = await loadObject(tx, s.objectRef, 'FOR SHARE');
      if (row.state !== 'available') throw refused('object_not_available');
      patients.add(await currentPatientOf(tx, row));
    }
    if (patients.has(null)) throw refused('object_unassociated');
    if (patients.size !== 1) throw refused('mixed_association');
  }

  async function writeSlots(
    tx: TenantTransaction,
    mountId: string,
    version: number,
    slots: readonly MountSlot[],
  ) {
    for (const s of slots) {
      await tx.query(
        `INSERT INTO cuspatlas.imaging_mount_slots (tenant_id, mount_id, mount_version, slot, object_id, created_by)
         VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, cuspatlas.current_actor_id())`,
        [mountId, version, s.slot, s.objectRef],
      );
    }
  }

  return {
    createMount(ctx: ActorContext, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.mounts.create';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        assertValid<MountCreate>(validateMountCreate, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as MountCreate;
        for (const s of p.slots) checkRef(s.objectRef);
        return deps.withTenantTransaction(ctx, (tx) =>
          execute(ctx, envelope, tx, async () => {
            await checkSlots(tx, p.template, p.slots);
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.imaging_mounts (tenant_id, template, created_by)
               VALUES (cuspatlas.current_tenant_id(), $1, cuspatlas.current_actor_id()) RETURNING id`,
              [p.template],
            );
            const id = rows[0]?.id as string;
            await writeSlots(tx, id, 1, p.slots);
            await recordCommand(
              tx,
              { operation: op, resourceType: MOUNT_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['template', 'slots'] },
            );
            return {
              data: { mountRef: id, version: 1, template: p.template, slotCount: p.slots.length },
              version: 1,
            };
          }),
        );
      });
    },

    reviseMount(ctx: ActorContext, mountRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.mounts.revise';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(mountRef);
        assertValid<MountRevise>(validateMountRevise, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as MountRevise;
        for (const s of p.slots) checkRef(s.objectRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{ id: string; template: MountTemplate; version: number }>(
            'SELECT id, template, version FROM cuspatlas.imaging_mounts WHERE id = $1 FOR UPDATE',
            [mountRef],
          );
          const m = rows[0];
          if (!m) throw notFound();
          return execute(ctx, { ...envelope, payload: { mountRef, ...p } }, tx, async () => {
            if (m.version !== p.expectedVersion)
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: m.version } });
            await checkSlots(tx, m.template, p.slots);
            const version = m.version + 1;
            await tx.query(
              'UPDATE cuspatlas.imaging_mounts SET version = $2, updated_at = now() WHERE id = $1',
              [m.id, version],
            );
            await writeSlots(tx, m.id, version, p.slots);
            await recordCommand(
              tx,
              { operation: op, resourceType: MOUNT_RESOURCE, resourceRef: m.id, resourceVersion: version },
              { changedFields: ['slots'] },
            );
            return {
              data: { mountRef: m.id, version, template: m.template, slotCount: p.slots.length },
              version,
            };
          });
        });
      });
    },

    readMount(ctx: ActorContext, mountRef: string, query: unknown) {
      const op = 'imaging.mounts.read';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(mountRef);
        assertValid<MountQuery>(validateMountQuery, query, IMAGING_PROPERTIES);
        const q = query as MountQuery;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            template: MountTemplate;
            version: number;
            created_by: string;
            created_at: Date;
          }>(
            'SELECT id, template, version, created_by, created_at FROM cuspatlas.imaging_mounts WHERE id = $1',
            [mountRef],
          );
          const m = rows[0];
          if (!m) throw notFound();
          const version = q.version === undefined ? m.version : Number(q.version);
          if (version > m.version) throw notFound();
          const slots = await tx.query<MountSlotRow>(
            `SELECT slot, object_id FROM cuspatlas.imaging_mount_slots WHERE mount_id = $1 AND mount_version = $2
             ORDER BY slot`,
            [m.id, version],
          );
          const out = [];
          const patients = new Set<string | null>();
          for (const s of slots.rows) {
            const row = await loadObject(tx, s.object_id);
            const patientRef = row.state === 'deleted' ? null : await currentPatientOf(tx, row);
            patients.add(patientRef);
            out.push({
              slot: s.slot,
              objectRef: s.object_id,
              state:
                row.state === 'available' ? 'present' : row.state === 'deleted' ? 'missing' : 'unavailable',
              patientRef,
              digestSha256: row.digest_sha256,
            });
          }
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: MOUNT_RESOURCE,
            resourceRefs: [m.id, ...out.map((x) => x.objectRef)].slice(0, 100),
            queryFields: q.version === undefined ? [] : ['version'],
          });
          const only = patients.size === 1 ? ([...patients][0] ?? null) : null;
          return {
            mountRef: m.id,
            template: m.template,
            version,
            currentVersion: m.version,
            patientRef: only,
            mixedAssociation: patients.size !== 1 || only === null,
            slots: out,
            createdAt: m.created_at.toISOString(),
            createdBy: m.created_by,
          };
        });
      });
    },

    createAnnotation(ctx: ActorContext, objectRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.annotations.create';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(objectRef);
        assertValid<AnnotationCreate>(validateAnnotationCreate, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as AnnotationCreate;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const obj = await loadObject(tx, objectRef, 'FOR SHARE');
          return execute(ctx, { ...envelope, payload: { objectRef, ...p } }, tx, async () => {
            if (obj.state !== 'available') throw refused('annotation_object_unavailable');
            const { rows } = await tx.query<{ annotation_ref: string }>(
              `INSERT INTO cuspatlas.imaging_annotations (tenant_id, annotation_ref, version, object_id, kind, state,
                 geometry, label, author_id)
               VALUES (cuspatlas.current_tenant_id(), gen_random_uuid(), 1, $1, $2, 'current', $3::jsonb, $4,
                 cuspatlas.current_actor_id())
               RETURNING annotation_ref`,
              [obj.id, p.kind, JSON.stringify(p.geometry), p.label ?? null],
            );
            const ref = rows[0]?.annotation_ref as string;
            await recordCommand(
              tx,
              { operation: op, resourceType: ANNOTATION_RESOURCE, resourceRef: ref, resourceVersion: 1 },
              { changedFields: ['kind', 'geometry', ...(p.label ? ['label'] : [])] },
            );
            return {
              data: { annotationRef: ref, objectRef: obj.id, version: 1, state: 'current' },
              version: 1,
            };
          });
        });
      });
    },

    supersedeAnnotation(ctx: ActorContext, annotationRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.annotations.supersede';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(annotationRef);
        assertValid<AnnotationSupersede>(validateAnnotationSupersede, envelope.payload, IMAGING_PROPERTIES);
        const p = envelope.payload as AnnotationSupersede;
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<{
            id: string;
            version: number;
            object_id: string;
            kind: string;
            state: string;
            label: string | null;
          }>(
            `SELECT id, version, object_id, kind, state, label FROM cuspatlas.imaging_annotations
             WHERE annotation_ref = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE`,
            [annotationRef],
          );
          const cur = rows[0];
          if (!cur) throw notFound();
          return execute(ctx, { ...envelope, payload: { annotationRef, ...p } }, tx, async () => {
            if (cur.state !== 'current') throw refused('annotation_withdrawn');
            if (cur.version !== p.expectedVersion)
              throw new RefusalError({ code: 'stale_version', detail: { currentVersion: cur.version } });
            const obj = await loadObject(tx, cur.object_id, 'FOR SHARE');
            if (obj.state !== 'available') throw refused('annotation_object_unavailable');
            await tx.query(`UPDATE cuspatlas.imaging_annotations SET state = 'superseded' WHERE id = $1`, [
              cur.id,
            ]);
            const withdrawn = p.geometry === undefined;
            const version = cur.version + 1;
            await tx.query(
              `INSERT INTO cuspatlas.imaging_annotations (tenant_id, annotation_ref, version, object_id, kind, state,
                 geometry, label, reason_code, author_id)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8, cuspatlas.current_actor_id())`,
              [
                annotationRef,
                version,
                cur.object_id,
                cur.kind,
                withdrawn ? 'withdrawn' : 'current',
                withdrawn ? null : JSON.stringify(p.geometry),
                withdrawn ? null : (p.label ?? cur.label),
                p.reasonCode,
              ],
            );
            await recordCommand(
              tx,
              {
                operation: op,
                resourceType: ANNOTATION_RESOURCE,
                resourceRef: annotationRef,
                resourceVersion: version,
              },
              { changedFields: withdrawn ? ['state'] : ['geometry', 'state'] },
            );
            return {
              data: {
                annotationRef,
                objectRef: cur.object_id,
                version,
                state: withdrawn ? 'withdrawn' : 'current',
              },
              version,
            };
          });
        });
      });
    },

    listAnnotations(ctx: ActorContext, objectRef: string) {
      const op = 'imaging.annotations.list';
      return base.guarded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkRef(objectRef);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const obj = await loadObject(tx, objectRef);
          const { rows } = await tx.query<{
            annotation_ref: string;
            version: number;
            state: string;
            kind: string;
            geometry: unknown;
            label: string | null;
            reason_code: string | null;
            author_id: string;
            created_at: Date;
          }>(
            `SELECT annotation_ref, version, state, kind, geometry, label, reason_code, author_id, created_at
             FROM cuspatlas.imaging_annotations WHERE object_id = $1 ORDER BY created_at, annotation_ref, version LIMIT 500`,
            [obj.id],
          );
          await recordSensitiveRead(tx, {
            operation: op,
            resourceType: ANNOTATION_RESOURCE,
            resourceRefs: [...new Set(rows.map((r) => r.annotation_ref))].slice(0, 100),
            queryFields: [],
          });
          return {
            objectRef: obj.id,
            annotations: rows.map((r) => ({
              annotationRef: r.annotation_ref,
              objectRef: obj.id,
              version: r.version,
              state: r.state,
              kind: r.kind,
              geometry: r.geometry,
              label: r.label,
              reasonCode: r.reason_code,
              authorRef: r.author_id,
              createdAt: r.created_at.toISOString(),
            })),
          };
        });
      });
    },

    /**
     * Derives a new object from an available PNG original. The source bytes are read verified and
     * never written; the result is its own content-addressed object with derivation provenance. A
     * transform that cannot run is recorded as a failed derivation (committed) and refused.
     */
    createDerivedImage(ctx: ActorContext, objectRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.derived.create';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(objectRef);
        assertValid<DerivedCreate>(validateDerivedCreate, envelope.payload, IMAGING_PROPERTIES);
        const t = (envelope.payload as DerivedCreate).transform;
        const store = base.store();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const src = await loadObject(tx, objectRef, 'FOR SHARE');
          if (src.kind !== 'original') throw failed('derived_source_not_original');
          if (src.state !== 'available') throw refused('object_not_available');
          const key = sha256Hex(canonicalJson({ source: src.digest_sha256, transform: t }));
          const recordFailure = async (why: string) => {
            await tx.query(
              `INSERT INTO cuspatlas.imaging_derivations (tenant_id, source_object_id, source_digest_sha256, transform,
                 derivation_key, state, failure_reason, author_id)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3::jsonb, $4, 'failed', $5, cuspatlas.current_actor_id())`,
              [src.id, src.digest_sha256, JSON.stringify(t), key, why],
            );
            throw new CommitThenRefuse(failed(why));
          };
          if (src.content_type !== 'image/png') await recordFailure('transform_unsupported');
          let raster: Raster;
          try {
            raster = decodePng(await store.read(ctx.tenantId, src.storage_key, src.digest_sha256));
          } catch (err) {
            if (err instanceof PngError) return recordFailure('transform_unsupported');
            if (isObjectStoreError(err) && err.code !== 'unavailable') throw refused('object_not_available');
            throw err;
          }
          return execute(ctx, { ...envelope, payload: { objectRef, transform: t } }, tx, async () => {
            const existing = await tx.query<{ id: string; digest_sha256: string; derivation: string }>(
              `SELECT o.id, o.digest_sha256, d.id AS derivation FROM cuspatlas.imaging_objects o
               JOIN cuspatlas.imaging_derivations d ON d.derived_object_id = o.id
               WHERE o.source_object_id = $1 AND o.derivation_key = $2 AND o.state = 'available' LIMIT 1`,
              [src.id, key],
            );
            const hit = existing.rows[0];
            if (hit)
              return {
                data: {
                  objectRef: hit.id,
                  sourceObjectRef: src.id,
                  digestSha256: hit.digest_sha256,
                  created: false,
                  derivationRef: hit.derivation,
                },
                version: 1,
              };
            const bytes = encodePng(applyTransform(raster, t));
            const put = await store.putContent(ctx.tenantId, bytes);
            const obj = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.imaging_objects (tenant_id, kind, state, content_type, byte_length, digest_sha256,
                 storage_key, source_object_id, derivation_key, created_by)
               VALUES (cuspatlas.current_tenant_id(), 'derived', 'available', 'image/png', $1, $2, $3, $4, $5,
                 cuspatlas.current_actor_id())
               RETURNING id`,
              [bytes.byteLength, put.digestSha256, put.storageKey, src.id, key],
            );
            const id = obj.rows[0]?.id as string;
            const der = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.imaging_derivations (tenant_id, source_object_id, source_digest_sha256, transform,
                 derivation_key, state, derived_object_id, author_id)
               VALUES (cuspatlas.current_tenant_id(), $1, $2, $3::jsonb, $4, 'succeeded', $5, cuspatlas.current_actor_id())
               RETURNING id`,
              [src.id, src.digest_sha256, JSON.stringify(t), key, id],
            );
            await recordCommand(
              tx,
              { operation: op, resourceType: OBJECT_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['kind', 'derivedFrom', 'transform'] },
            );
            return {
              data: {
                objectRef: id,
                sourceObjectRef: src.id,
                digestSha256: put.digestSha256,
                created: true,
                derivationRef: der.rows[0]?.id as string,
              },
              version: 1,
            };
          });
        });
      });
    },
  };
}
