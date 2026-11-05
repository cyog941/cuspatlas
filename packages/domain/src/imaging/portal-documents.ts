import {
  type ActorContext,
  assertValid,
  type CommandEnvelope,
  IMAGING_PROPERTIES,
  isObjectStoreError,
  type ObjectContent,
  type PortalReleaseData,
  RefusalError,
  type TenantTransaction,
  validatePortalReleaseCreate,
  validatePortalReleaseRevoke,
} from '@cuspatlas/contracts';
import { requirePortalAccess } from '../engagement/portal/access';
import { recordCommand } from '../events/record-command';
import { recordSensitiveRead } from '../events/record-sensitive-read';
import type { ActionName } from '../policy/authorize';
import { checkEnvelope, checkRef, type ImagingBase, notFound, refused } from './base';
import { loadObject } from './objects';
import { signGrantToken, verifyGrantToken } from './tokens';

/**
 * E2 portal documents, imaging side (closeout B; synthetic, recommended-pending-approval). A clinician
 * explicitly releases one image, currently I3-associated to the patient, to that patient's portal: a
 * separate human-only, audited, revocable fact. The portal lists live releases only and downloads
 * through an I1 short-lived read grant bound to the portal principal, scoped via E1
 * `requirePortalAccess` (relationship scope `clinical_read`). Unreleased clinical content never leaves.
 */
export const PORTAL_RELEASE_RESOURCE = 'portalDocumentRelease';
const PORTAL_GRANT_TTL = 60;
const DOCUMENT_SCOPE = ['clinical_read'] as const;
// Portal operations have no staff policy (no staff scope admits a portal principal); the name is used
// only for attempt recording.
const PORTAL_GRANT_OP = 'portal.documents.grantRead' as ActionName;
const PORTAL_CONTENT_OP = 'portal.documents.content' as ActionName;

interface ReleaseRow extends Record<string, unknown> {
  id: string;
  patient_id: string;
  item_id: string;
  revoked: boolean;
}

/** A live release of the patient whose image is still available and still associated to them, or 404. */
async function liveRelease(tx: TenantTransaction, patientRef: string, releaseRef: string) {
  checkRef(releaseRef);
  const { rows } = await tx.query<ReleaseRow>(
    `SELECT r.id, r.patient_id, r.item_id, r.revoked_at IS NOT NULL AS revoked
     FROM cuspatlas.portal_document_releases r
     JOIN cuspatlas.imaging_objects o ON o.id = r.item_id AND o.tenant_id = r.tenant_id AND o.state = 'available'
     JOIN cuspatlas.imaging_match_decisions d ON d.object_id = r.item_id AND d.tenant_id = r.tenant_id
       AND d.superseded_by_id IS NULL AND d.subject_patient_id = r.patient_id
     WHERE r.id = $1 AND r.item_kind = 'imaging_object' AND r.patient_id = $2 AND r.revoked_at IS NULL`,
    [releaseRef, patientRef],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** The documents portal view: live image releases of the patient (no staff object identifiers). */
export async function portalDocumentsView(tx: TenantTransaction, patientRef: string) {
  const { rows } = await tx.query<{
    id: string;
    content_type: string;
    byte_length: string;
    released_at: Date;
  }>(
    `SELECT r.id, o.content_type, o.byte_length::text AS byte_length, r.released_at
     FROM cuspatlas.portal_document_releases r
     JOIN cuspatlas.imaging_objects o ON o.id = r.item_id AND o.tenant_id = r.tenant_id AND o.state = 'available'
     JOIN cuspatlas.imaging_match_decisions d ON d.object_id = r.item_id AND d.tenant_id = r.tenant_id
       AND d.superseded_by_id IS NULL AND d.subject_patient_id = r.patient_id
     WHERE r.patient_id = $1 AND r.item_kind = 'imaging_object' AND r.revoked_at IS NULL
     ORDER BY r.released_at DESC, r.id LIMIT 100`,
    [patientRef],
  );
  return {
    documents: rows.map((r) => ({
      releaseRef: r.id,
      kind: 'image',
      contentType: r.content_type,
      byteLength: Number(r.byte_length),
      releasedAt: r.released_at.toISOString(),
    })),
  };
}

export function createPortalDocumentOperations(base: ImagingBase) {
  const { deps, execute } = base;
  return {
    /** Staff: release one associated image to its patient's portal (human-only, imaging.write). */
    releaseToPortal(
      ctx: ActorContext,
      objectRef: string,
      envelope: CommandEnvelope<unknown>,
    ): Promise<{ data: PortalReleaseData; version: number; correlationId: string; replayed: boolean }> {
      const op = 'imaging.objects.releaseToPortal';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(objectRef);
        assertValid(validatePortalReleaseCreate, envelope.payload, IMAGING_PROPERTIES);
        const { patientRef } = envelope.payload as { patientRef: string };
        return deps.withTenantTransaction(ctx, async (tx) => {
          const row = await loadObject(tx, objectRef, 'FOR SHARE');
          return execute<PortalReleaseData>(ctx, envelope, tx, async () => {
            if (row.state !== 'available') throw refused('object_not_available');
            const { rows: d } = await tx.query<{ subject_patient_id: string }>(
              `SELECT subject_patient_id FROM cuspatlas.imaging_match_decisions
               WHERE object_id = $1 AND superseded_by_id IS NULL`,
              [row.id],
            );
            // Only to the patient the image is currently associated with (never a guess).
            if (d[0]?.subject_patient_id !== patientRef) throw refused('object_not_associated_to_patient');
            const { rows: live } = await tx.query(
              `SELECT 1 FROM cuspatlas.portal_document_releases
               WHERE item_kind = 'imaging_object' AND item_id = $1 AND revoked_at IS NULL`,
              [row.id],
            );
            if (live.length > 0) throw refused('already_released');
            const { rows } = await tx.query<{ id: string }>(
              `INSERT INTO cuspatlas.portal_document_releases (tenant_id, patient_id, item_kind, item_id, released_by)
               VALUES (cuspatlas.current_tenant_id(), $1, 'imaging_object', $2, cuspatlas.current_actor_id())
               RETURNING id`,
              [patientRef, row.id],
            );
            const id = rows[0]?.id as string;
            await recordCommand(
              tx,
              { operation: op, resourceType: PORTAL_RELEASE_RESOURCE, resourceRef: id, resourceVersion: 1 },
              { changedFields: ['patientRef', 'objectRef'] },
            );
            return {
              data: { releaseRef: id, objectRef: row.id, patientRef, state: 'released' },
              version: 1,
            };
          });
        });
      });
    },

    /** Staff: revoke a portal release (human-only, imaging.write). Takes effect at once. */
    revokePortalRelease(ctx: ActorContext, releaseRef: string, envelope: CommandEnvelope<unknown>) {
      const op = 'imaging.portalReleases.revoke';
      return base.recorded(ctx, op, async () => {
        await base.authorize(ctx, op);
        checkEnvelope(envelope, op);
        checkRef(releaseRef);
        assertValid(validatePortalReleaseRevoke, envelope.payload, IMAGING_PROPERTIES);
        return deps.withTenantTransaction(ctx, async (tx) => {
          const { rows } = await tx.query<ReleaseRow>(
            `SELECT id, patient_id, item_id, revoked_at IS NOT NULL AS revoked
             FROM cuspatlas.portal_document_releases WHERE id = $1 AND item_kind = 'imaging_object' FOR UPDATE`,
            [releaseRef],
          );
          const r = rows[0];
          if (!r) throw notFound();
          return execute<PortalReleaseData>(ctx, { ...envelope, payload: { releaseRef } }, tx, async () => {
            if (r.revoked) throw refused('release_already_revoked');
            await tx.query(
              `UPDATE cuspatlas.portal_document_releases SET revoked_at = now(),
                 revoked_by = cuspatlas.current_actor_id() WHERE id = $1`,
              [r.id],
            );
            await recordCommand(
              tx,
              { operation: op, resourceType: PORTAL_RELEASE_RESOURCE, resourceRef: r.id, resourceVersion: 2 },
              { changedFields: ['revokedAt'] },
            );
            return {
              data: { releaseRef: r.id, objectRef: r.item_id, patientRef: r.patient_id, state: 'revoked' },
              version: 2,
            };
          });
        });
      });
    },

    /** Portal: a short-lived read grant for one live release of a patient the principal may see. */
    portalDocumentGrant(ctx: ActorContext, patientRef: string, releaseRef: string, body: unknown) {
      return base.recorded(ctx, PORTAL_GRANT_OP, async () => {
        if (typeof body !== 'object' || body === null || Object.keys(body).length > 0) {
          throw new RefusalError({ code: 'validation_failed', reasonCode: 'imaging_refused' });
        }
        const secret = base.secret();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const access = await requirePortalAccess(tx, patientRef, DOCUMENT_SCOPE);
          const r = await liveRelease(tx, access.patientRef, releaseRef);
          const { rows } = await tx.query<{ id: string; exp: string }>(
            `INSERT INTO cuspatlas.imaging_read_grants (tenant_id, object_id, principal_id, expires_at)
             VALUES (cuspatlas.current_tenant_id(), $1, cuspatlas.current_actor_id(),
               date_trunc('second', now()) + make_interval(secs => $2))
             RETURNING id, extract(epoch FROM expires_at)::bigint::text AS exp`,
            [r.item_id, PORTAL_GRANT_TTL],
          );
          const grant = rows[0];
          if (!grant) throw new Error('grant insert returned no row');
          await recordCommand(
            tx,
            {
              operation: PORTAL_GRANT_OP,
              resourceType: 'imagingReadGrant',
              resourceRef: grant.id,
              resourceVersion: 1,
            },
            { changedFields: ['releaseRef', 'expiresAt'] },
          );
          const expires = Number(grant.exp);
          return {
            grantRef: grant.id,
            releaseRef: r.id,
            token: signGrantToken(
              secret,
              { tenantId: ctx.tenantId, principalId: ctx.actorId, objectRef: r.item_id },
              grant.id,
              expires,
            ),
            expiresAt: new Date(expires * 1000).toISOString(),
            contentPath: `/portal/v1/patients/${access.patientRef}/documents/${r.id}/content`,
          };
        });
      });
    },

    /** Portal: the released image bytes, with a live grant of this principal (verified digest). */
    portalDocumentContent(
      ctx: ActorContext,
      patientRef: string,
      releaseRef: string,
      token: unknown,
    ): Promise<ObjectContent> {
      return base.recorded(ctx, PORTAL_CONTENT_OP, async () => {
        const store = base.store();
        const secret = base.secret();
        return deps.withTenantTransaction(ctx, async (tx) => {
          const access = await requirePortalAccess(tx, patientRef, DOCUMENT_SCOPE);
          const r = await liveRelease(tx, access.patientRef, releaseRef);
          const row = await loadObject(tx, r.item_id, 'FOR SHARE');
          const parsed = verifyGrantToken(
            secret,
            { tenantId: ctx.tenantId, principalId: ctx.actorId, objectRef: row.id },
            token,
          );
          const denied = () => new RefusalError({ code: 'forbidden', reasonCode: 'object_token_invalid' });
          // Expiry is decided by the grant row at the database clock (expires_at > now()), not by the
          // application clock against the token's copy of it (clock audit).
          if (!parsed) throw denied();
          const grant = await tx.query(
            `SELECT 1 FROM cuspatlas.imaging_read_grants WHERE id = $1 AND object_id = $2
               AND principal_id = cuspatlas.current_actor_id() AND revoked_at IS NULL AND expires_at > now()
               AND extract(epoch FROM expires_at)::bigint = $3`,
            [parsed.grantRef, row.id, parsed.expiresEpochSeconds],
          );
          if (grant.rowCount !== 1) throw denied();
          let bytes: Uint8Array;
          try {
            bytes = await store.read(ctx.tenantId, row.storage_key, row.digest_sha256);
          } catch (err) {
            // Integrity failures are the staff sweep's to quarantine; the portal only refuses.
            if (isObjectStoreError(err)) throw refused('object_not_available');
            throw err;
          }
          await recordSensitiveRead(tx, {
            operation: PORTAL_CONTENT_OP,
            resourceType: 'patient',
            resourceRefs: [access.patientRef],
            queryFields: [],
          });
          return { contentType: row.content_type, bytes, digestSha256: row.digest_sha256 };
        });
      });
    },
  };
}
